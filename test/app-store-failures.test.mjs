import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {EventEmitter} from 'node:events'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {appPermissions, createApps, missingVars, parseDotEnv} from '../omarchyd/apps.mjs'
import {freePort} from './free-port.mjs'
import {createSystemApps} from '../omarchyd/system-apps.mjs'

const git = (cwd, ...args) => execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()

function loopback(id) {
	return 20_000 + (parseInt(createHash('sha256').update(id).digest('hex').slice(0, 4), 16) % 9000)
}

function portFree(port) {
	return new Promise((resolve) => {
		const s = net.createServer()
		s.once('error', () => resolve(false))
		s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
	})
}

test('missing settings skip defaults, alternate forms, and YAML comments', () => {
	assert.deepEqual(missingVars('image: ${FOO:+bar}\nx: ${BAR+baz}\ny: ${BAZ:-keep}\nz: ${NEED}'), ['NEED'])
	const commented = `# Set \${ADMIN_TOKEN} in your own deployment
services:
  web:
    image: x
    environment:
      A: "1"  # was \${OLD_NAME}
      B: "keep # \${TOKEN}"
`
	assert.deepEqual(missingVars(commented), ['TOKEN'])
})

test('a quoted .env value followed by a comment drops its quotes', () => {
	assert.deepEqual(parseDotEnv('A="hello world" # note\nB=\'x y\' # note\nC=plain # note\nD="plain"\n'), {A: 'hello world', B: 'x y', C: 'plain', D: 'plain'})
})

test('no-new-privileges is not a system permission; unconfined and label disable are', () => {
	const only = 'services:\n a:\n  image: x\n  security_opt:\n   - no-new-privileges:true\n   - no-new-privileges\n'
	assert.deepEqual(appPermissions(only).filter((p) => p.id === 'system'), [])
	const text = `services:
  a:
    image: x
    security_opt:
      - no-new-privileges:true
      - seccomp=unconfined
      - apparmor=unconfined
      - seccomp:unconfined
      - apparmor:unconfined
      - label=disable
      - label:disable
      - systempaths=unconfined
      - seccomp=default
`
	const what = appPermissions(text).find((p) => p.id === 'system')?.what ?? []
	assert.deepEqual(what.filter((w) => String(w).includes('no-new-privileges')), [])
	assert.ok(what.includes('security_opt: seccomp=unconfined'))
	assert.ok(what.includes('security_opt: apparmor=unconfined'))
	assert.ok(what.includes('security_opt: seccomp:unconfined'))
	assert.ok(what.includes('security_opt: apparmor:unconfined'))
	assert.ok(what.includes('security_opt: label=disable'))
	assert.ok(what.includes('security_opt: label:disable'))
	assert.ok(what.includes('security_opt: systempaths=unconfined'))
	assert.equal(what.some((w) => String(w).includes('seccomp=default')), false)
})

async function listen(port) {
	const s = net.createServer()
	await new Promise((resolve, reject) => {
		s.once('error', reject)
		s.listen(port, '0.0.0.0', resolve)
	})
	return s
}

function fakeRun(record) {
	return async (cmd, args, opts = {}) => {
		record.push([cmd, ...(args ?? [])])
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			if (args.includes('ps')) return '[]'
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'info') return '{}'
			return ''
		}
		if (cmd === 'systemctl' || cmd === 'setfacl' || cmd === 'bwrap') return ''
		return ''
	}
}

async function finishInstall(apps, id) {
	const end = Date.now() + 8000
	for (;;) {
		const saved = JSON.parse(await readFile(join(apps.dataDir, 'apps/apps.json'), 'utf8'))
		const app = saved.apps.find((a) => a.id === id)
		if (app && app.state !== 'installing') return {saved, app}
		if (Date.now() > end) throw new Error(`${id} did not finish installing`)
		await new Promise((r) => setTimeout(r, 20))
	}
}

async function withApps(t, files, {systemApps = null, run} = {}) {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'app-store-fail-')))
	const prev = process.env.DOCKER_HOST
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`
	const store = join(root, 'store')
	await mkdir(store, {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	for (const [folder, body] of Object.entries(files)) {
		await mkdir(join(store, folder), {recursive: true})
		await writeFile(join(store, folder, 'omarchy-app.yml'), body.yml)
		await writeFile(join(store, folder, 'docker-compose.yml'), body.compose)
		if (body.env) await writeFile(join(store, folder, '.env'), body.env)
	}
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '-A')
	git(store, 'commit', '-qm', 'store')
	const calls = []
	const apps = createApps({
		dataDir: join(root, 'data'),
		home: join(root, 'home'),
		allowFileStores: true,
		gatewayHost: '127.0.0.1',
		defaultStores: [{url: `file://${store}`}],
		systemApps: typeof systemApps === 'function' ? systemApps(root) : (systemApps ?? null),
		run: run ?? fakeRun(calls),
		firewall: {open: async () => {}, close: async () => {}, lowPorts: async () => {}},
	})
	apps.dataDir = join(root, 'data')
	t.after(async () => {
		await apps.close()
		if (prev === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prev
		await rm(root, {recursive: true, force: true})
	})
	return {root, store, apps, calls}
}

