// Failures that used to crash a process, wedge a queue or give the wrong error.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createBackups} from '../omarchyd/backups.mjs'
import {handleRpc, RpcError} from '../omarchyd/rpc.mjs'
import {createUpdater} from '../omarchyd/updater.mjs'

const tmp = () => mkdtemp(join(os.tmpdir(), 'omarchy-robust-'))
const asRoot = process.getuid?.() === 0
const until = async (fn, ms = 3000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
		const v = await fn()
		if (v) return v
	}
	throw new Error('timed out')
}

test('#100 accounts: one failed save does not fail every later save', {skip: asRoot && 'root ignores file mode'}, async () => {
	const dir = await tmp()
	try {
		const a = await openAccounts(dir)
		await a.createOwner({name: 'me', password: 'correct horse'})
		await chmod(dir, 0o500)
		await assert.rejects(a.updateUser('owner', {language: 'de'}))
		await chmod(dir, 0o700)
		await a.updateUser('owner', {language: 'fr'})
		assert.match(await readFile(join(dir, 'accounts.json'), 'utf8'), /"fr"/)
	} finally {
		await chmod(dir, 0o700).catch(() => {})
		await rm(dir, {recursive: true, force: true})
	}
})

const files = (home) => ({async resolve(v) {
	return {real: join(home, v.slice('/Home'.length)), top: 'Home'}
}})

test('#96 backups: every run that was going at a restart is marked stopped', async () => {
	const dir = await tmp()
	try {
		await mkdir(join(dir, 'backups'), {recursive: true})
		const history = [
			{id: 'a', startedAt: 3000, endedAt: null, ok: false},
			{id: 'b', computer: 'pc1', startedAt: 2000, endedAt: null, ok: false},
			{id: 'c', startedAt: 1000, endedAt: 1500, ok: true},
		]
		await writeFile(join(dir, 'backups/history.json'), JSON.stringify(history))
		const b = createBackups({dataDir: dir, files: files(dir), apps: {backupTargets: async () => []}, timers: false, run: async () => ({stdout: '', stderr: ''})})
		const st = await b.procedures['backups.status'].run()
		for (const id of ['a', 'b']) {
			const h = st.history.find((x) => x.id === id)
			assert.ok(h.endedAt, id)
			assert.equal(h.ok, false)
		}
		b.close?.()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#95 backups: state files are written through the shared atomic writer', async () => {
	const src = await readFile(new URL('../omarchyd/backups.mjs', import.meta.url), 'utf8')
	assert.match(src, /writePrivate = \(file, text\) => writeAtomic\(/)
	assert.doesNotMatch(src, /\$\{process\.pid\}\.tmp/)
})

test('#110 #329 update: a failing first rev-parse is reported, not a crash; a failed restore says so', async () => {
	const dir = await tmp()
	const changelog = await readFile(new URL('../web/src/changelog.ts', import.meta.url), 'utf8')
	const fetchImpl = async (url) => {
		const path = new URL(url).pathname.split('/').slice(4).join('/')
		const f = {'package.json': JSON.stringify({version: '0.6.1'}), 'web/src/changelog.ts': changelog}
		return f[path] === undefined ? new Response('', {status: 404}) : new Response(f[path])
	}
	try {
		let revParses = 0
		const run = async (cmd, args) => {
			if (cmd === 'git' && args[2] === 'rev-parse' && ++revParses === 2) throw new Error('index.lock busy')
			return cmd === 'git' && args[2] === 'rev-parse' ? 'old\n' : ''
		}
		const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl, helperPath: '/nonexistent'})
		await u.procedures['system.update'].run()
		const st = await until(async () => {
			const s = await u.procedures['system.updateStatus'].run()
			return s.error ? s : null
		})
		assert.match(st.error, /index\.lock busy/)
		assert.equal(st.running, false)

		const run2 = async (cmd, args) => {
			if (cmd === 'git' && args[2] === 'rev-parse') return 'old\n'
			if (cmd === 'npm') throw new Error('build broke')
			return ''
		}
		const u2 = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run: run2, fetchImpl, helperPath: '/nonexistent'})
		await u2.procedures['system.update'].run()
		const st2 = await until(async () => {
			const s = await u2.procedures['system.updateStatus'].run()
			return s.error ? s : null
		})
		assert.match(st2.error, /putting the previous version back failed too/)
		assert.doesNotMatch(st2.error, /nothing changed/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#325 rpc: only the request body is "Invalid JSON"; a parse error inside a procedure is a 500', async () => {
	const procedures = {
		'x.broken': {kind: 'query', public: true, run: async () => JSON.parse('{"a": tr')},
		'x.echo': {kind: 'mutation', public: true, run: async (input) => input},
	}
	const server = http.createServer((req, res) => handleRpc(req, res, new URL(req.url, 'http://x'), procedures, () => null))
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	const error = console.error
	console.error = () => {}
	try {
		assert.equal((await fetch(`${base}/trpc/x.broken`)).status, 500)
		const bad = await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: '{bad'})
		assert.equal(bad.status, 400)
		assert.match(await bad.text(), /Invalid JSON/)
		const ok = await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: '{"a":1}'})
		assert.deepEqual((await ok.json()).result.data, {a: 1})
		assert.ok(RpcError)
	} finally {
		console.error = error
		server.close()
	}
})

