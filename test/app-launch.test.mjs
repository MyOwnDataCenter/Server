// Opening an app: is its web page usable right now? One server-side answer (readinessOf) that every
// Open button follows, so a running app with a dead web port isn't waited on for three minutes.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {readinessOf} from '../omarchyd/apps.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

describe('readinessOf', () => {
	const r = (probe, rest = {}) => readinessOf({probe, ...rest})
	test('any answer below 500 means the app is there: redirects, sign-in pages, not-found', () => {
		for (const status of [200, 204, 301, 302, 401, 403, 404]) assert.equal(r({result: 'answered', status}), 'ready', String(status))
	})
	test('not answering: starting while it was just started, unreachable after that', () => {
		for (const result of ['refused', 'timeout', 'error']) {
			assert.equal(r({result}, {runningForMs: 5_000}), 'starting', result)
			assert.equal(r({result}, {runningForMs: 10 * 60_000}), 'unreachable', result)
		}
	})
	test('stopped containers are stopped, however recently', () => {
		assert.equal(r({result: 'refused'}, {container: 'stopped', runningForMs: 1000}), 'stopped')
	})
	test('a server error: wait while starting, then open it (its own page says what’s wrong)', () => {
		assert.equal(r({result: 'answered', status: 503}, {runningForMs: 5_000}), 'starting')
		assert.equal(r({result: 'answered', status: 503}, {runningForMs: 10 * 60_000}), 'ready')
	})
	test('the app answers but Omarchy Server’s port for it is closed', () => {
		assert.equal(r({result: 'answered', status: 200}, {gatewayOpen: false}), 'gateway-down')
	})
	test('no web page', () => assert.equal(r({result: 'no-web'}), 'no-web'))
})

