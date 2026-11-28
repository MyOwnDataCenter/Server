import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {createMachines} from '../omarchyd/machines.mjs'

const wellFormed = (s) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

test('a chat title cut at its limit never splits an emoji', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'emo-'))
	try {
		const c = createConversations({dataDir, now: () => 1})
		const row = await c.create('owner', {keyId: 'k', title: 'x'.repeat(47) + '😀 rest'})
		assert.equal(wellFormed(row.title), true, JSON.stringify(row.title))
		assert.equal(row.title, 'x'.repeat(47) + '😀')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a machine name of 33 emoji is 33 characters and is accepted', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'emo-m-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines', 'vms'), {recursive: true})
	const catalog = join(root, 'catalog.json')
	await writeFile(catalog, JSON.stringify({version: 1, images: []}))
	const id = 'a1b2c3d4'
	const dir = join(dataDir, 'machines', 'vms', id)
	const rec = {
		id, vmid: 100, name: 'Box', osId: 'testos-amd64', sockets: 1, cores: 2, cpuType: 'host', memoryMb: 1024, memoryGb: 1, diskSizeGb: 20,
		mac: '52:54:00:11:22:33', portForwards: [], createdAt: 1760000000000, boot: ['disk0'], options: {},
		cloudInit: {username: 'chris', hostname: 'box', sshKeys: []},
		layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: join(dir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 20}]},
	}
	await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))
	const m = createMachines({
		dataDir,
		catalogUrl: `file://${catalog}`,
		fetchImpl: async () => { throw new Error('no network in test') },
		run: async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? ' Id   Name   State\n------------------\n' : ''),
		kvmDevice: join(root, 'kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
	})
	await m.ready
	const name = '😀'.repeat(33)
	await m.procedures['machines.updateOptions'].run({id, name})
	const listed = await m.procedures['machines.list'].run()
	assert.equal(listed.find((x) => x.id === id).name, name)
})
