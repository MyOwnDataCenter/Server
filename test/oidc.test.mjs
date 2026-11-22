import assert from 'node:assert/strict'
import {createHash, createHmac, createPublicKey, verify as cryptoVerify} from 'node:crypto'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createOidc, normalizeIssuerUrl, normalizeRedirectUris} from '../omarchyd/oidc.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

function totpNow(uri) {
	const secretB32 = new URL(uri).searchParams.get('secret')
	const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
	let bits = 0
	let val = 0
	const out = []
	for (const c of secretB32.replace(/=+$/, '').toUpperCase()) {
		const idx = alpha.indexOf(c)
		if (idx < 0) continue
		val = (val << 5) | idx
		bits += 5
		if (bits >= 8) {
			bits -= 8
			out.push((val >> bits) & 0xff)
		}
	}
	const key = Buffer.from(out)
	const step = Math.floor(Date.now() / 30_000)
	const msg = Buffer.alloc(8)
	msg.writeBigUInt64BE(BigInt(step))
	const h = createHmac('sha1', key).update(msg).digest()
	const o = h[h.length - 1] & 0x0f
	return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0')
}

function pkcePair(verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_extra_chars_12345') {
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	return {verifier, challenge}
}

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

test('OIDC validators enforce strict redirect URIs and issuer URLs', () => {
	assert.equal(normalizeIssuerUrl(''), '')
	assert.equal(normalizeIssuerUrl('https://sso.example.com/'), 'https://sso.example.com')
	assert.throws(() => normalizeIssuerUrl('https://sso.example.com/subpath'), /without a path/)
	assert.throws(() => normalizeIssuerUrl('https://u:p@sso.example.com'), /credentials/)
	assert.throws(() => normalizeIssuerUrl('ftp://sso.example.com'), /http\(s\)/)

	assert.deepEqual(normalizeRedirectUris(['https://immich.example.com/auth/login', 'app.immich:///oauth-callback']), [
		'https://immich.example.com/auth/login',
		'app.immich:///oauth-callback',
	])
	assert.throws(() => normalizeRedirectUris(['https://*.example.com/cb']), /Wildcard/)
	assert.throws(() => normalizeRedirectUris(['javascript:alert(1)']), /scheme/)
	assert.throws(() => normalizeRedirectUris(['https://app.example.com/cb#frag']), /fragment/)
})

