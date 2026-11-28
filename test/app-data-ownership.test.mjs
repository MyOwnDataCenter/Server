// An app's data folder lives under ~/.local. That is a hidden folder, but it is still the app's
// own data: the container user has to own it, or an app that runs as user 1000 (Jellyfin) cannot
// write its config and never starts.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {freePort} from './free-port.mjs'

describe('app data under a hidden home folder', () => {
	let root, home, data, d, auth, calls
	const every = []
	const git = (args, cwd) => execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return git(args, opts.cwd)
		if (cmd === 'docker-compose') {
			calls.push({args, env: opts.env})
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			if (args[4] === 'ps') return JSON.stringify([{Service: 'jellyfin', State: 'running'}])
			return ''
		}
		if (cmd === 'podman') {
			every.push(args.join(' '))
			calls.push({podman: args})
			return ''
		}
		if (cmd === 'setfacl') {
			calls.push({setfacl: args})
			return ''
		}
		throw new Error(`${cmd} not simulated`)
	}
	const chowns = () => calls.filter((c) => c.podman?.[0] === 'unshare' && c.podman?.[1] === 'chown').map((c) => c.podman.join(' '))

	before(async () => {
		calls = []
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-own-'))
		home = join(root, 'home')
		data = join(home, '.local/share/omarchy-server/omarchyd')
		const installed = join(data, 'apps/installed/jellyfin')
		await mkdir(join(installed, 'data/config'), {recursive: true})
		await mkdir(join(home, 'Videos'), {recursive: true})
		// An app whose data folder was swapped for a link to your SSH keys.
		const evil = join(data, 'apps/installed/evil')
		await mkdir(join(home, '.ssh/keys'), {recursive: true})
		await mkdir(evil, {recursive: true})
		await symlink(join(home, '.ssh'), join(evil, 'data'))
		await writeFile(join(evil, 'compose.omarchy.yml'), 'services:\n  evil:\n    image: evil/evil:latest\n    volumes:\n      - ./data/keys:/keys\n')
		await writeFile(join(root, 'podman.sock'), '')
		process.env.DOCKER_HOST = `unix://${join(root, 'podman.sock')}`
		await writeFile(join(installed, 'compose.omarchy.yml'), 'services:\n  jellyfin:\n    image: jellyfin/jellyfin:latest\n    user: "1000:1000"\n    volumes:\n      - ${APP_DATA_DIR:-.}/data/config:/config\n      - ${APP_DATA_DIR:-.}/data/cache:/cache\n      - ${VIDEOS_DIR}:/media/videos\n    ports:\n      - "127.0.0.1:21456:8096"\n')
		await writeFile(join(data, 'apps/apps.json'), JSON.stringify({
			stores: [],
			apps: [{id: 'evil', name: 'Evil', version: '1', port: 35199, path: '', permissions: [], dataDirs: [], userDirs: [], internalPort: 21457, installedAt: 1}, {id: 'jellyfin', name: 'Jellyfin', version: 'latest', port: 35111, path: '', permissions: [], dataDirs: [], userDirs: [], internalPort: 21456, installedAt: 1}],
			recent: [],
			defaultsAdded: true,
			umbrelStoreRemoved: true,
			permissionsVersion: 2,
		}))
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			webPort: 7798,
			appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null},
		})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		await d?.close()
		await rm(root, {recursive: true, force: true})
	})

	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const body = await (await fetch(url, init)).json()
		if (body.error) throw new Error(body.error.message)
		return body.result.data
	}

	test('an already installed app gets its data folder under ~/.local handed to the container user', async () => {
		await call('apps.list', undefined, 'query')
		const config = join(data, 'apps/installed/jellyfin/data/config')
		const cache = join(data, 'apps/installed/jellyfin/data/cache')
		const handed = chowns().join('\n')
		assert.match(handed, new RegExp(config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
		assert.match(handed, new RegExp(cache.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
		assert.doesNotMatch(handed, /\.ssh/)
		const saved = JSON.parse(await readFile(join(data, 'apps/apps.json'), 'utf8'))
		assert.ok(saved.apps.find((a) => a.id === 'jellyfin').dataDirs.includes(config))
	})

	test('installing an app whose data lives under ~/.local hands that data to the container user', async () => {
		const store = join(root, 'store')
		const port = await freePort()
		await mkdir(join(store, 'media'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo Store\n')
		await writeFile(join(store, 'media/omarchy-app.yml'), `manifestVersion: 1\nid: media\nname: Media\nversion: "1"\nport: ${port}\nweb:\n  service: jellyfin\n  port: 8096\n`)
		await writeFile(join(store, 'media/docker-compose.yml'), 'services:\n  jellyfin:\n    image: jellyfin/jellyfin:latest\n    user: "${PUID:-1000}:${PGID:-1000}"\n    volumes:\n      - ${APP_DATA_DIR:-.}/data/config:/config\n      - ${APP_DATA_DIR:-.}/data/cache:/cache\n      - ${VIDEOS_DIR}:/media/videos\n    ports:\n      - "8096:8096"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		calls.length = 0
		await call('appStore.addRepository', {url: `file://${store}`})
		await call('apps.install', {appId: 'media'})
		const config = join(data, 'apps/installed/media/data/config')
		const end = Date.now() + 5000
		let handed = ''
		for (;;) {
			handed = chowns().join('\n')
			if (handed.includes(config)) break
			if (Date.now() > end) break
			await new Promise((r) => setTimeout(r, 40))
		}
		assert.match(handed, new RegExp(config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
		assert.doesNotMatch(handed, /\.ssh/)
		// The install opens its page after the folder is handed over. Wait until that finishes,
		// so the test’s server can close the page and the process can exit.
		const endInstall = Date.now() + 5_000
		for (;;) {
			const media = (await call('apps.list', undefined, 'query')).find((a) => a.id === 'media')
			if (media && media.state !== 'installing') break
			if (Date.now() > endInstall) break
			await new Promise((r) => setTimeout(r, 30))
		}
	})

	test('a data folder that is a link to a hidden home folder is never handed over', async () => {
		await call('apps.list', undefined, 'query')
		assert.ok(!every.some((c) => c.startsWith('unshare chown') && (c.includes('.ssh') || c.includes('/evil/'))), every.join('\n'))
	})
})
