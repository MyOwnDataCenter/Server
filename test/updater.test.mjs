// Software update: comparing versions, release notes, the check against GitHub, and the update steps.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'

import {REPO_RAW, compareVersions, createUpdater, rawFromOrigin, releaseNotes} from '../omarchyd/updater.mjs'

let dir
before(async () => (dir = await mkdtemp(join(os.tmpdir(), 'omarchyd-u-'))))
after(() => rm(dir, {recursive: true, force: true}))

const changelog = await readFile(new URL('../web/src/changelog.ts', import.meta.url), 'utf8')
const remote = (version, extra = {}) => async (url) => {
	const path = new URL(url).pathname.split('/').slice(4).join('/')
	const files = {'package.json': JSON.stringify({version}), 'web/src/changelog.ts': changelog, 'helper/helper.mjs': 'helper v2', 'install.sh': 'for pkg in nodejs wayvnc newthing; do x; done', ...extra}
	return files[path] === undefined ? new Response('', {status: 404}) : new Response(files[path])
}

test('versions compare numerically', () => {
	assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
	assert.equal(compareVersions('0.6.1', '0.6.1'), 0)
	// Letters after the number count: 0.9.93 < 0.9.93A < 0.9.93B < 0.9.94.
	assert.equal(compareVersions('0.9.93B', '0.9.93A'), 1)
	assert.equal(compareVersions('0.9.93A', '0.9.93B'), -1)
	assert.equal(compareVersions('0.9.93A', '0.9.93'), 1)
	assert.equal(compareVersions('0.9.94', '0.9.93B'), 1)
	assert.equal(compareVersions('0.9.93a', '0.9.93A'), 0)
	assert.equal(compareVersions('0.9.93Z', '0.9.93AA'), -1)
	assert.equal(compareVersions('0.6.0', '0.6.1'), -1)
})

test('release notes list every version newer than yours', () => {
	const notes = releaseNotes(changelog, '0.5.0')
	assert.match(notes, /\*\*0\.6\.0 · Terminal, desktop and 400 apps\*\*/)
	assert.match(notes, /\*\*0\.6\.1 · Fixes\*\*\n- Fixed: Machines failed to start/)
	assert.ok(!notes.includes('**0.5.0'), 'not the one you have')
})

test('check: up to date, then an update with notes and a note to run the installer when needed', async () => {
	const helperPath = join(dir, 'helper.mjs')
	await writeFile(helperPath, 'helper v1')
	const run = async (cmd, args) => {
		if (cmd === 'pacman' && args[1] === 'newthing') throw new Error('not found')
		return ''
	}
	const same = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '9.9.9', run, fetchImpl: remote('9.9.9'), helperPath})
	assert.equal((await same.procedures['system.checkUpdate'].run()).available, false)
	assert.equal(same.updateWaiting(), null, 'nothing for the bell')
	const old = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath})
	const c = await old.procedures['system.checkUpdate'].run()
	assert.equal(c.available, true)
	assert.equal(c.name, 'MODC 0.6.1')
	assert.match(c.releaseNotes, /run the installer.*the storage helper changed; it needs new packages \(newthing\)/)
	assert.match(c.releaseNotes, /0\.6\.1 · Fixes/)
	assert.equal(old.updateWaiting(), '0.6.1', 'the bell lights up for it')
	for (const u of [same, old]) u.stop()
	const offline = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: async () => new Response('', {status: 503}), helperPath})
	await assert.rejects(offline.procedures['system.checkUpdate'].run(), /Couldn’t check for updates/)
})

const until = async (fn) => {
	for (let i = 0; i < 200; i++) {
		const v = await fn()
		if (v) return v
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('timed out')
}

test('update: download, build, restart from a separate unit; after the restart it reports done', async () => {
	const calls = []
	const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), cmd === 'git' && args[2] === 'rev-parse' ? 'abc123\n' : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	await until(() => calls.some((c) => c.startsWith('systemd-run')))
	assert.deepEqual(
		calls.filter((c) => !c.startsWith('pacman') && !c.includes('remote get-url')).map((c) => c.split(' ').slice(0, 4).join(' ')),
		['git -C /app rev-parse', 'git -C /app rev-parse', 'git -C /app fetch', 'git -C /app reset', `${process.execPath} scripts/deps.mjs`, 'npm run build', 'systemd-run --user --collect --on-active=2s'],
	)
	assert.match(calls.at(-1), /systemctl --user restart omarchyd\.service omarchy-server-web\.service$/)
	assert.equal((await u.procedures['system.updateStatus'].run()).progress, 95)
	// The restarted omarchyd is the new version.
	const after = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.6.1', run, fetchImpl: remote('0.6.1')})
	assert.deepEqual(await after.procedures['system.updateStatus'].run(), {running: false, progress: 100, description: 'Updated to 0.6.1', error: false})
})

