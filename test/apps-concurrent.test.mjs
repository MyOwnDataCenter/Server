// Concurrent app installs, updates, and store additions must serialize safely without leaving duplicate or broken state.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const gitSync = (cwd, ...args) =>
	execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()

function gitAsync(args, cwd, delayMs = 0) {
	return new Promise((resolve, reject) => {
		const runIt = () =>
			execFile('git', args, {cwd, maxBuffer: 8 * 1024 * 1024}, (err, stdout) => {
				if (err) return reject(err)
				resolve(stdout.toString())
			})
		if (delayMs > 0) setTimeout(runIt, delayMs)
		else runIt()
	})
}

async function freeAppPort() {
	for (let attempt = 0; attempt < 40; attempt++) {
		const candidate = 29_000 + Math.floor(Math.random() * 3_768)
		const ok = await new Promise((resolve) => {
			const s = net.createServer()
			s.once('error', () => resolve(false))
			s.listen(candidate, '0.0.0.0', () => s.close(() => resolve(true)))
		})
		if (ok) return candidate
	}
	throw new Error('no free port found')
}

async function createStoreRepo(dir, appsList) {
	await mkdir(dir, {recursive: true})
	await writeFile(join(dir, 'omarchy-app-store.yml'), 'id: demo\nname: Demo Store\n')
	for (const app of appsList) {
		await mkdir(join(dir, app.id), {recursive: true})
		await writeFile(
			join(dir, app.id, 'omarchy-app.yml'),
			`manifestVersion: 1\nid: ${app.id}\nname: ${app.name}\ntagline: Says hello\nversion: "${app.version ?? '1.0'}"\nport: ${app.port}\nicon: https://example.com/i.svg\ndefaultPassword: ""\n`,
		)
		await writeFile(
			join(dir, app.id, 'docker-compose.yml'),
			`version: "3.7"\nservices:\n  app_proxy:\n    environment:\n      APP_HOST: ${app.id}_web_1\n      APP_PORT: 8080\n  web:\n    image: example/${app.id}:${app.version ?? '1'}\n    volumes:\n      - \${APP_DATA_DIR}/data:/data\n`,
		)
	}
	gitSync(dir, 'init', '-q', '-b', 'main')
	gitSync(dir, 'add', '.')
	gitSync(dir, 'commit', '-qm', 'init')
	return `file://${dir}`
}

async function setupApps(t, {defaultStores = true, gitDelayMs = 0} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-apps-conc-'))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const storeDir = join(root, 'store')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	const port = await freeAppPort()
	const storeUrl = await createStoreRepo(storeDir, [{id: 'demo-app', name: 'Demo App', port, version: '1.0'}])
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	const prevDockerHost = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`

	let pullGate = null
	const up = new Set()
	const networks = new Set()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return gitAsync(args, opts.cwd, gitDelayMs)
		if (cmd === 'systemctl' || cmd === 'setfacl') return ''
		if (cmd === 'podman') {
			if (args[0] === 'info') {
				await wait(30)
				return '{}'
			}
			if (args[0] === 'network' && args[1] === 'exists' && !networks.has(args[2])) throw new Error('no such network')
			if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1))
			if (args[1] === 'rm') await rm(args.at(-1), {recursive: true, force: true})
			return ''
		}
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const project = args[1]
			const verb = args[4]
			if (verb === 'pull') {
				if (pullGate) await pullGate()
				else await wait(40)
				return ''
			}
			if (verb === 'up' || verb === 'restart') up.add(project)
			if (verb === 'stop' || verb === 'down') up.delete(project)
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(project) ? 'running' : 'exited'}])
			return ''
		}
		throw new Error(`${cmd} not simulated`)
	}

	const apps = createApps({
		dataDir,
		home,
		allowFileStores: true,
		gatewayHost: '127.0.0.1',
		defaultStores: defaultStores ? [{url: storeUrl}] : [],
		run,
		systemApps: null,
	})
	t.after(async () => {
		apps.close()
		if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDockerHost
		await rm(root, {recursive: true, force: true})
	})
	return {root, dataDir, storeDir, storeUrl, apps, port, setPullGate: (fn) => (pullGate = fn)}
}

async function waitInstalled(apps, id) {
	const end = Date.now() + 5000
	while (!apps.importState(id).done) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${id}`)
		await wait(15)
	}
}

test('concurrent installs of the same app allow one and refuse the duplicate', async (t) => {
	const {dataDir, apps} = await setupApps(t)
	await apps.procedures['appStore.registry'].run()
	const results = await Promise.allSettled([
		apps.procedures['apps.install'].run({appId: 'demo-app'}),
		apps.procedures['apps.install'].run({appId: 'demo-app'}),
	])
	await waitInstalled(apps, 'demo-app')
	const fulfilled = results.filter((r) => r.status === 'fulfilled')
	const rejected = results.filter((r) => r.status === 'rejected')
	assert.equal(fulfilled.length, 1)
	assert.equal(fulfilled[0].value, true)
	assert.equal(rejected.length, 1)
	assert.ok(rejected[0].reason instanceof RpcError)
	assert.equal(rejected[0].reason.code, 'CONFLICT')
	assert.match(rejected[0].reason.message, /already installed/)

	const listed = (await apps.procedures['apps.list'].run()).filter((a) => a.id === 'demo-app')
	assert.equal(listed.length, 1)
	assert.notEqual(listed[0].state, 'error')
	const saved = JSON.parse(await readFile(join(dataDir, 'apps', 'apps.json'), 'utf8'))
	assert.equal(saved.apps.filter((a) => a.id === 'demo-app').length, 1)
})

