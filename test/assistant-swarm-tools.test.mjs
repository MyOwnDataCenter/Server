import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {cardFor, namesFromInventory} from '../omarchyd/assistant/loop.mjs'
import {READ_TOOLS, WRITE_TOOLS, lookupTool, toolsFor, writeTool} from '../omarchyd/assistant/tools.mjs'
import {createConnector} from '../omarchyd/connector.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

describe('assistant swarm fleet tools', () => {
	test('every swarm read and write tool is owner-only and hidden from members', () => {
		const ownerNames = new Set(toolsFor('owner').map((t) => t.name))
		const memberNames = new Set(toolsFor('member').map((t) => t.name))

		const expectedReads = [
			'swarm_list',
			'swarm_alerts',
			'swarm_history',
			'swarm_storage_status',
			'swarm_storage_disks',
			'swarm_storage_pools',
			'swarm_services_list',
			'swarm_service_logs',
			'swarm_files_list',
			'swarm_apps_list',
			'swarm_backups_status',
		]
		const expectedWrites = [
			'swarm_action',
			'swarm_power',
			'swarm_wake',
			'swarm_update_connector',
			'swarm_update_all_connectors',
			'swarm_storage_mount',
			'swarm_storage_unmount',
			'swarm_storage_scrub',
			'swarm_storage_setSleep',
			'swarm_service_control',
			'swarm_app_control',
			'swarm_backup_run',
			'swarm_fleet_action',
			'swarm_rename',
		]

		for (const name of expectedReads) {
			assert.ok(lookupTool(name), `missing read tool ${name}`)
			assert.ok(ownerNames.has(name), `owner missing ${name}`)
			assert.ok(!memberNames.has(name), `member must not see ${name}`)
		}
		for (const name of expectedWrites) {
			assert.ok(writeTool(name), `missing write tool ${name}`)
			assert.ok(ownerNames.has(name), `owner missing ${name}`)
			assert.ok(!memberNames.has(name), `member must not see ${name}`)
		}
		assert.ok(READ_TOOLS.filter((t) => t.name.startsWith('swarm_')).every((t) => t.ownerOnly === true))
		assert.ok(WRITE_TOOLS.filter((t) => t.name.startsWith('swarm_')).every((t) => t.ownerOnly === true))
	})

	test('cardFor formats human-readable Approve cards for every new swarm write tool', () => {
		const names = namesFromInventory({
			swarm: [
				{id: 'a1', name: 'Studio Mac'},
				{id: 'a2', name: 'Render Box'},
			],
		})
		assert.equal(cardFor('swarm_power', {id: 'a1', name: 'suspend'}, names).title, 'Suspend Studio Mac')
		assert.equal(cardFor('swarm_power', {id: 'a2', name: 'shutdown'}, names).title, 'Shut down Render Box')
		assert.equal(cardFor('swarm_wake', {id: 'a2'}, names).title, 'Wake Render Box')
		assert.equal(cardFor('swarm_update_connector', {id: 'a1'}, names).title, 'Update the connector on Studio Mac')
		assert.equal(cardFor('swarm_update_all_connectors', {}, names).title, 'Update all outdated swarm connectors')
		assert.equal(cardFor('swarm_storage_mount', {id: 'a2', device: '/dev/sdb1'}, names).title, 'Mount /dev/sdb1 on Render Box')
		assert.equal(cardFor('swarm_storage_unmount', {id: 'a2', device: '/dev/sdb1'}, names).title, 'Unmount /dev/sdb1 on Render Box')
		assert.equal(cardFor('swarm_storage_scrub', {id: 'a2', name: 'tank', kind: 'zfs'}, names).title, 'Scrub pool tank on Render Box')
		assert.equal(cardFor('swarm_storage_setSleep', {id: 'a2', device: '/dev/sdb', minutes: 15}, names).detail, '/dev/sdb · 15 min')
		assert.equal(cardFor('swarm_service_control', {id: 'a2', kind: 'container', name: 'ollama', action: 'restart'}, names).title, 'Restart ollama on Render Box')
		assert.equal(cardFor('swarm_app_control', {id: 'a2', appId: 'open-webui', action: 'stop'}, names).title, 'Stop Open Webui on Render Box')
		assert.equal(cardFor('swarm_backup_run', {id: 'a1'}, names).title, 'Back up Studio Mac now')
		const fleet = cardFor('swarm_fleet_action', {ids: ['a1', 'a2'], name: 'theme-set', theme: 'tokyo-night'}, names)
		assert.equal(fleet.title, 'Set Tokyo Night across the swarm')
		assert.equal(fleet.detail, 'Studio Mac, Render Box')
	})

	describe('swarm.fleetAction execution', () => {
		let root, dataDir, tlsDir, c, server, port

		before(async () => {
			root = await mkdtemp(join(os.tmpdir(), 'swarm-fleet-'))
			dataDir = join(root, 'data')
			tlsDir = join(root, 'tls')
			await mkdir(dataDir, {recursive: true})
			await ensureTls({dir: tlsDir})
			c = createConnector({dataDir, tlsDir})
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
			await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
		})

		test('applies fleet theme-set to online manageable nodes and skips offline/unmanageable ones', async () => {
			const p1 = await c.procedures['swarm.pair'].run({manage: true})
			const e1 = await c.enroll({token: p1.token, info: {hostname: 'node-1', os: 'Omarchy'}, abilities: {manage: true}})
			const p2 = await c.procedures['swarm.pair'].run({manage: false})
			const e2 = await c.enroll({token: p2.token, info: {hostname: 'node-2', os: 'Omarchy'}, abilities: {manage: false}})
			const p3 = await c.procedures['swarm.pair'].run({manage: true})
			const e3 = await c.enroll({token: p3.token, info: {hostname: 'node-3', os: 'Omarchy'}, abilities: {manage: true}})

			const calls1 = []
			const ws1 = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${e1.body.id}:${e1.body.key}`}})
			const ws2 = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${e2.body.id}:${e2.body.key}`}})
			await Promise.all([
				new Promise((r, j) => (ws1.once('open', r), ws1.once('error', j))),
				new Promise((r, j) => (ws2.once('open', r), ws2.once('error', j))),
			])
			ws1.on('message', (raw) => {
				const msg = JSON.parse(String(raw))
				if (msg.op === 'call') {
					calls1.push(msg)
					ws1.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: true}))
				}
			})
			await new Promise((r) => setTimeout(r, 60))

			const res = await c.procedures['swarm.fleetAction'].run({name: 'theme-set', theme: 'catppuccin'})
			assert.equal(res.ok.length, 1)
			assert.equal(res.ok[0].id, e1.body.id)
			assert.equal(res.skipped.length, 2)
			assert.ok(res.skipped.some((s) => s.id === e2.body.id && /Manage/i.test(s.reason)))
			assert.ok(res.skipped.some((s) => s.id === e3.body.id && /Offline/i.test(s.reason)))
			assert.equal(res.failed.length, 0)
			assert.equal(calls1[0].name, 'theme-set')
			assert.equal(calls1[0].args.name, 'catppuccin')

			ws1.close()
			ws2.close()
		})
	})
})
