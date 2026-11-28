// Install, list, update, and store-refresh failures that used to leave a dead app looking
// running, a removed listing file in charge, or a failed “check for new apps” looking fine.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps, pickServerIp} from '../omarchyd/apps.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const git = (cwd, ...args) => execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const there = (p) => stat(p).then(() => true, () => false)

async function freePort() {
	for (let i = 0; i < 40; i++) {
		const candidate = 29_000 + Math.floor(Math.random() * 3_768)
		const ok = await new Promise((resolve) => {
			const s = net.createServer()
			s.once('error', () => resolve(false))
			s.listen(candidate, '0.0.0.0', () => s.close(() => resolve(true)))
		})
		if (ok) return candidate
	}
	throw new Error('no free port')
}

function listen(port, onRequest) {
	const server = http.createServer(onRequest)
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function hang(port) {
	const server = net.createServer(() => {})
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function setup(t, {apps: specs, startGraceMs = 120_000, interfaces = null} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-fail-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	await mkdir(home, {recursive: true})
	await writeFile(sock, '')
	const prevDocker = process.env.DOCKER_HOST
	const prevIfaces = os.networkInterfaces
	process.env.DOCKER_HOST = `unix://${sock}`
	if (interfaces) os.networkInterfaces = () => interfaces
	await mkdir(store, {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	for (const spec of specs) {
		await mkdir(join(store, spec.id), {recursive: true})
		const manifest = [`manifestVersion: 1`, `id: ${spec.id}`, `name: ${spec.name ?? spec.id}`, `version: "${spec.version ?? '1'}"`, spec.port ? `port: ${spec.port}` : null, spec.extra ?? null].filter(Boolean).join('\n')
		await writeFile(join(store, spec.id, 'omarchy-app.yml'), `${manifest}\n`)
		const composeName = spec.composeName ?? 'docker-compose.yml'
		await writeFile(join(store, spec.id, composeName), spec.compose)
		if (spec.exports) await writeFile(join(store, spec.id, 'exports.sh'), spec.exports)
		if (spec.env) await writeFile(join(store, spec.id, '.env'), spec.env)
	}
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '-A')
	git(store, 'commit', '-qm', 'init')
	const up = new Set()
	const composeCalls = []
	const lows = []
	let pullWait = null
	const networks = new Set()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'systemctl' || cmd === 'setfacl') return ''
		if (cmd === 'bwrap') {
			const env = {}
			for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') (env[args[i + 1]] = args[i + 2]), (i += 2)
			const script = String(args.at(-1)).replaceAll('/tmp/.wanted', join(root, '.wanted'))
			return execFileSync('bash', ['-c', script], {env: {...env, PATH: '/usr/bin:/bin'}}).toString()
		}
		if (cmd === 'podman') {
			if (args[0] === 'info') return '{}'
			if (args[0] === 'ps') {
				return JSON.stringify([...up].map((project) => ({State: 'running', Labels: {'com.docker.compose.project': project}})))
			}
			if (args[0] === 'network' && args[1] === 'exists' && !networks.has(args[2])) throw new Error('no such network')
			if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1))
			if (args[0] === 'unshare' && args[1] === 'rm') {
				await rm(args.at(-1), {recursive: true, force: true})
				return ''
			}
			return ''
		}
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			composeCalls.push({args, env: opts.env})
			const project = args[1]
			const verb = args.find((a, i) => i > 0 && ['up', 'stop', 'down', 'pull', 'ps', 'restart'].includes(a))
			if (verb === 'pull') {
				if (pullWait) await pullWait(project)
				return ''
			}
			if (verb === 'up') {
				if (!args.includes('--no-start')) up.add(project)
			}
			if (verb === 'stop' || verb === 'down') up.delete(project)
			if (verb === 'ps') return JSON.stringify([{State: up.has(project) ? 'running' : 'exited'}])
			return ''
		}
		throw new Error(`${cmd} not simulated`)
	}
	const apps = createApps({
		dataDir: data,
		home,
		allowFileStores: true,
		gatewayHost: '127.0.0.1',
		defaultStores: [],
		systemApps: null,
		run,
		startGraceMs,
		firewall: {open: async () => {}, close: async () => {}, lowPorts: async (n) => lows.push(n)},
	})
	t.after(async () => {
		apps.close()
		os.networkInterfaces = prevIfaces
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	})
	const call = (name, input) => apps.procedures[name].run(input)
	await call('appStore.addRepository', {url: `file://${store}`})
	const until = async (fn, ms = 8000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await wait(20)
		}
	}
	const installed = async (id) => until(async () => {
		const s = apps.importState(id)
		if (s.error) throw new Error(s.error)
		return s.done ? s : null
	})
	return {root, data, home, store, apps, call, up, composeCalls, lows, installed, until, setPullWait: (fn) => (pullWait = fn)}
}

