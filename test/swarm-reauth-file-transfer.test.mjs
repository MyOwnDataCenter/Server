import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createConnector} from '../omarchyd/connector.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

const allowed = {terminal: true, files: true}

test('adding a computer again while a file is being copied from it ends the copy and keeps the new key', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-reauth-file-'))
	const dataDir = join(root, 'data')
	const tlsDir = join(root, 'tls')
	await mkdir(dataDir, {recursive: true})
	await ensureTls({dir: tlsDir})
	const c = createConnector({dataDir, tlsDir, connectorDir: join(root, 'connector')})
	const server = http.createServer()
	server.on('upgrade', (req, socket, head) => c.upgradeAgent(req, socket, head))
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	let ws
	t.after(async () => {
		ws?.terminate()
		c.close()
		await new Promise((r) => server.close(r))
		await rm(root, {recursive: true, force: true})
	})

	const info = {hostname: 'box1', os: 'Arch'}
	const paired = await c.procedures['swarm.pair'].run(allowed)
	const {id, key} = (await c.enroll({token: paired.token, info, abilities: allowed})).body
	ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/connector/ws`, {headers: {authorization: `Bearer ${id}:${key}`}})
	await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))
	const opened = new Promise((resolve) => ws.on('message', (raw) => JSON.parse(String(raw)).op === 'open' && resolve()))
	ws.send(JSON.stringify({op: 'hello', info, abilities: allowed}))
	await new Promise((r) => setTimeout(r, 80))

	// A copy is under way: the computer has been asked for the file and has not answered yet.
	const copying = c.files.pull(id, 'Documents/big.iso', async () => {}).then(() => null, (error) => error)
	await opened

	const again = await c.procedures['swarm.reauthorize'].run({id, ...allowed})
	const res = await c.enroll({token: again.token, info, abilities: allowed})
	assert.equal(res.status, 200)
	assert.equal(res.body.reauthorized, true)
	assert.notEqual(res.body.key, key)

	const error = await copying
	assert.match(String(error?.message), /Permissions updated/)
})
