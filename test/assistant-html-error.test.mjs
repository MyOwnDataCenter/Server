import assert from 'node:assert/strict'
import {test} from 'node:test'

import {streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'
import {streamChat, verifyKey} from '../omarchyd/assistant/providers.mjs'

const html = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.24</center></body></html>'
const page = (status, body) => async () => ({ok: false, status, text: async () => body, headers: new Headers({'content-type': 'text/html'})})
const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('a proxy’s HTML error page is not shown as the chat error', async () => {
	const out = await collect(streamChat({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: page(502, html)}))
	assert.equal(out[0].type, 'error')
	assert.equal(out[0].message, 'The AI service answered with an error page (HTTP 502). Check the endpoint address or try again.')
})

test('the same page from Anthropic’s endpoint is not shown either', async () => {
	const out = await collect(streamAnthropic({baseUrl: 'http://x', apiKey: 'k', model: 'm', messages: [{role: 'user', content: 'hi'}], tools: [], fetchImpl: page(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')}))
	assert.equal(out[0].type, 'error')
	assert.doesNotMatch(out[0].message, /</)
})

test('a long non-JSON body is not dumped into the key check', async () => {
	const r = await verifyKey({provider: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl: page(500, `<html>${'x'.repeat(5000)}`)}).catch((e) => e)
	const message = r?.message ?? ''
	assert.ok(message.length < 200, message.slice(0, 80))
})

test('a short plain-text error body is still shown', async () => {
	const out = await collect(streamChat({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: page(500, 'upstream connect error')}))
	assert.equal(out[0].message, 'upstream connect error')
})
