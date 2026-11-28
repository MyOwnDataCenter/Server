// While a machine is being cloned or backed up its disks are being read. Like every other change to
// its drives, growing one is refused until that is over.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('a drive cannot be grown while the machine is being cloned', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-resizebusy-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	await mkdir(vm, {recursive: true})
	await writeFile(join(vm, 'disk.qcow2'), 'x')
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({machines: [{id, name: 'Source', osId: 'testos-amd64', cores: 1, sockets: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 10, portForwards: [], createdAt: 1, mac: '52:54:00:11:22:33', layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: join(vm, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]}}]}),
	)
	const resized = []
	const run = async (cmd, args) => {
		if (cmd === 'virsh') return args.includes('list') ? ' Id   Name   State\n------------------\n' : ''
		if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 10 * 1024 ** 3, 'actual-size': 4096})
		if (cmd === 'qemu-img' && args[0] === 'resize') resized.push(args)
		if (cmd === 'qemu-img' && args[0] === 'convert') {
			await wait(300)
			await writeFile(args.at(-1), 'copy')
		}
		return ''
	}
	const mx = createMachines({dataDir, run, kvmDevice: join(root, 'no-kvm'), statsIntervalMs: 60_000, watchIdleMs: 1})
	await mx.ready
	await mx.procedures['machines.clone'].run({id, name: 'Copy'})
	await assert.rejects(mx.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 20}), /busy/)
	assert.deepEqual(resized, [])
	await wait(600)
})
