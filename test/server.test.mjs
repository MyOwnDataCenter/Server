import assert from 'node:assert/strict'
import {chmod, mkdtemp, readdir, readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

async function startTouch({backendUrl, appHosts} = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'touch-'))
	const store = await createStore(dir)
	if (backendUrl) await store.setConfig({backendUrl})
	if (appHosts) await store.setConfig({appHosts})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(server)
	const base = `http://127.0.0.1:${server.address().port}`
	let cookie = ''
	const req = async (method, path, body, headers = {}) => {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? {'content-type': 'application/json'} : {}),
				...(method !== 'GET' ? {'x-omarchy-server': '1'} : {}),
				...(cookie ? {cookie} : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		const all = res.headers.getSetCookie()
		const set = all.find((c) => c.startsWith('omarchy_server_sid=')) ?? null
		if (set) cookie = set.split(';')[0]
		return {status: res.status, body: await res.json().catch(() => null), setCookie: set, setCookies: all}
	}
	return {dir, store, base, req, getCookie: () => cookie, close: () => (app.closeRelays(), new Promise((r) => server.close(r)))}
}

describe('Omarchy Server server against an omarchyd stand-in', () => {
	let fake
	let touch
	before(async () => {
		fake = await startFakeserverd({accessTtlMs: 60 * 60 * 1000})
		touch = await startTouch()
	})
	after(async () => {
		await touch.close()
		await fake.close()
	})

	test('unconfigured server asks to connect, setup verifies the address is Omarchy Server', async () => {
		let r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.configured, false)
		r = await touch.req('POST', '/api/setup', {url: 'http://127.0.0.1:1'})
		assert.equal(r.status, 502)
		r = await touch.req('POST', '/api/setup', {url: fake.url})
		assert.equal(r.status, 200)
		assert.equal(r.body.version, '2.0.0')
		r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.server.reachable, true)
		// a loopback Server address is reported as the address the phone used to reach Touch
		assert.equal(r.body.server.host, '127.0.0.1')
		assert.equal(r.body.server.url, 'http://127.0.0.1')
		// before sign-in, not when it last started or its exact build
		assert.equal(r.body.server.startedAt, undefined)
		assert.equal(r.body.server.revision, undefined)
		// before sign-in nothing identifies the accounts; only the backdrop wallpaper is shared
		assert.deepEqual(r.body.accounts, [{userId: '', name: '', avatar: null, wallpaper: {id: '23', brandColorHsl: '24 90% 50%'}}])
		assert.equal(r.body.session, null)
	})

	test('signed in, bootstrap says when the server last started and its exact build', async () => {
		const signedIn = await startTouch({backendUrl: fake.url})
		try {
			assert.equal((await signedIn.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)
			const r = await signedIn.req('GET', '/api/bootstrap')
			assert.equal(r.body.server.startedAt, 1_700_000_000_000)
			assert.equal(r.body.server.revision, 'abc1234')
		} finally {
			await signedIn.close()
		}
	})

	test('wallpaper route only serves numeric Omarchy Server wallpaper ids', async () => {
		const bad = await fetch(`${touch.base}/api/wallpaper/..%2F..%2Fetc`)
		assert.equal(bad.status, 404)
		const missing = await fetch(`${touch.base}/api/wallpaper/999`)
		assert.equal(missing.status, 404)
	})

	test('proxy refuses calls before sign-in', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
	})

	test('Object.prototype names are not treated as RPC procedures', async () => {
		const fresh = await startTouch({backendUrl: fake.url})
		try {
			for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'constructor', '__proto__']) {
				const r = await fresh.req('POST', `/api/rpc/${name}`, {input: {}})
				assert.equal(r.status, 404, name)
				assert.equal(r.body?.error?.code, 'NOT_FOUND', name)
				assert.match(r.body?.error?.message ?? '', /is not available in Omarchy Server/, name)
			}
		} finally {
			await fresh.close()
		}
	})

	test('assistant stream is proxied without buffering', async () => {
		const fresh = await startTouch({backendUrl: fake.url})
		try {
			const anon = await fresh.req('POST', '/api/assistant/stream', {message: 'how much disk'})
			assert.equal(anon.status, 401)
			assert.equal((await fresh.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)
			const res = await fetch(`${fresh.base}/api/assistant/stream`, {
				method: 'POST',
				headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: fresh.getCookie()},
				body: JSON.stringify({message: 'how much disk'}),
			})
			assert.equal(res.status, 200)
			assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
			assert.equal(res.headers.get('cache-control'), 'no-store')
			const reader = res.body.getReader()
			const first = await reader.read()
			const chunk = new TextDecoder().decode(first.value)
			assert.match(chunk, /event: text/)
			assert.equal(chunk.includes('event: done'), false)
			let rest = ''
			for (;;) {
				const next = await reader.read()
				if (next.done) break
				rest += new TextDecoder().decode(next.value)
			}
			assert.match(rest, /event: done/)
			assert.match(rest, /"conversationId":"c_test"/)
			const hit = fake.calls.findLast((c) => c.path === 'assistant.stream')
			assert.equal(hit.input.message, 'how much disk')
			assert.match(hit.authorization, /^Bearer /)
			assert.equal(`${chunk}${rest}`.includes(hit.authorization.slice('Bearer '.length)), false)
			const hung = await fetch(`${fresh.base}/api/assistant/stream`, {
				method: 'POST',
				headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: fresh.getCookie()},
				body: JSON.stringify({message: 'stop'}),
			})
			const early = hung.body.getReader()
			assert.match(new TextDecoder().decode((await early.read()).value), /event: text/)
			await early.cancel()
			await new Promise((r) => setTimeout(r, 50))
			assert.equal(fake.streamWasAborted(), true)
		} finally {
			await fresh.close()
		}
	})

	test('wrong password surfaces omarchyd’s message', async () => {
		// username and password are both required, and a wrong one of either reads the same
		let r = await touch.req('POST', '/api/auth/login', {password: 'correct horse'})
		assert.equal(r.status, 400)
		r = await touch.req('POST', '/api/auth/login', {username: 'chris', password: 'nope'})
		assert.equal(r.status, 401)
		assert.equal(r.body.error.message, 'Incorrect username or password')
		r = await touch.req('POST', '/api/auth/login', {username: 'admin', password: 'correct horse'})
		assert.equal(r.status, 401)
		assert.equal(r.body.error.message, 'Incorrect username or password')
	})

	test('native login stores credentials server-side and sets only an opaque cookie', async () => {
		const r = await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'}, {'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'})
		assert.equal(r.status, 200)
		assert.equal(r.body.mode, 'native')
		assert.match(r.setCookie, /HttpOnly/)
		assert.match(r.setCookie, /SameSite=Strict/)
		// One sign-in for everything: the browser also gets the app session, so no app asks again.
		const appSession = r.setCookies.find((c) => c.startsWith('OMARCHY_APP_SESSION='))
		assert.ok(appSession, 'the sign-in hands this browser its app session')
		assert.match(appSession, /HttpOnly/)
		assert.match(appSession, /SameSite=Lax/)
		const login = fake.calls.findLast((c) => c.path === 'user.loginNative')
		assert.deepEqual(login.input.client, {id: 'omarchy-server', platform: 'ios', deviceClass: 'phone', appVersion: '0.9.52', appBuild: '1', osVersion: 'web'})
		const saved = await readFile(join(touch.dir, 'sessions.json'), 'utf8')
		assert.ok(!saved.includes(touch.getCookie().split('=')[1]), 'cookie value must not be stored in plain form')
		assert.equal((await stat(join(touch.dir, 'sessions.json'))).mode & 0o777, 0o600)
	})

	test('queries and mutations go through with the bearer token', async () => {
		let r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.length, 4)
		r = await touch.req('GET', `/api/rpc/apps.state?input=${encodeURIComponent(JSON.stringify({appId: 'jellyfin'}))}`)
		assert.equal(r.body.data.state, 'stopped')
		r = await touch.req('POST', '/api/rpc/apps.start', {input: {appId: 'jellyfin'}})
		assert.equal(r.status, 200)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
		assert.match(fake.calls.findLast((c) => c.path === 'apps.start').authorization, /^Bearer /)
	})

	const openConsole = (headers) =>
		new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=ubuntu-1`, {headers})
			ws.once('message', (data) => {
				resolve({ok: true, first: data.toString()})
				ws.close()
			})
			ws.once('unexpected-response', (_req, res) => resolve({ok: false, status: res.statusCode}))
			ws.once('error', () => resolve({ok: false}))
		})

	test('VM console: bridges VNC through a server-held browser session', async () => {
		const r = await touch.req('GET', '/api/console/check')
		assert.equal(r.status, 200)
		const ok = await openConsole({cookie: touch.getCookie(), origin: touch.base})
		assert.deepEqual(ok, {ok: true, first: 'RFB 003.008\n'})
		// the ticket was requested with the dashboard token + browser cookie, never the native token
		const ticketCall = fake.calls.findLast((c) => c.path === 'user.createWebSocketTicket')
		assert.deepEqual(ticketCall.input, {target: 'machines'})
		const native = fake.calls.findLast((c) => c.path === 'apps.list' || c.path === 'user.get')
		assert.notEqual(ticketCall.authorization, native?.authorization)
	})

	test('VM console: refuses other sites, missing sign-in and odd machine ids', async () => {
		assert.equal((await openConsole({cookie: touch.getCookie(), origin: 'http://evil.example'})).status, 403)
		assert.equal((await openConsole({cookie: touch.getCookie()})).status, 403)
		assert.equal((await openConsole({origin: touch.base})).status, 401)
		const bad = await new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=../x`, {headers: {cookie: touch.getCookie(), origin: touch.base}})
			ws.once('unexpected-response', (_q, res) => resolve(res.statusCode))
			ws.once('error', () => resolve(0))
		})
		assert.equal(bad, 400)
	})

	test('creates a machine through omarchyd', async () => {
		const r = await touch.req('POST', '/api/rpc/machines.create', {input: {name: 'Dev box', osId: 'debian-server-amd64', cores: 2, memoryGb: 2, diskSizeGb: 15, arch: 'amd64', username: 'chris', password: 'pw'}})
		assert.equal(r.status, 200)
		assert.equal(r.body.data.state, 'installing')
		assert.equal(fake.lastCreate().username, 'chris')
	})

	test('settings calls go through', async () => {
		assert.equal((await touch.req('POST', '/api/rpc/system.setHostname', {input: {hostname: 'nest'}})).status, 200)
		assert.equal(fake.settings.hostname, 'nest')
		assert.equal((await touch.req('POST', '/api/rpc/apps.setTorEnabled', {input: true})).status, 200)
		assert.equal(fake.settings.tor, true)
		const wrong = await touch.req('POST', '/api/rpc/user.changePassword', {input: {oldPassword: 'nope', newPassword: 'abcdefg'}})
		assert.equal(wrong.status, 401)
		// Signed-in devices are the browsers this web server holds sessions for.
		const second = await fetch(`${touch.base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json', 'x-omarchy-server': '1', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0'}, body: JSON.stringify({username: 'chris', password: 'correct horse'})})
		assert.equal(second.status, 200)
		let sessions = (await touch.req('GET', '/api/rpc/user.listSessions')).body.data
		assert.equal(sessions.length, 2)
		assert.equal(sessions[0].current, true)
		assert.match(sessions[0].client.userAgent, /iPhone/)
		const other = sessions.find((x) => !x.current)
		assert.match(other.client.userAgent, /Firefox/)
		assert.equal((await touch.req('POST', '/api/rpc/user.revokeSession', {input: {sessionId: sessions[0].id}})).status, 400, 'this device signs out with Sign out')
		const r = await touch.req('POST', '/api/rpc/user.revokeSession', {input: {sessionId: other.id}})
		assert.equal(r.status, 200)
		assert.ok(fake.calls.some((c) => c.path === 'user.revokeAppPasses'), 'their app passes end too')
		sessions = (await touch.req('GET', '/api/rpc/user.listSessions')).body.data
		assert.deepEqual(sessions.map((x) => x.current), [true])
		const secondCookie = second.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
		assert.equal((await fetch(`${touch.base}/api/rpc/apps.list`, {headers: {cookie: secondCookie}})).status, 401, 'the other browser is signed out')
	})

	test('the assistant’s look is saved per account, cleaned, and never sent to omarchyd', async () => {
		const before = fake.calls.length
		let r = await touch.req('POST', '/api/prefs', {assistantLook: {character: 'patch', name: '  Sparky <b>\n', animate: false, intensity: 'playful', size: 'large', floating: false, reactions: true, extra: 'dropped'}})
		assert.equal(r.status, 200)
		assert.deepEqual(r.body.prefs.assistantLook, {character: 'patch', name: 'Sparky b', animate: false, intensity: 'playful', size: 'large', floating: false, reactions: true, position: {}})
		// Where you dragged it, per layout: kept on the screen (0–1), anything else dropped.
		r = await touch.req('POST', '/api/prefs', {assistantLook: {character: 'patch', position: {phone: {x: 0.25, y: 1.7}, desktop: {x: 'x', y: 0}, tv: {x: 0, y: 0}}}})
		assert.deepEqual(r.body.prefs.assistantLook.position, {phone: {x: 0.25, y: 1}})
		r = await touch.req('GET', '/api/prefs')
		assert.equal(r.body.prefs.assistantLook.character, 'patch')
		// Unknown values fall back; a bad character id or shape is refused; null resets.
		r = await touch.req('POST', '/api/prefs', {assistantLook: {character: 'orbit', intensity: 'wild', size: 'huge', name: 'x'.repeat(80)}})
		assert.deepEqual([r.body.prefs.assistantLook.intensity, r.body.prefs.assistantLook.size, r.body.prefs.assistantLook.name.length], ['normal', 'medium', 24])
		assert.equal((await touch.req('POST', '/api/prefs', {assistantLook: {character: '../x'}})).status, 400)
		assert.equal((await touch.req('POST', '/api/prefs', {assistantLook: 'oma'})).status, 400)
		r = await touch.req('POST', '/api/prefs', {assistantLook: null})
		assert.equal(r.body.prefs.assistantLook, null)
		// Appearance only: none of this reached the assistant (omarchyd).
		assert.equal(fake.calls.slice(before).some((c) => String(c.path).startsWith('assistant')), false)
	})

	test('theme settings are saved per account and validated', async () => {
		let r = await touch.req('POST', '/api/prefs', {theme: 'tokyo', accent: 'teal'})
		assert.equal(r.status, 200)
		r = await touch.req('GET', '/api/prefs')
		assert.equal(r.body.prefs.theme, 'tokyo')
		assert.equal(r.body.prefs.accent, 'teal')
		const rev = r.body.prefs.rev
		// Changing one thing keeps the rest, and counts up so other devices notice.
		r = await touch.req('POST', '/api/prefs', {accent: 'pink'})
		assert.deepEqual([r.body.prefs.theme, r.body.prefs.accent, r.body.prefs.rev], ['tokyo', 'pink', rev + 1])
		// A solid colour instead of a picture (and back), checked.
		r = await touch.req('POST', '/api/prefs', {solidColor: '#1A1B26'})
		assert.equal(r.body.prefs.solidColor, '#1a1b26')
		assert.equal((await touch.req('POST', '/api/prefs', {solidColor: 'red; background:url(x)'})).status, 400)
		r = await touch.req('POST', '/api/prefs', {solidColor: null})
		assert.equal(r.body.prefs.solidColor, null)
		assert.equal(r.body.prefs.theme, 'tokyo', 'the rest is untouched')
		assert.equal((await touch.req('POST', '/api/prefs', {theme: '<script>'})).status, 400)
		assert.equal((await touch.req('POST', '/api/prefs', {customBrandHsl: 'red; x'})).status, 400)
		const anon = await fetch(`${touch.base}/api/prefs`)
		assert.equal(anon.status, 401)
	})

	test('desktop settings are saved per account; the latest save wins, counted by the server', async () => {
		assert.equal((await touch.req('GET', '/api/desktop')).body.desktop, null)
		const cfg = {wallpaper: 'photo', style: 'graphite', dock: {position: 'top', iconSize: 60}}
		let r = await touch.req('POST', '/api/desktop', {config: cfg})
		assert.equal(r.status, 200)
		assert.equal(r.body.desktop.rev, 1)
		r = await touch.req('GET', '/api/desktop')
		assert.deepEqual(r.body.desktop.config, cfg)
		assert.equal(r.body.desktop.rev, 1)
		// Another device saves next: it wins, whatever that device's clock says.
		r = await touch.req('POST', '/api/desktop', {config: {wallpaper: 'valley'}, updatedAt: 1})
		assert.equal(r.body.desktop.rev, 2)
		assert.equal((await touch.req('GET', '/api/desktop')).body.desktop.config.wallpaper, 'valley')
		assert.ok(Math.abs((await touch.req('GET', '/api/desktop')).body.desktop.updatedAt - Date.now()) < 5000)
		assert.equal((await touch.req('POST', '/api/desktop', {config: [1]})).status, 400)
		assert.equal((await touch.req('POST', '/api/desktop', {config: {x: 'y'.repeat(61_000)}})).status, 413)
		assert.equal((await fetch(`${touch.base}/api/desktop`)).status, 401)
		r = await touch.req('POST', '/api/desktop', {config: {shell: 'hyprland', wallpaper: 'valley'}})
		assert.equal(r.status, 200)
		assert.equal((await touch.req('GET', '/api/desktop')).body.desktop.config.shell, 'hyprland')
	})

	test('custom background upload accepts JPEG only and is private', async () => {
		const send = (body) =>
			fetch(`${touch.base}/api/background`, {method: 'POST', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1', cookie: touch.getCookie()}, body})
		assert.equal((await send(Buffer.from('<svg onload=alert(1)>'))).status, 400)
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
		const up = await send(jpeg)
		assert.equal(up.status, 200)
		assert.ok((await up.json()).prefs.backgroundVersion)
		const got = await fetch(`${touch.base}/api/background`, {headers: {cookie: touch.getCookie()}})
		assert.equal(got.status, 200)
		assert.equal(got.headers.get('content-type'), 'image/jpeg')
		assert.equal((await fetch(`${touch.base}/api/background`)).status, 401)
		const del = await touch.req('DELETE', '/api/background')
		assert.equal(del.body.prefs.backgroundVersion, null)
	})

	test('a failed settings save returns an error and keeps what was saved', async () => {
		const fresh = await startTouch({backendUrl: fake.url})
		const origError = console.error
		const logged = []
		console.error = (...args) => logged.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' '))
		const bgDir = () => join(fresh.dir, 'backgrounds')
		try {
			assert.equal((await fresh.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)
			assert.equal((await fresh.req('POST', '/api/prefs', {theme: 'tokyo', accent: 'teal'})).status, 200)
			const desktop = {wallpaper: 'valley', style: 'graphite'}
			assert.equal((await fresh.req('POST', '/api/desktop', {config: desktop})).status, 200)
			const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])
			const send = (body) => fetch(`${fresh.base}/api/background`, {method: 'POST', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1', cookie: fresh.getCookie()}, body})
			assert.equal((await send(jpeg)).status, 200)
			const prefs = (await fresh.req('GET', '/api/prefs')).body.prefs
			const savedDesktop = (await fresh.req('GET', '/api/desktop')).body.desktop
			const [bgName] = await readdir(bgDir())
			const bgPath = join(bgDir(), bgName)
			const bgBefore = await readFile(bgPath)
			const diskBefore = await readFile(join(fresh.dir, 'config.json'), 'utf8')
			// config.json lives here. backgrounds/ stays writable, so only the config write fails.
			await chmod(fresh.dir, 0o555)
			const refused = {error: {code: 'INTERNAL', message: 'Couldn’t save that'}}
			const leak = 'LeakCheckName'
			const marker = 'IMGLEAKMARKER'
			let r = await fresh.req('POST', '/api/prefs', {theme: 'mocha', assistantLook: {character: 'patch', name: leak}})
			assert.equal(r.status, 500)
			assert.deepEqual(r.body, refused)
			assert.equal(JSON.stringify(r.body).includes(leak), false)
			assert.equal(JSON.stringify(r.body).includes(fresh.dir), false)
			assert.equal((await fresh.req('POST', '/api/prefs', {theme: '<script>'})).status, 400)
			r = await fresh.req('POST', '/api/desktop', {config: {wallpaper: 'dunes', leak}})
			assert.equal(r.status, 500)
			assert.deepEqual(r.body, refused)
			assert.equal((await fresh.req('POST', '/api/desktop', {config: [1]})).status, 400)
			const up = await send(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker)]))
			assert.equal(up.status, 500)
			assert.deepEqual(await up.json(), refused)
			assert.equal((await fresh.req('GET', '/api/prefs')).body.prefs.backgroundVersion, prefs.backgroundVersion)
			let gotBg = await fetch(`${fresh.base}/api/background`, {headers: {cookie: fresh.getCookie()}})
			assert.equal(gotBg.status, 200)
			assert.deepEqual(Buffer.from(await gotBg.arrayBuffer()), bgBefore)
			assert.deepEqual(await readdir(bgDir()), [bgName])
			const removed = await fresh.req('DELETE', '/api/background')
			assert.equal(removed.status, 500)
			assert.deepEqual(removed.body, refused)
			const anon = await fetch(`${fresh.base}/api/prefs`, {method: 'POST', headers: {'content-type': 'application/json', 'x-omarchy-server': '1'}, body: JSON.stringify({theme: 'mocha'})})
			assert.equal(anon.status, 401)
			assert.deepEqual((await fresh.req('GET', '/api/prefs')).body.prefs, prefs)
			assert.equal((await fresh.req('GET', '/api/prefs')).body.prefs.backgroundVersion, prefs.backgroundVersion)
			assert.deepEqual((await fresh.req('GET', '/api/desktop')).body.desktop, savedDesktop)
			gotBg = await fetch(`${fresh.base}/api/background`, {headers: {cookie: fresh.getCookie()}})
			assert.equal(gotBg.status, 200)
			assert.deepEqual(Buffer.from(await gotBg.arrayBuffer()), bgBefore)
			assert.deepEqual(await readdir(bgDir()), [bgName])
			await chmod(fresh.dir, 0o700)
			assert.equal(await readFile(join(fresh.dir, 'config.json'), 'utf8'), diskBefore)
			const text = logged.join('\n')
			assert.ok(logged.length >= 4)
			assert.match(text, /EACCES/)
			assert.equal(text.includes(leak), false)
			assert.equal(text.includes(marker), false)
			// The process is still up, and a later save still sticks.
			r = await fresh.req('POST', '/api/prefs', {accent: 'pink'})
			assert.equal(r.status, 200)
			assert.equal(r.body.prefs.theme, 'tokyo')
			assert.equal(r.body.prefs.accent, 'pink')
			assert.equal((await fresh.req('GET', '/api/prefs')).body.prefs.accent, 'pink')
		} finally {
			console.error = origError
			await chmod(fresh.dir, 0o700).catch(() => {})
			await fresh.close()
		}
	})

	test('overlapping config saves keep both changes, and a failed one does not', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'touch-cfg-'))
		const store = await createStore(dir)
		try {
			await store.setConfig({theme: 'tokyo'})
			const first = store.setConfig({accent: 'teal'})
			const second = store.setConfig({solid: 'yes'})
			const [a, b] = await Promise.all([first, second])
			assert.equal(a.theme, 'tokyo')
			assert.equal(a.accent, 'teal')
			assert.equal(b.theme, 'tokyo')
			assert.equal(b.accent, 'teal')
			assert.equal(b.solid, 'yes')
			assert.deepEqual(store.getConfig(), b)
			await chmod(dir, 0o555)
			await assert.rejects(store.setConfig({nope: true}))
			assert.equal(store.getConfig().nope, undefined)
			assert.equal(store.getConfig().accent, 'teal')
			await chmod(dir, 0o700)
			const later = await store.setConfig({later: 2})
			assert.equal(later.accent, 'teal')
			assert.equal(later.solid, 'yes')
			assert.equal(later.later, 2)
			assert.equal(later.nope, undefined)
			const disk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
			assert.equal(disk.theme, 'tokyo')
			assert.equal(disk.accent, 'teal')
			assert.equal(disk.solid, 'yes')
			assert.equal(disk.later, 2)
			assert.equal(disk.nope, undefined)
		} finally {
			await chmod(dir, 0o700).catch(() => {})
		}
	})

	test('terminal: bridges a shell (and an app shell) with a terminal ticket', async () => {
		const open = (q) =>
			new Promise((resolve) => {
				const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/terminal?${q}`, {headers: {cookie: touch.getCookie(), origin: touch.base}})
				let out = ''
				ws.on('message', (d) => {
					out += d.toString()
					if (out.includes('$ ') && !out.includes('ran')) ws.send('ls\r')
					if (out.includes('ls: ran')) {
						ws.close()
						resolve({ok: true, out})
					}
				})
				ws.once('unexpected-response', (_q, res) => resolve({ok: false, status: res.statusCode}))
			})
		const shell = await open('cols=80&rows=24')
		assert.ok(shell.ok)
		assert.match(shell.out, /Welcome to Omarchy Server/)
		const appShell = await open('appId=immich&cols=60&rows=20')
		assert.ok(appShell.ok)
		assert.deepEqual(fake.terminals.at(-1), {appId: 'immich', cols: 60, rows: 20})
		// “New session” asks for a fresh shell; only fresh=1 means that.
		assert.ok((await open('cols=80&rows=24&fresh=1')).ok)
		assert.deepEqual(fake.terminals.at(-1), {appId: null, cols: 80, rows: 24, fresh: '1'})
		assert.ok((await open('cols=80&rows=24&fresh=yes')).ok)
		assert.equal(fake.terminals.at(-1).fresh, undefined)
		assert.equal((await open('appId=../x&cols=80&rows=24')).status, 400)
		assert.equal((await open('cols=5000&rows=24')).status, 400)
	})

	test('a member cannot open the host terminal or a swarm computer through the web server', async () => {
		const member = await startTouch({backendUrl: fake.url})
		try {
			const login = await member.req('POST', '/api/auth/login', {username: 'Sam', password: 'correct horse'})
			assert.equal(login.status, 200)
			const open = (path) =>
				new Promise((resolve) => {
					const ws = new WebSocket(`${member.base.replace('http', 'ws')}${path}`, {headers: {cookie: member.getCookie(), origin: member.base}})
					ws.once('open', () => {
						ws.close()
						resolve({ok: true})
					})
					ws.once('unexpected-response', (_q, res) => resolve({ok: false, status: res.statusCode}))
				})
			assert.equal((await open('/api/terminal?cols=80&rows=24')).status, 403)
			assert.equal((await open('/api/terminal?agentId=0123456789ab&cols=80&rows=24')).status, 403)
			assert.equal((await open('/api/console?machineId=agent-0123456789ab')).status, 403)
			assert.equal((await member.req('GET', '/api/console/check?target=terminal')).status, 403)
			assert.equal((await member.req('GET', '/api/console/check?machineId=agent-0123456789ab')).status, 403)
			assert.equal((await open('/api/console?machineId=desktop')).status, 403, 'this server’s desktop is the owner’s session')
			assert.equal((await member.req('GET', '/api/console/check?machineId=desktop')).status, 403)
			const vm = await open('/api/console?machineId=ubuntu-1')
			assert.equal(vm.ok, true, 'a member can still open a VM screen')
		} finally {
			await member.close()
		}
	})

	test('files: list, upload, download and preview through the server', async () => {
		const list = await touch.req('GET', `/api/rpc/files.list?input=${encodeURIComponent(JSON.stringify({path: '/Home/Documents'}))}`)
		assert.equal(list.status, 200)
		assert.ok(list.body.data.files.some((f) => f.name === 'Notes.txt'))
		const up = await fetch(`${touch.base}/api/files/upload?path=${encodeURIComponent('/Home/Documents/hello.txt')}`, {
			method: 'POST',
			headers: {cookie: touch.getCookie(), 'x-omarchy-server': '1', 'content-type': 'application/octet-stream'},
			body: 'uploaded from the phone',
		})
		assert.equal(up.status, 200)
		assert.equal((await up.json()).path, '/Home/Documents/hello.txt')
		const down = await fetch(`${touch.base}/api/files/download?path=${encodeURIComponent('/Home/Documents/hello.txt')}`, {headers: {cookie: touch.getCookie()}})
		assert.equal(down.status, 200)
		assert.equal(await down.text(), 'uploaded from the phone')
		assert.match(down.headers.get('content-disposition'), /hello\.txt/)
		const view = await fetch(`${touch.base}/api/files/view?path=${encodeURIComponent('/Home/Documents/Notes.txt')}`, {headers: {cookie: touch.getCookie()}})
		assert.equal(view.status, 200)
		assert.match(view.headers.get('content-security-policy'), /sandbox/)
		// cross-site upload refused, signed-out download refused
		const csrf = await fetch(`${touch.base}/api/files/upload?path=%2FHome%2Fx.txt`, {method: 'POST', headers: {cookie: touch.getCookie()}, body: 'x'})
		assert.equal(csrf.status, 403)
		assert.equal((await fetch(`${touch.base}/api/files/download?path=%2FHome%2FDocuments%2FNotes.txt`)).status, 401)
		const mv = await touch.req('POST', '/api/rpc/files.move', {input: {path: '/Home/Documents/hello.txt', toDirectory: '/Home/Downloads'}})
		assert.equal(mv.status, 200)
		assert.ok(fake.fsTree.has('/Home/Downloads/hello.txt'))
	})

	test('community app stores can be listed, added and removed', async () => {
		const url = 'https://github.com/TouchWorkStation/app-store'
		const add = await touch.req('POST', '/api/rpc/appStore.addRepository', {input: {url}})
		assert.equal(add.status, 200)
		const list = await touch.req('GET', '/api/rpc/appStore.repositories')
		assert.ok(list.body.data.some((r) => r.url === url && r.meta.id === 'touchworkstation'))
		const reg = await touch.req('GET', '/api/rpc/appStore.registry')
		assert.ok(reg.body.data.some((r) => r.apps.some((a) => a.id === 'touchworkstation-chrome')))
		const dup = await touch.req('POST', '/api/rpc/appStore.addRepository', {input: {url}})
		assert.notEqual(dup.status, 200)
		const rm = await touch.req('POST', '/api/rpc/appStore.removeRepository', {input: {url}})
		assert.equal(rm.status, 200)
	})

	test('file viewer: saves edits in place, extracts archives, asks for renditions', async () => {
		const save = await fetch(`${touch.base}/api/files/upload?path=${encodeURIComponent('/Home/Documents/Notes.txt')}&collision=replace`, {
			method: 'POST',
			headers: {cookie: touch.getCookie(), 'x-omarchy-server': '1', 'content-type': 'application/octet-stream'},
			body: 'edited in the viewer',
		})
		assert.equal(save.status, 200)
		assert.equal((await save.json()).path, '/Home/Documents/Notes.txt')
		assert.equal(fake.fsTree.get('/Home/Documents/Notes.txt').data.toString(), 'edited in the viewer')
		const un = await touch.req('POST', '/api/rpc/files.unarchive', {input: {path: '/Home/backup.zip'}})
		assert.equal(un.status, 200)
		assert.ok(fake.fsTree.has('/Home/backup'))
		const th = await touch.req('POST', '/api/rpc/files.getThumbnail', {input: {path: '/Home/Photos/Lake.jpg', variant: 'preview-1280-webp-v2'}})
		assert.equal(th.status, 200)
		assert.equal(typeof th.body.data, 'string')
	})

	test('non-allowlisted procedures are refused without reaching omarchyd', async () => {
		const before = fake.calls.length
		const r = await touch.req('POST', '/api/rpc/user.deleteUser', {input: {userId: 'x'}})
		assert.equal(r.status, 404)
		assert.equal(fake.calls.length, before)
	})

	test('storage: drives and pool status pass through; RAID setup is never reachable', async () => {
		const devices = await touch.req('GET', '/api/rpc/hardware.internalStorage.getDevices')
		assert.equal(devices.status, 200)
		assert.ok(devices.body.data.some((d) => d.isSystemDrive))
		const raid = await touch.req('GET', '/api/rpc/hardware.raid.getStatus')
		assert.equal(raid.status, 200)
		assert.equal(raid.body.data.exists, false)
		const before = fake.calls.length
		const setup = await touch.req('POST', '/api/rpc/hardware.raid.setup', {input: {devices: ['a'], raidType: 'storage'}})
		assert.equal(setup.status, 404)
		assert.equal(fake.calls.length, before)
	})

	test('desktop windows may frame only the server host, and the Host header can’t inject CSP', async () => {
		const {request} = await import('node:http')
		const cspFor = (host) =>
			new Promise((resolve, reject) => {
				const u = new URL(touch.base)
				const r = request({host: u.hostname, port: u.port, path: '/api/bootstrap', headers: {host}}, (res) => {
					res.resume()
					resolve(res.headers['content-security-policy'] ?? '')
				})
				r.on('error', reject)
				r.end()
			})
		assert.match(await cspFor('192.168.1.50:7780'), /frame-src 'self' http:\/\/192\.168\.1\.50:\* https:\/\/192\.168\.1\.50:\*;/)
		const evil = await cspFor('x.com;script-src *')
		assert.doesNotMatch(evil, /script-src \*/)
		assert.doesNotMatch(evil, /frame-src/)
	})

	test('bootstrap says how a browser tab reaches apps: directly on this port, or not (a proxy) (#86)', async () => {
		const {request} = await import('node:http')
		const u = new URL(touch.base)
		const accessFor = (host) =>
			new Promise((resolve, reject) => {
				const r = request({host: u.hostname, port: u.port, path: '/api/bootstrap', headers: {host}}, (res) => {
					let body = ''
					res.on('data', (c) => (body += c))
					res.on('end', () => resolve(JSON.parse(body).server?.appAccess))
				})
				r.on('error', reject)
				r.end()
			})
		// Reached on the server's own port (on your network): the app ports on that host work.
		assert.equal(await accessFor(`192.168.1.50:${u.port}`), 'direct')
		// Through a proxy on 80/443 with no app addresses: they don't.
		assert.equal(await accessFor('omarchy.example.com'), 'none')
		assert.equal(await accessFor('omarchy.example.com:8443'), 'none')
	})

	test('app windows: reports whether the browser’s Omarchy Server app session is valid, never the session itself', async () => {
		const ask = (app, extra) => touch.req('GET', `/api/app-access?app=${app}`, undefined, {cookie: `${touch.getCookie()}${extra}`})
		// a malformed cookie from another app on the same host must not break anything
		let r = await ask('nextcloud', '; junk=%E0%A4%A')
		assert.equal(r.status, 200)
		assert.deepEqual(r.body, {state: 'signin'})
		r = await ask('nextcloud', '; OMARCHY_APP_SESSION=expired')
		assert.deepEqual(r.body, {state: 'signin'})
		r = await ask('nextcloud', '; OMARCHY_APP_SESSION=good-app-session')
		assert.deepEqual(r.body, {state: 'ok'})
		r = await ask('private-notes', '; OMARCHY_APP_SESSION=good-app-session')
		assert.deepEqual(r.body, {state: 'not-shared'})
		const check = fake.appAuthChecks.at(-1)
		assert.equal(check.app, 'private-notes')
		assert.equal(check.cookie, 'OMARCHY_APP_SESSION=good-app-session') // only the app cookie is forwarded
		assert.equal((await touch.req('GET', '/api/app-access?app=../../x')).status, 400)
		const out = await fetch(`${touch.base}/api/app-access?app=nextcloud`, {headers: {cookie: 'OMARCHY_APP_SESSION=good-app-session'}})
		assert.equal(out.status, 401) // needs a Touch session too
	})

	test('desktop: on the local network apps open in plain windows (no relay port); the relay still works', async () => {
		const r = await touch.req('GET', '/api/app-frame?apps=immich,nextcloud,home-assistant,../x')
		assert.equal(r.status, 200)
		assert.equal(r.body.sso, true) // the sign-in kept Omarchy Server's app session server-side
		assert.deepEqual(r.body.results, {immich: 'window', nextcloud: 'window', 'home-assistant': 'window'})
		assert.deepEqual(r.body.relay, {}, 'the app gateway allows the window itself, so no extra firewall ports are needed')
		const open = await touch.req('GET', '/api/app-open?app=nextcloud')
		assert.equal(open.status, 200)
		const url = new URL(open.body.url)
		const via = (path, cookie) => fetch(new URL(path, url), {headers: cookie ? {cookie} : {}, redirect: 'manual'})
		// only browsers signed in to Touch get through
		assert.equal((await via('/', 'OMARCHY_APP_SESSION=good-app-session')).status, 401)
		// no Omarchy Server app sign-in needed in the browser: Touch supplies its own app session
		const page = await via('/', touch.getCookie())
		assert.equal(page.status, 200)
		assert.match(await page.text(), /Nextcloud/)
		assert.equal(page.headers.get('x-frame-options'), null)
		assert.equal(page.headers.get('content-security-policy'), `frame-ancestors 'self' ${touch.base}`)
		const ha = await touch.req('GET', '/api/app-open?app=home-assistant')
		const hap = await fetch(ha.body.url, {headers: {cookie: touch.getCookie()}})
		assert.equal(hap.headers.get('content-security-policy'), `frame-ancestors 'self' ${touch.base}`)
		// a frameable app's own redirect stays on the relay
		const im = await touch.req('GET', '/api/app-open?app=immich')
		const imr = await fetch(im.body.url, {headers: {cookie: touch.getCookie()}, redirect: 'manual'})
		assert.equal(imr.status, 302)
		assert.equal(new URL(imr.headers.get('location'), im.body.url).port, new URL(im.body.url).port)
		// Touch's own cookie never reaches an app
		assert.ok(fake.appRequests.length > 0)
		assert.ok(!fake.appRequests.some((c) => c.includes('omarchy_server_sid')))
		assert.equal((await via('/__touch/ping.gif')).headers.get('content-type'), 'image/gif')
		assert.equal((await touch.req('GET', '/api/app-open?app=../x')).status, 400)
		assert.equal((await fetch(`${touch.base}/api/app-frame?apps=immich`)).status, 401)
	})

	test('remote access: app subdomains get a one-time hand-over, then a per-app cookie', async () => {
		const {request} = await import('node:http')
		const touch2 = await startTouch({backendUrl: fake.url, appHosts: '{app}-touch.example.com'})
		try {
			await touch2.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
			const u = new URL(touch2.base)
			const get = (host, path, headers = {}) =>
				new Promise((resolve, reject) => {
					const q = request({host: u.hostname, port: u.port, path, headers: {host, ...headers}}, (res) => {
						let body = ''
						res.on('data', (c) => (body += c))
						res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}))
					})
					q.on('error', reject)
					q.end()
				})
			// the Touch page, as reached through the tunnel
			const open = await get('touch.example.com', '/api/app-open?app=nextcloud', {cookie: touch2.getCookie(), 'x-forwarded-proto': 'https'})
			const body = JSON.parse(open.body)
			assert.match(body.url, /^https:\/\/nextcloud-touch\.example\.com\/__touch\/enter\?t=/)
			// The app's own address, to copy or bookmark (no one-time ticket in it), and tabs use this route (#86).
			assert.equal(body.address, 'https://nextcloud-touch.example.com/')
			const boot = JSON.parse((await get('touch.example.com', '/api/bootstrap', {cookie: touch2.getCookie(), 'x-forwarded-proto': 'https'})).body)
			assert.equal(boot.server.appAccess, 'relay')
			const enter = new URL(body.url)
			// nothing gets through without the hand-over
			assert.equal((await get('nextcloud-touch.example.com', '/')).status, 401)
			const handed = await get('nextcloud-touch.example.com', enter.pathname + enter.search, {'x-forwarded-proto': 'https'})
			assert.equal(handed.status, 302)
			const cookie = handed.headers['set-cookie'][0]
			assert.match(cookie, /^__touch_app=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/)
			// the ticket is single use
			assert.equal((await get('nextcloud-touch.example.com', enter.pathname + enter.search)).status, 401)
			const page = await get('nextcloud-touch.example.com', '/', {cookie: cookie.split(';')[0]})
			assert.equal(page.status, 200)
			assert.match(page.body, /Nextcloud/)
			assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self' https://touch.example.com")
			// a per-app cookie doesn't open other apps
			assert.equal((await get('immich-touch.example.com', '/', {cookie: cookie.split(';')[0]})).status, 401)
			// Touch's own pages allow framing its app subdomains
			const csp = (await get('touch.example.com', '/api/bootstrap')).headers['content-security-policy']
			assert.match(csp, /frame-src [^;]*https:\/\/\*\.example\.com/)
		} finally {
			await touch2.close()
		}
	})

	test('wrong HTTP method for a procedure kind is refused', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.start')
		assert.equal(r.status, 405)
	})

	test('cross-site POSTs are refused', async () => {
		let r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {'x-omarchy-server': ''})
		assert.equal(r.status, 403)
		r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {origin: 'http://evil.example'})
		assert.equal(r.status, 403)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
	})

	test('an expired access token is refreshed with the device token and the call retried', async () => {
		fake.expireAllAccessTokens()
		const r = await touch.req('GET', '/api/rpc/system.cpuUsage')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.totalUsed, 18.4)
		assert.ok(fake.calls.some((c) => c.path === 'user.refreshNativeAccess'))
	})

	test('re-pointing the server needs a signed-in session', async () => {
		const anon = await fetch(`${touch.base}/api/setup`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
			body: JSON.stringify({url: 'http://192.0.2.1'}),
		})
		assert.equal(anon.status, 403)
	})

	test('revoking the device in Omarchy Server signs the phone out', async () => {
		fake.revokeAllDevices()
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
		assert.equal(touch.store.sessionCount(), 0)
		const b = await touch.req('GET', '/api/bootstrap')
		assert.equal(b.body.session, null)
	})

	test('logout revokes the Omarchy Server session', async () => {
		await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
		const r = await touch.req('POST', '/api/auth/logout')
		assert.equal(r.status, 200)
		assert.ok(fake.calls.findLast((c) => c.path === 'user.logout'))
		assert.equal(touch.store.sessionCount(), 0)
	})
})