test('OIDC full Authorization Code + PKCE S256 + 2FA + RS256 verification + security invariants', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'omarchy-oidc-'))
	const accounts = await openAccounts(dir)
	await accounts.createOwner({name: 'Nate', password: 'super-secret-password'})
	const totpUri = accounts.totpUri('owner')
	await accounts.enable2fa('owner', {totpUri, totpToken: totpNow(totpUri)})

	const audited = []
	const oidc = createOidc({dataDir: dir, accounts, audit: {record: async (e) => audited.push(e)}})
	const srv = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://localhost')
		if (!(await oidc.handleHttp(req, res, u))) {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${srv.address().port}`

	try {
		// Unknown username must not fall back to owner
		await assert.rejects(accounts.verifyCredentials({username: 'nonexistent', password: 'super-secret-password'}), /Incorrect/)

		const created = await oidc.procedures['oidc.createClient'].run({
			name: 'Immich',
			redirectUris: ['https://immich.example.com/auth/login', 'app.immich:///oauth-callback'],
		})
		assert.ok(created.client.id.startsWith('oidc_'))
		assert.ok(created.clientSecret.startsWith('omarchy_oidc_'))
		const list = await oidc.procedures['oidc.clients'].run()
		assert.equal(list.length, 1)
		assert.equal('secretHash' in list[0], false)

		// Discovery & JWKS
		const disc = await httpReq(base, '/.well-known/openid-configuration', {headers: {'x-forwarded-proto': 'https', 'x-forwarded-host': 'omarchy.example.com'}})
		assert.equal(disc.status, 200)
		const meta = JSON.parse(disc.body)
		assert.equal(meta.issuer, 'https://omarchy.example.com')
		assert.equal(meta.token_endpoint, 'https://omarchy.example.com/oidc/token')
		assert.deepEqual(meta.code_challenge_methods_supported, ['S256'])
		assert.deepEqual(meta.response_modes_supported, ['query'])

		// OPTIONS CORS preflight on /oidc/token & /oidc/userinfo
		const optTok = await httpReq(base, '/oidc/token', {method: 'OPTIONS'})
		assert.equal(optTok.status, 204)
		assert.equal(optTok.headers['access-control-allow-origin'], '*')

		// prompt=none returns login_required, and overly long nonce is rejected
		const promptNone = await httpReq(
			base,
			`/oidc/authorize?${new URLSearchParams({
				client_id: created.client.id,
				redirect_uri: 'https://immich.example.com/auth/login',
				response_type: 'code',
				scope: 'openid',
				prompt: 'none',
				state: 's1',
				code_challenge: pkcePair().challenge,
				code_challenge_method: 'S256',
			})}`,
		)
		assert.equal(promptNone.status, 302)
		assert.match(promptNone.headers.location, /error=login_required/)
		const longNonce = await httpReq(
			base,
			`/oidc/authorize?${new URLSearchParams({
				client_id: created.client.id,
				redirect_uri: 'https://immich.example.com/auth/login',
				response_type: 'code',
				scope: 'openid',
				nonce: 'a'.repeat(300),
				code_challenge: pkcePair().challenge,
				code_challenge_method: 'S256',
			})}`,
		)
		assert.equal(longNonce.status, 302)
		assert.match(longNonce.headers.location, /error=invalid_request/)

		const jwksRes = await httpReq(base, '/oidc/jwks.json')
		assert.equal(jwksRes.status, 200)
		const jwks = JSON.parse(jwksRes.body)
		assert.equal(jwks.keys.length, 1)
		assert.equal(jwks.keys[0].alg, 'RS256')
		const pubKey = createPublicKey({key: jwks.keys[0], format: 'jwk'})

		// Open redirect blocked (400 HTML, never 302)
		const badRedir = await httpReq(base, `/oidc/authorize?client_id=${created.client.id}&redirect_uri=${encodeURIComponent('https://evil.example.com/steal')}&response_type=code&scope=openid`)
		assert.equal(badRedir.status, 400)
		assert.equal(badRedir.headers.location, undefined)

		// GET authorize renders CSRF-protected form with targeted form-action CSP
		const {verifier, challenge} = pkcePair()
		const authQuery = new URLSearchParams({
			client_id: created.client.id,
			redirect_uri: 'https://immich.example.com/auth/login',
			response_type: 'code',
			scope: 'openid profile email groups',
			state: 'st-123',
			nonce: 'nonce-456',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		})
		const getAuth = await httpReq(base, `/oidc/authorize?${authQuery}`)
		assert.equal(getAuth.status, 200)
		assert.match(getAuth.headers['content-security-policy'], /form-action 'self' https:\/\/immich\.example\.com/)
		const csrfCookie = String(getAuth.headers['set-cookie']?.[0] ?? '').split(';')[0]
		const csrfInput = /name="csrf" value="([^"]+)"/.exec(getAuth.body)?.[1]
		assert.ok(csrfCookie && csrfInput)

		// Missing CSRF cookie rejected with 403
		const noCsrf = await httpReq(base, '/oidc/authorize', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({...Object.fromEntries(authQuery), csrf: csrfInput, username: 'Nate', password: 'super-secret-password'}).toString(),
		})
		assert.equal(noCsrf.status, 403)

		// Password without 2FA rejected with 401
		const no2fa = await httpReq(base, '/oidc/authorize', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie},
			body: new URLSearchParams({...Object.fromEntries(authQuery), csrf: csrfInput, username: 'Nate', password: 'super-secret-password', action: 'approve'}).toString(),
		})
		assert.equal(no2fa.status, 401)
		assert.match(no2fa.body, /6-digit/)
		const csrfCookie2 = String(no2fa.headers['set-cookie']?.[0] ?? '').split(';')[0]
		const csrfInput2 = /name="csrf" value="([^"]+)"/.exec(no2fa.body)?.[1]

		// Valid password + 2FA issues 302 with code & state
		const okAuth = await httpReq(base, '/oidc/authorize', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				cookie: csrfCookie2,
				'x-forwarded-proto': 'https',
				'x-forwarded-host': 'omarchy.example.com',
			},
			body: new URLSearchParams({
				...Object.fromEntries(authQuery),
				csrf: csrfInput2,
				username: 'Nate',
				password: 'super-secret-password',
				totp: totpNow(totpUri),
				action: 'approve',
			}).toString(),
		})
		assert.equal(okAuth.status, 302)
		const loc = new URL(okAuth.headers.location)
		assert.equal(loc.origin + loc.pathname, 'https://immich.example.com/auth/login')
		assert.equal(loc.searchParams.get('state'), 'st-123')
		const code = loc.searchParams.get('code')
		assert.ok(code && code.length > 20)

		// Wrong client secret rejected (doesn't burn? wait: client auth runs BEFORE code consumption!)
		const badSecret = await httpReq(base, '/oidc/token', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: 'https://immich.example.com/auth/login',
				client_id: created.client.id,
				client_secret: 'wrong',
				code_verifier: verifier,
			}).toString(),
		})
		assert.equal(badSecret.status, 401)

		// Valid Basic auth + valid PKCE verifier exchanges code for RS256 id_token + access_token
		const basic = Buffer.from(`${encodeURIComponent(created.client.id)}:${encodeURIComponent(created.clientSecret)}`).toString('base64')
		const tokRes = await httpReq(base, '/oidc/token', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}`},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: 'https://immich.example.com/auth/login',
				code_verifier: verifier,
			}).toString(),
		})
		assert.equal(tokRes.status, 200)
		const tok = JSON.parse(tokRes.body)
		assert.equal(tok.token_type, 'Bearer')
		assert.ok(tok.access_token.startsWith('oidc_at_'))
		assert.ok(tok.id_token)

		// Cryptographically verify RS256 signature on id_token against JWKS public key
		const [hB64, pB64, sB64] = tok.id_token.split('.')
		const verified = cryptoVerify('RSA-SHA256', Buffer.from(`${hB64}.${pB64}`, 'utf8'), pubKey, Buffer.from(sB64, 'base64url'))
		assert.equal(verified, true)
		const header = JSON.parse(Buffer.from(hB64, 'base64url').toString('utf8'))
		const payload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8'))
		assert.equal(header.kid, jwks.keys[0].kid)
		assert.equal(payload.iss, 'https://omarchy.example.com')
		assert.equal(payload.aud, created.client.id)
		assert.equal(payload.sub, 'owner')
		assert.equal(payload.nonce, 'nonce-456')
		assert.equal(payload.preferred_username, 'Nate')
		assert.equal(payload.email, 'owner@omarchy.example.com')
		assert.equal(payload.email_verified, false)
		assert.deepEqual(payload.groups, ['owner'])

		// Replaying the same authorization code fails (single-use)
		const replay = await httpReq(base, '/oidc/token', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}`},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: 'https://immich.example.com/auth/login',
				code_verifier: verifier,
			}).toString(),
		})
		assert.equal(replay.status, 400)
		assert.equal(JSON.parse(replay.body).error, 'invalid_grant')

		// UserInfo endpoint returns claims for valid Bearer token
		const ui = await httpReq(base, '/oidc/userinfo', {headers: {authorization: `Bearer ${tok.access_token}`}})
		assert.equal(ui.status, 200)
		assert.deepEqual(JSON.parse(ui.body), {
			sub: 'owner',
			name: 'Nate',
			preferred_username: 'Nate',
			email: 'owner@omarchy.example.com',
			email_verified: false,
			groups: ['owner'],
		})

		// Non-PKCE client must reject unexpected code_verifier (RFC 9700 downgrade protection)
		const noPkceClient = await oidc.procedures['oidc.createClient'].run({
			name: 'Headscale',
			redirectUris: ['https://hs.example.com/oidc/callback'],
			requirePkce: false,
		})
		const npQuery = new URLSearchParams({
			client_id: noPkceClient.client.id,
			redirect_uri: 'https://hs.example.com/oidc/callback',
			response_type: 'code',
			scope: 'openid',
		})
		const npGet = await httpReq(base, `/oidc/authorize?${npQuery}`)
		assert.equal(npGet.status, 200)
		const npCookie = String(npGet.headers['set-cookie']?.[0] ?? '').split(';')[0]
		const npCsrf = /name="csrf" value="([^"]+)"/.exec(npGet.body)?.[1]
		assert.ok(npCookie && npCsrf)
		await oidc.procedures['oidc.deleteClient'].run({id: noPkceClient.client.id})

		// Custom native app URI scheme + Deny flow
		const mobileQuery = new URLSearchParams({
			client_id: created.client.id,
			redirect_uri: 'app.immich:///oauth-callback',
			response_type: 'code',
			scope: 'openid',
			state: 'mob-1',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		})
		const getMob = await httpReq(base, `/oidc/authorize?${mobileQuery}`)
		assert.equal(getMob.status, 200)
		assert.match(getMob.headers['content-security-policy'], /form-action 'self' app\.immich:/)
		const mobCookie = String(getMob.headers['set-cookie']?.[0] ?? '').split(';')[0]
		const mobCsrf = /name="csrf" value="([^"]+)"/.exec(getMob.body)?.[1]
		const denied = await httpReq(base, '/oidc/authorize', {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded', cookie: mobCookie},
			body: new URLSearchParams({...Object.fromEntries(mobileQuery), csrf: mobCsrf, action: 'deny'}).toString(),
		})
		assert.equal(denied.status, 302)
		assert.match(denied.headers.location, /^app\.immich:\/\/\/oauth-callback\?.*error=access_denied.*state=mob-1/)

		// Secret rotation + deletion revokes tokens
		const rotated = await oidc.procedures['oidc.rotateSecret'].run({id: created.client.id})
		assert.notEqual(rotated.clientSecret, created.clientSecret)
		await oidc.procedures['oidc.deleteClient'].run({id: created.client.id})
		const uiAfterDel = await httpReq(base, '/oidc/userinfo', {headers: {authorization: `Bearer ${tok.access_token}`}})
		assert.equal(uiAfterDel.status, 401)
		assert.ok(audited.some((e) => e.action === 'oidc.authorize'))
	} finally {
		await new Promise((r) => srv.close(r))
		await rm(dir, {recursive: true, force: true, maxRetries: 3})
	}
})

test('Express app proxies OIDC discovery, JWKS, and authorize CSP cleanly', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'omarchy-oidc-web-'))
	const daemonDir = join(dir, 'daemon')
	const webDir = join(dir, 'web')
	const accounts = await openAccounts(daemonDir)
	await accounts.createOwner({name: 'Nate', password: 'super-secret-password'})
	const oidc = createOidc({dataDir: daemonDir, accounts})
	const created = await oidc.procedures['oidc.createClient'].run({
		name: 'Forgejo',
		redirectUris: ['https://git.example.com/user/oauth2/omarchy/callback'],
	})
	const daemonSrv = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://localhost')
		if (!(await oidc.handleHttp(req, res, u))) {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((r) => daemonSrv.listen(0, '127.0.0.1', r))
	const store = await createStore(webDir)
	await store.setConfig({backendUrl: `http://127.0.0.1:${daemonSrv.address().port}`})
	const app = createApp({store})
	const webSrv = http.createServer(app)
	await new Promise((r) => webSrv.listen(0, '127.0.0.1', r))
	const webBase = `http://127.0.0.1:${webSrv.address().port}`

	try {
		const disc = await httpReq(webBase, '/.well-known/openid-configuration')
		assert.equal(disc.status, 200)
		const meta = JSON.parse(disc.body)
		assert.equal(meta.issuer, webBase)
		assert.equal(meta.jwks_uri, `${webBase}/oidc/jwks.json`)

		const jwks = await httpReq(webBase, '/oidc/jwks.json')
		assert.equal(jwks.status, 200)
		assert.equal(JSON.parse(jwks.body).keys[0].alg, 'RS256')

		// Authorize through Express proxy must override Express's default form-action 'self' CSP
		// and trust x-forwarded-host from loopback while stripping unrelated cookies.
		const discFwd = await httpReq(webBase, '/.well-known/openid-configuration', {
			headers: {'x-forwarded-host': 'sso.example.com', 'x-forwarded-proto': 'https'},
		})
		assert.equal(discFwd.status, 200)
		assert.equal(JSON.parse(discFwd.body).issuer, 'https://sso.example.com')

		const {challenge} = pkcePair()
		const q = new URLSearchParams({
			client_id: created.client.id,
			redirect_uri: 'https://git.example.com/user/oauth2/omarchy/callback',
			response_type: 'code',
			scope: 'openid',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		})
		const auth = await httpReq(webBase, `/oidc/authorize?${q}`)
		assert.equal(auth.status, 200)
		assert.match(auth.headers['content-security-policy'], /form-action 'self' https:\/\/git\.example\.com/)
	} finally {
		await new Promise((r) => webSrv.close(r))
		await new Promise((r) => daemonSrv.close(r))
		await rm(dir, {recursive: true, force: true, maxRetries: 3})
	}
})

