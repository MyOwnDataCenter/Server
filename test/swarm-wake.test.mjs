// Wake an offline swarm computer from this server, without a live connector.
import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConnector} from '../omarchyd/connector.mjs'

const abilities = {terminal: false, desktop: false, manage: true, backup: false, storage: false, services: false, files: false, vms: false, containers: false}

const agent = (extra) => ({
	id: 'abc123def456',
	name: 'jules',
	keyHash: 'x'.repeat(64),
	allowed: {...abilities},
	on: {...abilities},
	enrolledAt: 1,
	nics: [{mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1, missingSessions: 0, missingOnlineMs: 0, countedSession: 0}],
	...extra,
})

async function open(agents, sendWol) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-wake-'))
	await writeFile(join(root, 'swarm.json'), JSON.stringify({agents}))
	const c = createConnector({dataDir: root, tlsDir: root, sendWol})
	return {c, root}
}

test('swarm.wake sends remembered addresses while the computer is off', async () => {
	const sent = []
	const {c, root} = await open([agent()], async (mac) => sent.push(mac))
	try {
		const out = await c.procedures['swarm.wake'].run({id: 'abc123def456'})
		assert.equal(out.ok, true)
		assert.equal(out.sent, true)
		assert.equal(out.mac, 'aa:bb:cc:dd:ee:01')
		assert.deepEqual(sent, ['aa:bb:cc:dd:ee:01'])
		const [row] = await c.procedures['swarm.list'].run()
		assert.deepEqual(row.macs, ['aa:bb:cc:dd:ee:01'])
		assert.deepEqual(row.info?.macs, ['aa:bb:cc:dd:ee:01'])
		assert.equal(row.online, false)
	} finally {
		c.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('swarm.wake needs Manage and a remembered NIC', async () => {
	const {c, root} = await open([
		agent({id: 'abc123def456', on: {manage: false}, allowed: {manage: false}}),
		agent({id: 'bbbbbbbbbbbb', name: 'blank', nics: []}),
	], async () => {})
	try {
		await assert.rejects(() => c.procedures['swarm.wake'].run({id: 'abc123def456'}), /Managing/)
		await assert.rejects(() => c.procedures['swarm.wake'].run({id: 'bbbbbbbbbbbb'}), /remembered/)
		await assert.rejects(() => c.procedures['swarm.wake'].run({id: 'missing'}), /isn’t in your swarm/)
	} finally {
		c.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('swarm.wake fails when this server cannot send and nobody else is on', async () => {
	const {c, root} = await open([agent()], async () => { throw new Error('no route') })
	try {
		await assert.rejects(() => c.procedures['swarm.wake'].run({id: 'abc123def456'}), /wake packet/)
	} finally {
		c.close()
		await rm(root, {recursive: true, force: true})
	}
})