test('#103 #250 web API: bad Origin and malformed JSON get JSON errors; HEAD is not refused as cross-site', async () => {
	const {createApp} = await import('../server/app.mjs')
	const {createStore} = await import('../server/store.mjs')
	const dir = await tmp()
	const app = createApp({store: await createStore(dir), relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	const base = `http://127.0.0.1:${server.address().port}`
	try {
		let r = await fetch(`${base}/api/prefs`, {method: 'POST', headers: {'x-omarchy-server': '1', origin: 'null', 'content-type': 'application/json'}, body: '{}'})
		assert.equal(r.status, 403)
		assert.equal((await r.json()).error.code, 'FORBIDDEN')
		r = await fetch(`${base}/api/prefs`, {method: 'POST', headers: {'x-omarchy-server': '1', 'content-type': 'application/json'}, body: '{bad'})
		assert.equal(r.status, 400)
		assert.match(r.headers.get('content-type'), /json/)
		assert.doesNotMatch(await r.text(), /node_modules|at /)
		r = await fetch(`${base}/api/bootstrap`, {method: 'HEAD'})
		assert.notEqual(r.status, 403)
	} finally {
		app.closeRelays?.()
		await new Promise((r) => server.close(r))
		await rm(dir, {recursive: true, force: true})
	}
})

test('#323 host CPU: guest time is not counted twice', async () => {
	const {cpuFromStat} = await import('../omarchyd/system.mjs')
	const a = cpuFromStat('cpu  100 0 0 300 0 0 0 0 0 0')
	const b = cpuFromStat('cpu  200 0 0 600 0 0 0 0 100 0')
	const busy = 100 * (1 - (b.idle - a.idle) / (b.total - a.total))
	assert.equal(Math.round(busy), 25)
})

test('#321 update: two requests at once start one update', async () => {
	const dir = await tmp()
	const changelog = await readFile(new URL('../web/src/changelog.ts', import.meta.url), 'utf8')
	const fetchImpl = async (url) => {
		await new Promise((r) => setTimeout(r, 30))
		const path = new URL(url).pathname.split('/').slice(4).join('/')
		const f = {'package.json': JSON.stringify({version: '0.6.1'}), 'web/src/changelog.ts': changelog}
		return f[path] === undefined ? new Response('', {status: 404}) : new Response(f[path])
	}
	try {
		let fetches = 0
		const run = async (cmd, args) => {
			if (cmd === 'git' && args.includes('fetch')) fetches++
			return cmd === 'git' && args[2] === 'rev-parse' ? 'old\n' : ''
		}
		const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl, helperPath: '/nonexistent'})
		const up = u.procedures['system.update'].run
		const results = await Promise.allSettled([up(), up()])
		assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
		assert.match(String(results.find((r) => r.status === 'rejected').reason.message), /already running/)
		await new Promise((r) => setTimeout(r, 200))
		assert.ok(fetches <= 1)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#485 neither HTTP server cuts a long upload off after Node’s 5 minute request limit', async () => {
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await tmp()
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root})
	try {
		assert.equal(d.server.requestTimeout, 0)
		// A request that is still being sent is not an idle one: headers keep their own limit.
		assert.ok(d.server.headersTimeout > 0)
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
	// The web server's listener lives in the command line entry, which starts on import; check its source.
	const cli = await readFile(new URL('../server/cli.mjs', import.meta.url), 'utf8')
	assert.match(cli, /httpServer\.requestTimeout = 0/)
})
