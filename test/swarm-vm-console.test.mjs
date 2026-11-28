import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const box = {id: 'abcd1234', name: 'Box', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 8, mac: '52:54:00:11:22:33', cloudInit: {username: 'chris', hostname: 'box'}, layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: 'disk.qcow2', device: 'disk', bus: 'virtio', format: 'qcow2'}, {id: 'seed', role: 'seed', file: 'seed.iso', device: 'cdrom', bus: 'sata', format: 'raw'}]}, options: {agent: true}, boot: ['disk0'], portForwards: []}

async function readyWithBox(calls, {offline = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-box-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: !offline, allowed: {vms: true}, on: {vms: true}}],
			progress: () => null,
			call: async (id, name, args) => {
				if (offline) throw new Error('offline')
				calls.push({id, name, args})
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch: 'amd64', threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga']}
				return 'ok'
			},
		},
	})
	await machines.ready
	return {machines, root}
}

test('vncSocket for a remote guest names the agent and does not touch a local path', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	const target = await machines.vncSocket('abcd1234')
	assert.deepEqual(target, {agentId: 'abc123abc123', guest: 'abcd1234'})
	assert.equal(calls.some((c) => c.name === 'vm-vnc-path'), false)
})

test('vncSocket for a local guest whose socket is absent says it isn’t running', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-local-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [{id: 'deadbeef', name: 'Local', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8}]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
	})
	await machines.ready
	await assert.rejects(
		machines.vncSocket('deadbeef'),
		(e) => e.code === 'PRECONDITION_FAILED' && /isn’t running/.test(e.message) && !/another computer/.test(e.message),
	)
	await rm(root, {recursive: true, force: true})
})

test('the console upgrade branches on agentId', async () => {
	const text = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	assert.match(text, /openChannel\(target\.agentId, 'vnc', ws, \{guest: target\.guest\}\)/)
	assert.doesNotMatch(text, /vncSocket\(machineId\)\.catch\(\(\) => null\)/)
	assert.match(text, /ws\.close\(1011, message\)/)
})

test('vncSocket for a remote guest fails when the host is offline', async () => {
	const {machines} = await readyWithBox([], {offline: true})
	await assert.rejects(
		machines.vncSocket('abcd1234'),
		(e) => e.code === 'PRECONDITION_FAILED' && e.message === 'PC is offline right now',
	)
})

test('vncSocket for a remote guest is forbidden when Virtual machines is off', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-box-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: true, allowed: {vms: false}, on: {vms: false}}],
			progress: () => null,
			call: async () => 'ok',
		},
	})
	await machines.ready
	await assert.rejects(
		machines.vncSocket('abcd1234'),
		(e) => e.code === 'FORBIDDEN' && e.message === 'Pair PC again with Virtual machines switched on.',
	)
	await rm(root, {recursive: true, force: true})
})
