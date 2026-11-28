// A VM that is already here must not be shut down on Unraid before the import says "It's already here".
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createUnraid} from '../omarchyd/unraid.mjs'

test('a running VM that is already here is not shut down on Unraid', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-here-'))
	const sshCmds = []
	const vmXml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>1048576</memory><vcpu>1</vcpu><devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='vda' bus='virtio'/></disk></devices></domain>`
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		sshCmds.push(remote)
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-virsh\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'domains\t300\n', stderr: ''}
		if (remote.startsWith('virsh list')) return {stdout: 'Win11\n', stderr: ''}
		if (remote.startsWith('virsh dumpxml')) return {stdout: vmXml, stderr: ''}
		if (remote.startsWith('virsh domstate')) return {stdout: sshCmds.some((c) => c.startsWith('virsh shutdown')) ? 'shut off\n' : 'running\n', stderr: ''}
		if (remote.startsWith('stat -c %s')) return {stdout: '1024\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	// The machine came over after the scan, so the scan did not mark it.
	let here = false
	const machines = {importedVm: () => here, importState: () => ({done: true, error: null, name: 'Win11'}), importVm: async () => ({id: 'vm-1'})}
	const u = createUnraid({dataDir: dir, files: {}, apps: {installed: () => false}, machines, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		here = true
		await u.procedures['unraid.start'].run({vms: ['Win11'], shutdownRunningVms: true})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job?.endedAt) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(st.job.items[0].status, 'failed')
		assert.match(st.job.items[0].error, /already here/)
		assert.deepEqual(sshCmds.filter((c) => c.startsWith('virsh shutdown')), [])
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})
