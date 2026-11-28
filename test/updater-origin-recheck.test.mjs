import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createUpdater} from '../omarchyd/updater.mjs'

test('a copy installed from a non-GitHub origin sees a version published after its first check', async (t) => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchyd-recheck-'))
	t.after(() => rm(dir, {recursive: true, force: true}))
	let published = '0.6.0'
	let fetchedVersion = null
	const fetches = []
	const run = async (cmd, args) => {
		if (cmd !== 'git') return ''
		if (args.includes('get-url')) return 'https://gitlab.com/group/omarchy-server.git\n'
		if (args[2] === 'ls-remote') return 'abc\trefs/heads/main\n'
		if (args[2] === 'fetch') {
			fetchedVersion = published
			fetches.push(published)
			return ''
		}
		// Only what the last fetch brought down is there to read.
		if (args[2] === 'show' && String(args.at(-1)).endsWith('package.json')) return JSON.stringify({version: fetchedVersion})
		return ''
	}
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.6.0', run, helperPath: '/nonexistent'})
	t.after(() => u.stop())
	assert.equal((await u.procedures['system.checkUpdate'].run()).available, false)

	published = '0.6.1'
	// The check keeps its answer for ten seconds on its own; the owner asking again after that, or the
	// update step's own forced check, must look at the origin again.
	const again = await u.procedures['system.update'].run().catch((error) => error)
	assert.notEqual(again?.message, 'My Own Data Center is already up to date')
	assert.deepEqual(fetches.slice(0, 2), ['0.6.0', '0.6.1'])
	// Let the update it started reach its restart step before the folder goes.
	for (let i = 0; i < 100; i++) {
		const status = await u.procedures['system.updateStatus'].run()
		if (status.description === 'Restarting' || status.error) break
		await new Promise((r) => setTimeout(r, 20))
	}
})
