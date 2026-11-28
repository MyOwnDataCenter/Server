// Two Clone requests that arrive together (a double click, two tabs) must not give two machines one name.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

test('two clones requested at once get different names', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-clonetwice-'))
	t.after(async () => {
		await new Promise((r) => setTimeout(r, 150))
		await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50})
	})
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	await mkdir(vm, {recursive: true})
	await writeFile(join(vm, 'disk.qcow2'), 'x')
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({machines: [{id, name: 'Source', osId: 'testos-amd64', cores: 1, sockets: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 10, portForwards: [], createdAt: 1, mac: '52:54:00:11:22:33', layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: join(vm, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]}}]}),
	)
	const run = async (cmd, args) => {
		if (cmd === 'virsh') return args.includes('list') ? ' Id   Name   State\n------------------\n' : ''
		if (cmd === 'qemu-img' && args[0] === 'convert') await writeFile(args.at(-1), 'copy')
		return ''
	}
	const mx = createMachines({dataDir, run, kvmDevice: join(root, 'no-kvm'), statsIntervalMs: 60_000, watchIdleMs: 1})
	await mx.ready
	const results = await Promise.allSettled([mx.procedures['machines.clone'].run({id, name: 'Copy'}), mx.procedures['machines.clone'].run({id, name: 'Copy'})])
	assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
	const names = (await mx.procedures['machines.list'].run()).map((m) => m.name).sort()
	assert.deepEqual(names, ['Copy', 'Source'])
})
