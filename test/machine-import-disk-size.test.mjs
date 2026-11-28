import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

test('a machine brought over from Unraid shows the size of its disk in the machine list', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'mid-'))
	try {
		const raw = join(root, 'vdisk1.img')
		await writeFile(raw, 'raw')
		await writeFile(join(root, 'kvm'), '')
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await writeFile(args.at(-1), 'copied')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 40 * 1024 ** 3, 'actual-size': 4096})
			if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
			return ''
		}
		const machines = createMachines({dataDir: join(root, 'data'), run, kvmDevice: join(root, 'kvm')})
		await machines.ready
		const {id} = await machines.importVm({name: 'one', disks: [{file: raw, bus: 'virtio', format: 'raw'}]})
		const end = Date.now() + 5000
		for (;;) {
			const state = machines.importState(id)
			if (state.done) {
				assert.equal(state.error, null)
				break
			}
			if (Date.now() > end) throw new Error('import did not finish')
			await new Promise((r) => setTimeout(r, 10))
		}
		const listed = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
		assert.equal(listed.diskSizeGb, 40)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
