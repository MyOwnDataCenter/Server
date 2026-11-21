import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import WebSocket, {WebSocketServer} from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {validateRemoteAppCompose} from '../omarchyd/connector.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {osLook} from '../web/src/osLook.ts'

const INSTALL_SH = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const execFileAsync = promisify(execFile)

async function httpReq(baseUrl, path, {method = 'GET', headers = {}, body = null} = {}) {
	const url = new URL(path, baseUrl)
	return new Promise((resolve, reject) => {
		const req = http.request(url, {method, headers}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}))
		})
		req.on('error', reject)
		if (body != null) req.write(body)
		req.end()
	})
}

function cookiePair(setCookie) {
	const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
	return list.map((c) => c.split(';')[0]).join('; ')
}

describe('swarm remote app hosting, authenticated relay routing, and macOS support', () => {
	let root, dataDir, homeDir, tlsDir, storeDir, omarchyd, store, app, webServer, webUrl

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-apps-'))
		dataDir = join(root, 'omarchyd')
		homeDir = join(root, 'home')
		tlsDir = join(root, 'tls')
		storeDir = join(root, 'web-store')
		await mkdir(dataDir, {recursive: true})
		await mkdir(homeDir, {recursive: true})
		await mkdir(storeDir, {recursive: true})
		await ensureTls({dir: tlsDir})

		// Seed an owner and a non-owner member before starting omarchyd.
		const seed = await openAccounts(dataDir)
		await seed.createOwner({name: 'Owner', password: 'owner-password-123'})
		const accFile = join(dataDir, 'accounts.json')
		const acc = JSON.parse(await readFile(accFile, 'utf8'))
		acc.users.push({...acc.users[0], userId: 'member', name: 'Member', role: 'member'})
		await writeFile(accFile, JSON.stringify(acc))

		omarchyd = await startOmarchyd({
			dataDir,
			home: homeDir,
			host: '127.0.0.1',
			port: 0,
			tlsDir,
			appOptions: {systemApps: null, run: async () => ({ok: true, out: '', err: ''})},
			machineOptions: {run: async () => ({ok: true, out: '', err: ''})},
		})

		store = await createStore(storeDir)
		await store.setConfig({backendUrl: omarchyd.url})
		app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
		webServer = http.createServer(app)
		app.attachConsole(webServer)
		await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
		webUrl = `http://127.0.0.1:${webServer.address().port}`
	})

	after(async () => {
		app?.closeRelays?.()
		app?.closeAll?.()
		await new Promise((r) => webServer?.close(r))
		await omarchyd?.close?.()
		await rm(root, {recursive: true, force: true})
	})

	test('install.sh has valid bash syntax and rejects Linux-only abilities on macOS', async () => {
		await execFileAsync('bash', ['-n', INSTALL_SH])
		if (process.platform === 'darwin') {
			await assert.rejects(
				execFileAsync('bash', [INSTALL_SH, '--server', 'https://127.0.0.1:7780', '--ca', '0'.repeat(64), '--token', 'tok', '--allow', 'terminal,desktop']),
				/Desktop screen sharing isn't supported on macOS/,
			)
			await assert.rejects(
				execFileAsync('bash', [INSTALL_SH, '--server', 'https://127.0.0.1:7780', '--ca', '0'.repeat(64), '--token', 'tok', '--allow', 'terminal,storage']),
				/Storage drive management isn't supported on macOS/,
			)
		}
		assert.equal(osLook('macos').icon, 'macos')
	})

	test('server-side validateRemoteAppCompose enforces strict allowlist and rejects dangerous compose', () => {
		const valid = validateRemoteAppCompose(
			`services:\n  app:\n    image: nginx:alpine\n    restart: unless-stopped\n    environment:\n      LONG_NOTE: "it's ${'a'.repeat(110)}"\n    ports:\n      - "127.0.0.1:8080:80"\n    volumes:\n      - appdata:/data\n      - ./cfg:/cfg:ro\nvolumes:\n  appdata: {}\n`,
			8080,
		)
		assert.deepEqual(valid.publishedPorts, [8080])
		const parsedOut = JSON.parse(valid.compose)
		assert.equal(parsedOut.services.app.ports[0], '127.0.0.1:8080:80')

		for (const bad of [
			'services:\n  app:\n    image: alpine\n    privileged: true\n',
			'services:\n  app:\n    image: alpine\n    cap_add: [SYS_ADMIN]\n',
			'services:\n  app:\n    image: alpine\n    devices: ["/dev/sda:/dev/sda"]\n',
			'services:\n  app:\n    image: alpine\n    network_mode: host\n',
			'services:\n  app:\n    image: alpine\n    security_opt: ["apparmor:unconfined"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["/:/host"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["./../escape:/escape"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["./Docker-Compose.yml:/c"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["./META.JSON:/m"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["./data:/data", "./data/x:/host"]\n',
			'services:\n  app:\n    image: alpine\n    volumes: ["./data:/data", "./DATA/x:/host"]\n',
			'services:\n  app:\n    image: alpine\n    volumes:\n      - type: bind\n        source: "./a:/b"\n        target: /c\n',
			'services:\n  app:\n    image: alpine\n    ports: ["0.0.0.0:8080:80"]\n',
			'services:\n  app:\n    image: alpine\n    ports: ["8080:80"]\n',
			'services:\n  app:\n    image: alpine\n    ports: ["127.0.0.1:80:80"]\n',
			'services:\n  app: &a\n    image: alpine\n',
		]) {
			assert.throws(() => validateRemoteAppCompose(bad, 0))
		}
		// Declared web port must match a published 127.0.0.1 TCP port
		assert.throws(() => validateRemoteAppCompose('services:\n  app:\n    image: alpine\n    ports:\n      - "127.0.0.1:8080:80"\n', 9090))
	})

	test('authenticates remote app HTTP and WebSocket routing through server relay without exposing loopback ports', async () => {
		// Sign owner and member into the web server.
		const ownerLogin = await httpReq(webUrl, '/api/auth/login', {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
			body: JSON.stringify({username: 'Owner', password: 'owner-password-123'}),
		})
		assert.equal(ownerLogin.status, 200, ownerLogin.body)
		const ownerCookie = cookiePair(ownerLogin.headers['set-cookie'])

		const memberLogin = await httpReq(webUrl, '/api/auth/login', {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
			body: JSON.stringify({username: 'Member', password: 'owner-password-123'}),
		})
		assert.equal(memberLogin.status, 200, memberLogin.body)
		const memberCookie = cookiePair(memberLogin.headers['set-cookie'])

		// Spin up a mock remote app HTTP + WebSocket server on 127.0.0.1.
		const seenHeaders = []
		const seenPaths = []
		const appBackend = http.createServer((req, res) => {
			seenHeaders.push(req.headers)
			seenPaths.push(req.url)
			if (req.url === '/redir') {
				res.writeHead(302, {location: `http://127.0.0.1:${appPort}/after`})
				return res.end()
			}
			res.writeHead(200, {
				'content-type': 'text/plain',
				'set-cookie': ['omarchy_server_sid=evil; Path=/', 'OMARCHY_BROWSER_SESSION=evil; Path=/', 'demo_session=ok; Path=/'],
			})
			res.end(`hello-from-remote-app:${req.url}`)
		})
		const appWss = new WebSocketServer({noServer: true})
		appBackend.on('upgrade', (req, socket, head) => {
			appWss.handleUpgrade(req, socket, head, (ws) => {
				ws.on('message', (d) => ws.send(`echo:${String(d)}`))
			})
		})
		await new Promise((r) => appBackend.listen(0, '127.0.0.1', r))
		const appPort = appBackend.address().port

		const rpc = async (path, kind, input, cookie = ownerCookie) => {
			const url = kind === 'query' ? `/api/rpc/${path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}` : `/api/rpc/${path}`
			const r = await httpReq(webUrl, url, {
				method: kind === 'query' ? 'GET' : 'POST',
				headers: {cookie, 'content-type': 'application/json', 'x-omarchy-server': '1'},
				body: kind === 'query' ? null : JSON.stringify({input}),
			})
			return {status: r.status, json: JSON.parse(r.body)}
		}

		try {
			const paired = await rpc('swarm.pair', 'mutation', {apps: true})
			assert.equal(paired.status, 200)
			const enrolledRes = await httpReq(webUrl, '/connector/enroll', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({
					token: paired.json.data.token,
					info: {hostname: 'mac-node', os: 'macOS 15', osId: 'macos'},
					abilities: {apps: true},
				}),
			})
			assert.equal(enrolledRes.status, 200)
			const {id, key} = JSON.parse(enrolledRes.body)

			const ws = new WebSocket(`ws://127.0.0.1:${webServer.address().port}/connector/ws`, {
				headers: {authorization: `Bearer ${id}:${key}`},
			})
			const installed = []
			const tcpSockets = new Map()
			await new Promise((resolve, reject) => {
				ws.once('open', resolve)
				ws.once('error', reject)
			})
			ws.on('message', (data, isBinary) => {
				if (isBinary) {
					const buf = Buffer.from(data)
					const ch = buf.readUInt32BE(0)
					tcpSockets.get(ch)?.write(buf.subarray(4))
					return
				}
				const msg = JSON.parse(String(data))
				if (msg.op === 'open' && msg.kind === 'tcp') {
					const sock = net.connect(msg.port, '127.0.0.1')
					tcpSockets.set(msg.ch, sock)
					const head = Buffer.alloc(4)
					head.writeUInt32BE(msg.ch)
					sock.on('data', (chunk) => ws.send(Buffer.concat([head, chunk]), {binary: true}))
					sock.on('close', () => {
						tcpSockets.delete(msg.ch)
						if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({op: 'closed', ch: msg.ch}))
					})
					sock.on('error', () => {
						tcpSockets.delete(msg.ch)
						if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({op: 'closed', ch: msg.ch, code: 1011, reason: 'connect failed'}))
					})
					return
				}
				if (msg.op === 'close') {
					tcpSockets.get(msg.ch)?.destroy()
					tcpSockets.delete(msg.ch)
					return
				}
				if (msg.op !== 'call') return
				if (msg.name === 'apps-status') {
					ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {engine: 'podman', compose: 'podman compose', available: true, freeDisk: 100e9, gpus: []}}))
				} else if (msg.name === 'apps-install') {
					installed.push({id: msg.args.id, name: msg.args.name, port: msg.args.port, path: msg.args.path || '', state: 'running', installedAt: Date.now()})
					ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: installed[installed.length - 1]}))
				} else if (msg.name === 'apps-list') {
					ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: installed}))
				} else if (msg.name === 'apps-control') {
					if (msg.args.action === 'logs') ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {logs: 'app started ok'}}))
					else ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: true}))
				}
			})
			ws.send(JSON.stringify({op: 'hello', info: {hostname: 'mac-node', os: 'macOS 15', osId: 'macos'}, abilities: {apps: true}}))
			await new Promise((r) => setTimeout(r, 80))

			// Reject dangerous compose via RPC
			const badInstall = await rpc('swarm.apps.install', 'mutation', {
				id,
				appId: 'evil-app',
				port: 0,
				compose: 'services:\n  app:\n    image: alpine\n    privileged: true\n',
			})
			assert.equal(badInstall.status, 400)

			// Valid install succeeds
			const goodInstall = await rpc('swarm.apps.install', 'mutation', {
				id,
				appId: 'demo-web',
				name: 'Demo Web',
				port: appPort,
				compose: `services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:${appPort}:80"\n`,
			})
			assert.equal(goodInstall.status, 200)

			// Direct RPC swarm.apps.open returns descriptor, NOT an unauthenticated 127.0.0.1 URL
			const rawOpen = await rpc('swarm.apps.open', 'mutation', {id, appId: 'demo-web'})
			assert.equal(rawOpen.status, 200)
			assert.equal(rawOpen.json.data.agentId, id)
			assert.equal(rawOpen.json.data.appId, 'demo-web')
			assert.equal(rawOpen.json.data.port, appPort)
			assert.equal(rawOpen.json.data.url, undefined)

			// Member cannot open remote app
			const memberOpen = await httpReq(webUrl, '/api/swarm/apps/open', {
				method: 'POST',
				headers: {cookie: memberCookie, 'content-type': 'application/json', 'x-omarchy-server': '1'},
				body: JSON.stringify({id, appId: 'demo-web'}),
			})
			assert.equal(memberOpen.status, 403)

			// Owner gets a browser-reachable authenticated relay URL
			const ownerOpen = await httpReq(webUrl, '/api/swarm/apps/open', {
				method: 'POST',
				headers: {cookie: ownerCookie, 'content-type': 'application/json', 'x-omarchy-server': '1'},
				body: JSON.stringify({id, appId: 'demo-web'}),
			})
			assert.equal(ownerOpen.status, 200, ownerOpen.body)
			const opened = JSON.parse(ownerOpen.body)
			assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

			// Unauthenticated request to the relay URL is refused (401)
			const unauthed = await httpReq(opened.url, '/')
			assert.equal(unauthed.status, 401)

			// Member request to the relay URL is refused (403)
			const memberRelay = await httpReq(opened.url, '/', {headers: {cookie: memberCookie}})
			assert.equal(memberRelay.status, 403)

			// Direct unauthenticated request to omarchyd /connector/app/... is refused (401)
			const directOmarchyd = await httpReq(omarchyd.url, `/connector/app/${id}/demo-web/`)
			assert.equal(directOmarchyd.status, 401)

			// Signed-in owner reaches the remote app; Touch/Omarchy server cookies are stripped while app cookies pass,
			// and Set-Cookie headers trying to overwrite Omarchy Server cookies are stripped from responses.
			const okResp = await httpReq(opened.url, '/hello?x=1', {
				headers: {cookie: `${ownerCookie}; OMARCHY_BROWSER_SESSION=secret; OMARCHY_OIDC_CSRF=csrf; demo_app_pref=dark`},
			})
			assert.equal(okResp.status, 200)
			assert.equal(okResp.body, 'hello-from-remote-app:/hello?x=1')
			const lastHdr = seenHeaders[seenHeaders.length - 1]
			assert.equal(lastHdr.authorization, undefined)
			assert.equal(lastHdr.cookie, 'demo_app_pref=dark')
			assert.deepEqual(okResp.headers['set-cookie'], ['demo_session=ok; Path=/'])

			// Cross-origin POST to the swarm relay is refused
			const crossPost = await httpReq(opened.url, '/action', {
				method: 'POST',
				headers: {cookie: ownerCookie, origin: 'http://evil.example'},
			})
			assert.equal(crossPost.status, 403)

			// Loopback redirect Location header from remote app is rewritten to the relay host
			const redir = await httpReq(opened.url, '/redir', {headers: {cookie: ownerCookie}})
			assert.equal(redir.status, 302)
			assert.equal(redir.headers.location, `${new URL(opened.url).origin}/after`)

			// Path traversal attempt on relay cannot escape /connector/app/:agentId/:appId into omarchyd /trpc
			const trav = await httpReq(opened.url, '/../../trpc/system.stats', {headers: {cookie: ownerCookie}})
			assert.equal(trav.status, 200)
			assert.equal(trav.body, 'hello-from-remote-app:/trpc/system.stats')

			// WebSocket upgrade over the authenticated relay works for owner with same Origin
			const relayOrigin = new URL(opened.url).origin
			const relayWsUrl = opened.url.replace(/^http:/, 'ws:') + 'ws'
			// Cross-origin WS upgrade is refused
			await assert.rejects(
				new Promise((resolve, reject) => {
					const badWs = new WebSocket(relayWsUrl, {headers: {cookie: ownerCookie, origin: 'http://evil.example'}})
					badWs.once('open', () => (badWs.close(), resolve()))
					badWs.once('error', reject)
				}),
			)
			// Same-origin owner WS upgrade echoes through omarchyd -> connector -> mock backend
			const echoReply = await new Promise((resolve, reject) => {
				const clientWs = new WebSocket(relayWsUrl, {headers: {cookie: ownerCookie, origin: relayOrigin}})
				clientWs.once('error', reject)
				clientWs.once('open', () => clientWs.send('ping-remote'))
				clientWs.once('message', (d) => {
					clientWs.close()
					resolve(String(d))
				})
			})
			assert.equal(echoReply, 'echo:ping-remote')

			// Assistant-used swarm.apps.control + logs + uninstall work
			const ctrl = await rpc('swarm.apps.control', 'mutation', {id, appId: 'demo-web', action: 'restart'})
			assert.equal(ctrl.status, 200)
			const logs = await rpc('swarm.apps.logs', 'query', {id, appId: 'demo-web'})
			assert.match(logs.json.data.logs, /app started ok/)
			const uninst = await rpc('swarm.apps.uninstall', 'mutation', {id, appId: 'demo-web'})
			assert.equal(uninst.status, 200)

			ws.close()
		} finally {
			appWss.close()
			await new Promise((r) => appBackend.close(r))
		}
	})
})
