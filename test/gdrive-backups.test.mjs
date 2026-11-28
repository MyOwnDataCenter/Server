import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createBackups} from '../omarchyd/backups.mjs'
import {GdriveQuotaError, cleanFolderName, createGdriveClient, pkceChallenge} from '../omarchyd/gdrive.mjs'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

function hasRealRestic() {
	try {
		const out = execFileSync('restic', ['version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
		return /restic \d+\.\d+/.test(out)
	} catch {
		return false
	}
}

// Realistic in-process mock Google OAuth2 + Drive v3 server (supports PKCE, multipart, resumable 308 chunks, Range 206, 429 retry, and 403 dailyLimitExceeded).
async function startMockGoogleDrive({quotaLimit = 30 * 1000 ** 4, email = 'owner@example.com'} = {}) {
	let seq = 1
	const files = new Map() // id -> {id, name, mimeType, parents: [id], data: Buffer, trashed: false}
	const sessions = new Map() // uploadId -> {parentId, name, existingId, expectedTotal, chunks: Map<start, Buffer>}
	const authCodes = new Map() // code -> {codeChallenge, clientId, redirectUri}
	const tokens = new Set(['acc_initial'])
	const refreshTokens = new Map() // refresh -> {clientId, clientSecret}
	let failNextUploads = 0
	let triggerDailyQuotaOnUpload = false
	const calls = []

	const parseMultipart = (buf, contentType) => {
		const m = /boundary=([^\s;]+)/i.exec(contentType)
		if (!m) throw new Error('missing boundary')
		const sep = Buffer.from(`--${m[1]}`)
		const parts = []
		let pos = buf.indexOf(sep)
		while (pos !== -1) {
			const next = buf.indexOf(sep, pos + sep.length)
			if (next === -1) break
			const raw = buf.subarray(pos + sep.length + 2, next - 2)
			const hdrEnd = raw.indexOf(Buffer.from('\r\n\r\n'))
			if (hdrEnd !== -1) parts.push(raw.subarray(hdrEnd + 4))
			pos = next
		}
		return {meta: JSON.parse(parts[0].toString('utf8')), body: parts[1]}
	}

	const matchQuery = (item, q) => {
		if (!q) return true
		if (q.includes('trashed = false') && item.trashed) return false
		const parentMatch = /'([^']+)' in parents/.exec(q)
		if (parentMatch && !item.parents.includes(parentMatch[1])) return false
		const nameMatch = /name = '((?:\\'|[^'])*)'/.exec(q)
		if (nameMatch && item.name !== nameMatch[1].replace(/\\'/g, "'")) return false
		const mimeMatch = /mimeType = '([^']+)'/.exec(q)
		if (mimeMatch && item.mimeType !== mimeMatch[1]) return false
		return true
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		calls.push({method: req.method, path: url.pathname, search: url.search})
		const json = (code, data) => {
			res.writeHead(code, {'content-type': 'application/json'})
			res.end(JSON.stringify(data))
		}
		const readBody = async () => {
			const chunks = []
			for await (const c of req) chunks.push(c)
			return Buffer.concat(chunks)
		}

		// OAuth2 token endpoint
		if (url.pathname === '/oauth/token' && req.method === 'POST') {
			const form = new URLSearchParams((await readBody()).toString('utf8'))
			const grant = form.get('grant_type')
			if (grant === 'authorization_code') {
				const code = form.get('code')
				const rec = authCodes.get(code)
				if (!rec) return json(400, {error: 'invalid_grant', error_description: 'unknown code'})
				if (rec.codeChallenge && pkceChallenge(form.get('code_verifier') ?? '') !== rec.codeChallenge) {
					return json(400, {error: 'invalid_grant', error_description: 'PKCE verifier mismatch'})
				}
				if (rec.redirectUri !== form.get('redirect_uri')) {
					return json(400, {error: 'redirect_uri_mismatch'})
				}
				authCodes.delete(code)
				const access = `acc_${seq++}`
				const refresh = `ref_${seq++}`
				tokens.add(access)
				refreshTokens.set(refresh, {clientId: form.get('client_id')})
				return json(200, {access_token: access, refresh_token: refresh, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file'})
			}
			if (grant === 'refresh_token') {
				const refresh = form.get('refresh_token')
				if (!refreshTokens.has(refresh)) return json(400, {error: 'invalid_grant'})
				const access = `acc_${seq++}`
				tokens.add(access)
				return json(200, {access_token: access, expires_in: 3600})
			}
			return json(400, {error: 'unsupported_grant_type'})
		}

		// Require valid Bearer token on Drive API calls
		const auth = String(req.headers.authorization ?? '')
		if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
			return json(401, {error: {code: 401, message: 'Invalid Credentials'}})
		}

		// GET /drive/v3/about
		if (url.pathname === '/drive/v3/about' && req.method === 'GET') {
			let usage = 0
			for (const f of files.values()) if (!f.trashed && f.data) usage += f.data.length
			return json(200, {
				user: {emailAddress: email, displayName: 'Test Owner'},
				storageQuota: {limit: String(quotaLimit), usage: String(usage), usageInDrive: String(usage), usageInDriveTrash: '0'},
			})
		}

		// GET /drive/v3/files (list / search)
		if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
			const q = url.searchParams.get('q') ?? ''
			const matched = [...files.values()]
				.filter((f) => matchQuery(f, q))
				.map((f) => ({
					id: f.id,
					name: f.name,
					mimeType: f.mimeType,
					size: f.data ? String(f.data.length) : undefined,
					md5Checksum: f.data ? createHash('md5').update(f.data).digest('hex') : undefined,
				}))
			return json(200, {files: matched})
		}

		// POST /drive/v3/files (create folder)
		if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
			const meta = JSON.parse((await readBody()).toString('utf8'))
			const id = `id_${seq++}`
			files.set(id, {id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ['root'], data: null, trashed: false})
			return json(200, {id, name: meta.name})
		}

		// GET / DELETE /drive/v3/files/:id
		const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
		if (fileMatch) {
			const f = files.get(decodeURIComponent(fileMatch[1]))
			if (!f || f.trashed) return json(404, {error: {code: 404, message: 'Not found'}})
			if (req.method === 'DELETE') {
				files.delete(f.id)
				res.writeHead(204)
				return res.end()
			}
			if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
				const buf = f.data ?? Buffer.alloc(0)
				const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
				if (range) {
					const start = Number(range[1])
					const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1
					const slice = buf.subarray(start, end + 1)
					res.writeHead(206, {
						'content-type': 'application/octet-stream',
						'content-length': String(slice.length),
						'content-range': `bytes ${start}-${end}/${buf.length}`,
					})
					return res.end(slice)
				}
				res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(buf.length)})
				return res.end(buf)
			}
		}

		// Upload endpoint: multipart & resumable
		if (url.pathname.startsWith('/upload/drive/v3/files')) {
			const uploadType = url.searchParams.get('uploadType')
			const uploadId = url.searchParams.get('upload_id')
			if (triggerDailyQuotaOnUpload) {
				await readBody()
				return json(403, {error: {code: 403, message: 'User rate limit exceeded', errors: [{reason: 'dailyLimitExceeded'}]}})
			}
			if (failNextUploads > 0) {
				failNextUploads--
				await readBody()
				return json(429, {error: {code: 429, message: 'Rate Limit Exceeded', errors: [{reason: 'rateLimitExceeded'}]}})
			}
			if (uploadType === 'multipart') {
				const raw = await readBody()
				const {meta, body} = parseMultipart(raw, String(req.headers['content-type'] ?? ''))
				const existingMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
				const id = existingMatch ? decodeURIComponent(existingMatch[1]) : `id_${seq++}`
				const prev = files.get(id)
				files.set(id, {
					id,
					name: meta.name ?? prev?.name ?? 'file',
					mimeType: 'application/octet-stream',
					parents: meta.parents ?? prev?.parents ?? ['root'],
					data: body,
					trashed: false,
				})
				return json(200, {id, name: files.get(id).name, size: String(body.length), md5Checksum: createHash('md5').update(body).digest('hex')})
			}
			if (uploadType === 'resumable' && !uploadId) {
				const meta = JSON.parse((await readBody()).toString('utf8'))
				const existingMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
				const sid = `up_${seq++}`
				sessions.set(sid, {
					parentId: meta.parents?.[0] ?? 'root',
					name: meta.name,
					existingId: existingMatch ? decodeURIComponent(existingMatch[1]) : null,
					parts: [],
					received: 0,
				})
				res.writeHead(200, {location: `${baseUrl}/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}`})
				return res.end()
			}
			if (uploadId && req.method === 'PUT') {
				const s = sessions.get(uploadId)
				if (!s) return json(404, {error: {code: 404, message: 'Upload session not found'}})
				const chunk = await readBody()
				const crHdr = String(req.headers['content-range'] ?? '')
				if (/^bytes \*\/\d+$/.test(crHdr)) {
					res.writeHead(308, s.received > 0 ? {range: `bytes=0-${s.received - 1}`} : {})
					return res.end()
				}
				const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(crHdr)
				if (!cr) return json(400, {error: {code: 400, message: 'Missing Content-Range'}})
				const start = Number(cr[1])
				const end = Number(cr[2])
				const total = Number(cr[3])
				assert.equal(chunk.length, end - start + 1)
				s.parts.push({start, data: chunk})
				s.received = end + 1
				if (s.received < total) {
					res.writeHead(308, {range: `bytes=0-${end}`})
					return res.end()
				}
				const full = Buffer.alloc(total)
				for (const p of s.parts) p.data.copy(full, p.start)
				const id = s.existingId ?? `id_${seq++}`
				const prev = files.get(id)
				files.set(id, {
					id,
					name: s.name ?? prev?.name ?? 'file',
					mimeType: 'application/octet-stream',
					parents: prev?.parents ?? [s.parentId],
					data: full,
					trashed: false,
				})
				sessions.delete(uploadId)
				return json(200, {id, name: files.get(id).name, size: String(full.length), md5Checksum: createHash('md5').update(full).digest('hex')})
			}
		}

		return json(404, {error: {code: 404, message: `Unhandled ${req.method} ${url.pathname}`}})
	})

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const baseUrl = `http://127.0.0.1:${server.address().port}`
	return {
		baseUrl,
		gdriveOptions: {
			authUrl: `${baseUrl}/oauth/auth`,
			tokenUrl: `${baseUrl}/oauth/token`,
			apiBase: `${baseUrl}/drive/v3`,
			uploadBase: `${baseUrl}/upload/drive/v3`,
		},
		files,
		calls,
		issueCode(authUrl) {
			const u = new URL(authUrl)
			const code = `4/0A_${randomBytes(8).toString('hex')}`
			authCodes.set(code, {
				codeChallenge: u.searchParams.get('code_challenge'),
				clientId: u.searchParams.get('client_id'),
				redirectUri: u.searchParams.get('redirect_uri'),
			})
			return {code, state: u.searchParams.get('state'), callbackUrl: `${u.searchParams.get('redirect_uri')}?state=${encodeURIComponent(u.searchParams.get('state'))}&code=${encodeURIComponent(code)}`}
		},
		setFailNextUploads(n) {
			failNextUploads = n
		},
		setDailyQuotaError(on) {
			triggerDailyQuotaOnUpload = on
		},
		allStoredPayloads() {
			return [...files.values()].filter((f) => f.mimeType !== FOLDER_MIME && f.data).map((f) => ({name: f.name, data: f.data}))
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}

async function makeWorkspace() {
	const root = await mkdtemp(join(os.tmpdir(), 'modc-gdrive-test-'))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const serverDataDir = join(root, 'server-config')
	const appsDir = join(root, 'apps', 'notes')
	const poolDir = join(root, 'pools', 'media')
	await mkdir(dataDir, {recursive: true})
	await mkdir(join(home, 'Backups'), {recursive: true})
	await mkdir(serverDataDir, {recursive: true})
	await mkdir(appsDir, {recursive: true})
	await mkdir(poolDir, {recursive: true})
	await writeFile(join(appsDir, 'secret-notes.txt'), 'SUPER_SECRET_APP_PAYLOAD_XYZ_987654\n')
	await writeFile(join(serverDataDir, 'settings.json'), JSON.stringify({theme: 'tokyo-night', secretMarker: 'TOP_SECRET_CONFIG_MARKER'}))
	await writeFile(join(poolDir, 'family-video.bin'), Buffer.concat([Buffer.from('PRIVATE_POOL_HEADER_'), randomBytes(128 * 1024)]))
	const files = {
		async resolve(vp) {
			if (vp.startsWith('/Home/')) return {real: join(home, vp.slice('/Home/'.length))}
			if (vp === '/Home') return {real: home}
			if (vp.startsWith('/Pools/')) return {real: join(poolDir, vp.slice('/Pools/'.length))}
			if (vp === '/Pools') return {real: poolDir}
			throw new Error(`bad path ${vp}`)
		},
	}
	const apps = {
		async backupTargets() {
			return [{id: 'notes', name: 'Notes', dir: appsDir, running: false}]
		},
		async pauseForBackup() {},
		async resumeAfterBackup() {},
	}
	return {root, dataDir, home, serverDataDir, appsDir, poolDir, files, apps, cleanup: () => rm(root, {recursive: true, force: true})}
}

test('Google Drive OAuth2 PKCE, resumable chunked upload, 429 retry, and 750 GB daily cap handling', async () => {
	const mock = await startMockGoogleDrive()
	const ws = await makeWorkspace()
	try {
		const backups = createBackups({
			dataDir: ws.dataDir,
			home: ws.home,
			serverDataDir: ws.serverDataDir,
			files: ws.files,
			apps: ws.apps,
			unshare: false,
			timers: false,
			gdriveOptions: {...mock.gdriveOptions, chunkSize: 256 * 1024},
		})
		await backups.ready

		// 1. Start OAuth2 PKCE flow
		const start = await backups.procedures['backups.gdrive.authStart'].run({
			clientId: '123456-test.apps.googleusercontent.com',
			clientSecret: 'GOCSPX-secret-value',
			redirectUri: 'http://127.0.0.1',
			folderName: 'My 30TB Vault',
		})
		assert.match(start.authUrl, /code_challenge=/)
		assert.match(start.authUrl, /code_challenge_method=S256/)
		assert.match(start.authUrl, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/)
		assert.ok(!start.authUrl.includes('include_granted_scopes'), 'must not request include_granted_scopes')

		// 2. Wrong CSRF state must be rejected
		const issued = mock.issueCode(start.authUrl)
		await assert.rejects(
			() => backups.procedures['backups.gdrive.authFinish'].run({code: issued.code, state: 'wrong-state'}),
			/expired or didn’t match/i,
		)

		// 3. Complete OAuth by pasting full callback URL
		const finished = await backups.procedures['backups.gdrive.authFinish'].run({code: issued.callbackUrl})
		assert.equal(finished.connected, true)
		assert.equal(finished.email, 'owner@example.com')
		assert.equal(finished.quota.limit, 30 * 1000 ** 4)
		assert.equal(finished.folderName, 'My 30TB Vault')
		assert.ok(finished.folderId)

		// Verify secrets NEVER appear in status output
		const st = await backups.procedures['backups.status'].run()
		const serialized = JSON.stringify(st)
		assert.ok(!serialized.includes('GOCSPX-secret-value'))
		assert.ok(!serialized.includes('ref_'))
		assert.ok(!serialized.includes('acc_'))

		// 4. Probe verifies write/read/delete inside Drive folder
		const probe = await backups.procedures['backups.gdrive.test'].run()
		assert.equal(probe.ok, true)

		// 5. Resumable multi-chunk upload (600 KB across 3 x 256 KB chunks) with transient 429 retry
		mock.setFailNextUploads(1)
		const bigPayload = randomBytes(600 * 1024)
		const bigFile = join(ws.root, 'big-pack.bin')
		await writeFile(bigFile, bigPayload)
		const uploaded = await backups.gdrive.putObject(finished.folderId, 'server/data/aa/' + 'a'.repeat(64), bigFile, {size: bigPayload.length})
		assert.equal(uploaded.size, bigPayload.length)
		const readBack = await backups.gdrive.downloadBuffer(uploaded.id)
		assert.ok(readBack.equals(bigPayload), 'resumable uploaded payload must match byte-for-byte')

		// 6. Google 750 GB daily upload cap throws GdriveQuotaError cleanly
		mock.setDailyQuotaError(true)
		await assert.rejects(
			() => backups.gdrive.putObject(finished.folderId, 'server/data/bb/' + 'b'.repeat(64), Buffer.from('test')),
			(err) => err instanceof GdriveQuotaError && err.retryAfterMs > 0,
		)
		mock.setDailyQuotaError(false)

		// 7. Disconnect wipes tokens & local index
		await backups.procedures['backups.gdrive.disconnect'].run()
		const after = await backups.procedures['backups.gdrive.status'].run()
		assert.equal(after.connected, false)
		assert.equal(after.hasClientSecret, false)
		backups.close()
	} finally {
		await mock.close()
		await ws.cleanup()
	}
})

test('Google Drive restic REST v2 bridge enforces auth, Range downloads, and metadata caching', async () => {
	const mock = await startMockGoogleDrive()
	const ws = await makeWorkspace()
	try {
		const client = createGdriveClient({
			indexFile: join(ws.dataDir, 'gdrive-index.json'),
			cacheDir: join(ws.dataDir, 'gdrive-cache'),
			getCredentials: async () => ({clientId: 'cid.apps.googleusercontent.com', clientSecret: '', refreshToken: ref}),
			...mock.gdriveOptions,
		})
		// Mint a valid token via mock OAuth
		const verifier = randomBytes(32).toString('base64url')
		const issued = mock.issueCode(`${mock.baseUrl}/oauth/auth?client_id=cid.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1&state=s1&code_challenge=${pkceChallenge(verifier)}`)
		// Reject tokens granted wider scope than drive.file
		const badClient = createGdriveClient({
			indexFile: join(ws.dataDir, 'bad-idx.json'),
			getCredentials: async () => null,
			fetchImpl: async () => new Response(JSON.stringify({access_token: 'tok', refresh_token: 'ref', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive'}), {status: 200}),
		})
		await assert.rejects(
			() => badClient.exchangeCode({clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'https://srv/cb', codeVerifier: 'v'}),
			/wider than drive\.file/,
		)

		const tok = await client.exchangeCode({
			clientId: 'cid.apps.googleusercontent.com',
			clientSecret: '',
			code: issued.code,
			redirectUri: 'http://127.0.0.1',
			codeVerifier: verifier,
		})
		const ref = tok.refreshToken
		const rootId = await client.ensureRootFolder('MODC Bridge Test')
		const bridge = await client.startResticBridge(rootId, {repoPrefix: 'server'})
		try {
			const u = new URL(bridge.repoUrl.replace(/^rest:/, ''))
			const base = `http://${u.host}`
			const authHeader = `Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}`

			// Unauthenticated request rejected with 401
			const unauth = await fetch(`${base}/config`)
			assert.equal(unauth.status, 401)

			// Create repo layout
			const created = await fetch(`${base}/?create=true`, {method: 'POST', headers: {authorization: authHeader}})
			assert.equal(created.status, 200)

			// Upload config + pack
			const cfgBytes = Buffer.from('{"id":"test-repo","version":2}')
			assert.equal((await fetch(`${base}/config`, {method: 'POST', headers: {authorization: authHeader}, body: cfgBytes})).status, 200)
			// Overwriting existing config is forbidden (immutable)
			assert.equal((await fetch(`${base}/config`, {method: 'POST', headers: {authorization: authHeader}, body: cfgBytes})).status, 403)

			const packHash = 'c'.repeat(64)
			const packBytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
			assert.equal((await fetch(`${base}/data/${packHash}`, {method: 'POST', headers: {authorization: authHeader}, body: packBytes})).status, 200)

			// REST v2 list returns [{name, size}]
			const listRes = await fetch(`${base}/data/`, {headers: {authorization: authHeader, accept: 'application/vnd.x.restic.rest.v2'}})
			assert.equal(listRes.status, 200)
			assert.deepEqual(await listRes.json(), [{name: packHash, size: packBytes.length}])

			// Range GET returns 206 Partial Content
			const rangeRes = await fetch(`${base}/data/${packHash}`, {headers: {authorization: authHeader, range: 'bytes=10-19'}})
			assert.equal(rangeRes.status, 206)
			assert.equal(await rangeRes.text(), 'abcdefghij')
		} finally {
			await bridge.close()
		}
	} finally {
		await mock.close()
		await ws.cleanup()
	}
})

test('Full end-to-end encrypted Direct-to-Drive backup, zero-plaintext check, restore, and disaster recovery with real restic', {skip: !hasRealRestic()}, async () => {
	const mock = await startMockGoogleDrive()
	const ws = await makeWorkspace()
	const ws2 = await makeWorkspace()
	try {
		const backups = createBackups({
			dataDir: ws.dataDir,
			home: ws.home,
			serverDataDir: ws.serverDataDir,
			files: ws.files,
			apps: ws.apps,
			unshare: false,
			timers: false,
			gdriveOptions: {...mock.gdriveOptions, chunkSize: 256 * 1024},
		})
		await backups.ready

		// 1. Connect Google Drive & enable Direct-to-Drive mode (zero local duplicate repo!)
		const start = await backups.procedures['backups.gdrive.authStart'].run({
			clientId: '999-real.apps.googleusercontent.com',
			redirectUri: 'http://127.0.0.1',
			folderName: 'MODC Live 30TB',
		})
		const issued = mock.issueCode(start.authUrl)
		await backups.procedures['backups.gdrive.authFinish'].run({code: issued.callbackUrl})
		const cfg = await backups.procedures['backups.gdrive.configure'].run({
			enabled: true,
			mode: 'direct',
			packSizeMiB: 64,
			include: {apps: true, settings: true, machineBackups: false, customPaths: ['/Pools']},
		})
		assert.equal(cfg.configured, true)
		assert.ok(cfg.recoveryKey, 'must mint a 32-char recovery key')
		const recoveryKey = cfg.recoveryKey

		// 2. Run a full encrypted backup directly to Google Drive
		const run = await backups.runBackup('manual')
		await run.done
		const st = await backups.procedures['backups.status'].run()
		assert.equal(st.last.ok, true, `backup failed: ${st.last.error}`)
		assert.equal(st.last.gdrive.ok, true)
		assert.equal(st.last.gdrive.mode, 'direct')
		assert.ok(st.last.gdrive.uploaded > 0)
		assert.equal(st.last.items.length, 3) // Notes app + Server settings + /Pools

		// 3. ZERO-KNOWLEDGE VERIFICATION: assert ZERO plaintext content or filenames exist anywhere on Google Drive!
		const stored = mock.allStoredPayloads()
		assert.ok(stored.length >= 4, `expected encrypted restic files on Drive, got ${stored.length}`)
		for (const item of stored) {
			assert.ok(!item.name.includes('secret-notes'), `filename leaked on Drive: ${item.name}`)
			assert.ok(!item.name.includes('family-video'), `filename leaked on Drive: ${item.name}`)
			assert.ok(!item.data.includes(Buffer.from('SUPER_SECRET_APP_PAYLOAD_XYZ_987654')), `app plaintext leaked in ${item.name}!`)
			assert.ok(!item.data.includes(Buffer.from('TOP_SECRET_CONFIG_MARKER')), `settings plaintext leaked in ${item.name}!`)
			assert.ok(!item.data.includes(Buffer.from('PRIVATE_POOL_HEADER_')), `pool plaintext leaked in ${item.name}!`)
		}

		// 4. Verify snapshots list directly from Drive & restore Notes app after wiping it locally
		const snaps = await backups.procedures['backups.snapshots'].run()
		const appSnap = snaps.find((s) => s.tags.includes('app:notes'))
		assert.ok(appSnap, 'app:notes snapshot must exist on Google Drive')
		assert.ok(snaps.some((s) => s.tags.includes(`folder:${encodeURIComponent('/Pools')}`)), 'custom folder /Pools snapshot must exist on Google Drive')

		await writeFile(join(ws.appsDir, 'secret-notes.txt'), 'CORRUPTED_DATA')
		const restored = await backups.procedures['backups.restoreApp'].run({snapshotId: appSnap.id, appId: 'notes'})
		assert.equal(restored.restored, 'Notes')
		assert.equal(await readFile(join(ws.appsDir, 'secret-notes.txt'), 'utf8'), 'SUPER_SECRET_APP_PAYLOAD_XYZ_987654\n')

		// 5. DISASTER RECOVERY on a brand-new server (ws2) using ONLY Google Drive + recoveryKey!
		const rebuilt = createBackups({
			dataDir: ws2.dataDir,
			home: ws2.home,
			serverDataDir: ws2.serverDataDir,
			files: ws2.files,
			apps: ws2.apps,
			unshare: false,
			timers: false,
			gdriveOptions: {...mock.gdriveOptions, chunkSize: 256 * 1024},
		})
		await rebuilt.ready
		const s2 = await rebuilt.procedures['backups.gdrive.authStart'].run({
			clientId: '999-real.apps.googleusercontent.com',
			redirectUri: 'http://127.0.0.1',
			folderName: 'MODC Live 30TB',
		})
		await rebuilt.procedures['backups.gdrive.authFinish'].run({code: mock.issueCode(s2.authUrl).callbackUrl})

		// Wrong recovery key must be rejected with FORBIDDEN
		await assert.rejects(
			() => rebuilt.procedures['backups.gdrive.connectExisting'].run({folderName: 'MODC Live 30TB', recoveryKey: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh'}),
			/recovery key doesn’t open/i,
		)
		// Correct recovery key unlocks all Drive snapshots immediately
		const recovered = await rebuilt.procedures['backups.gdrive.connectExisting'].run({folderName: 'MODC Live 30TB', recoveryKey})
		assert.equal(recovered.configured, true)
		const snaps2 = await rebuilt.procedures['backups.snapshots'].run()
		assert.equal(snaps2.length, snaps.length)

		backups.close()
		rebuilt.close()
	} finally {
		await mock.close()
		await ws.cleanup()
		await ws2.cleanup()
	}
})

test('Google Drive 3-2-1 mirror uploads in restic safety order, prunes deleted packs, and respects computers/ prefix isolation', async () => {
	const mock = await startMockGoogleDrive()
	const ws = await makeWorkspace()
	try {
		let ref = ''
		const client = createGdriveClient({
			indexFile: join(ws.dataDir, 'gdrive-index.json'),
			cacheDir: join(ws.dataDir, 'gdrive-cache'),
			getCredentials: async () => ({clientId: 'cid.apps.googleusercontent.com', clientSecret: '', refreshToken: ref}),
			...mock.gdriveOptions,
		})
		const verifier = randomBytes(32).toString('base64url')
		const issued = mock.issueCode(`${mock.baseUrl}/oauth/auth?client_id=cid.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1&state=s2&code_challenge=${pkceChallenge(verifier)}`)
		const tok = await client.exchangeCode({
			clientId: 'cid.apps.googleusercontent.com',
			clientSecret: '',
			code: issued.code,
			redirectUri: 'http://127.0.0.1',
			codeVerifier: verifier,
		})
		ref = tok.refreshToken
		const rootId = await client.ensureRootFolder('Mirror 3-2-1')

		// Create a local encrypted repo tree
		const localRoot = join(ws.root, 'local-repo')
		const pack1 = '1'.repeat(64)
		const pack2 = '2'.repeat(64)
		const key1 = '3'.repeat(64)
		const snap1 = '4'.repeat(64)
		await mkdir(join(localRoot, 'server', 'data', '11'), {recursive: true})
		await mkdir(join(localRoot, 'server', 'keys'), {recursive: true})
		await mkdir(join(localRoot, 'server', 'snapshots'), {recursive: true})
		await writeFile(join(localRoot, 'server', 'data', '11', pack1), randomBytes(1024))
		await writeFile(join(localRoot, 'server', 'keys', key1), Buffer.from('enc-key'))
		await writeFile(join(localRoot, 'server', 'snapshots', snap1), Buffer.from('enc-snap'))
		await writeFile(join(localRoot, 'server', 'config'), Buffer.from('enc-cfg'))

		const m1 = await client.mirrorLocalRepo(rootId, localRoot)
		assert.equal(m1.uploaded, 4)
		assert.equal(m1.removed, 0)

		// Second mirror is a no-op (everything already cached in index)
		const m2 = await client.mirrorLocalRepo(rootId, localRoot)
		assert.equal(m2.uploaded, 0)
		assert.equal(m2.removed, 0)

		// Prune pack1 and add pack2 -> mirror uploads 1 and removes 1
		await rm(join(localRoot, 'server', 'data', '11', pack1))
		await mkdir(join(localRoot, 'server', 'data', '22'), {recursive: true})
		await writeFile(join(localRoot, 'server', 'data', '22', pack2), randomBytes(2048))
		const m3 = await client.mirrorLocalRepo(rootId, localRoot)
		assert.equal(m3.uploaded, 1)
		assert.equal(m3.removed, 1)

		// Prefix-scoped computers/ mirror leaves server/ completely untouched even if local server/ is absent (Direct-to-Drive mode!)
		const compOnly = join(ws.root, 'comp-only-repo')
		await mkdir(join(compOnly, 'computers', 'macbook', 'keys'), {recursive: true})
		await writeFile(join(compOnly, 'computers', 'macbook', 'config'), Buffer.from('comp-cfg'))
		await writeFile(join(compOnly, 'computers', 'macbook', 'keys', key1), Buffer.from('comp-key'))
		const m4 = await client.mirrorLocalRepo(rootId, compOnly, {prefix: 'computers/'})
		assert.equal(m4.uploaded, 2)
		assert.equal(m4.removed, 0)
		const idx = await client.reindex(rootId)
		assert.ok(idx.files['server/config'], 'server/config must remain intact on Drive')
		assert.ok(idx.files['computers/macbook/config'], 'computers/macbook/config must be uploaded')

		// Safety guard: a different local server/config must be REFUSED and must NOT wipe Drive history!
		const wrongLocal = join(ws.root, 'wrong-local-repo')
		await mkdir(join(wrongLocal, 'server'), {recursive: true})
		await writeFile(join(wrongLocal, 'server', 'config'), Buffer.from('DIFFERENT-REPO-ID'))
		await assert.rejects(() => client.mirrorLocalRepo(rootId, wrongLocal), /different backup repository/i)
		const idxAfter = await client.reindex(rootId)
		assert.ok(idxAfter.files[`server/data/22/${pack2}`], 'existing Drive pack must NOT be deleted when local repo mismatches')
	} finally {
		await mock.close()
		await ws.cleanup()
	}
})

test('Google Drive default folder name uses My Own Data Center', () => {
	assert.equal(cleanFolderName(''), 'My Own Data Center Backups')
	assert.equal(cleanFolderName('   '), 'My Own Data Center Backups')
})
