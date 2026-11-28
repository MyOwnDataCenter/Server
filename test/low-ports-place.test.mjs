// Install-time floor: placeApp must lower it to the host port Compose will bind.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'
import {freePorts} from './free-port.mjs'

test('placeApp asks for the port Compose binds, not an unused ${PORT:-default}', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-low-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const prevPort = process.env.PORT
	const prevDocker = process.env.DOCKER_HOST
	delete process.env.PORT
	process.env.DOCKER_HOST = `unix://${sock}`
	const lows = []
	const up = new Set()
	const git = (args) => execFileSync('git', gitArgv(args), {stdio: 'pipe'}).toString()
	const run = async (cmd, args) => {
		if (cmd === 'git') return git(args)
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') return ''
		if (cmd === 'setfacl') return ''
		if (cmd === 'bwrap') {
			const env = {}
			for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') (env[args[i + 1]] = args[i + 2]), (i += 2)
			// The sandbox writes /tmp/.wanted; keep that off the real /tmp so another app's list is not reused.
			const script = String(args.at(-1)).replaceAll('/tmp/.wanted', join(root, '.wanted'))
			return execFileSync('bash', ['-c', script], {env: {...env, PATH: '/usr/bin:/bin'}}).toString()
		}
		throw new Error(`${cmd} not simulated`)
	}
	const [base] = await freePorts(5)
	// Short syntax, long syntax, and an exports.sh port all have to use the merged env.
	// One installed app's exports are visible to the next, so the app that exports PORT goes last.
	const listings = [
		{id: 'from-dotenv', port: base, compose: 'services:\n  web:\n    image: x\n    ports:\n      - "${PORT:-22}:80"\n', env: 'PORT=443\n', grant: ['low-ports'], want: 443},
		{id: 'from-default', port: base + 1, compose: 'services:\n  web:\n    image: x\n    ports:\n      - "${PORT:-22}:80"\n', grant: ['low-ports'], want: 22},
		{id: 'from-high', port: base + 2, compose: 'services:\n  web:\n    image: x\n    ports:\n      - "${PORT:-22}:80"\n', env: 'PORT=8080\n', grant: [], want: null},
		{id: 'from-real-low', port: base + 3, compose: 'services:\n  web:\n    image: x\n    ports:\n      - "${PORT:-8080}:80"\n', env: 'PORT=80\n', grant: ['low-ports'], want: 80},
		{id: 'from-export', port: base + 4, compose: 'services:\n  web:\n    image: x\n    ports:\n      - target: 80\n        published: "${PORT:-22}"\n', exports: 'export PORT=443\n', grant: ['low-ports'], want: 443},
	]
	let apps
	try {
		await writeFile(sock, '')
		await mkdir(store, {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		for (const row of listings) {
			await mkdir(join(store, row.id), {recursive: true})
			await writeFile(join(store, row.id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${row.id}\nname: ${row.id}\nversion: "1"\nport: ${row.port}\n`)
			await writeFile(join(store, row.id, 'docker-compose.yml'), row.compose)
			if (row.env) await writeFile(join(store, row.id, '.env'), row.env)
			if (row.exports) await writeFile(join(store, row.id, 'exports.sh'), row.exports)
		}
		git(['init', '-q', '-b', 'main', store])
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', store, 'add', '.'])
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', store, 'commit', '-qm', 'apps'])
		apps = createApps({dataDir: data, home, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null, run, firewall: {open: async () => {}, close: async () => {}, lowPorts: async (n) => lows.push(n)}})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('appStore.addRepository', {url: `file://${store}`})
		const until = async (fn, ms = 8000) => {
			const end = Date.now() + ms
			for (;;) {
				const v = await fn()
				if (v) return v
				if (Date.now() > end) throw new Error('timed out')
				await new Promise((r) => setTimeout(r, 30))
			}
		}
		for (const row of listings) {
			const before = lows.length
			await call('apps.install', {appId: row.id, grant: row.grant})
			const app = await until(async () => {
				const found = (await call('apps.list')).find((a) => a.id === row.id)
				if (found?.state === 'error') throw new Error(found.error || 'install failed')
				return found && found.state !== 'installing' ? found : null
			})
			assert.ok(app.state === 'running' || app.state == null, `${row.id} installed`)
			const got = lows.slice(before)
			if (row.want === null) assert.deepEqual(got, [], `${row.id} must not lower the floor to the unused default 22`)
			else assert.deepEqual(got, [row.want], `${row.id} lowers the floor to the port Compose binds`)
		}
	} finally {
		await apps?.close()
		if (prevPort === undefined) delete process.env.PORT
		else process.env.PORT = prevPort
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
})