test('update: a failing rev-parse is a failed update, and the updater is free to try again', async () => {
	let parses = 0
	const run = async (cmd, args) => {
		if (cmd === 'git' && args[2] === 'rev-parse') {
			parses++
			if (parses >= 2) throw new Error('git: index.lock busy')
			return 'old111\n'
		}
		return ''
	}
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	const st = await until(async () => {
		const s = await u.procedures['system.updateStatus'].run()
		return s.error ? s : null
	})
	assert.match(st.error, /index\.lock busy/)
	assert.equal(st.running, false)
	// The failed attempt clears its lock after the status is saved. Until then a new
	// attempt is still told one is running; once it clears, that refusal is gone.
	let again = 'An update is already running'
	for (let i = 0; i < 50 && /already running/.test(again); i++) {
		again = await u.procedures['system.update'].run().then(() => '', (e) => e.message)
		if (/already running/.test(again)) await new Promise((r) => setTimeout(r, 10))
	}
	assert.equal(/already running/.test(again), false, again)
})

test('update: a status file that cannot be saved does not leave the update running', async () => {
	const data = join(dir, 'stuck-data')
	await mkdir(data)
	const calls = []
	const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), cmd === 'git' && args[2] === 'rev-parse' ? 'abc123\n' : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: data, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.ready
	const root = typeof process.getuid === 'function' && process.getuid() === 0
	// Root ignores the mode bit, so a data dir that is a file is the write failure instead.
	let restore = async () => {}
	try {
		if (root) {
			await rm(data, {recursive: true, force: true})
			await writeFile(data, 'not a directory')
			restore = async () => {
				await rm(data, {force: true})
				await mkdir(data)
			}
		} else {
			await chmod(data, 0o500)
			restore = () => chmod(data, 0o700)
		}
		const writeError = /EACCES|EPERM|ENOTDIR/
		await assert.rejects(u.procedures['system.update'].run(), writeError)
		const again = await u.procedures['system.update'].run().then(
			() => new Error('the folder still cannot be written'),
			(error) => error,
		)
		assert.equal(/already running/.test(again.message), false, again.message)
		assert.match(again.message, writeError)
		const stuck = await u.procedures['system.updateStatus'].run()
		assert.equal(stuck.running, false)
		assert.notEqual(stuck.description, 'Starting')
		await restore()
		restore = async () => {}
		assert.equal(await u.procedures['system.update'].run(), true)
		await until(() => calls.some((c) => c.startsWith('systemd-run')))
	} finally {
		await restore()
		u.stop()
	}
})

test('update: a failed build puts the previous version back', async () => {
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '))
		if (cmd === 'git' && args[2] === 'rev-parse') return 'old111\n'
		if (cmd === 'npm' && args[1] === 'build' && !calls.some((c) => c.includes('reset --hard old111'))) throw new Error('vite: syntax error')
		return ''
	}
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	const st = await until(async () => {
		const s = await u.procedures['system.updateStatus'].run()
		return s.error ? s : null
	})
	assert.match(st.error, /failed and nothing changed: .*syntax error/)
	assert.ok(calls.includes('git -C /app reset --hard old111'))
	assert.ok(!calls.some((c) => c.startsWith('systemd-run')))
})

