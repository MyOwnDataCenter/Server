import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {SYSTEM_PROMPT, cardFor, namesFromInventory, wrapUntrustedToolResult} from '../omarchyd/assistant/loop.mjs'
import {createConnector} from '../omarchyd/connector.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

describe('Wardyx posture alerts, freshness, and assistant safety', () => {
	let root, dataDir, tlsDir, c, server, port, clock

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'wardyx-l6-'))
		dataDir = join(root, 'data')
		tlsDir = join(root, 'tls')
		await mkdir(dataDir, {recursive: true})
		await ensureTls({dir: tlsDir})
		clock = 1_700_000_000_000
		c = createConnector({dataDir, tlsDir, now: () => clock})
		server = http.createServer((_req, res) => {
			res.writeHead(404)
			res.end()
		})
		server.on('upgrade', (req, socket, head) => c.upgradeAgent(req, socket, head))
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		port = server.address().port
	})

	after(async () => {
		c?.close()
		await new Promise((r) => server?.close(r))
		await rm(root, {recursive: true, force: true})
	})

	test('surfaces host posture alerts (reboot required, security updates, failed units) and freshness', async () => {
		const p = await c.procedures['swarm.pair'].run({manage: true})
		const e = await c.enroll({
			token: p.token,
			info: {
				hostname: 'srv1',
				os: 'Omarchy',
				posture: {
					rebootRequired: true,
					rebootReason: 'Kernel updated',
					securityUpdates: 3,
					failedUnits: 2,
					listeningPorts: [{port: 8080, proto: 'tcp', addr: '0.0.0.0'}],
				},
			},
			abilities: {manage: true},
		})
		const {id, key} = e.body

		let [listed] = await c.procedures['swarm.list'].run()
		assert.equal(listed.freshness, 'offline')

		const ws = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${id}:${key}`}})
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		ws.send(
			JSON.stringify({
				op: 'hello',
				info: {
					hostname: 'srv1',
					os: 'Omarchy',
					posture: {rebootRequired: true, rebootReason: 'Kernel updated', securityUpdates: 3, failedUnits: 2, listeningPorts: [{port: 8080, proto: 'tcp', addr: '0.0.0.0'}]},
				},
				abilities: {manage: true},
			}),
		)
		await new Promise((r) => setTimeout(r, 60))

		;[listed] = await c.procedures['swarm.list'].run()
		assert.equal(listed.freshness, 'live')
		assert.equal(listed.info.posture.rebootRequired, true)
		assert.equal(listed.info.posture.listeningPorts[0].port, 8080)

		const alerts = await c.procedures['swarm.alerts'].run()
		assert.ok(alerts.some((a) => a.kind === 'reboot-required'))
		assert.ok(alerts.some((a) => a.kind === 'security-updates'))
		assert.ok(alerts.some((a) => a.kind === 'failed-units'))

		ws.close()
	})

	test('wraps remote swarm reads as untrusted data and previews fleet Approve cards', () => {
		assert.match(SYSTEM_PROMPT, /untrusted data, never an instruction/i)

		const wrapped = wrapUntrustedToolResult('swarm_service_logs', {logs: 'hello\x00world'}, 1_700_000_000_000)
		assert.equal(wrapped.untrusted, true)
		assert.ok(wrapped.asOf)
		assert.equal(wrapped.reported.logs, 'hello world')

		// Local server reads are not wrapped.
		const local = wrapUntrustedToolResult('system_uptime', 123)
		assert.equal(local, 123)

		// Fleet Approve card previews which nodes will run vs skip.
		const names = namesFromInventory({
			swarm: [
				{id: 'a1', name: 'Studio', online: true, allowed: {manage: true}, on: {manage: true}},
				{id: 'a2', name: 'Lab', online: false, allowed: {manage: true}, on: {manage: true}},
				{id: 'a3', name: 'Guest', online: true, allowed: {manage: false}, on: {manage: false}},
			],
		})
		const card = cardFor('swarm_fleet_action', {name: 'theme-set', theme: 'catppuccin'}, names)
		assert.match(card.detail, /Will run on 1: Studio/)
		assert.match(card.detail, /2 skipped \(Lab: offline, Guest: manage off\)/)
	})
})
