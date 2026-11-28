// A connection that never sends a byte belongs to no http server yet, so nothing but the front
// door can end it. It closes it after a while instead of keeping it open for ever.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {test} from 'node:test'

import {dualProtocolServer} from '../omarchyd/tls.mjs'

test('a connection that stays silent is closed, a talking one is served', async () => {
	const server = http.createServer((_req, res) => res.end('ok'))
	const front = dualProtocolServer(server, () => null, {firstByteMs: 150})
	await new Promise((r) => front.listen(0, '127.0.0.1', r))
	const {port} = front.address()
	try {
		const silent = net.connect(port, '127.0.0.1')
		const closed = new Promise((resolve) => silent.once('close', () => resolve(true)))
		const verdict = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 1500))])
		silent.destroy()
		assert.equal(verdict, true, 'the silent connection was closed')
		const res = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(await res.text(), 'ok')
	} finally {
		front.destroyConnections()
		await new Promise((r) => front.close(r))
	}
})
