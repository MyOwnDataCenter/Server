// A browser that stops reading must not make the server queue its desktop frames or shell output
// without limit (#571). A screen's source is paused while the browser is behind (a big burst is
// normal) and dropped only when the browser reads nothing for a while; a shell is cut off at 1 MiB.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createTerminalSessions} from '../omarchyd/terminal.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

describe('desktop and VM screens', () => {
	let root, d, vnc, auth, closed, written
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchy-bp-'))
		const accounts = await openAccounts(join(root, 'd'))
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		closed = false
		written = 0
		vnc = net.createServer((sock) => {
			sock.on('error', () => {})
			sock.on('close', () => (closed = true))
			const chunk = Buffer.alloc(64 * 1024, 1)
			const pump = () => {
				while (!sock.destroyed && written < 400 * 1024 * 1024) {
					written += chunk.length
					if (!sock.write(chunk)) return sock.once('drain', pump)
				}
			}
			sock.write('RFB 003.008\n')
			pump()
		})
		await new Promise((r) => vnc.listen(0, '127.0.0.1', r))
		d = await startOmarchyd({port: 0, dataDir: join(root, 'd'), home: root, desktopVncPort: vnc.address().port, viewerStallMs: 1500, desktopVncSocket: join(root, 'no-such.sock')})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
	})
	after(async () => {
		vnc.close()
		await d?.close()
		await rm(root, {recursive: true, force: true})
	})

	test('a viewer that stops reading holds the screen back, then is cut off, instead of the frames queueing in memory', async () => {
		const res = await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: auth, body: JSON.stringify({target: 'machines'})})).json()
		const ws = new WebSocket(`${d.url.replace('http', 'ws')}/machines/console?machineId=desktop&ticket=${res.result.data}`, ['binary'])
		ws.on('error', () => {})
		await new Promise((r, j) => (ws.once('message', r), ws.once('error', j)))
		ws._socket.pause()
		await wait(700)
		assert.equal(closed, false, 'a short wait is not a stall')
		const held = written
		assert.ok(held < 64 * 1024 * 1024, `the server stopped taking frames (${held} bytes written)`)
		for (let i = 0; i < 40 && !closed; i++) await wait(100)
		ws.terminate()
		assert.equal(closed, true, 'the source was dropped once the viewer read nothing for the stall time')
		assert.ok(written < 64 * 1024 * 1024, `the server stopped taking frames (${written} bytes written)`)
	})
})

describe('persistent shells', {skip: spawnSync('sh', ['-c', 'command -v script']).status === 0 ? false : 'script is not installed'}, () => {
	test('a socket that stops reading is dropped, a healthy one keeps getting the output', async () => {
		const sessions = createTerminalSessions()
		const fake = (buffered) =>
			Object.assign(new EventEmitter(), {
				OPEN: 1,
				readyState: 1,
				bufferedAmount: buffered,
				sent: 0,
				terminated: false,
				send(_data, opts) {if (opts?.binary) this.sent++},
				terminate() {
					this.terminated = true
					this.readyState = 3
					this.emit('close')
				},
				close() {
					this.readyState = 3
					this.emit('close')
				},
			})
		const stalled = fake(2 * 1024 * 1024)
		const healthy = fake(0)
		const shell = {command: ['sh', '-c', 'sleep 0.3; echo hello; sleep 1'], cwd: '/tmp', home: '/tmp'}
		await sessions.attach(stalled, {userId: 'owner', appId: '', cols: 80, rows: 24, fresh: true, shell})
		await sessions.attach(healthy, {userId: 'owner', appId: '', cols: 80, rows: 24, shell})
		await wait(800)
		assert.equal(stalled.terminated, true)
		assert.equal(stalled.sent, 0)
		assert.equal(healthy.terminated, false)
		assert.ok(healthy.sent > 0)
		healthy.emit('message', '\x03', false)
		sessions.closeAll?.()
	})
})
