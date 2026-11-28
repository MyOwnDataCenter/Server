import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

async function open(t) {
	const root = await mkdtemp(join(os.tmpdir(), 'mit-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines', 'vms'), {recursive: true})
	const catalog = join(root, 'catalog.json')
	await writeFile(catalog, JSON.stringify({version: 1, images: []}))
	const id = 'a1b2c3d4'
	const dir = join(dataDir, 'machines', 'vms', id)
	const rec = {
		id, vmid: 100, name: 'Box', osId: 'testos-amd64', sockets: 1, cores: 1, cpuType: 'host', memoryMb: 1024, memoryGb: 1, diskSizeGb: 20,
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
	return {id, run: (name, input) => m.procedures[name].run(input), list: () => m.procedures['machines.list'].run()}
}

const refused = (promise) => assert.rejects(promise, (e) => e.code === 'BAD_REQUEST')

test('a machine can’t be renamed to a value that is not text', async (t) => {
	const {id, run, list} = await open(t)
	for (const name of [null, {}, ['a', 'b'], 5, true]) await refused(run('machines.updateOptions', {id, name}))
	assert.equal((await list()).find((x) => x.id === id).name, 'Box')
})

test('start order and delay must be real numbers, not true or a list', async (t) => {
	const {id, run} = await open(t)
	await refused(run('machines.updateOptions', {id, startupOrder: true}))
	await refused(run('machines.updateOptions', {id, startupDelay: []}))
	await refused(run('machines.updateOptions', {id, startupDelay: true}))
	assert.equal(await run('machines.updateOptions', {id, startupOrder: 3, startupDelay: 10}).then(() => true), true)
})

test('a disk size must be a number', async (t) => {
	const {id, run} = await open(t)
	for (const sizeGb of [true, [5], ' 5 ']) await refused(run('machines.addDisk', {id, sizeGb}))
})

test('the network link setting must be true or false, not the text "false"', async (t) => {
	const {id, run} = await open(t)
	await refused(run('machines.updateHardware', {id, linkDown: 'false'}))
})