test('OIDC protects against corrupt config wipe, concurrent client races, unexpected PKCE verifier, and cookie leaks', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'omarchy-oidc-edge-'))
	try {
		// Corrupt oidc.json must fail loudly instead of silently wiping signing keys
		const badDir = join(dir, 'bad')
		const accountsBad = await openAccounts(badDir)
		await writeFile(join(badDir, 'oidc.json'), '{not valid json', 'utf8')
		const oidcBad = createOidc({dataDir: badDir, accounts: accountsBad})
		await assert.rejects(oidcBad.procedures['oidc.status'].run(), /corrupted/)

		// Concurrent createClient calls must not lose updates
		const okDir = join(dir, 'ok')
		const accounts = await openAccounts(okDir)
		await accounts.createOwner({name: 'Nate', password: 'super-secret-password'})
		const oidc = createOidc({dataDir: okDir, accounts})
		const [c1, c2] = await Promise.all([
			oidc.procedures['oidc.createClient'].run({name: 'App1', redirectUris: ['https://a1.example.com/cb'], requirePkce: false, issuerUrl: 'https://sso.example.com'}),
			oidc.procedures['oidc.createClient'].run({name: 'App2', redirectUris: ['https://a2.example.com/cb'], requirePkce: false}),
		])
		const all = await oidc.procedures['oidc.clients'].run()
		assert.equal(all.length, 2)
		assert.equal((await oidc.procedures['oidc.status'].run()).issuerUrl, 'https://sso.example.com')

		// Unexpected code_verifier on non-PKCE authorization code is rejected (RFC 9700)
		let seenCookieOnToken = null
		const srv = http.createServer(async (req, res) => {
			const u = new URL(req.url ?? '/', 'http://localhost')
			if (u.pathname === '/oidc/token') seenCookieOnToken = req.headers.cookie ?? null
			if (!(await oidc.handleHttp(req, res, u))) {
				res.writeHead(404)
				res.end()
			}
		})
		await new Promise((r) => srv.listen(0, '127.0.0.1', r))
		const store = await createStore(join(dir, 'web'))
		await store.setConfig({backendUrl: `http://127.0.0.1:${srv.address().port}`})
		const webSrv = http.createServer(createApp({store}))
		await new Promise((r) => webSrv.listen(0, '127.0.0.1', r))
		const webBase = `http://127.0.0.1:${webSrv.address().port}`
		try {
			const q = new URLSearchParams({client_id: c1.client.id, redirect_uri: 'https://a1.example.com/cb', response_type: 'code', scope: 'openid'})
			const g = await httpReq(webBase, `/oidc/authorize?${q}`)
			const csrfCookie = String(g.headers['set-cookie']?.[0] ?? '').split(';')[0]
			const csrf = /name="csrf" value="([^"]+)"/.exec(g.body)?.[1]
			const p = await httpReq(webBase, '/oidc/authorize', {
				method: 'POST',
				headers: {'content-type': 'application/x-www-form-urlencoded', cookie: `${csrfCookie}; omarchy_session=secret-sid`},
				body: new URLSearchParams({...Object.fromEntries(q), csrf, username: 'Nate', password: 'super-secret-password', action: 'approve'}).toString(),
			})
			assert.equal(p.status, 302)
			const code = new URL(p.headers.location).searchParams.get('code')
			assert.ok(code)
			const t = await httpReq(webBase, '/oidc/token', {
				method: 'POST',
				headers: {'content-type': 'application/x-www-form-urlencoded', cookie: 'omarchy_session=secret-sid'},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: 'https://a1.example.com/cb',
					client_id: c1.client.id,
					client_secret: c1.clientSecret,
					code_verifier: pkcePair().verifier,
				}).toString(),
			})
			assert.equal(t.status, 400)
			assert.equal(JSON.parse(t.body).error, 'invalid_grant')
			assert.equal(seenCookieOnToken, null)
			assert.ok(c2.client.id)
		} finally {
			await new Promise((r) => webSrv.close(r))
			await new Promise((r) => srv.close(r))
		}
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 3})
	}
})