const proxyCompose = (extra) => `services:\n  app_proxy:\n    environment:\n      APP_HOST: web\n      APP_PORT: "80"\n  web:\n    image: example/app:1\n${extra}`

test('pickServerIp keeps LAN addresses and skips only podman and docker bridges', () => {
	const v4 = (address, internal = false) => ({family: 'IPv4', internal, address})
	assert.equal(pickServerIp({eth0: [v4('172.20.1.5')]}), '172.20.1.5')
	assert.equal(pickServerIp({eth0: [v4('172.16.5.9')]}), '172.16.5.9')
	assert.equal(pickServerIp({eth0: [v4('172.15.0.1')]}), '172.15.0.1')
	assert.equal(pickServerIp({eth0: [v4('172.32.0.1')]}), '172.32.0.1')
	assert.equal(pickServerIp({eth0: [v4('192.168.1.5')]}), '192.168.1.5')
	assert.equal(pickServerIp({eth0: [v4('10.88.1.1'), v4('192.168.1.5')]}), '192.168.1.5')
	assert.equal(pickServerIp({eth0: [v4('10.89.0.2'), v4('172.16.0.4')]}), '172.16.0.4')
	assert.equal(pickServerIp({eth0: [v4('172.17.0.2')]}), '127.0.0.1')
	assert.equal(pickServerIp({
		lo: [v4('127.0.0.1', true)],
		docker0: [v4('172.17.0.1')],
		podman0: [v4('10.88.0.1')],
		'cni-podman0': [v4('10.89.0.1')],
		'br-lan': [v4('172.20.1.5')],
		veth123: [v4('192.168.9.9')],
		eth0: [v4('172.16.1.8')],
	}), '172.16.1.8')
	assert.equal(pickServerIp({docker0: [v4('192.168.1.5')], lo: [v4('127.0.0.1', true)]}), '127.0.0.1')
})

test('list keeps a web app running during start grace even when nothing is listening yet', async (t) => {
	const port = await freePort()
	const fx = await setup(t, {
		startGraceMs: 60_000,
		apps: [{id: 'dead', name: 'Dead', port, compose: proxyCompose('')}],
	})
	await fx.call('apps.install', {appId: 'dead'})
	await fx.installed('dead')
	assert.equal((await fx.call('apps.list')).find((a) => a.id === 'dead').state, 'running')
})

test('list reports a dead web app as stopped after start grace, and a real answer as running', async (t) => {
	const port = await freePort()
	const fx = await setup(t, {
		startGraceMs: 0,
		apps: [
			{id: 'dead', name: 'Dead', port, compose: proxyCompose('')},
			{id: 'noweb', name: 'No Web', compose: 'services:\n  web:\n    image: example/noweb:1\n'},
		],
	})
	await fx.call('apps.install', {appId: 'dead'})
	await fx.call('apps.install', {appId: 'noweb'})
	await fx.installed('dead')
	await fx.installed('noweb')
	await wait(30)
	const listed = await fx.call('apps.list')
	const dead = listed.find((a) => a.id === 'dead')
	assert.equal(dead.state, 'stopped', 'refused on the app port after grace is stopped, not running')
	assert.equal(listed.find((a) => a.id === 'noweb').state, 'running', 'an app with no web port stays on the podman result')
	// The sign-in gateway on the public port answers 302. That must not count as the app being up.
	const gateway = await fetch(`http://127.0.0.1:${port}/`, {redirect: 'manual'})
	assert.equal(gateway.status, 302)
	const page = await listen(dead.internalPort, (_req, res) => res.writeHead(302, {location: '/start'}).end())
	try {
		await wait(1600)
		const again = (await fx.call('apps.list')).find((a) => a.id === 'dead')
		assert.equal(again.state, 'running', '302 from the app’s own port means it is up')
	} finally {
		page.close()
	}
	await wait(1600)
	assert.equal((await fx.call('apps.list')).find((a) => a.id === 'dead').state, 'stopped')
})

