// A clone or a restored backup is named by the user, so it gets the same name check as a new machine.
// A control character in a name makes libvirt refuse the machine's definition (#306).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const list = ' Id   Name   State\n------------------\n'

test('cloning a machine refuses a name libvirt cannot hold', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-clonename-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	await mkdir(join(dataDir, 'machines', 'vms', id), {recursive: true})
	await writeFile(join(dataDir, 'machines', 'vms', id, 'disk.qcow2'), 'x')
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({machines: [{id, name: 'Source', osId: 'testos-amd64', cores: 1, sockets: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 10, portForwards: [], createdAt: 1, mac: '52:54:00:11:22:33', layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: join(dataDir, 'machines', 'vms', id, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]}}]}),
	)
	const run = async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? list : '')
	const mx = createMachines({dataDir, run, kvmDevice: join(root, 'no-kvm'), statsIntervalMs: 60_000, watchIdleMs: 1})
	await mx.ready
	await assert.rejects(mx.procedures['machines.clone'].run({id, name: 'bad\u0001name'}), /name can’t be used/)
	assert.deepEqual((await mx.procedures['machines.list'].run()).map((m) => m.name), ['Source'])
})

test('restoring a backup refuses a name libvirt cannot hold', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-restorename-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const backup = join(home, 'Backups', 'Machines', '100-box-20261125-120000')
	await mkdir(backup, {recursive: true})
	await writeFile(join(backup, 'machine.json'), JSON.stringify({format: 1, sourceId: 'a1b2c3d4', createdAt: 1, machine: {name: 'Box', cores: 1, memoryMb: 1024, layout: {firmware: 'bios', disks: []}}}))
	const run = async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? list : '')
	const files = {resolve: async () => ({real: home})}
	const mx = createMachines({dataDir, run, files, kvmDevice: join(root, 'no-kvm'), statsIntervalMs: 60_000, watchIdleMs: 1})
	await mx.ready
	await assert.rejects(mx.procedures['machines.restoreBackup'].run({backupId: '100-box-20261125-120000', name: 'bad\u0001name'}), /name can’t be used/)
	assert.deepEqual(await mx.procedures['machines.list'].run(), [])
})
