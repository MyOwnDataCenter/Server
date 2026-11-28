import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

test('when libvirt refuses a changed machine setting, the person is told why instead of "Internal error"', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'mdf-'))
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
		run: async (cmd, args) => {
			if (cmd !== 'virsh') return ''
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'define') throw new Error('error: unsupported configuration: machine type is not available')
			if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
			return ''
		},
		kvmDevice: join(root, 'kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
	})
	await m.ready
	await assert.rejects(m.procedures['machines.updateOptions'].run({id, agent: true}), (e) => e instanceof RpcError && /unsupported configuration/.test(e.message) && /Box/.test(e.message))
})