test('running web apps are probed together, not one after another', async (t) => {
	const a = await freePort()
	const b = await freePort()
	const fx = await setup(t, {
		startGraceMs: 0,
		apps: [
			{id: 'one', name: 'One', port: a, compose: proxyCompose('')},
			{id: 'two', name: 'Two', port: b, compose: proxyCompose('')},
		],
	})
	await fx.call('apps.install', {appId: 'one'})
	await fx.call('apps.install', {appId: 'two'})
	await fx.installed('one')
	await fx.installed('two')
	await wait(30)
	const saved = JSON.parse(await readFile(join(fx.data, 'apps', 'apps.json'), 'utf8'))
	const servers = []
	for (const id of ['one', 'two']) servers.push(await hang(saved.apps.find((x) => x.id === id).internalPort))
	try {
		const began = Date.now()
		const list = await fx.call('apps.list')
		const took = Date.now() - began
		assert.equal(list.find((x) => x.id === 'one').state, 'stopped')
		assert.equal(list.find((x) => x.id === 'two').state, 'stopped')
		assert.ok(took < 1500, `probes ran one after another (${took}ms)`)
	} finally {
		for (const s of servers) s.close()
	}
})

test('uninstall while that app is installing or updating is refused; another app is not', async (t) => {
	const port = await freePort()
	const other = await freePort()
	const fx = await setup(t, {
		apps: [
			{id: 'demo', name: 'Demo', port, compose: proxyCompose('')},
			{id: 'other', name: 'Other', port: other, compose: proxyCompose('')},
		],
	})
	let release
	let seen
	const started = new Promise((r) => (seen = r))
	fx.setPullWait(async (project) => {
		if (project !== 'omarchy-demo') return
		seen()
		await new Promise((r) => (release = r))
	})
	const installing = fx.call('apps.install', {appId: 'demo'})
	await started
	await assert.rejects(fx.call('apps.uninstall', {appId: 'demo'}), (e) => e instanceof RpcError && e.code === 'CONFLICT' && e.message === 'Demo is busy')
	await fx.call('apps.install', {appId: 'other'})
	await fx.installed('other')
	assert.equal(await fx.call('apps.uninstall', {appId: 'other'}), true)
	release()
	fx.setPullWait(null)
	assert.equal(await installing, true)
	await fx.installed('demo')
	assert.equal((await fx.call('apps.list')).some((a) => a.id === 'demo'), true)
	assert.equal((await fx.call('apps.list')).some((a) => a.id === 'other'), false)

	let releaseUpdate
	let seenUpdate
	const updateStarted = new Promise((r) => (seenUpdate = r))
	fx.setPullWait(async (project) => {
		if (project !== 'omarchy-demo') return
		seenUpdate()
		await new Promise((r) => (releaseUpdate = r))
	})
	await writeFile(join(fx.store, 'demo', 'omarchy-app.yml'), `manifestVersion: 1\nid: demo\nname: Demo\nversion: "2"\nport: ${port}\n`)
	git(fx.store, 'add', '-A')
	git(fx.store, 'commit', '-qm', 'v2')
	await fx.call('appStore.refresh')
	const updating = fx.call('apps.update', {appId: 'demo'})
	await updateStarted
	await assert.rejects(fx.call('apps.uninstall', {appId: 'demo'}), (e) => e instanceof RpcError && e.code === 'CONFLICT' && e.message === 'Demo is busy')
	releaseUpdate()
	fx.setPullWait(null)
	assert.equal(await updating, true)
	assert.equal((await fx.call('apps.list')).find((a) => a.id === 'demo').version, '2')
})

test('a failed install precheck does not leave the app busy', async (t) => {
	const fx = await setup(t, {
		apps: [{id: 'lowapp', name: 'lowapp', port: 80, compose: proxyCompose('')}],
	})
	await assert.rejects(fx.call('apps.install', {appId: 'lowapp'}), (e) => e instanceof RpcError && e.message === 'lowapp uses port 80. Apps need a port of 1024 or higher')
	await assert.rejects(fx.call('apps.install', {appId: 'lowapp'}), (e) => e instanceof RpcError && e.message === 'lowapp uses port 80. Apps need a port of 1024 or higher')
	assert.deepEqual(await fx.call('apps.list'), [])
})

