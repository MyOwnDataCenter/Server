import assert from 'node:assert/strict'
import {test} from 'node:test'

import {forgetMcpTools, listMcpTools} from '../omarchyd/assistant/mcp.mjs'

// An app that accepts the connection and never answers.
const hung = (opts) =>
	new Promise((_resolve, reject) => {
		const stop = () => reject(Object.assign(new Error('The operation was aborted'), {name: 'AbortError'}))
		if (opts.signal?.aborted) return stop()
		opts.signal?.addEventListener('abort', stop, {once: true})
	})

test('an app that never answers its tool list does not hold up the turn', async () => {
	const url = 'http://127.0.0.1:19001/mcp'
	forgetMcpTools([url])
	const started = Date.now()
	const tools = await listMcpTools({url, transport: 'http', fetchImpl: (_u, opts) => hung(opts), timeoutMs: 60})
	assert.deepEqual(tools, [])
	assert.ok(Date.now() - started < 2000)
})

test('stopping the turn still stops the listing', async () => {
	const url = 'http://127.0.0.1:19002/mcp'
	forgetMcpTools([url])
	const ac = new AbortController()
	const pending = listMcpTools({url, transport: 'http', fetchImpl: (_u, opts) => hung(opts), timeoutMs: 60_000, signal: ac.signal})
	ac.abort()
	await assert.rejects(pending, (e) => e.name === 'AbortError')
})
