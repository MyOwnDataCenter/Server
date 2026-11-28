import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {responsesInput, streamResponses} from '../omarchyd/assistant/providers.mjs'

const SECRET = 'sk-test-secret-wxyz'
const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : null)})
const sse = (events) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		for (const e of events) yield new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	})(),
})
const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body)})
const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('responsesInput moves system text to instructions and pairs tool calls with their results', () => {
	const {instructions, input} = responsesInput([
		{role: 'system', content: 'Be brief'},
		{role: 'user', content: 'disk?'},
		{role: 'assistant', content: null, tool_calls: [{id: 'call_1', type: 'function', function: {name: 'system_disk', arguments: '{}'}}]},
		{role: 'tool', tool_call_id: 'call_1', content: '{"free":10}'},
	])
	assert.equal(instructions, 'Be brief')
	assert.deepEqual(input, [
		{role: 'user', content: 'disk?'},
		{type: 'function_call', call_id: 'call_1', name: 'system_disk', arguments: '{}'},
		{type: 'function_call_output', call_id: 'call_1', output: '{"free":10}'},
	])
})

test('streamResponses posts to /responses and yields text, then a tool call built from argument deltas', async () => {
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, opts, body: JSON.parse(opts.body)})
		return sse([
			{type: 'response.created'},
			{type: 'response.output_text.delta', delta: 'Checking '},
			{type: 'response.output_text.delta', delta: 'disk'},
			{type: 'response.output_item.added', item: {type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'system_disk', arguments: ''}},
			{type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"pa'},
			{type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'th":"/"}'},
			{type: 'response.output_item.done', item: {type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'system_disk'}},
			{type: 'response.completed'},
		])
	}
	const tools = [{type: 'function', function: {name: 'system_disk', description: 'Disk use', parameters: {type: 'object', properties: {}}}}]
	const out = await collect(streamResponses({baseUrl: 'http://box/v1/', apiKey: SECRET, model: 'gpt-5.5', messages: [{role: 'system', content: 'sys'}, {role: 'user', content: 'hi'}], tools, fetchImpl}))
	assert.equal(seen[0].url, 'http://box/v1/responses')
	assert.equal(seen[0].opts.headers.authorization, `Bearer ${SECRET}`)
	assert.equal(seen[0].body.instructions, 'sys')
	assert.equal(seen[0].body.store, false)
	assert.equal(seen[0].body.stream, true)
	assert.deepEqual(seen[0].body.tools, [{type: 'function', name: 'system_disk', description: 'Disk use', parameters: {type: 'object', properties: {}}}])
	assert.equal(out.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Checking disk')
	assert.deepEqual(out.filter((e) => e.type === 'tool'), [{type: 'tool', id: 'call_9', name: 'system_disk', arguments: '{"path":"/"}'}])
	assert.equal(out.some((e) => e.type === 'error'), false)
})

test('streamResponses takes an access token, as a ChatGPT sign-in would pass it', async () => {
	let seenUrl
	let auth
	const fetchImpl = async (url, opts) => {
		seenUrl = url
		auth = opts.headers.authorization
		return sse([{type: 'response.completed'}])
	}
	await collect(streamResponses({accessToken: 'tok', model: 'm', messages: [], tools: [], fetchImpl}))
	assert.equal(seenUrl, 'https://api.openai.com/v1/responses')
	assert.equal(auth, 'Bearer tok')
})

test('streamResponses reports refusals, failures and a cut-off stream as errors', async () => {
	const run = (fetchImpl) => collect(streamResponses({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl}))
	assert.deepEqual(await run(async () => json(401, {error: {message: 'Incorrect API key'}})), [{type: 'error', message: 'Incorrect API key', status: 401}])
	const failed = await run(async () => sse([{type: 'response.failed', response: {error: {message: 'model overloaded'}}}]))
	assert.equal(failed.at(-1).message, 'model overloaded')
	const cut = await run(async () => sse([{type: 'response.output_text.delta', delta: 'Hal'}]))
	assert.equal(cut.at(-1).type, 'error')
	assert.match(cut.at(-1).message, /cut off/)
})

test('OpenAI keys default to Responses; others to Chat Completions; the owner can switch', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ar-'))
	try {
		const keys = createKeyStore({dataDir})
		const openai = await keys.add(OWNER, {provider: 'openai', apiKey: SECRET, model: 'gpt-5.5'})
		assert.equal(openai.api, 'responses')
		const grok = await keys.add(OWNER, {provider: 'spacexai', apiKey: SECRET, model: 'grok-4.7'})
		assert.equal(grok.api, 'chat')
		const local = await keys.add(OWNER, {provider: 'openai-compatible', apiKey: '', model: 'qwen3', baseUrl: 'http://127.0.0.1:8000', api: 'responses'})
		assert.equal(local.api, 'responses')
		assert.equal((await keys.update(OWNER, {id: openai.id, api: 'chat'})).api, 'chat')
		assert.equal((await keys.update(OWNER, {id: openai.id, api: 'bogus'})).api, 'chat')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a Responses key streams its turn through /responses and saves the reply', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ar-'))
	const urls = []
	const fetchImpl = async (url) => {
		urls.push(url)
		return sse([{type: 'response.output_text.delta', delta: 'Hello'}, {type: 'response.completed'}])
	}
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, runProcedure: async (name) => (name === 'system.getHostname' ? 'box' : null)})
		await asst.keys.add(OWNER, {provider: 'openai', apiKey: SECRET, model: 'gpt-5.5'})
		const events = []
		const out = await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(urls, ['https://api.openai.com/v1/responses'])
		assert.deepEqual(events.map((e) => e.event), ['speaker', 'text', 'done'])
		const saved = JSON.parse(await readFile(join(dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8'))
		assert.equal(saved.messages.at(-1).content, 'Hello')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