test('a private loopback port skips another app’s public port', async (t) => {
	const fooPort = loopback('foo')
	const pub = await freePort()
	assert.equal(await portFree(fooPort), true, `loopback ${fooPort} is already taken on this host`)
	assert.equal(await portFree(pub), true, `public port ${pub} is already taken on this host`)
	const {apps} = await withApps(t, {
		bar: {
			yml: `manifestVersion: 1\nid: bar\nname: Bar\nversion: "1"\nport: ${fooPort}\nweb:\n  service: web\n  port: 80\n`,
			compose: 'services:\n  web:\n    image: x\n',
		},
		foo: {
			yml: `manifestVersion: 1\nid: foo\nname: Foo\nversion: "1"\nport: ${pub}\nweb:\n  service: web\n  port: 80\n`,
			compose: 'services:\n  web:\n    image: x\n',
		},
	})
	await apps.procedures['apps.install'].run({appId: 'bar'})
	await finishInstall(apps, 'bar')
	await apps.procedures['apps.install'].run({appId: 'foo'})
	await finishInstall(apps, 'foo')
	const written = await readFile(join(apps.dataDir, 'apps/installed/foo/compose.omarchy.yml'), 'utf8')
	assert.equal(written.includes(`127.0.0.1:${fooPort}:`), false, written)
	assert.match(written, /127\.0\.0\.1:\d+:80/)
})

test('a private loopback port skips a port something else is listening on', async (t) => {
	const id = 'zed'
	const taken = loopback(id)
	const pub = await freePort()
	assert.equal(await portFree(taken), true, `loopback ${taken} is already taken on this host`)
	assert.equal(await portFree(pub), true, `public port ${pub} is already taken on this host`)
	const held = await listen(taken)
	t.after(() => held.close())
	const {apps} = await withApps(t, {
		[id]: {
			yml: `manifestVersion: 1\nid: ${id}\nname: Zed\nversion: "1"\nport: ${pub}\nweb:\n  service: web\n  port: 80\n`,
			compose: 'services:\n  web:\n    image: x\n',
		},
	})
	await apps.procedures['apps.install'].run({appId: id})
	await finishInstall(apps, id)
	const written = await readFile(join(apps.dataDir, `apps/installed/${id}/compose.omarchy.yml`), 'utf8')
	assert.equal(written.includes(`127.0.0.1:${taken}:`), false, written)
	assert.match(written, /127\.0\.0\.1:\d+:80/)
})

test('named volumes and tmpfs are not created as app folders', async (t) => {
	const port = await freePort()
	const {apps, calls} = await withApps(t, {
		boss: {
			yml: `manifestVersion: 1\nid: boss\nname: Boss\nversion: "1"\nport: ${port}\nweb:\n  service: boss\n  port: 80\n`,
			env: 'EXTRA="./extra" # note\n',
			compose: `services:
  boss:
    image: x
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./conf:/conf
      - \${EXTRA}:/extra
      - \${APP_DATA_DIR:-.}/data/config:/config
      - type: volume
        source: other
        target: /o
      - type: tmpfs
        target: /run
volumes:
  pgdata:
  other:
`,
		},
	})
	await apps.procedures['apps.install'].run({appId: 'boss'})
	await finishInstall(apps, 'boss')
	const dir = join(apps.dataDir, 'apps/installed/boss')
	await access(join(dir, 'conf'))
	await access(join(dir, 'extra'))
	await access(join(dir, 'data/config'))
	await assert.rejects(access(join(dir, 'pgdata')))
	await assert.rejects(access(join(dir, 'other')))
	const chown = calls.filter((c) => c[0] === 'podman' && c[1] === 'unshare' && c[2] === 'chown').flat().join(' ')
	assert.match(chown, /\/conf\b/)
	assert.match(chown, /\/extra\b/)
	assert.doesNotMatch(chown, /pgdata/)
	assert.doesNotMatch(chown, /\/other\b/)
})

test('a store listing sends installSize and does not warn about comment-only variables', async (t) => {
	const {apps} = await withApps(t, {
		sized: {
			yml: 'manifestVersion: 1\nid: sized\nname: Sized\nversion: "1"\nport: 37021\ninstallSize: 250000000\ncategory: files\n',
			compose: `# Set \${ADMIN_TOKEN} in your own deployment
services:
  web:
    image: x
    environment:
      A: "1"  # was \${OLD_NAME}
      B: "\${NEED:+used}"
`,
		},
	})
	const reg = await apps.procedures['appStore.registry'].run()
	const app = reg.flatMap((s) => s.apps).find((a) => a.id === 'sized')
	assert.equal(app.installSize, 250000000)
	assert.equal(app.caution, undefined)
	const detail = await apps.procedures['appStore.app'].run({appId: 'sized'})
	assert.equal(detail.installSize, 250000000)
})

