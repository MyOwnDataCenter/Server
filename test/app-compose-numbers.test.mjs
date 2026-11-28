// Compose numbers, nested defaults, symlinked home, update ports, a failed update, and Tailscale uninstall.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps, expandVars, prepareCompose} from '../omarchyd/apps.mjs'
import {freePort} from './free-port.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {createSystemApps} from '../omarchyd/system-apps.mjs'

test('prepareCompose keeps numeric scalar text while still rewriting ports', () => {
	const text = [
		'services:',
		'  app_proxy:',
		'    environment:',
		'      APP_HOST: demo_web_1',
		'      APP_PORT: 8080',
		'  web:',
		'    image: x',
		'    environment:',
		'      DISCORD_GUILD_ID: 1081234567890123456',
		'      UMASK: 022',
		'    volumes:',
		'      - type: bind',
		'        source: ./secret',
		'        target: /secret',
		'        mode: 0400',
		'    configs:',
		'      - source: sticky',
		'        target: /sticky',
		'        mode: 01777',
		'',
	].join('\n')
	const out = prepareCompose('demo', text, () => 21234)
	assert.equal(out.internalPort, 21234)
	assert.match(out.text, /127\.0\.0\.1:21234:8080/)
	assert.doesNotMatch(out.text, /app_proxy/)
	assert.match(out.text, /DISCORD_GUILD_ID: 1081234567890123456\b/)
	assert.match(out.text, /UMASK: 022\b/)
	assert.match(out.text, /mode: 0400\b/)
	assert.match(out.text, /mode: 01777\b/)
	assert.doesNotMatch(out.text, /DISCORD_GUILD_ID: 1081234567890123500/)
	assert.doesNotMatch(out.text, /UMASK: 22\b/)
	assert.doesNotMatch(out.text, /mode: 400\b/)
	assert.doesNotMatch(out.text, /mode: 1777\b/)
})

test('expandVars expands a nested default and keeps the plain forms', () => {
	assert.equal(expandVars('${DATA_DIR:-${APP_DATA_DIR}/data}', {APP_DATA_DIR: '/srv/apps/x'}), '/srv/apps/x/data')
	assert.equal(expandVars('${DATA_DIR:-${APP_DATA_DIR}/data}', {DATA_DIR: '/data/mine', APP_DATA_DIR: '/srv/apps/x'}), '/data/mine')
	assert.equal(expandVars('${DATA_DIR:-/var/lib/data}', {}), '/var/lib/data')
	assert.equal(expandVars('${NAME}', {NAME: 'ada'}), 'ada')
	assert.equal(expandVars('$NAME', {NAME: 'ada'}), 'ada')
	assert.equal(expandVars('${EMPTY:-fallback}', {EMPTY: ''}), 'fallback')
	assert.equal(expandVars('${EMPTY-fallback}', {EMPTY: ''}), '')
	assert.equal(expandVars('${SET:+alt}', {SET: 'x'}), 'alt')
	assert.equal(expandVars('${SET+alt}', {SET: ''}), 'alt')
	assert.equal(expandVars('${UNSET:+alt}', {}), '')
	assert.equal(expandVars('pre ${DATA_DIR:-${APP_DATA_DIR}/data} post', {APP_DATA_DIR: '/srv/apps/x'}), 'pre /srv/apps/x/data post')
})

function git(args, cwd) {
	return execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()
}