test('checks and updates from the repository it was installed from (omarchy-server-dev, or omarchy-server)', async () => {
	assert.equal(rawFromOrigin('https://github.com/MyOwnDataCenter/omarchy-server-dev.git'), 'https://raw.githubusercontent.com/MyOwnDataCenter/omarchy-server-dev')
	assert.equal(rawFromOrigin('https://github.com/MyOwnDataCenter/server'), 'https://raw.githubusercontent.com/MyOwnDataCenter/server')
	assert.equal(rawFromOrigin('git@github.com:MyOwnDataCenter/omarchy-server-dev.git'), 'https://raw.githubusercontent.com/MyOwnDataCenter/omarchy-server-dev')
	assert.equal(rawFromOrigin('https://evil.example/x/y.git'), null)
	const asked = []
	const run = async (cmd, args) => (cmd === 'git' && args.includes('get-url') ? 'https://github.com/MyOwnDataCenter/omarchy-server-dev.git\n' : '')
	const fetchImpl = async (url) => (asked.push(String(url)), new Response(JSON.stringify({version: '0.6.1'})))
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl, helperPath: '/nonexistent'})
	await u.procedures['system.checkUpdate'].run()
	assert.ok(asked.length && asked.every((a) => a.startsWith('https://raw.githubusercontent.com/MyOwnDataCenter/omarchy-server-dev/main/')), asked.join(' '))
	// No origin (git isn't there): the main repository. A non-GitHub origin is not this path.
	const asked2 = []
	const u2 = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run: async () => { throw new Error('no git') }, fetchImpl: async (url) => (asked2.push(String(url)), new Response(JSON.stringify({version: '0.5.0'}))), helperPath: '/nonexistent'})
	await u2.procedures['system.checkUpdate'].run()
	assert.ok(asked2[0].startsWith('https://raw.githubusercontent.com/MyOwnDataCenter/server/main/'))
})

test('installer prompt: needed after an update the installer hasn’t been run for, then not once it has', async () => {
	const {mkdir} = await import('node:fs/promises')
	const {installerRevision, installerPackages} = await import('../omarchyd/updater.mjs')
	const app = join(dir, 'inst-app')
	const data = join(dir, 'inst-data')
	await mkdir(join(app, 'helper'), {recursive: true})
	await mkdir(data, {recursive: true})
	const helperPath = join(dir, 'inst-helper.mjs')
	await writeFile(join(app, 'install.sh'), '#!/bin/bash\nINSTALLER_REVISION=2\nfor pkg in nodejs samba newthing; do x; done\n')
	await writeFile(join(app, 'helper', 'helper.mjs'), 'helper v2')
	await writeFile(helperPath, 'helper v1')
	assert.equal(installerRevision('a\nINSTALLER_REVISION=7\n'), 7)
	assert.equal(installerRevision('no revision'), 0)
	assert.deepEqual(installerPackages('for pkg in a b-c $(bad) d; do'), ['a', 'b-c', 'd'])
	let installed = new Set(['nodejs', 'samba'])
	const run = async (cmd, args) => {
		if (cmd === 'git') return 'https://github.com/MyOwnDataCenter/server.git\n'
		if (cmd === 'pacman' && !installed.has(args[1])) throw new Error('not found')
		return ''
	}
	const make = (opts = {}) => createUpdater({autoCheck: false, appDir: app, dataDir: data, currentVersion: '1.0.0', run, helperPath, webPort: 7790, installerCheck: true, ...opts})
	const st = await make().procedures['system.installerStatus'].run()
	assert.equal(st.needed, true)
	assert.deepEqual(st.reasons, ['This update changed what the installer sets up.', 'The storage helper changed.', 'New system packages are needed: newthing.'])
	// Runs the installer from the same place this copy came from, keeps the port, and defers the restart.
	assert.equal(st.command, 'curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | OMARCHY_SERVER_FROM_APP=1 OMARCHY_SERVER_PORT=7790 bash')
	// What the installer leaves behind when it finishes.
	await writeFile(join(data, 'installer-revision'), '2\n')
	await writeFile(helperPath, 'helper v2')
	installed = new Set(['nodejs', 'samba', 'newthing'])
	assert.deepEqual(await make().procedures['system.installerStatus'].run(), {needed: false, reasons: []})
	// After beta (or in a dev run), never asked.
	await writeFile(join(data, 'installer-revision'), '1\n')
	assert.deepEqual(await make({installerCheck: false}).procedures['system.installerStatus'].run(), {needed: false, reasons: []})
})