test('a failed store load is not cached, and a failed refresh still throws', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'app-store-cache-')))
	t.after(() => rm(root, {recursive: true, force: true}))
	const origin = join(root, 'origin')
	await mkdir(join(origin, 'one'), {recursive: true})
	await writeFile(join(origin, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(origin, 'one', 'omarchy-app.yml'), 'manifestVersion: 1\nid: one\nname: One\nport: 37022\n')
	await writeFile(join(origin, 'one', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n')
	const url = `file://${origin}`
	let gitOk = false
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (!gitOk) return ''
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url}], systemApps: null, run})
	t.after(() => apps.close())
	assert.deepEqual(await apps.procedures['appStore.registry'].run(), [])
	const dir = join(root, 'data', 'apps', 'stores', createHash('sha256').update(url).digest('hex').slice(0, 16))
	await mkdir(join(dir, 'one'), {recursive: true})
	await writeFile(join(dir, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(dir, 'one', 'omarchy-app.yml'), 'manifestVersion: 1\nid: one\nname: One\nport: 37022\n')
	await writeFile(join(dir, 'one', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n')
	const again = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(again[0].apps.map((a) => a.id), ['one'])

	const failing = createApps({
		dataDir: join(root, 'data-fail'),
		home: join(root, 'home'),
		allowFileStores: true,
		defaultStores: [{url: 'file:///tmp/omarchy-missing-store'}],
		systemApps: null,
		run: async (cmd) => {
			if (cmd === 'git') throw Object.assign(new Error('git failed'), {stderr: 'fatal: could not read from remote\n'})
			return ''
		},
	})
	t.after(() => failing.close())
	await assert.rejects(failing.procedures['appStore.refresh'].run(), /Couldn't reach/)
	await assert.rejects(failing.procedures['appStore.registry'].run(), /Couldn't reach/)
})

test('the hourly store check going offline keeps the catalog that is already downloaded (#681, #129)', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'app-store-offline-')))
	t.after(() => rm(root, {recursive: true, force: true}))
	const origin = join(root, 'origin')
	await mkdir(join(origin, 'one'), {recursive: true})
	await writeFile(join(origin, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(origin, 'one', 'omarchy-app.yml'), 'manifestVersion: 1\nid: one\nname: One\nport: 37023\n')
	await writeFile(join(origin, 'one', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n')
	git(origin, 'init', '-q', '-b', 'main')
	git(origin, 'add', '.')
	git(origin, 'commit', '-qm', 'store')
	const url = `file://${origin}`
	let online = true
	const run = async (cmd, args, opts = {}) => {
		if (cmd !== 'git') return ''
		if (!online) throw Object.assign(new Error('git failed'), {stderr: 'fatal: unable to access: Could not resolve host\n'})
		return execFileSync('git', gitArgv(args), {cwd: opts.cwd, stdio: 'pipe'}).toString()
	}
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url}], systemApps: null, run})
	t.after(() => apps.close())
	assert.deepEqual((await apps.procedures['appStore.registry'].run())[0].apps.map((a) => a.id), ['one'])
	online = false
	// Two hours later the cached listing and the last check have both expired, and the network is gone.
	const real = Date.now
	Date.now = () => real() + 2 * 60 * 60_000
	try {
		const later = await apps.procedures['appStore.registry'].run()
		assert.deepEqual(later[0].apps.map((a) => a.id), ['one'])
		// An explicit "Check for new apps" still says it could not reach the store.
		await assert.rejects(apps.procedures['appStore.refresh'].run(), /Couldn't reach/)
	} finally {
		Date.now = real
	}
})

test('Tailscale’s private port skips another app’s public port', async (t) => {
	const target = loopback('tailscale')
	assert.equal(await portFree(target), true, `tailscale loopback ${target} is already taken on this host`)
	const pub = await freePort()
	const kills = []
	const {apps, root} = await withApps(
		t,
		{
			hold: {
				yml: `manifestVersion: 1\nid: hold\nname: Hold\nversion: "1"\nport: ${target}\nweb:\n  service: web\n  port: 80\n`,
				compose: 'services:\n  web:\n    image: x\n',
			},
		},
		{
			systemApps: (dir) =>
				createSystemApps({
					helper: async (verb) => (verb === 'tailscale-setup' ? JSON.stringify({installedPackage: false}) : 'ok'),
					helperFile: join(dir, 'helper.mjs'),
					tailscaleBin: join(dir, 'tailscale'),
					restartDelayMs: 60_000,
					ports: {tailscale: pub},
					spawn: () => {
						const child = new EventEmitter()
						child.stdout = new EventEmitter()
						child.stderr = new EventEmitter()
						child.kill = (sig) => kills.push(sig)
						return child
					},
					run: async () => '',
				}),
		},
	)
	await writeFile(join(root, 'helper.mjs'), "const verbs = {\n\t'tailscale-setup': async () => {},\n\t'tailscale-remove': async () => {},\n}\n")
	await apps.procedures['apps.install'].run({appId: 'hold'})
	await finishInstall(apps, 'hold')
	await apps.procedures['apps.install'].run({appId: 'tailscale', grant: ['system-software']})
	const installed = await finishInstall(apps, 'tailscale')
	assert.equal(installed.app.system, true)
	assert.notEqual(installed.app.internalPort, target)
	assert.ok(installed.app.internalPort >= 20_000 && installed.app.internalPort < 29_000)
})