test('an update drops listing files the new listing removed and keeps data files', async (t) => {
	const port = await freePort()
	const fx = await setup(t, {
		apps: [{
			id: 'img',
			name: 'Img',
			port,
			version: '1',
			composeName: 'omarchy-compose.yml',
			exports: 'export LEGACY=1\n',
			compose: 'services:\n  web:\n    image: example/one:1\n    volumes:\n      - ${APP_DATA_DIR}/data:/data\n',
		}],
	})
	await fx.call('apps.install', {appId: 'img'})
	await fx.installed('img')
	const dir = join(fx.data, 'apps', 'installed', 'img')
	await mkdir(join(dir, 'data'), {recursive: true})
	await writeFile(join(dir, 'data', 'exports.sh'), 'keep-me\n')
	await writeFile(join(dir, 'data', 'omarchy-compose.yml'), 'image: example/one:1\n')
	await rm(join(fx.store, 'img', 'omarchy-compose.yml'))
	await rm(join(fx.store, 'img', 'exports.sh'))
	await writeFile(join(fx.store, 'img', 'docker-compose.yml'), 'services:\n  web:\n    image: example/two:2\n    volumes:\n      - ${APP_DATA_DIR}/data:/data\n')
	await writeFile(join(fx.store, 'img', 'omarchy-app.yml'), `manifestVersion: 1\nid: img\nname: Img\nversion: "2"\nport: ${port}\n`)
	git(fx.store, 'add', '-A')
	git(fx.store, 'commit', '-qm', 'switch compose')
	await fx.call('appStore.refresh')
	assert.equal(await fx.call('apps.update', {appId: 'img'}), true)
	assert.equal(await there(join(dir, 'omarchy-compose.yml')), false)
	assert.equal(await there(join(dir, 'exports.sh')), false)
	assert.equal(await readFile(join(dir, 'data', 'exports.sh'), 'utf8'), 'keep-me\n')
	assert.match(await readFile(join(dir, 'data', 'omarchy-compose.yml'), 'utf8'), /example\/one:1/)
	const ran = await readFile(join(dir, 'compose.omarchy.yml'), 'utf8')
	assert.match(ran, /example\/two:2/)
	assert.doesNotMatch(ran, /example\/one:1/)
})

test('updating a stopped app does not start it; a running app stays up', async (t) => {
	const port = await freePort()
	const fx = await setup(t, {
		apps: [{id: 'box', name: 'Box', port, version: '1', compose: proxyCompose('')}],
	})
	await fx.call('apps.install', {appId: 'box'})
	await fx.installed('box')
	assert.equal(await fx.call('apps.stop', {appId: 'box'}), true)
	await writeFile(join(fx.store, 'box', 'omarchy-app.yml'), `manifestVersion: 1\nid: box\nname: Box\nversion: "2"\nport: ${port}\n`)
	git(fx.store, 'add', '-A')
	git(fx.store, 'commit', '-qm', 'v2')
	await fx.call('appStore.refresh')
	assert.equal(await fx.call('apps.update', {appId: 'box'}), true)
	const stoppedUp = fx.composeCalls.filter((c) => c.args[1] === 'omarchy-box' && c.args.includes('up')).at(-1).args
	assert.ok(stoppedUp.includes('--no-start'), `stopped update started the app: ${stoppedUp.join(' ')}`)
	assert.equal(fx.up.has('omarchy-box'), false)
	assert.equal((await fx.call('apps.list')).find((a) => a.id === 'box').state, 'stopped')
	assert.equal(await fx.call('apps.start', {appId: 'box'}), true)
	await writeFile(join(fx.store, 'box', 'omarchy-app.yml'), `manifestVersion: 1\nid: box\nname: Box\nversion: "3"\nport: ${port}\n`)
	git(fx.store, 'add', '-A')
	git(fx.store, 'commit', '-qm', 'v3')
	await fx.call('appStore.refresh')
	assert.equal(await fx.call('apps.update', {appId: 'box'}), true)
	const runningUp = fx.composeCalls.filter((c) => c.args[1] === 'omarchy-box' && c.args.includes('up')).at(-1).args
	assert.ok(!runningUp.includes('--no-start'))
	assert.ok(runningUp.includes('-d'))
	assert.equal(fx.up.has('omarchy-box'), true)
	assert.equal((await fx.call('apps.list')).find((a) => a.id === 'box').state, 'running')
})