test('installer prompt runs the local clone’s install.sh when a source is set', async () => {
	const {mkdir} = await import('node:fs/promises')
	const src = join(dir, 'prompt-src')
	const store = join(dir, 'prompt-store')
	const app = join(dir, 'prompt-app')
	const data = join(dir, 'prompt-data')
	await writeSource(src, {version: '0.6.1'})
	await mkdir(join(app, 'helper'), {recursive: true})
	await mkdir(data, {recursive: true})
	await writeFile(join(app, 'install.sh'), '#!/bin/bash\nINSTALLER_REVISION=2\nfor pkg in nodejs; do x; done\n')
	await writeFile(join(app, 'helper', 'helper.mjs'), 'helper v2')
	const helperPath = join(dir, 'prompt-helper.mjs')
	await writeFile(helperPath, 'helper v1')
	const run = async (cmd, args) => {
		if (cmd === 'git') return 'https://github.com/MyOwnDataCenter/server.git\n'
		if (cmd === 'pacman') throw new Error('not found')
		return ''
	}
	const u = createUpdater({autoCheck: false, appDir: app, dataDir: data, currentVersion: '1.0.0', sourceDir: src, appStoreDir: store, run, helperPath, webPort: 7790, installerCheck: true})
	const st = await u.procedures['system.installerStatus'].run()
	assert.equal(st.needed, true)
	assert.equal(
		st.command,
		`OMARCHY_SERVER_SOURCE='${src}' OMARCHY_SERVER_APP_STORE='${store}' OMARCHY_SERVER_REPO='${src}' OMARCHY_SERVER_FROM_APP=1 OMARCHY_SERVER_PORT=7790 bash '${join(src, 'install.sh')}'`,
	)
	assert.equal(st.command.includes('curl'), false)
})

async function writeSource(src, {version, helper = 'helper v2', install = 'for pkg in nodejs wayvnc; do x; done'} = {}) {
	const {mkdir} = await import('node:fs/promises')
	await mkdir(join(src, 'web/src'), {recursive: true})
	await mkdir(join(src, 'helper'), {recursive: true})
	await writeFile(join(src, 'package.json'), JSON.stringify({version}))
	await writeFile(join(src, 'web/src/changelog.ts'), changelog)
	await writeFile(join(src, 'helper/helper.mjs'), helper)
	await writeFile(join(src, 'install.sh'), install)
}

test('createUpdater does not take sourceDir from the environment', async () => {
	const src = join(dir, 'env-src')
	await writeSource(src, {version: '9.9.9'})
	const prev = process.env.OMARCHY_SERVER_SOURCE
	process.env.OMARCHY_SERVER_SOURCE = src
	try {
		let fetched = 0
		const u = createUpdater({
			autoCheck: false,
			appDir: '/app',
			dataDir: join(dir, 'env-data'),
			currentVersion: '0.5.0',
			run: async () => '',
			fetchImpl: async (url) => {
				fetched++
				return remote('0.6.1')(url)
			},
			helperPath: '/nonexistent',
		})
		const c = await u.procedures['system.checkUpdate'].run()
		u.stop()
		assert.ok(fetched > 0, 'must still check GitHub when sourceDir is not passed')
		assert.equal(c.version, '0.6.1')
	} finally {
		if (prev === undefined) delete process.env.OMARCHY_SERVER_SOURCE
		else process.env.OMARCHY_SERVER_SOURCE = prev
	}
})

test('check: reads the local clone, not GitHub', async () => {
	const src = join(dir, 'local-src')
	await writeSource(src, {version: '0.6.1'})
	let fetched = 0
	const helperPath = join(dir, 'local-helper.mjs')
	await writeFile(helperPath, 'helper v1')
	const run = async (cmd, args) => {
		if (cmd === 'git' && args.includes('rev-parse')) return args.includes(src) ? 'srcsha\n' : 'appsha\n'
		if (cmd === 'pacman') throw new Error('not found')
		return ''
	}
	const u = createUpdater({
		autoCheck: false,
		appDir: join(dir, 'app'),
		dataDir: join(dir, 'local-data'),
		currentVersion: '0.5.0',
		sourceDir: src,
		helperPath,
		run,
		fetchImpl: async () => {
			fetched++
			return new Response('', {status: 503})
		},
	})
	const c = await u.procedures['system.checkUpdate'].run()
	u.stop()
	assert.equal(fetched, 0, 'must not call GitHub')
	assert.equal(c.available, true)
	assert.equal(c.version, '0.6.1')
	assert.match(c.releaseNotes, /0\.6\.1 · Fixes/)
	assert.match(c.releaseNotes, /OMARCHY_SERVER_REPO=/)
	assert.ok(c.releaseNotes.includes(`bash '${join(src, 'install.sh')}'`))
})

