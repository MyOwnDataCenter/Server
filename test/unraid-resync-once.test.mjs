// Two re-sync requests at the same moment (a double click, two tabs) must start one job, like Start does (#752).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createUnraid} from '../omarchyd/unraid.mjs'

test('two re-sync requests at once start only one job', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-resync-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	let rsyncs = 0
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncs++
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'Media\t100\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const u = createUnraid({dataDir: dir, files, apps: {installed: () => false}, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		await u.procedures['unraid.start'].run({shares: ['Media'], shareOnNetwork: false})
		let st
		for (let i = 0; i < 300; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job?.endedAt) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(st.job.items[0].status, 'done')
		const results = await Promise.allSettled([u.procedures['unraid.resync'].run({}), u.procedures['unraid.resync'].run({})])
		assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
		assert.match(results.find((r) => r.status === 'rejected').reason.message, /already running/)
		for (let i = 0; i < 300; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job?.endedAt) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(rsyncs, 2, 'one copy for the move and one for the re-sync')
	} finally {
		u.close()
		await new Promise((r) => setTimeout(r, 100))
		await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50})
	}
})