describe('apps.probe', () => {
	let root, d, auth, port, tlsFiles
	const up = new Set()
	const git = (args, cwd) => execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return git(args, opts.cwd)
		if (cmd === 'docker-compose') {
			const p = args[1]
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(p)
			if (verb === 'stop' || verb === 'down') up.delete(p)
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(p) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const body = await (await fetch(url, init)).json()
		if (body.error) throw new Error(body.error.message)
		return body.result.data
	}
	const q = (p, i) => call(p, i, 'query')
	const until = async (fn, ms = 5000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 40))
		}
	}
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))
	const installed = async (id) => until(async () => (await q('apps.list')).find((a) => a.id === id && a.state === 'running'))
	// Stand-in for the app's own web server on its private port.
	const serve = (internalPort, handler, secure = null) =>
		new Promise((resolve) => {
			const s = secure ? https.createServer(secure, handler) : http.createServer(handler)
			s.listen(internalPort, '127.0.0.1', () => resolve(s))
		})
	// Longer than the list's own web check (800 ms). A firewall that drops a closed port, instead of
	// refusing it, makes that check use the whole 800 ms. A shorter grace would already call the app stopped.
	const GRACE = 3_000

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-launch-'))
		const data = join(root, 'data')
		await writeFile(join(root, 'podman.sock'), '')
		process.env.DOCKER_HOST = `unix://${join(root, 'podman.sock')}`
		port = 27300 + Math.floor(Math.random() * 2000) // below the ephemeral range, clear of apps.test.mjs
		const store = join(root, 'store')
		const listing = (id, n, extra = '') => `manifestVersion: 1\nid: ${id}\nname: ${id}\nversion: "1"\nport: ${port + n}\nweb:\n  service: web\n  port: 3000\n${extra}`
		for (const [id, n, extra] of [['wizard', 0, ''], ['secure', 1, '  https: true\n']]) {
			await mkdir(join(store, id), {recursive: true})
			await writeFile(join(store, id, 'omarchy-app.yml'), listing(id, n, extra))
			await writeFile(join(store, id, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports:\n      - "3000:3000"\n')
		}
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: launch\nname: Launch\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home: join(root, 'home'), webPort: 7798, appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], startGraceMs: GRACE}})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
		await call('appStore.addRepository', {url: `file://${store}`})
		tlsFiles = await ensureTls({dir: join(root, 'upstream-tls'), names: {dns: ['localhost'], ips: ['127.0.0.1']}})
	})
	after(async () => {
		await d?.close()
		await rm(root, {recursive: true, force: true})
	})

	test('an app whose setup page redirects is ready at once (AdGuard Home’s first run)', async () => {
		await call('apps.install', {appId: 'wizard'})
		const app = await installed('wizard')
		const s = await serve(app.internalPort, (req, res) => res.writeHead(302, {location: '/install.html'}).end())
		try {
			const p = await q('apps.probe', {appId: 'wizard'})
			assert.equal(p.readiness, 'ready')
			assert.equal(p.status, 302)
			assert.equal(p.gateway, true)
		} finally {
			s.close()
		}
	})

	test('running, but nothing on its web port: “starting” only briefly, then “unreachable” with the reason', async () => {
		// What AdGuard Home does after its setup: the containers keep running, the listed port goes quiet.
		await call('apps.restart', {appId: 'wizard'})
		const soon = await q('apps.probe', {appId: 'wizard'})
		assert.equal(soon.readiness, 'starting', 'just restarted: give it a moment')
		await wait(GRACE + 100)
		const later = await q('apps.probe', {appId: 'wizard'})
		assert.equal(later.readiness, 'unreachable', 'not three minutes of “still starting”')
		assert.equal(later.result, 'refused')
		assert.equal(later.container, 'running')
		assert.ok(later.runningFor >= 0)
	})

	test('a restart starts the wait again; once the page answers it is ready; 401 and 404 count as answers', async () => {
		const app = (await q('apps.list')).find((a) => a.id === 'wizard')
		await call('apps.restart', {appId: 'wizard'})
		assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'starting')
		let status = 401
		const s = await serve(app.internalPort, (req, res) => res.writeHead(status).end())
		try {
			assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'ready')
			status = 404
			assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'ready')
			status = 503
			assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'starting', 'a server error right after starting: wait')
			await wait(GRACE + 100)
			assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'ready', 'still an error later: open it and let its page say why')
		} finally {
			s.close()
		}
	})

	test('stopped is reported as stopped, not as starting', async () => {
		await call('apps.stop', {appId: 'wizard'})
		assert.equal((await q('apps.probe', {appId: 'wizard'})).readiness, 'stopped')
		await call('apps.start', {appId: 'wizard'})
	})

	test('an app that speaks https itself is asked over https (it used to look dead)', async () => {
		await call('apps.install', {appId: 'secure'})
		const app = await installed('secure')
		const s = await serve(app.internalPort, (req, res) => res.writeHead(200).end('ok'), {key: tlsFiles.key, cert: tlsFiles.cert})
		try {
			const p = await q('apps.probe', {appId: 'secure'})
			assert.equal(p.result, 'answered')
			assert.equal(p.readiness, 'ready')
		} finally {
			s.close()
		}
	})

	test('the same page is reachable through the app’s port over http and https once signed in', async () => {
		const app = (await q('apps.list')).find((a) => a.id === 'wizard')
		const s = await serve(app.internalPort, (req, res) => res.writeHead(200).end('hello from the app'))
		try {
			// Not signed in: sent to Omarchy Server to sign in, never straight to the app.
			const stranger = await fetch(`http://127.0.0.1:${app.port}/`, {redirect: 'manual'})
			assert.equal(stranger.status, 302)
			assert.match(stranger.headers.get('location'), /:7798\//)
			const ticket = await call('apps.accessTicket', {appId: 'wizard'})
			const enter = await fetch(`http://127.0.0.1:${app.port}/__omarchy/enter?t=${ticket.ticket ?? ticket}`, {redirect: 'manual'})
			const cookie = enter.headers.get('set-cookie').split(';')[0]
			assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/`, {headers: {cookie}})).text(), 'hello from the app')
			const viaTls = await new Promise((resolve, reject) =>
				https.get({host: '127.0.0.1', port: app.port, path: '/', headers: {cookie}, rejectUnauthorized: false}, (res) => {
					let body = ''
					res.on('data', (c) => (body += c)).on('end', () => resolve(body))
				}).on('error', reject),
			)
			assert.equal(viaTls, 'hello from the app')
		} finally {
			s.close()
		}
	})
})