test('check: same version with a different clone commit is an update', async () => {
	const src = join(dir, 'same-ver-src')
	await writeSource(src, {version: '0.5.0'})
	const run = async (cmd, args) => (cmd === 'git' && args.includes('rev-parse') ? (args.includes(src) ? 'aaa\n' : 'bbb\n') : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: join(dir, 'same-ver-data'), currentVersion: '0.5.0', sourceDir: src, helperPath: '/nonexistent', run, fetchImpl: async () => new Response('', {status: 503})})
	const c = await u.procedures['system.checkUpdate'].run()
	u.stop()
	assert.equal(c.available, true)
	assert.equal(c.version, '0.5.0')
})

test('check: same version and the same clone commit is up to date', async () => {
	const src = join(dir, 'same-sha-src')
	await writeSource(src, {version: '0.5.0'})
	const run = async (cmd) => (cmd === 'git' ? 'same\n' : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: join(dir, 'same-sha-data'), currentVersion: '0.5.0', sourceDir: src, helperPath: '/nonexistent', run, fetchImpl: async () => new Response('', {status: 503})})
	const c = await u.procedures['system.checkUpdate'].run()
	u.stop()
	assert.equal(c.available, false)
})

test('update: fetches the local clone instead of origin', async () => {
	const src = join(dir, 'fetch-src')
	const data = join(dir, 'fetch-data')
	await mkdir(data, {recursive: true})
	await writeSource(src, {version: '0.6.1'})
	const calls = []
	const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), cmd === 'git' && args[2] === 'rev-parse' ? 'abc123\n' : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: data, currentVersion: '0.5.0', sourceDir: src, run, helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	await until(() => calls.some((c) => c.startsWith('systemd-run')))
	u.stop()
	assert.ok(calls.some((c) => c === `git -C /app fetch --depth 1 ${src} HEAD`))
	assert.ok(calls.some((c) => c === 'git -C /app reset --hard FETCH_HEAD'))
	assert.ok(!calls.some((c) => c.includes(' origin ')))
})

test('the installer ships a revision, stamps it when it finishes, and defers its restart when run from the app', async () => {
	const {installerRevision} = await import('../omarchyd/updater.mjs')
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
	assert.ok(installerRevision(script) >= 1)
	assert.match(script, /printf '%s\\n' "\$INSTALLER_REVISION" >"\$BASE\/omarchyd\/installer-revision"/)
	assert.match(script, /\[ "\$FROM_APP" = 1 \] \|\| systemctl --user restart omarchyd\.service omarchy-server-web\.service/)
	assert.match(script, /systemd-run --user --collect --on-active=5s/)
	// The stamp comes after the last sudo step, so a failed run doesn't count.
	assert.ok(script.indexOf('installer-revision') > script.lastIndexOf('sudo '))
})

test('rawFromOrigin accepts the other GitHub URL forms', () => {
	const raw = 'https://raw.githubusercontent.com/o/r'
	assert.equal(rawFromOrigin('ssh://git@github.com/o/r.git'), raw)
	assert.equal(rawFromOrigin('https://user:token@github.com/o/r.git'), raw)
	assert.equal(rawFromOrigin('git://github.com/o/r.git'), raw)
	assert.equal(rawFromOrigin('https://www.github.com/o/r.git'), raw)
	assert.equal(rawFromOrigin('https://GitHub.com/o/r.git'), raw)
})

test('a file or GitLab origin is read with git and not the official raw URL', async () => {
	for (const origin of ['file:///tmp/omarchy-fork', 'https://gitlab.com/group/omarchy-server.git']) {
		assert.equal(rawFromOrigin(origin), null)
		const calls = []
		const fetched = []
		const run = async (cmd, args) => {
			calls.push([cmd, ...args].join(' '))
			if (cmd === 'git' && args.includes('get-url')) return `${origin}\n`
			if (cmd === 'git' && args[2] === 'ls-remote') return `abc\trefs/heads/main\n`
			if (cmd === 'git' && args[2] === 'show' && String(args.at(-1)).endsWith('package.json')) return JSON.stringify({version: '0.6.1'})
			if (cmd === 'git' && args[2] === 'show') return ''
			return ''
		}
		const u = createUpdater({
			autoCheck: false,
			appDir: '/app',
			dataDir: dir,
			currentVersion: '0.5.0',
			run,
			fetchImpl: async (url) => {
				fetched.push(String(url))
				return new Response(JSON.stringify({version: '9.9.9'}))
			},
			helperPath: '/nonexistent',
		})
		const c = await u.procedures['system.checkUpdate'].run()
		const from = await u.source()
		u.stop()
		assert.equal(c.version, '0.6.1', origin)
		assert.equal(fetched.length, 0, fetched.join(' '))
		assert.equal(from === REPO_RAW, false, from)
		assert.ok(calls.some((line) => line.includes('ls-remote') && line.includes(origin)), calls.join('\n'))
		assert.ok(calls.some((line) => line.includes('fetch') && line.includes(origin)), calls.join('\n'))
		assert.equal(calls.some((line) => line.includes(REPO_RAW)), false)
	}
})

