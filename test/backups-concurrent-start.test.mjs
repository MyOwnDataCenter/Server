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

// A set-up server whose NAS and restic store already exist, so only the start of a run is under test.
async function setup(t, {swarm = null, computers = {}} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-start-'))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const repo = join(home, 'Backups', 'Omarchy Server')
	await mkdir(join(dataDir, 'backups', 'computers'), {recursive: true})
	await mkdir(join(repo, 'server'), {recursive: true})
	await writeFile(join(repo, 'server', 'config'), 'config')
	await writeFile(join(dataDir, 'backups', 'recovery-key'), 'key\n')
	await writeFile(join(dataDir, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(join(dataDir, 'backups', 'config.json'), JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}, computers}))
	for (const id of Object.keys(computers)) {
		await mkdir(join(repo, 'computers', id), {recursive: true})
		await writeFile(join(repo, 'computers', id, 'config'), 'config')
		await writeFile(join(dataDir, 'backups', 'computers', `${id}.key`), 'pw\n')
	}
	const calls = []
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		swarm,
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args) => {
			calls.push([cmd, ...args])
			if (args[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
			return {stdout: '', stderr: ''}
		},
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	await b.ready
	return {b, calls}
}

test('two backup requests at the same moment start one backup, not two', async (t) => {
	const {b, calls} = await setup(t)
	const results = await Promise.allSettled([b.runBackup('manual'), b.runBackup('manual')])
	const started = results.filter((r) => r.status === 'fulfilled')
	const refused = results.filter((r) => r.status === 'rejected')
	assert.equal(started.length, 1, 'both requests started a backup')
	assert.equal(refused.length, 1)
	assert.equal(refused[0].reason.code, 'CONFLICT')
	await started[0].value.done
	assert.equal(calls.filter((c) => c[0] === '/bin/restic' && c[1] === 'backup').length, 1)
	const status = await b.procedures['backups.status'].run()
	assert.equal(status.history.length, 1)
})

test('a backup that cannot start leaves the next request free to start', async (t) => {
	const {b} = await setup(t)
	const first = await b.runBackup('manual')
	await first.done
	const again = await b.runBackup('manual')
	await again.done
	assert.ok(again.id)
})

test('two backup requests for one computer at the same moment start one run', async (t) => {
	let backupRuns = 0
	let release
	const swarm = {
		async agents() {
			return [{id: 'pc1', name: 'Study PC', online: true, allowed: true, on: true}]
		},
		call(_id, name) {
			if (name === 'backup-run') {
				backupRuns++
				return new Promise((resolve) => (release = resolve))
			}
			return {}
		},
		progress: () => null,
	}
	const {b} = await setup(t, {swarm, computers: {pc1: {enabled: true, folders: ['Documents'], schedule: {frequency: 'daily', hour: 1, weekday: 0}}}})
	const results = await Promise.allSettled([b.runComputer('pc1', 'manual'), b.runComputer('pc1', 'manual')])
	const started = results.filter((r) => r.status === 'fulfilled')
	const refused = results.filter((r) => r.status === 'rejected')
	assert.equal(started.length, 1, 'both requests started a run')
	assert.equal(refused[0]?.reason.code, 'CONFLICT')
	for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20))
	release?.({added: 1, files: 1})
	await started[0].value.done
	assert.equal(backupRuns, 1)
})