function engineRun({pullFail, calls, up, root}) {
	return async (cmd, args) => {
		if (cmd === 'git') return execFileSync('git', args, {stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			calls.push({args})
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'pull' && pullFail.current) throw new Error('manifest unknown')
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') return ''
		if (cmd === 'setfacl') return ''
		if (cmd === 'systemctl') return ''
		if (cmd === 'bwrap') {
			const env = {}
			for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') (env[args[i + 1]] = args[i + 2]), (i += 2)
			const script = String(args.at(-1)).replaceAll('/tmp/.wanted', join(root, '.wanted'))
			return execFileSync('bash', ['-c', script], {env: {...env, PATH: '/usr/bin:/bin'}}).toString()
		}
		throw new Error(`${cmd} not simulated`)
	}
}

async function withStore(appBody, fn) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-compose-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const calls = []
	const up = new Set()
	const pullFail = {current: false}
	const fw = {open: [], close: []}
	let apps
	try {
		await writeFile(sock, '')
		await mkdir(home, {recursive: true})
		await mkdir(join(store, 'demo'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, 'demo', 'omarchy-app.yml'), appBody.manifest)
		await writeFile(join(store, 'demo', 'docker-compose.yml'), appBody.compose)
		if (appBody.exports) await writeFile(join(store, 'demo', 'exports.sh'), appBody.exports)
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		apps = createApps({
			dataDir: data,
			home,
			allowFileStores: true,
			gatewayHost: '127.0.0.1',
			defaultStores: [],
			systemApps: null,
			run: engineRun({pullFail, calls, up, root}),
			firewall: {open: async (p) => fw.open.push(p), close: async (p) => fw.close.push(p)},
		})
		const call = (name, input) => apps.procedures[name].run(input)
		const url = `file://${store}`
		await call('appStore.addRepository', {url})
		await fn({root, data, home, store, url, apps, call, fw, pullFail, calls})
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
}

const untilInstalled = async (call, id) => {
	const end = Date.now() + 8000
	for (;;) {
		const found = (await call('apps.list')).find((a) => a.id === id)
		if (found?.error) throw new Error(found.error)
		if (found && found.state !== 'installing') return found
		if (Date.now() > end) throw new Error('timed out')
		await new Promise((r) => setTimeout(r, 30))
	}
}

test('update closes dropped openPorts and opens the listing’s new ones', async () => {
	const port = await freePort()
	const manifest = (version, ports) => `manifestVersion: 1\nid: demo\nname: Demo\nversion: "${version}"\nport: ${port}\nweb:\n  service: web\n  port: 8080\nopenPorts: [${ports}]\n`
	await withStore(
		{manifest: manifest('1', '1'), compose: 'services:\n  web:\n    image: example/demo:1\n    ports:\n      - "8080:8080"\n'},
		async ({data, store, url, call, fw}) => {
			await call('apps.install', {appId: 'demo'})
			await untilInstalled(call, 'demo')
			const openedAtInstall = fw.open.slice()
			assert.ok(openedAtInstall.includes(1), 'install opens the original port')
			await writeFile(join(store, 'demo', 'omarchy-app.yml'), manifest('2', '2'))
			git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
			git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v2'], store)
			await call('appStore.removeRepository', {url})
			await call('appStore.addRepository', {url})
			const beforeClose = fw.close.length
			const beforeOpen = fw.open.length
			await call('apps.update', {appId: 'demo'})
			const app = await untilInstalled(call, 'demo')
			assert.equal(app.version, '2')
			assert.ok(fw.close.slice(beforeClose).includes(1), 'the dropped port was closed')
			assert.ok(!fw.close.slice(beforeClose).includes(2), 'the new port was not closed')
			assert.ok(fw.open.slice(beforeOpen).includes(2), 'the new port was opened')
			const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
			assert.deepEqual(saved.apps.find((a) => a.id === 'demo').openPorts, [2])
		},
	)
})

test('a symlink home accepts a folder in the real directory and still refuses one outside', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-homelink-'))
	const realHome = join(root, 'real-home')
	const home = join(root, 'home')
	const data = join(root, 'data')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const port = await freePort()
	let apps
	try {
		await mkdir(realHome, {recursive: true})
		await symlink(realHome, home)
		await writeFile(sock, '')
		await mkdir(join(store, 'box'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, 'box', 'omarchy-app.yml'), `manifestVersion: 1\nid: box\nname: Box\nversion: "1"\nport: ${port}\nweb:\n  service: web\n  port: 8787\nfolders:\n  - id: notes\n    label: Notes\n`)
		await writeFile(join(store, 'box', 'docker-compose.yml'), 'services:\n  web:\n    image: example/box:1\n    volumes:\n      - ${FOLDER_NOTES}:/notes\n    ports:\n      - "8787:8787"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		const calls = []
		const up = new Set()
		apps = createApps({
			dataDir: data,
			home,
			allowFileStores: true,
			gatewayHost: '127.0.0.1',
			defaultStores: [],
			systemApps: null,
			run: engineRun({pullFail: {current: false}, calls, up, root}),
			firewall: {open: async () => {}, close: async () => {}},
		})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('appStore.addRepository', {url: `file://${store}`})
		const place = (path) => call('apps.install', {appId: 'box', folders: [{appId: 'box', id: 'notes', path}]})
		await assert.rejects(place('/tmp'), /outside your home|can’t use/)
		await symlink('/tmp', join(realHome, 'escape'))
		await assert.rejects(place(join(home, 'escape')), /outside your home folder/)
		const notes = join(home, 'Notes')
		await place(notes)
		const app = await untilInstalled(call, 'box')
		assert.equal(app.id, 'box')
		assert.equal((await stat(join(realHome, 'Notes'))).isDirectory(), true)
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
})

test('a failed pull restores the previous compose file and exports', async () => {
	const port = await freePort()
	const manifest = (version) => `manifestVersion: 1\nid: demo\nname: Demo\nversion: "${version}"\nport: ${port}\nweb:\n  service: web\n  port: 8080\n`
	await withStore(
		{
			manifest: manifest('1.0'),
			compose: 'services:\n  web:\n    image: example/demo:1\n    ports:\n      - "8080:8080"\n',
			exports: 'export KEEP_EXPORT=original\n',
		},
		async ({data, store, url, call, pullFail}) => {
			await call('apps.install', {appId: 'demo'})
			await untilInstalled(call, 'demo')
			const composePath = join(data, 'apps', 'installed', 'demo', 'compose.omarchy.yml')
			const beforeBytes = await readFile(composePath)
			const before = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8')).apps.find((a) => a.id === 'demo')
			assert.equal(before.exports.KEEP_EXPORT, 'original')
			await writeFile(join(store, 'demo', 'omarchy-app.yml'), manifest('2.0'))
			await writeFile(join(store, 'demo', 'docker-compose.yml'), 'services:\n  web:\n    image: example/demo:2\n    environment:\n      NEW_THING: yes\n    ports:\n      - "8080:8080"\n')
			await writeFile(join(store, 'demo', 'exports.sh'), 'export KEEP_EXPORT=changed\nexport NEW_EXPORT=yes\n')
			git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
			git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v2'], store)
			await call('appStore.removeRepository', {url})
			await call('appStore.addRepository', {url})
			pullFail.current = true
			await assert.rejects(call('apps.update', {appId: 'demo'}), /Couldn’t update Demo while downloading the new version/)
			const afterBytes = await readFile(composePath)
			assert.deepEqual(afterBytes, beforeBytes)
			const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
			const app = saved.apps.find((a) => a.id === 'demo')
			assert.equal(app.version, '1.0')
			assert.deepEqual(app.exports, before.exports)
			assert.ok((await call('apps.list')).some((a) => a.id === 'demo'))
		},
	)
})

test('a failed Tailscale uninstall keeps the page running and the app listed', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-ts-rm-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const port = await freePort()
	const kills = []
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${join(root, 'podman.sock')}`
	let apps
	try {
		await mkdir(home, {recursive: true})
		await writeFile(process.env.DOCKER_HOST.slice('unix://'.length), '')
		const helperFile = join(root, 'helper.mjs')
		await writeFile(helperFile, "const verbs = {\n\t'tailscale-setup': async () => {},\n\t'tailscale-remove': async () => {},\n}\n")
		const systemApps = createSystemApps({
			helper: async (verb) => {
				if (verb === 'tailscale-remove') throw new Error('remove refused')
				if (verb === 'tailscale-setup') return JSON.stringify({installedPackage: true})
				return 'ok'
			},
			helperFile,
			tailscaleBin: join(root, 'tailscale'),
			socketPath: join(root, 'tailscaled.sock'),
			restartDelayMs: 60_000,
			ports: {tailscale: port},
			spawn: () => {
				const child = new EventEmitter()
				child.stdout = new EventEmitter()
				child.stderr = new EventEmitter()
				child.kill = (sig) => kills.push(sig)
				return child
			},
			run: async (cmd) => {
				if (cmd === 'journalctl') return ''
				throw new Error(`${cmd} not simulated`)
			},
		})
		apps = createApps({
			dataDir: data,
			home,
			allowFileStores: true,
			gatewayHost: '127.0.0.1',
			defaultStores: [],
			systemApps,
			run: async (cmd) => (cmd === 'systemctl' || cmd === 'podman' || cmd === 'docker-compose' ? '' : ''),
			firewall: {open: async () => {}, close: async () => {}},
		})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('apps.install', {appId: 'tailscale', grant: ['system-software']})
		const installed = await untilInstalled(call, 'tailscale')
		assert.equal(installed.system, true)
		let thrown = null
		try {
			await call('apps.uninstall', {appId: 'tailscale'})
		} catch (error) {
			thrown = error
		}
		assert.equal(thrown instanceof RpcError, true)
		assert.match(thrown.message, /Couldn’t uninstall Tailscale: remove refused/)
		assert.deepEqual(kills, [])
		assert.ok((await call('apps.list')).some((a) => a.id === 'tailscale'))
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
})