test('concurrent updates refuse the second request without clearing the busy marker', async (t) => {
	const {storeDir, apps, port, setPullGate} = await setupApps(t)
	await apps.procedures['appStore.registry'].run()
	await apps.procedures['apps.install'].run({appId: 'demo-app'})
	await waitInstalled(apps, 'demo-app')

	await writeFile(
		join(storeDir, 'demo-app', 'omarchy-app.yml'),
		`manifestVersion: 1\nid: demo-app\nname: Demo App\ntagline: Says hello\nversion: "1.1"\nport: ${port}\nicon: https://example.com/i.svg\ndefaultPassword: ""\n`,
	)
	gitSync(storeDir, 'add', '.')
	gitSync(storeDir, 'commit', '-qm', 'v1.1')
	await apps.procedures['appStore.refresh'].run()

	let pulls = 0
	let pullStartedResolve
	const pullStarted = new Promise((r) => (pullStartedResolve = r))
	let pullRelease
	const pullWait = new Promise((r) => (pullRelease = r))
	setPullGate(async () => {
		if (++pulls === 1) {
			pullStartedResolve()
			await pullWait
		}
	})

	const p1 = apps.procedures['apps.update'].run({appId: 'demo-app'})
	const p2 = apps.procedures['apps.update'].run({appId: 'demo-app'})
	try {
		await assert.rejects(p2, (e) => e instanceof RpcError && e.code === 'CONFLICT' && e.message === 'Demo App is busy')

		await pullStarted
		await assert.rejects(
			apps.procedures['apps.stop'].run({appId: 'demo-app'}),
			(e) => e instanceof RpcError && e.code === 'CONFLICT' && e.message === 'Demo App is busy',
		)

		pullRelease()
		setPullGate(null)
		assert.equal(await p1, true)
	} finally {
		pullRelease?.()
		setPullGate(null)
		await Promise.allSettled([p1, p2])
	}
	const listed = (await apps.procedures['apps.list'].run()).find((a) => a.id === 'demo-app')
	assert.equal(listed.version, '1.1')
	assert.equal(await apps.procedures['apps.stop'].run({appId: 'demo-app'}), true)

	// An update that exits early (app removed from store) must release busy cleanly.
	await rm(join(storeDir, 'demo-app'), {recursive: true, force: true})
	gitSync(storeDir, 'add', '-A')
	gitSync(storeDir, 'commit', '-qm', 'remove demo-app')
	await apps.procedures['appStore.refresh'].run()
	await assert.rejects(apps.procedures['apps.update'].run({appId: 'demo-app'}), (e) => e instanceof RpcError && e.code === 'NOT_FOUND')
	assert.equal(await apps.procedures['apps.start'].run({appId: 'demo-app'}), true)
})

test('concurrent addRepository calls for the same store allow one and refuse the duplicate', async (t) => {
	const {root, storeUrl, apps, port} = await setupApps(t, {defaultStores: false, gitDelayMs: 25})
	const results = await Promise.allSettled([
		apps.procedures['appStore.addRepository'].run({url: storeUrl}),
		apps.procedures['appStore.addRepository'].run({url: storeUrl}),
	])
	const fulfilled = results.filter((r) => r.status === 'fulfilled')
	const rejected = results.filter((r) => r.status === 'rejected')
	assert.equal(fulfilled.length, 1)
	assert.equal(fulfilled[0].value, true)
	assert.equal(rejected.length, 1)
	assert.ok(rejected[0].reason instanceof RpcError)
	assert.equal(rejected[0].reason.code, 'CONFLICT')
	assert.equal(rejected[0].reason.message, 'That store is already added')

	const repos = await apps.procedures['appStore.repositories'].run()
	assert.equal(repos.length, 1)
	assert.equal(repos[0].url, storeUrl)
	const reg = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(reg[0].apps.map((a) => a.id), ['demo-app'])

	// A failed addRepository must not block adding a store afterwards.
	await assert.rejects(
		apps.procedures['appStore.addRepository'].run({url: `file://${join(root, 'missing-store')}`}),
		(e) => e instanceof RpcError && e.code === 'BAD_REQUEST',
	)
	const extraUrl = await createStoreRepo(join(root, 'extra-store'), [{id: 'extra-app', name: 'Extra App', port: port + 1}])
	assert.equal(await apps.procedures['appStore.addRepository'].run({url: extraUrl}), true)
	assert.equal((await apps.procedures['appStore.repositories'].run()).length, 2)
})
