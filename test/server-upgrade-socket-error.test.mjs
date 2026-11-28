// A browser that drops a WebSocket upgrade while the server is still working on it (checking the
// session with omarchyd, or waiting for an app to answer) must not end the server process.
import assert from 'node:assert/strict'
import net from 'node:net'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const json = (data) => new Response(JSON.stringify({result: {data}}), {headers: {'content-type': 'application/json'}})

async function startTouch(fetchImpl) {
	const dir = await mkdtemp(join(tmpdir(), 'upgrade-reset-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: 'http://127.0.0.1:9'})
	await store.putSession('sidsid', {mode: 'legacy', accountId: 'a', accessToken: 't'})
	const app = createApp({store, fetchImpl, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	app.attachConsole(server)
	return {
		app,
		port: server.address().port,
		close: async () => {
			app.closeRelays()
			await new Promise((resolve) => server.close(resolve))
			await rm(dir, {recursive: true, force: true})
		},
	}
}

// Send the upgrade, reset the connection while the server is still busy, and return what went uncaught.
async function dropUpgrade(port, request) {
	const saved = process.listeners('uncaughtException')
	const uncaught = []
	process.removeAllListeners('uncaughtException')
	process.on('uncaughtException', (error) => uncaught.push(error))
	try {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
		socket.on('error', () => {})
		await new Promise((resolve) => setTimeout(resolve, 150))
		socket.resetAndDestroy()
		await new Promise((resolve) => setTimeout(resolve, 700))
		return uncaught
	} finally {
		process.removeAllListeners('uncaughtException')
		for (const fn of saved) process.on('uncaughtException', fn)
	}
}

const upgrade = (path, host, cookie) =>
	`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}\r\nCookie: ${cookie}\r\n\r\n`

test('a terminal upgrade reset while omarchyd is still answering does not end the server', async () => {
	const touch = await startTouch(async () => {
		await new Promise((resolve) => setTimeout(resolve, 500))
		return json({role: 'owner'})
	})
	try {
		const uncaught = await dropUpgrade(touch.port, upgrade('/api/terminal?cols=80&rows=24', `127.0.0.1:${touch.port}`, 'omarchy_server_sid=sidsid'))
		assert.deepEqual(uncaught.map((e) => e.code), [])
	} finally {
		await touch.close()
	}
})

test('an app relay upgrade reset while the app is still answering does not end the server', async () => {
	// An app that accepts the connection and never answers.
	const stall = net.createServer((s) => s.on('error', () => {}))
	await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve))
	const touch = await startTouch(async () => json([{id: 'stall', port: stall.address().port, path: '/'}]))
	try {
		const open = await (await fetch(`http://127.0.0.1:${touch.port}/api/app-open?app=stall`, {headers: {cookie: 'omarchy_server_sid=sidsid'}})).json()
		const relayPort = Number(new URL(open.url).port)
		const uncaught = await dropUpgrade(relayPort, upgrade('/ws', `127.0.0.1:${relayPort}`, 'omarchy_server_sid=sidsid'))
		assert.deepEqual(uncaught.map((e) => e.code), [])
	} finally {
		await touch.close()
		stall.close()
	}
})
