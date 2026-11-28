import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
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

// A NAS share kept in memory: the files under the backup folder, by path.
function fakeNas(remote) {
	const when = 'Thu Nov 19 14:48:56 2026'
	return async (args, opts = {}) => {
		let stdout = ''
		for (const raw of String(opts.input ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
			const [cmd, ...rest] = [...raw.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0].replace(/^"|"$/g, ''))
			if (cmd === 'put') remote.set(rest[1], await readFile(rest[0]))
			else if (cmd === 'del') remote.delete(rest[0])
			else if (cmd === 'get') await writeFile(rest[1], remote.get(rest[0]) ?? '')
			else if (cmd === 'ls') {
				const dirs = new Map()
				for (const [p, bytes] of remote) {
					const i = p.lastIndexOf('/')
					const dir = i < 0 ? '' : p.slice(0, i)
					dirs.set(dir, [...(dirs.get(dir) ?? []), [p.slice(i + 1), bytes.length]])
				}
				for (const [dir, list] of [...dirs].sort(([a], [b]) => a.length - b.length)) {
					if (dir) stdout += `\n\\Omarchy Server\\${dir.split('/').join('\\')}\n`
					for (const [name, size] of list) stdout += `  ${name.padEnd(36)} A ${String(size).padStart(8)}  ${when}\n`
				}
			}
		}
		return {stdout, stderr: ''}
	}
}

test('a folder of the backup store that cannot be read does not make the NAS copy delete its files', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-unreadable-'))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const store = join(home, 'Backups', 'Omarchy Server', 'server')
	const pack = 'a'.repeat(64)
	const other = 'b'.repeat(64)
	const files = {config: 'config', 'keys/k1': 'key', [`data/aa/${pack}`]: 'pack-one', [`data/bb/${other}`]: 'pack-two', [`snapshots/${'c'.repeat(64)}`]: 'snap'}
	const remote = new Map()
	for (const [p, text] of Object.entries(files)) {
		await mkdir(join(store, p, '..'), {recursive: true})
		await writeFile(join(store, p), text)
		remote.set(`server/${p}`, Buffer.from(text))
	}
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	await writeFile(join(dataDir, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(join(dataDir, 'backups', 'config.json'), JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}}))
	const nas = fakeNas(remote)
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? nas(args, opts) : {stdout: '', stderr: ''}),
	})
	t.after(async () => {
		await chmod(join(store, 'data', 'aa'), 0o700).catch(() => {})
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	await b.ready
	await chmod(join(store, 'data', 'aa'), 0o000)
	if ((await readFile(join(store, 'data', 'aa', pack)).catch(() => null)) !== null) return t.skip('this account can read a folder with no permissions')

	await assert.rejects(b.mirror(), /read/i)
	assert.ok(remote.has(`server/data/aa/${pack}`), 'the NAS copy of an unreadable folder was deleted')
	assert.equal(remote.size, Object.keys(files).length)
})