describe('a wrong password is one try', () => {
	test('a wrong password is sent once and the session stays', async () => {
		const fake = await startFakeserverd()
		const touch = await startTouch({backendUrl: fake.url})
		try {
			assert.equal((await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)
			assert.equal(touch.store.sessionCount(), 1)
			const change = await touch.req('POST', '/api/rpc/user.changePassword', {input: {oldPassword: 'nope', newPassword: 'longer-secret'}})
			assert.equal(change.status, 401)
			assert.equal(fake.calls.filter((c) => c.path === 'user.changePassword').length, 1)
			assert.equal(fake.calls.filter((c) => c.path === 'user.refreshNativeAccess').length, 0)
			assert.equal(touch.store.sessionCount(), 1)
			const reset = await touch.req('POST', '/api/rpc/system.factoryReset', {input: {password: 'nope'}})
			assert.equal(reset.status, 401)
			assert.equal(fake.calls.filter((c) => c.path === 'system.factoryReset').length, 1)
			assert.equal(touch.store.sessionCount(), 1)
			const desk = await touch.req('POST', '/api/rpc/system.desktopSignIn', {input: {password: 'nope'}})
			assert.equal(desk.status, 401)
			assert.equal(fake.calls.filter((c) => c.path === 'system.desktopSignIn').length, 1)
			assert.equal(touch.store.sessionCount(), 1)
		} finally {
			await touch.close()
			await fake.close()
		}
	})

	test('a wrong password on a legacy session is sent once and the session stays', async () => {
		const fake = await startFakeserverd({legacy: true})
		const touch = await startTouch({backendUrl: fake.url})
		try {
			assert.equal((await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)
			const change = await touch.req('POST', '/api/rpc/user.changePassword', {input: {oldPassword: 'nope', newPassword: 'longer-secret'}})
			assert.equal(change.status, 401)
			assert.equal(fake.calls.filter((c) => c.path === 'user.changePassword').length, 1)
			assert.equal(touch.store.sessionCount(), 1)
		} finally {
			await touch.close()
			await fake.close()
		}
	})
})

describe('older Omarchy Server without native login', () => {
	test('falls back to user.login bearer tokens', async () => {
		const fake = await startFakeserverd({legacy: true})
		const touch = await startTouch({backendUrl: fake.url})
		try {
			const r = await touch.req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})
			assert.equal(r.status, 200)
			assert.equal(r.body.mode, 'legacy')
			const list = await touch.req('GET', '/api/rpc/apps.list')
			assert.equal(list.status, 200)
		} finally {
			await touch.close()
			await fake.close()
		}
	})
})

