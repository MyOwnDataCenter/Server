import assert from 'node:assert/strict'
import {test} from 'node:test'

import {streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'
import {streamChat, streamResponses} from '../omarchyd/assistant/providers.mjs'

// A server that ends its lines with CRLF, delivered so a chunk ends between the \r and the \n.
const crlfStream = (events) => {
	const text = events.map((e) => `${e.join('\r\n')}\r\n\r\n`).join('')
	const pieces = text.split(/(?<=\r)/)
	return {
		ok: true,
		status: 200,
		text: async () => text,
		body: (async function* () {
			for (const p of pieces) yield Buffer.from(p)
		})(),
	}
}

const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('Responses events split between \\r and \\n are still read', async () => {
	const res = crlfStream([
		['event: response.output_text.delta', `data: ${JSON.stringify({type: 'response.output_text.delta', delta: 'Hello'})}`],
		['event: response.completed', `data: ${JSON.stringify({type: 'response.completed'})}`],
	])
	const out = await collect(streamResponses({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => res}))
	assert.deepEqual(out, [{type: 'text', text: 'Hello'}])
})

test('Anthropic events split between \\r and \\n are still read', async () => {
	const res = crlfStream([
		['event: content_block_delta', `data: ${JSON.stringify({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hello'}})}`],
		['event: message_delta', `data: ${JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}})}`],
		['event: message_stop', `data: ${JSON.stringify({type: 'message_stop'})}`],
	])
	const out = await collect(streamAnthropic({apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => res}))
	assert.deepEqual(out, [{type: 'text', text: 'Hello'}])
})

test('Chat Completions events split between \\r and \\n are still read', async () => {
	const res = crlfStream([
		[`data: ${JSON.stringify({choices: [{delta: {content: 'Hello'}}]})}`],
		[`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}`],
		['data: [DONE]'],
	])
	const out = await collect(streamChat({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => res}))
	assert.deepEqual(out, [{type: 'text', text: 'Hello'}])
})
