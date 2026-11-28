// A machine that lives on a computer that has since been removed from the swarm can still be deleted
// from the list: nothing can be asked of that computer any more, and the row would otherwise stay for good.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const box = {id: 'abcd1234', name: 'Box', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 8, mac: '52:54:00:11:22:33', layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: 'disk.qcow2', device: 'disk', bus: 'virtio', format: 'qcow2'}]}, options: {}, boot: ['disk0'], portForwards: []}

async function open(t, agents) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-removedhost-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box]}))
	const calls = []
	const machines = createMachines({
		dataDir: data,
		run: async () => '',
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => {
				throw new Error('no pair')
			},
			list: agents,
			progress: () => null,
			call: async (id, name) => {
				calls.push(name)
				return 'ok'
			},
		},
	})
	await machines.ready
	return {machines, calls}
}

test('a machine on a computer that is no longer in the swarm can be deleted', async (t) => {
	const {machines, calls} = await open(t, async () => [])
	assert.equal(await machines.procedures['machines.uninstall'].run({id: 'abcd1234'}, {auth: {role: 'owner'}}), true)
	assert.deepEqual(await machines.procedures['machines.list'].run(), [])
	assert.deepEqual(calls, [])
})

test('a swarm list that cannot be read does not delete the machine', async (t) => {
	const {machines} = await open(t, async () => {
		throw new Error('swarm.json is damaged')
	})
	await assert.rejects(machines.procedures['machines.uninstall'].run({id: 'abcd1234'}, {auth: {role: 'owner'}}))
	assert.equal((await machines.procedures['machines.list'].run()).length, 1)
})