describe('always use the secure address', () => {
	test('page loads over http go to https when turned on; API calls and the certificate don’t', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'touch-https-'))
		const store = await createStore(dir)
		let alwaysHttps = false
		const tls = {get: () => ({}), ca: () => '-----BEGIN CERTIFICATE-----\n', policy: () => ({alwaysHttps})}
		const app = createApp({store, tls, relayPortBase: 0, relayHost: '127.0.0.1'})
		const server = await new Promise((r) => {
			const s = app.listen(0, '127.0.0.1', () => r(s))
		})
		const base = `http://127.0.0.1:${server.address().port}`
		const nav = {'sec-fetch-mode': 'navigate', accept: 'text/html'}
		// fetch() sets its own Sec-Fetch-Mode, so ask like a browser does, with plain http.
		const {request} = await import('node:http')
		const fetch = (url, {headers = {}} = {}) =>
			new Promise((resolve, reject) =>
				request(url, {headers}, (res) => {
					let body = ''
					res.on('data', (c) => (body += c))
					res.on('end', () => resolve({status: res.statusCode, headers: {get: (k) => res.headers[k] ?? null}, json: async () => JSON.parse(body)}))
				})
					.on('error', reject)
					.end(),
			)
		try {
			assert.notEqual((await fetch(`${base}/settings`, {headers: nav, redirect: 'manual'})).status, 308, 'off by default')
			alwaysHttps = true
			const r = await fetch(`${base}/settings?x=1`, {headers: nav, redirect: 'manual'})
			assert.equal(r.status, 308)
			assert.equal(r.headers.get('location'), `https://127.0.0.1:${server.address().port}/settings?x=1`)
			assert.notEqual((await fetch(`${base}/api/tls/status`, {redirect: 'manual'})).status, 308)
			assert.equal((await fetch(`${base}/api/tls/ca.crt`, {headers: nav, redirect: 'manual'})).status, 200)
			assert.equal((await (await fetch(`${base}/api/tls/status`)).json()).alwaysHttps, true)
			assert.notEqual((await fetch(`${base}/settings`, {headers: {...nav, host: 'evil.example/"'}, redirect: 'manual'})).headers.get('location')?.includes('"'), true)
		} finally {
			server.close()
		}
	})
})
