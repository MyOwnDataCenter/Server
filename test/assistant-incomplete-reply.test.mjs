import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'

import {streamChat} from '../omarchyd/assistant/providers.mjs'
import {streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'

const enc = (s) => new TextEncoder().encode(s)
const reply = (text) => ({ok: true, status: 200, body: (async function* () { if (text) yield enc(text) })()})
const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}
const chat = (text) => collect(streamChat({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => reply(text)}))
const sseData = (o) => `data: ${JSON.stringify(o)}\n\n`

test('a chat stream that closes before it finishes is reported as cut off', async () => {
	const out = await chat(sseData({choices: [{delta: {content: 'Half a sent'}}]}))
	assert.equal(out.at(-1).type, 'error')
	assert.match(out.at(-1).message, /cut off/)
})

test('an empty chat stream is reported, not treated as an answer', async () => {
	const out = await chat('')
	assert.deepEqual(out.map((e) => e.type), ['error'])
})

test('an error sent inside a 200 chat stream is shown to the person', async () => {
	const out = await chat(sseData({error: {message: 'rate limit inside stream', code: 429}}))
	assert.deepEqual(out, [{type: 'error', message: 'rate limit inside stream'}])
})

test('a plain JSON completion from a server that ignored stream:true is read as the answer', async () => {
	const out = await chat(JSON.stringify({choices: [{message: {content: 'Hello there'}, finish_reason: 'stop'}]}))
	assert.deepEqual(out, [{type: 'text', text: 'Hello there'}])
})

test('a finished chat stream with a finish reason but no [DONE] is still an answer', async () => {
	const out = await chat(sseData({choices: [{delta: {content: 'Hi'}}]}) + sseData({choices: [{delta: {}, finish_reason: 'stop'}]}))
	assert.deepEqual(out, [{type: 'text', text: 'Hi'}])
})

test('an Anthropic reply that stopped because the chat is too long is an error, not an answer', async () => {
	const ev = (o) => `event: ${o.type}\n${sseData(o)}`
	const body = ev({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}})
		+ ev({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Partial'}})
		+ ev({type: 'content_block_stop', index: 0})
		+ ev({type: 'message_delta', delta: {stop_reason: 'model_context_window_exceeded'}})
		+ ev({type: 'message_stop'})
	const out = await collect(streamAnthropic({baseUrl: 'http://x', apiKey: 'k', model: 'm', messages: [{role: 'user', content: 'hi'}], tools: [], fetchImpl: async () => reply(body)}))
	assert.equal(out.at(-1).type, 'error')
	assert.match(out.at(-1).message, /too long/)
})

test('a turn whose model sent no text and no tool call ends with an error, not a silent done', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'air-'))
	try {
		const body = `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`
		const fetchImpl = async () => ({ok: true, status: 200, text: async () => body, body: (async function* () { yield body })()})
		const accounts = {getUser: (userId) => (userId === 'owner' ? {userId, role: 'owner'} : null)}
		const asst = createAssistant({dataDir, accounts, now: () => 50, fetchImpl, runProcedure: async () => null})
		await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'hello', emit: (e) => events.push(e)})
		assert.equal(events.some((e) => e.event === 'done'), false)
		const error = events.find((e) => e.event === 'error')
		assert.match(error?.data?.message ?? '', /empty answer/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
