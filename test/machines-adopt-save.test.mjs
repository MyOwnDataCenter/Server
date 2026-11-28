// A clone, restore or import whose machines.json cannot be saved must leave nothing behind:
// no machine in the list, no "installing" row that never ends, and the name free to use again.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

test('an import that cannot be saved leaves no machine and no busy row behind', async (t) => {
	t.mock.method(console, 'error', () => {})
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-adopt-'))
	try {
		const dataDir = join(root, 'data')
		const disk = join(root, 'vdisk1.img')
		await writeFile(disk, 'raw')
		await mkdir(join(dataDir, 'machines'), {recursive: true})
		// A registry that could not be read at startup refuses every save.
		await writeFile(join(dataDir, 'machines', 'machines.json'), '{"machines":[{"id":"abcd1234"')
		const run = async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? ' Id   Name   State\n------------------\n' : '')
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'no-kvm'), statsIntervalMs: 60_000, watchIdleMs: 1})
		await machines.ready
		await assert.rejects(machines.importVm({name: 'Win11', disks: [{file: disk, bus: 'sata', format: 'raw'}]}), /machines\.json is damaged/)
		const rows = await machines.procedures['machines.list'].run()
		assert.deepEqual(rows, [])
		assert.equal(machines.importedVm('Win11'), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