test('two Tor apps uninstalled together both finish and the proxy stops', async (t) => {
	const a = await freePort()
	const b = await freePort()
	const compose = 'services:\n  web:\n    image: x\n    environment:\n      TOR_PROXY: ${TOR_PROXY_IP}:${TOR_PROXY_PORT}\n'
	const fx = await setup(t, {
		apps: [
			{id: 'tor-a', name: 'Tor A', port: a, compose},
			{id: 'tor-b', name: 'Tor B', port: b, compose},
		],
	})
	await fx.call('apps.install', {appId: 'tor-a'})
	await fx.call('apps.install', {appId: 'tor-b'})
	await fx.installed('tor-a')
	await fx.installed('tor-b')
	const torDir = join(fx.data, 'apps', 'system', 'tor')
	assert.equal(await there(torDir), true)
	const results = await Promise.allSettled([
		fx.call('apps.uninstall', {appId: 'tor-a'}),
		fx.call('apps.uninstall', {appId: 'tor-b'}),
	])
	assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'])
	assert.equal(fx.up.has('omarchy-tor'), false)
	assert.equal(await there(torDir), false)
	assert.equal(await fx.apps.uninstallAll(), 0)
	assert.equal(await there(torDir), false)
})

test('an app that depends on itself or a cycle is unsupported, not a port clash', async (t) => {
	const a = await freePort()
	const b = await freePort()
	const c = await freePort()
	const fx = await setup(t, {
		apps: [
			{id: 'loopapp', name: 'loopapp', port: a, extra: 'dependencies:\n  - loopapp\n', compose: proxyCompose('')},
			{id: 'cycle-a', name: 'Cycle A', port: b, extra: 'dependencies:\n  - cycle-b\n', compose: proxyCompose('')},
			{id: 'cycle-b', name: 'Cycle B', port: c, extra: 'dependencies:\n  - cycle-a\n', compose: proxyCompose('')},
		],
	})
	const reg = (await fx.call('appStore.registry'))[0].apps
	const self = reg.find((x) => x.id === 'loopapp')
	assert.match(self.unsupported, /depends on itself/)
	assert.equal((self.needs ?? []).includes('loopapp'), false)
	for (const id of ['cycle-a', 'cycle-b']) assert.match(reg.find((x) => x.id === id).unsupported, /dependency loop/)
	await assert.rejects(fx.call('apps.install', {appId: 'loopapp'}), (e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /depends on itself/.test(e.message) && !/already in use/.test(e.message))
	await assert.rejects(fx.call('apps.install', {appId: 'cycle-a'}), (e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /dependency loop/.test(e.message) && !/already in use/.test(e.message))
	assert.deepEqual(await fx.call('apps.list'), [])
})

test('exports.sh low port is shown at review and is not published without a grant', async (t) => {
	const low = await freePort()
	const high = await freePort()
	const compose = `services:\n  app_proxy:\n    environment:\n      APP_HOST: web\n      APP_PORT: "80"\n  web:\n    image: example/low:1\n    ports:\n      - "\${PORT:-8080}:80"\n`
	const fx = await setup(t, {
		apps: [
			{id: 'lowapp', name: 'Low', port: low, compose, exports: 'export PORT=443\n'},
			{id: 'highapp', name: 'High', port: high, compose, exports: 'export PORT=8080\n'},
		],
	})
	const review = await fx.call('apps.installReview', {appId: 'lowapp'})
	const perm = review.permissions.find((p) => p.id === 'low-ports')
	assert.ok(perm, 'review listed no low-ports permission')
	assert.ok(perm.what.map(String).includes('443'), `low-ports what=${perm.what.join(',')}`)
	const highReview = await fx.call('apps.installReview', {appId: 'highapp'})
	assert.equal(highReview.permissions.some((p) => p.id === 'low-ports'), false)
	await assert.rejects(fx.call('apps.install', {appId: 'lowapp', grant: []}), /Installing needs your permission/)
	assert.deepEqual(fx.lows, [])
	assert.equal(fx.up.has('omarchy-lowapp'), false)
	assert.equal((await fx.call('apps.list')).some((a) => a.id === 'lowapp'), false)
	await fx.call('apps.install', {appId: 'lowapp', grant: ['low-ports']})
	await fx.installed('lowapp')
	assert.deepEqual(fx.lows, [443])
	const placed = await readFile(join(fx.data, 'apps', 'installed', 'lowapp', 'compose.omarchy.yml'), 'utf8')
	assert.match(placed, /443:80|\$\{PORT:-8080\}:80/)
	await fx.call('apps.install', {appId: 'highapp', grant: []})
	await fx.installed('highapp')
	assert.deepEqual(fx.lows, [443])
})

test('install port errors distinguish low, invalid, and reserved ports', async (t) => {
	const fx = await setup(t, {
		apps: [
			{id: 'lowapp', name: 'lowapp', port: 80, compose: proxyCompose('')},
			{id: 'huge', name: 'huge', port: 70000, compose: proxyCompose('')},
			{id: 'kept', name: 'kept', port: 7780, compose: proxyCompose('')},
			{id: 'wide', name: 'wide', port: 45000, compose: proxyCompose('')},
			{id: 'old', name: 'old', port: 2021, compose: proxyCompose('')},
		],
	})
	await assert.rejects(fx.call('apps.install', {appId: 'lowapp'}), (e) => e.message === 'lowapp uses port 80. Apps need a port of 1024 or higher')
	await assert.rejects(fx.call('apps.install', {appId: 'huge'}), (e) => e.message === 'huge lists port 70000, which is not a valid port')
	await assert.rejects(fx.call('apps.install', {appId: 'kept'}), (e) => e.message === 'kept wants port 7780, which this server keeps for itself')
	await assert.rejects(fx.call('apps.install', {appId: 'wide'}), (e) => e.message === 'wide wants port 45000, which this server keeps for itself')
	await assert.rejects(fx.call('apps.install', {appId: 'old'}), (e) => e.message === 'old wants port 2021, which this server keeps for itself')
})

test('serverIp gives a compose app the LAN address, not a bridge address', async (t) => {
	const port = await freePort()
	const fx = await setup(t, {
		interfaces: {
			docker0: [{family: 'IPv4', internal: false, address: '172.17.0.1'}],
			podman0: [{family: 'IPv4', internal: false, address: '10.88.1.1'}],
			eth0: [{family: 'IPv4', internal: false, address: '172.20.1.5'}],
		},
		apps: [{id: 'lan', name: 'Lan', port, compose: proxyCompose('')}],
	})
	await fx.call('apps.install', {appId: 'lan'})
	await fx.installed('lan')
	const up = fx.composeCalls.find((c) => c.args[1] === 'omarchy-lan' && c.args.includes('up'))
	assert.equal(up.env.SERVER_IP, '172.20.1.5')
})

test('a failed check for new apps names the store and the git error', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-refresh-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const store = join(root, 'store')
	await mkdir(join(store, 'aa'), {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(store, 'aa', 'omarchy-app.yml'), 'manifestVersion: 1\nid: aa\nname: Aa\nversion: "1"\nport: 35111\n')
	await writeFile(join(store, 'aa', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n')
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '-A')
	git(store, 'commit', '-qm', 'init')
	const url = `file://${store}`
	let fail = false
	let fetches = 0
	let release
	let seen
	const started = new Promise((r) => (seen = r))
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (fail && args.includes('fetch')) {
				fetches++
				if (fetches === 1) {
					seen()
					await new Promise((r) => (release = r))
				}
				const error = new Error('git failed')
				error.stderr = 'hint: check the address\nfatal: could not read from remote\n'
				throw error
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		if (cmd === 'docker-compose' && args[0] === 'version') return 'Docker Compose version v2.30.0'
		return ''
	}
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())
	await apps.procedures['appStore.addRepository'].run({url})
	const before = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(before[0].apps.map((a) => a.id), ['aa'])
	fail = true
	const one = apps.procedures['appStore.refresh'].run()
	const two = apps.procedures['appStore.refresh'].run()
	await started
	release()
	const want = `Couldn't reach ${url}: fatal: could not read from remote`
	for (const p of [one, two]) {
		await assert.rejects(p, (e) => e instanceof RpcError && e.code === 'BAD_GATEWAY' && e.message === want)
	}
	assert.equal(fetches, 1, 'one shared download for both callers')
	const after = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(after[0].apps.map((a) => a.id), ['aa'], 'a failed refresh is not cached as an empty store')
	fail = false
	assert.equal(typeof await apps.procedures['appStore.refresh'].run(), 'number')
})
