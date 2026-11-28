import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createBackups} from '../omarchyd/backups.mjs'

const fakeFiles = (home) => ({
	async resolve(v, {mustExist = true} = {}) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		const real = join(home, v.slice('/Home'.length))
		if (mustExist) await stat(real)
		return {real, top: 'Home'}
	},
})

test('two restores of an app at the same moment start one restore', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-restore-'))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const appDir = join(dataDir, 'apps', 'installed', 'notes')
	const snapshotId = 'ab'.repeat(32)
	await mkdir(appDir, {recursive: true})
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'server'), {recursive: true})
	await writeFile(join(home, 'Backups', 'Omarchy Server', 'server', 'config'), 'config')
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	await writeFile(join(dataDir, 'backups', 'recovery-key'), 'key\n')
	await writeFile(join(dataDir, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(join(dataDir, 'backups', 'config.json'), JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}}))
	const restores = []
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => [{id: 'notes', name: 'Notes', dir: appDir, running: false}]},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args) => {
			if (args[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
			if (args[0] === 'snapshots') return {stdout: JSON.stringify([{id: snapshotId, short_id: snapshotId.slice(0, 8), time: new Date().toISOString(), tags: ['app:notes'], paths: [appDir]}]), stderr: ''}
			if (args[0] === 'restore') {
				restores.push(args)
				await mkdir(join(args[args.indexOf('--target') + 1], appDir), {recursive: true})
			}
			return {stdout: '', stderr: ''}
		},
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	await b.ready
	const results = await Promise.allSettled([b.procedures['backups.restoreApp'].run({snapshotId, appId: 'notes'}), b.procedures['backups.restoreApp'].run({snapshotId, appId: 'notes'})])
	assert.equal(restores.length, 1, 'both requests ran a restore')
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
	assert.equal(results.find((r) => r.status === 'rejected')?.reason.code, 'CONFLICT')
})
