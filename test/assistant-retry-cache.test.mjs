import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'
import {retryAfterMs, retryingFetch} from '../omarchyd/assistant/retry.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : null)})
const reply = (status, body = '', headers = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(headers),
	text: async () => body,
	body: null,
})
const sse = (events) => ({
	ok: true,
	status: 200,
	headers: new Headers(),
	body: (async function* () {
		for (const e of events) yield new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	})(),
})
// Records each wait instead of sleeping.
const fakeSleep = () => {
	const waits = []
	const sleep = async (ms) => {
		waits.push(ms)
	}
	return {waits, sleep}
}
const scripted = (...responses) => {
	const calls = []
	const fetchImpl = async (url, init) => {
		calls.push({url, init})
		const next = responses.shift()
		if (next instanceof Error) throw next
		return typeof next === 'function' ? next() : next
	}
	return {calls, fetchImpl}
}

test('retryAfterMs reads seconds, milliseconds and an HTTP date', () => {
	assert.equal(retryAfterMs(reply(429, '', {'retry-after': '3'})), 3000)
	assert.equal(retryAfterMs(reply(429, '', {'retry-after-ms': '250', 'retry-after': '9'})), 250)
	assert.equal(retryAfterMs(reply(429, '', {'retry-after': new Date(10_000).toUTCString()}), 4000), 6000)
	assert.equal(retryAfterMs(reply(429)), null)
})

test('a busy provider is asked again, after the wait it names', async () => {
	const {waits, sleep} = fakeSleep()
	const {calls, fetchImpl} = scripted(reply(429, '{"error":{"message":"slow down"}}', {'retry-after': '2'}), reply(529, 'overloaded'), reply(200, 'ok'))
	const res = await retryingFetch(fetchImpl, {sleep})('http://x', {method: 'POST'})
	assert.equal(res.status, 200)
	assert.equal(calls.length, 3)
	assert.equal(waits[0], 2000)
	assert.ok(waits[1] >= 2000 && waits[1] < 2500, 'backs off when no wait is named')
})

test('it gives up after three tries and hands back the last error intact', async () => {
	const {sleep} = fakeSleep()
	const {calls, fetchImpl} = scripted(reply(503, 'a'), reply(503, 'b'), reply(503, '{"error":{"message":"down"}}'))
	const res = await retryingFetch(fetchImpl, {sleep})('http://x', {})
	assert.equal(calls.length, 3)
	assert.equal(res.status, 503)
	assert.equal(await res.text(), '{"error":{"message":"down"}}')
})

test('no retry for a rejected key, a bad request, an empty account, a long wait or x-should-retry: false', async () => {
	const once = async (res) => {
		const {calls, fetchImpl} = scripted(res, reply(200))
		const out = await retryingFetch(fetchImpl, {sleep: async () => assert.fail('should not wait')})('http://x', {})
		assert.equal(calls.length, 1)
		return out
	}
	await once(reply(401))
	await once(reply(400))
	const quota = await once(reply(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'))
	assert.match(await quota.text(), /quota/)
	await once(reply(429, '', {'retry-after': '120'}))
	await once(reply(529, '', {'x-should-retry': 'false'}))
})

test('a dropped connection is retried; a refused one is not', async () => {
	const {sleep} = fakeSleep()
	const reset = Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}})
	const {calls, fetchImpl} = scripted(reset, reply(200))
	assert.equal((await retryingFetch(fetchImpl, {sleep})('http://x', {})).status, 200)
	assert.equal(calls.length, 2)
	const refused = Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
	await assert.rejects(() => retryingFetch(scripted(refused).fetchImpl, {sleep})('http://x', {}), /fetch failed/)
})

test('stopping the turn while waiting stops the retry', async () => {
	const ctl = new AbortController()
	const {fetchImpl, calls} = scripted(reply(503), reply(200))
	const pending = retryingFetch(fetchImpl)('http://x', {signal: ctl.signal})
	setTimeout(() => ctl.abort(), 10)
	await assert.rejects(pending, (e) => e.name === 'AbortError')
	assert.equal(calls.length, 1)
})

test('a chat turn survives a 429 and an overloaded stream, and shows the answer once', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'arc-'))
	const {waits, sleep} = fakeSleep()
	const {calls, fetchImpl} = scripted(
		reply(429, '', {'retry-after': '1'}),
		() => sse([{type: 'error', error: {type: 'overloaded_error', message: 'Overloaded'}}]),
		() => sse([
			{type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
			{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hello'}},
			{type: 'content_block_stop', index: 0},
			{type: 'message_delta', delta: {stop_reason: 'end_turn'}},
			{type: 'message_stop'},
		]),
	)
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, sleep, runProcedure: async () => null})
		await asst.keys.add(OWNER, {provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5'})
		const events = []
		const out = await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(calls.length, 3)
		assert.equal(waits[0], 1000)
		assert.deepEqual(events.map((e) => e.event), ['speaker', 'text', 'done'])
		const saved = JSON.parse(await readFile(join(dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8'))
		assert.deepEqual(saved.messages.map((m) => m.content), ['hi', 'Hello'])
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('an overloaded stream that never recovers ends the turn with its error', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'arc-'))
	const {sleep} = fakeSleep()
	const over = () => sse([{type: 'error', error: {type: 'overloaded_error', message: 'Overloaded'}}])
	const {calls, fetchImpl} = scripted(over, over, over, over)
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, sleep, runProcedure: async () => null})
		await asst.keys.add(OWNER, {provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5'})
		const events = []
		const out = await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(calls.length, 3)
		assert.deepEqual(events, [{event: 'error', data: {message: 'Overloaded', conversationId: out.conversationId}}])
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('Anthropic requests mark the tools, the system prompt and the chat for caching', async () => {
	let body
	const fetchImpl = async (_url, init) => {
		body = JSON.parse(init.body)
		return sse([{type: 'message_stop'}])
	}
	const tools = ['a', 'b'].map((name) => ({type: 'function', function: {name, description: name, parameters: {type: 'object', properties: {}}}}))
	for await (const _ of streamAnthropic({apiKey: 'k', model: 'm', messages: [{role: 'system', content: 'sys'}, {role: 'user', content: 'hi'}], tools, fetchImpl}));
	assert.equal(body.tools[0].cache_control, undefined)
	assert.deepEqual(body.tools[1].cache_control, {type: 'ephemeral'})
	assert.deepEqual(body.system, [{type: 'text', text: 'sys', cache_control: {type: 'ephemeral'}}])
	assert.deepEqual(body.cache_control, {type: 'ephemeral'})
	const marks = JSON.stringify(body).match(/cache_control/g).length
	assert.ok(marks <= 4, 'at most four breakpoints')
	for await (const _ of streamAnthropic({apiKey: 'k', model: 'm', messages: [{role: 'user', content: 'hi'}], tools: [], fetchImpl}));
	assert.equal(body.system, undefined)
	assert.equal(body.tools, undefined)
	assert.deepEqual(body.cache_control, {type: 'ephemeral'})
})