test('update: a failed fetch does not reset or rebuild, and the status leaves Downloading', async () => {
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '))
		if (cmd === 'git' && args[2] === 'rev-parse') return 'old111\n'
		if (cmd === 'git' && args[2] === 'fetch') throw new Error('fetch failed: network down')
		return ''
	}
	const data = join(dir, 'fetch-fail')
	await mkdir(data, {recursive: true})
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: data, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	const st = await until(async () => {
		const s = await u.procedures['system.updateStatus'].run()
		return s.error ? s : null
	})
	u.stop()
	assert.match(st.error, /fetch failed: network down/)
	assert.equal(st.running, false)
	assert.notEqual(st.description, 'Downloading')
	assert.equal(calls.some((line) => line.includes('reset')), false, calls.join('\n'))
	assert.equal(calls.some((line) => line.includes('deps.mjs')), false, calls.join('\n'))
	assert.equal(calls.some((line) => line.startsWith('npm ')), false, calls.join('\n'))
})

test('update: a failure after the tree changed says Restoring, then puts the previous version back', async () => {
	const calls = []
	let u
	let duringRestore = null
	const run = async (cmd, args) => {
		const line = [cmd, ...args].join(' ')
		calls.push(line)
		if (cmd === 'git' && args[2] === 'rev-parse') return 'old111\n'
		if (line === 'git -C /app reset --hard old111') duringRestore = await u.procedures['system.updateStatus'].run()
		if (cmd === 'npm' && args[1] === 'build' && !calls.some((c) => c.includes('reset --hard old111'))) throw new Error('vite: syntax error')
		return ''
	}
	const data = join(dir, 'restore-desc')
	await mkdir(data, {recursive: true})
	u = createUpdater({autoCheck: false, appDir: '/app', dataDir: data, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	const st = await until(async () => {
		const s = await u.procedures['system.updateStatus'].run()
		return s.error ? s : null
	})
	u.stop()
	assert.match(st.error, /failed and nothing changed: .*syntax error/)
	assert.equal(st.description, '')
	assert.equal(duringRestore?.description, 'Restoring')
	assert.notEqual(duringRestore?.description, 'Downloading')
	assert.ok(calls.includes('git -C /app reset --hard old111'))
	assert.ok(calls.filter((line) => line.includes('deps.mjs')).length >= 1)
})

test('installer hint keeps the source, the app store, the repo, and the port', async () => {
	const src = join(dir, 'hint-src')
	const store = join(dir, 'hint-store')
	await writeSource(src, {version: '0.6.1', helper: 'helper v2'})
	const helperPath = join(dir, 'hint-helper.mjs')
	await writeFile(helperPath, 'helper v1')
	const run = async (cmd) => {
		if (cmd === 'pacman') throw new Error('not found')
		return ''
	}
	const u = createUpdater({
		autoCheck: false,
		appDir: join(dir, 'hint-app'),
		dataDir: join(dir, 'hint-data'),
		currentVersion: '0.5.0',
		sourceDir: src,
		appStoreDir: store,
		webPort: 7791,
		run,
		helperPath,
		fetchImpl: async () => new Response('', {status: 503}),
	})
	const c = await u.procedures['system.checkUpdate'].run()
	u.stop()
	assert.match(c.releaseNotes, /OMARCHY_SERVER_SOURCE=/)
	assert.match(c.releaseNotes, /OMARCHY_SERVER_APP_STORE=/)
	assert.match(c.releaseNotes, /OMARCHY_SERVER_REPO=/)
	assert.match(c.releaseNotes, /OMARCHY_SERVER_PORT=7791/)
	assert.ok(c.releaseNotes.includes(src))
	assert.ok(c.releaseNotes.includes(store))
})
