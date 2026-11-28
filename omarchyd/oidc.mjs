// Zero-dependency OpenID Connect (OIDC) Authorization Code + PKCE Identity Provider.
// Backed directly by omarchyd/accounts.mjs (passwords + TOTP 2FA) with RS256 JWT signing.
import {createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import {RpcError} from './rpc.mjs'
import {writeAtomic} from './atomic.mjs'

const CSRF_COOKIE = 'OMARCHY_OIDC_CSRF'
const CODE_TTL_MS = 120_000
const ACCESS_TTL_MS = 3600_000
const ID_TOKEN_TTL_S = 3600
const MAX_CODES = 2000
const MAX_TOKENS = 4000
const ALLOWED_SCOPES = ['openid', 'profile', 'email', 'groups']
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])
const SAFE_HOST = /^[a-z0-9.\-:[\]]{1,260}$/i

export const OIDC_PRESETS = [
	{
		id: 'immich',
		name: 'Immich',
		requirePkce: true,
		defaultPaths: ['/auth/login', 'app.immich:///oauth-callback'],
		note: 'In Immich Administration → Settings → OAuth, paste the Issuer URL, Client ID, and Client Secret. Immich supports PKCE S256 by default.',
	},
	{
		id: 'forgejo',
		name: 'Forgejo / Gitea',
		requirePkce: true,
		defaultPaths: ['/user/oauth2/omarchy/callback'],
		note: 'In Site Administration → Authentication Sources → Add OAuth2 → OpenID Connect, use the Discovery URL (PKCE S256 supported).',
	},
	{
		id: 'jellyfin',
		name: 'Jellyfin',
		requirePkce: false,
		defaultPaths: ['/sso/OID/redirect/omarchy'],
		note: 'With the Jellyfin SSO-Auth plugin, configure provider "omarchy" using the Issuer URL. PKCE is off by default for compatibility with the plugin.',
	},
	{
		id: 'grafana',
		name: 'Grafana',
		requirePkce: true,
		defaultPaths: ['/login/generic_oauth'],
		note: 'Configure [auth.generic_oauth] with auth_url, token_url, api_url (userinfo), use_pkce = true, and scopes "openid profile email groups".',
	},
	{
		id: 'paperless',
		name: 'Paperless-ngx',
		requirePkce: false,
		defaultPaths: ['/accounts/oidc/omarchy/login/callback/'],
		note: 'Set PAPERLESS_APPS=allauth.socialaccount.providers.openid_connect and server_url to the Discovery URL. PKCE is off unless OAUTH_PKCE_ENABLED is set.',
	},
	{
		id: 'open-webui',
		name: 'Open WebUI',
		requirePkce: true,
		defaultPaths: ['/oauth/oidc/callback'],
		note: 'Set OPENID_PROVIDER_URL to the Discovery URL, plus OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.',
	},
	{
		id: 'headscale',
		name: 'Headscale',
		requirePkce: false,
		defaultPaths: ['/oidc/callback'],
		note: 'In Headscale config.yaml under oidc:, set issuer, client_id, and client_secret. Turn PKCE on here only if you set oidc.pkce.enabled: true in Headscale.',
	},
]

function sha256Hex(s) {
	return createHash('sha256').update(String(s)).digest('hex')
}

function sha256B64Url(s) {
	return createHash('sha256').update(String(s)).digest('base64url')
}

function b64urlJson(obj) {
	return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}

function safeEqual(a, b) {
	const ba = Buffer.from(String(a ?? ''), 'utf8')
	const bb = Buffer.from(String(b ?? ''), 'utf8')
	return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function parseCookies(header) {
	const out = {}
	for (const part of String(header ?? '').split(';')) {
		const eq = part.indexOf('=')
		if (eq <= 0) continue
		const k = part.slice(0, eq).trim()
		const v = part.slice(eq + 1).trim()
		try {
			out[k] = decodeURIComponent(v)
		} catch {
			out[k] = v
		}
	}
	return out
}

export function normalizeIssuerUrl(raw) {
	const v = String(raw ?? '').trim()
	if (!v) return ''
	let u
	try {
		u = new URL(v)
	} catch {
		throw new RpcError('BAD_REQUEST', 'Enter a valid http:// or https:// Issuer URL (or leave blank for automatic)')
	}
	if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password || u.search || u.hash) {
		throw new RpcError('BAD_REQUEST', 'Issuer URL must be http(s):// without credentials, query string, or fragment')
	}
	if (u.pathname && u.pathname !== '/') {
		throw new RpcError('BAD_REQUEST', 'Issuer URL must be an origin without a path (e.g. https://omarchy.example.com)')
	}
	return u.origin
}

export function normalizeRedirectUris(list) {
	if (!Array.isArray(list) || list.length === 0) throw new RpcError('BAD_REQUEST', 'Add at least one redirect URI')
	const out = []
	for (const raw of list) {
		const s = String(raw ?? '').trim()
		if (!s) continue
		if (s.includes('*')) throw new RpcError('BAD_REQUEST', `Wildcard redirect URIs aren’t allowed: ${s}`)
		if (/[\u0000-\u001f\u007f\\]/.test(s)) throw new RpcError('BAD_REQUEST', `Redirect URI contains an unsupported character: ${s}`)
		let u
		try {
			u = new URL(s)
		} catch {
			throw new RpcError('BAD_REQUEST', `Invalid redirect URI: ${s}`)
		}
		if (u.username || u.password) throw new RpcError('BAD_REQUEST', `Redirect URI must not contain credentials: ${s}`)
		if (FORBIDDEN_SCHEMES.has(u.protocol.toLowerCase())) {
			throw new RpcError('BAD_REQUEST', `Unsupported redirect URI scheme: ${u.protocol}`)
		}
		if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.hostname) {
			throw new RpcError('BAD_REQUEST', `Invalid redirect URI: ${s}`)
		}
		if (u.hash) throw new RpcError('BAD_REQUEST', `Redirect URI must not contain a fragment (#): ${s}`)
		if (!out.includes(s)) out.push(s)
	}
	if (!out.length) throw new RpcError('BAD_REQUEST', 'Add at least one redirect URI')
	if (out.length > 20) throw new RpcError('BAD_REQUEST', 'Too many redirect URIs (max 20)')
	return out
}

function redirectCspTarget(redirectUri) {
	try {
		const u = new URL(redirectUri)
		if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
		if (/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol)) return u.protocol.toLowerCase()
	} catch {
		/* ignore */
	}
	return ''
}

function synthesizeEmail(user, issuerUrl) {
	const slug =
		String(user.userId || 'user')
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '.')
			.replace(/^\.+|\.+$/g, '') || 'user'
	let domain = 'omarchy.local'
	try {
		const h = new URL(issuerUrl).hostname.toLowerCase()
		if (h && h !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.includes(':')) domain = h
	} catch {
		/* keep default */
	}
	return `${slug}@${domain}`
}

function userClaims(user, scopes, issuerUrl) {
	const set = new Set(scopes)
	const claims = {sub: String(user.userId)}
	if (set.has('profile')) {
		claims.name = user.name
		claims.preferred_username = user.name
	}
	if (set.has('email')) {
		claims.email = synthesizeEmail(user, issuerUrl)
		claims.email_verified = false
	}
	if (set.has('groups')) {
		claims.groups = [user.role || 'member']
	}
	return claims
}

function generateRsaKey() {
	const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
	const kid = `omarchy-${randomBytes(6).toString('hex')}`
	return {
		kid,
		privateJwk: privateKey.export({format: 'jwk'}),
		publicJwk: publicKey.export({format: 'jwk'}),
	}
}

async function readBody(req, maxBytes = 32 * 1024) {
	let size = 0
	const chunks = []
	for await (const c of req) {
		size += c.length
		if (size > maxBytes) throw new RpcError('PAYLOAD_TOO_LARGE', 'Request body too large')
		chunks.push(c)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function parseTokenBody(req, raw) {
	const ct = String(req.headers['content-type'] ?? '').toLowerCase()
	if (ct.includes('application/json')) {
		try {
			const obj = JSON.parse(raw || '{}')
			return obj && typeof obj === 'object' ? obj : {}
		} catch {
			return {}
		}
	}
	return Object.fromEntries(new URLSearchParams(raw))
}

function parseBasicAuth(header) {
	const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header ?? '').trim())
	if (!m) return null
	const decoded = Buffer.from(m[1], 'base64').toString('utf8')
	const colon = decoded.indexOf(':')
	if (colon < 0) return null
	const dec = (s) => {
		try {
			return decodeURIComponent(s.replace(/\+/g, ' '))
		} catch {
			return s
		}
	}
	return {clientId: dec(decoded.slice(0, colon)), clientSecret: dec(decoded.slice(colon + 1))}
}

function renderAuthorizePage({clientName, params, csrf, error = '', username = '', needs2fa = false}) {
	const scopes = String(params.scope ?? 'openid')
		.split(/\s+/)
		.filter((s) => ALLOWED_SCOPES.includes(s))
	const scopeDesc = {
		openid: 'Your account identifier',
		profile: 'Your display name',
		email: 'Your account email address',
		groups: 'Your server role (owner or member)',
	}
	const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method']
		.filter((k) => params[k])
		.map((k) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(params[k])}">`)
		.join('')
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ${escapeHtml(clientName)} · My Own Data Center</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#0f1117;color:#eef2ff;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:400px;background:#171a24;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:26px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b95b3;margin-bottom:6px}
h1{margin:0 0 6px;font-size:21px;font-weight:650}
.sub{margin:0 0 18px;color:#9aa3be;font-size:14px}
.err{background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.4);color:#fecaca;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-bottom:14px}
.scopes{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px 12px;margin-bottom:16px;font-size:13px;color:#c7d0e8}
.scopes b{display:block;font-size:12px;color:#8b95b3;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.scopes ul{margin:0;padding-left:18px}
.scopes li{margin:2px 0}
label{display:block;font-size:13px;color:#b8c2dd;margin:0 0 5px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;margin-bottom:12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0f1117;color:#fff;font:inherit}
input:focus{outline:2px solid #60a5fa;border-color:#60a5fa}
.actions{display:flex;gap:10px;margin-top:8px}
button{flex:1;padding:11px 14px;border-radius:10px;border:0;font:inherit;font-weight:600;cursor:pointer}
.primary{background:#3b82f6;color:#fff}
.secondary{background:rgba(255,255,255,.08);color:#d7dff3}
</style>
</head>
<body>
<main class="card">
	<div class="eyebrow">My Own Data Center</div>
	<h1>Sign in to ${escapeHtml(clientName)}</h1>
	<p class="sub">Use your account on this server to continue.</p>
	${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
	<div class="scopes">
		<b>This app will receive</b>
		<ul>${scopes.map((s) => `<li>${escapeHtml(scopeDesc[s] || s)}</li>`).join('')}</ul>
	</div>
	<form method="POST" action="/oidc/authorize" autocomplete="on">
		${hidden}
		<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
		<label for="u">Account name</label>
		<input id="u" name="username" type="text" required autocomplete="username" value="${escapeHtml(username)}">
		<label for="p">Password</label>
		<input id="p" name="password" type="password" required autocomplete="current-password">
		<label for="t">Two-factor code ${needs2fa ? '(required)' : '(if enabled)'}</label>
		<input id="t" name="totp" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" placeholder="6-digit code">
		<div class="actions">
			<button type="submit" name="action" value="deny" class="secondary" formnovalidate>Cancel</button>
			<button type="submit" name="action" value="approve" class="primary">Sign in &amp; allow</button>
		</div>
	</form>
</main>
</body>
</html>`
}

function renderErrorPage(title, message) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · My Own Data Center</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#0f1117;color:#eef2ff;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{max-width:420px;background:#171a24;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px}h1{margin:0 0 8px;font-size:19px}p{margin:0;color:#9aa3be}</style>
</head>
<body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`
}

export function createOidc({dataDir, accounts, audit = null, now = () => Date.now()} = {}) {
	const file = join(dataDir, 'oidc.json')
	let state = null
	let privateKeyObj = null
	let initPromise = null
	let writeChain = Promise.resolve()

	const codes = new Map() // code -> {clientId, redirectUri, userId, scope, nonce, codeChallenge, authTime, issuer, expiresAt}
	const accessTokens = new Map() // token -> {userId, clientId, scope, issuer, expiresAt}

	function prune() {
		const t = now()
		for (const [k, v] of codes) if (v.expiresAt <= t) codes.delete(k)
		for (const [k, v] of accessTokens) if (v.expiresAt <= t) accessTokens.delete(k)
	}

	async function updateState(mutator) {
		let result
		const run = writeChain.catch(() => {}).then(async () => {
			const res = await mutator(state)
			const next = res && typeof res === 'object' && 'state' in res ? res.state : res
			result = res && typeof res === 'object' && 'value' in res ? res.value : next
			await writeAtomic(file, JSON.stringify(next, null, 2), {mode: 0o600})
			state = next
			privateKeyObj = createPrivateKey({key: state.key.privateJwk, format: 'jwk'})
		})
		writeChain = run
		await run
		return result
	}

	async function ensureReady() {
		if (state) return state
		if (!initPromise) {
			initPromise = (async () => {
				let raw
				try {
					raw = await readFile(file, 'utf8')
				} catch (e) {
					if (e?.code === 'ENOENT') {
						await updateState(() => ({issuerUrl: '', key: generateRsaKey(), clients: []}))
						return state
					}
					throw new RpcError('INTERNAL_SERVER_ERROR', `Couldn’t read OIDC config (${e?.code || 'I/O error'})`)
				}
				let loaded
				try {
					loaded = JSON.parse(raw)
				} catch {
					throw new RpcError('INTERNAL_SERVER_ERROR', 'OIDC config file (oidc.json) is corrupted — fix or remove it manually rather than resetting signing keys')
				}
				if (!loaded || typeof loaded !== 'object' || !loaded.key?.privateJwk || !loaded.key?.publicJwk || !loaded.key?.kid) {
					throw new RpcError('INTERNAL_SERVER_ERROR', 'OIDC config file (oidc.json) is missing required signing key data')
				}
				state = {
					issuerUrl: typeof loaded.issuerUrl === 'string' ? loaded.issuerUrl : '',
					key: loaded.key,
					clients: Array.isArray(loaded.clients) ? loaded.clients : [],
				}
				privateKeyObj = createPrivateKey({key: state.key.privateJwk, format: 'jwk'})
				return state
			})().finally(() => {
				initPromise = null
			})
		}
		return initPromise
	}

	function publicClientView(c) {
		return {
			id: c.id,
			name: c.name,
			publicClient: !!c.publicClient,
			requirePkce: c.requirePkce !== false,
			redirectUris: [...c.redirectUris],
			scopes: [...(c.scopes ?? ALLOWED_SCOPES)],
			createdAt: c.createdAt,
			...(c.managedAppId ? {managedAppId: c.managedAppId} : {}),
		}
	}

	function issuerFor(req) {
		if (state?.issuerUrl) return state.issuerUrl
		const rawHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
			.split(',')[0]
			.trim()
		const host = SAFE_HOST.test(rawHost) ? rawHost : 'localhost'
		const rawProto = String(req.headers['x-forwarded-proto'] ?? '')
			.split(',')[0]
			.trim()
			.toLowerCase()
		const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : req.socket?.encrypted ? 'https' : 'http'
		return `${proto}://${host}`
	}

	function signJwt(payload) {
		const header = {alg: 'RS256', typ: 'JWT', kid: state.key.kid}
		const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
		const sig = cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKeyObj).toString('base64url')
		return `${signingInput}.${sig}`
	}

	function sendJson(res, status, body, extraHeaders = {}) {
		const buf = Buffer.from(JSON.stringify(body), 'utf8')
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': buf.length,
			'cache-control': 'no-store',
			pragma: 'no-cache',
			...extraHeaders,
		})
		res.end(buf)
	}

	function redirectWithError(res, redirectUri, error, description, stateParam, extraHeaders = {}) {
		const u = new URL(redirectUri)
		u.searchParams.set('error', error)
		if (description) u.searchParams.set('error_description', description)
		if (stateParam) u.searchParams.set('state', stateParam)
		res.writeHead(302, {location: u.toString(), 'cache-control': 'no-store', ...extraHeaders})
		res.end()
	}

	function validateAuthorizeParams(params, client) {
		const responseType = String(params.response_type ?? '')
		if (responseType !== 'code') return {error: 'unsupported_response_type', description: 'Only response_type=code is supported'}
		const requestedScopes = String(params.scope ?? '')
			.trim()
			.split(/\s+/)
			.filter(Boolean)
		if (!requestedScopes.includes('openid')) return {error: 'invalid_scope', description: 'The openid scope is required'}
		const grantedScopes = requestedScopes.filter((s) => ALLOWED_SCOPES.includes(s))
		const nonce = String(params.nonce ?? '')
		if (nonce.length > 256) return {error: 'invalid_request', description: 'nonce is too long (max 256 characters)'}
		const codeChallenge = String(params.code_challenge ?? '').trim()
		const codeChallengeMethod = String(params.code_challenge_method ?? '').trim()
		const needPkce = client.requirePkce !== false || !!client.publicClient
		if (codeChallenge) {
			if (codeChallengeMethod !== 'S256') return {error: 'invalid_request', description: 'Only PKCE code_challenge_method=S256 is supported'}
			if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return {error: 'invalid_request', description: 'Invalid code_challenge'}
		} else if (needPkce) {
			return {error: 'invalid_request', description: 'PKCE code_challenge (S256) is required for this client'}
		}
		return {ok: true, scope: grantedScopes.join(' '), codeChallenge, nonce}
	}

	function isSecureReq(req) {
		const proto = String(req.headers['x-forwarded-proto'] ?? '')
			.split(',')[0]
			.trim()
			.toLowerCase()
		return proto === 'https' || !!req.socket?.encrypted
	}

	function csrfCookieHeader(req, value, maxAge) {
		return `${CSRF_COOKIE}=${value}; Path=/oidc/authorize; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureReq(req) ? '; Secure' : ''}`
	}

	function authorizeHeaders(redirectUri, extra = {}) {
		const target = redirectCspTarget(redirectUri)
		return {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${target ? ` ${target}` : ''}`,
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			...extra,
		}
	}

	const CORS_HEADERS = {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': 'Authorization, Content-Type',
	}

	async function handleHttp(req, res, url) {
		const path = url.pathname
		if ((path === '/oidc/token' || path === '/oidc/userinfo' || path === '/.well-known/openid-configuration' || path === '/oidc/jwks.json') && req.method === 'OPTIONS') {
			res.writeHead(204, CORS_HEADERS)
			res.end()
			return true
		}

		if (path === '/.well-known/openid-configuration' && req.method === 'GET') {
			await ensureReady()
			const iss = issuerFor(req)
			sendJson(
				res,
				200,
				{
					issuer: iss,
					authorization_endpoint: `${iss}/oidc/authorize`,
					token_endpoint: `${iss}/oidc/token`,
					userinfo_endpoint: `${iss}/oidc/userinfo`,
					jwks_uri: `${iss}/oidc/jwks.json`,
					response_types_supported: ['code'],
					response_modes_supported: ['query'],
					grant_types_supported: ['authorization_code'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256'],
					scopes_supported: ALLOWED_SCOPES,
					token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
					code_challenge_methods_supported: ['S256'],
					claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'auth_time', 'name', 'preferred_username', 'email', 'email_verified', 'groups'],
				},
				{'access-control-allow-origin': '*'},
			)
			return true
		}

		if (path === '/oidc/jwks.json' && req.method === 'GET') {
			await ensureReady()
			sendJson(
				res,
				200,
				{
					keys: [
						{
							...state.key.publicJwk,
							kid: state.key.kid,
							use: 'sig',
							alg: 'RS256',
						},
					],
				},
				{'access-control-allow-origin': '*'},
			)
			return true
		}

		if (path === '/oidc/authorize' && req.method === 'GET') {
			await ensureReady()
			const params = Object.fromEntries(url.searchParams.entries())
			const client = state.clients.find((c) => c.id === params.client_id)
			if (!client) {
				const html = renderErrorPage('Unknown app', 'This client ID isn’t registered on this server.')
				res.writeHead(400, authorizeHeaders(''))
				res.end(html)
				return true
			}
			if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) {
				const html = renderErrorPage('Invalid redirect URI', 'The redirect URI doesn’t match any address registered for this app.')
				res.writeHead(400, authorizeHeaders(''))
				res.end(html)
				return true
			}
			const check = validateAuthorizeParams(params, client)
			if (!check.ok) {
				redirectWithError(res, params.redirect_uri, check.error, check.description, params.state)
				return true
			}
			const prompts = String(params.prompt ?? '')
				.trim()
				.split(/\s+/)
				.filter(Boolean)
			if (prompts.includes('none')) {
				redirectWithError(res, params.redirect_uri, 'login_required', 'Interactive sign-in is required', params.state)
				return true
			}
			const csrf = randomBytes(24).toString('base64url')
			const html = renderAuthorizePage({clientName: client.name, params, csrf})
			res.writeHead(200, authorizeHeaders(params.redirect_uri, {'set-cookie': csrfCookieHeader(req, csrf, 600)}))
			res.end(html)
			return true
		}

		if (path === '/oidc/authorize' && req.method === 'POST') {
			await ensureReady()
			let raw
			try {
				raw = await readBody(req, 16 * 1024)
			} catch (e) {
				res.writeHead(413, authorizeHeaders(''))
				res.end(renderErrorPage('Request too large', e.message))
				return true
			}
			const form = Object.fromEntries(new URLSearchParams(raw))
			const client = state.clients.find((c) => c.id === form.client_id)
			if (!client || !form.redirect_uri || !client.redirectUris.includes(form.redirect_uri)) {
				res.writeHead(400, authorizeHeaders(''))
				res.end(renderErrorPage('Invalid request', 'Unknown client or redirect URI.'))
				return true
			}
			const cookies = parseCookies(req.headers.cookie)
			const cookieCsrf = cookies[CSRF_COOKIE]
			if (!cookieCsrf || !form.csrf || !safeEqual(cookieCsrf, form.csrf)) {
				const freshCsrf = randomBytes(24).toString('base64url')
				const html = renderAuthorizePage({
					clientName: client.name,
					params: form,
					csrf: freshCsrf,
					error: 'Your sign-in form expired. Please try again.',
					username: form.username ?? '',
				})
				res.writeHead(403, authorizeHeaders(form.redirect_uri, {'set-cookie': csrfCookieHeader(req, freshCsrf, 600)}))
				res.end(html)
				return true
			}
			if (form.action === 'deny') {
				redirectWithError(res, form.redirect_uri, 'access_denied', 'User cancelled sign-in', form.state, {'set-cookie': csrfCookieHeader(req, '', 0)})
				return true
			}
			const check = validateAuthorizeParams(form, client)
			if (!check.ok) {
				redirectWithError(res, form.redirect_uri, check.error, check.description, form.state, {'set-cookie': csrfCookieHeader(req, '', 0)})
				return true
			}
			let user
			try {
				user = await accounts.verifyCredentials({
					username: form.username,
					password: form.password,
					totpToken: String(form.totp ?? '').replace(/\s+/g, '') || undefined,
				})
			} catch (e) {
				const freshCsrf = randomBytes(24).toString('base64url')
				const msg = e?.message || 'Incorrect username or password'
				const html = renderAuthorizePage({
					clientName: client.name,
					params: form,
					csrf: freshCsrf,
					error: msg,
					username: form.username ?? '',
					needs2fa: /2FA|6-digit/i.test(msg),
				})
				res.writeHead(401, authorizeHeaders(form.redirect_uri, {'set-cookie': csrfCookieHeader(req, freshCsrf, 600)}))
				res.end(html)
				return true
			}
			prune()
			if (codes.size >= MAX_CODES) {
				const oldest = codes.keys().next().value
				if (oldest) codes.delete(oldest)
			}
			const code = randomBytes(32).toString('base64url')
			codes.set(code, {
				clientId: client.id,
				redirectUri: form.redirect_uri,
				userId: user.userId,
				scope: check.scope,
				nonce: check.nonce,
				codeChallenge: check.codeChallenge,
				authTime: Math.floor(now() / 1000),
				issuer: issuerFor(req),
				expiresAt: now() + CODE_TTL_MS,
			})
			await audit?.record({action: 'oidc.authorize', target: client.id, actor: user.userId, ok: true, detail: {clientName: client.name}})
			const dest = new URL(form.redirect_uri)
			dest.searchParams.set('code', code)
			if (form.state) dest.searchParams.set('state', form.state)
			res.writeHead(302, {
				location: dest.toString(),
				'cache-control': 'no-store',
				'set-cookie': csrfCookieHeader(req, '', 0),
			})
			res.end()
			return true
		}

		if (path === '/oidc/token' && req.method === 'POST') {
			await ensureReady()
			let raw
			try {
				raw = await readBody(req, 32 * 1024)
			} catch {
				sendJson(res, 413, {error: 'invalid_request', error_description: 'Request too large'})
				return true
			}
			const body = parseTokenBody(req, raw)
			const basic = parseBasicAuth(req.headers.authorization)
			if (basic && body.client_id && body.client_id !== basic.clientId) {
				sendJson(res, 400, {error: 'invalid_request', error_description: 'Multiple conflicting client_id values'})
				return true
			}
			const clientId = String(basic?.clientId ?? body.client_id ?? '')
			const clientSecret = basic ? basic.clientSecret : String(body.client_secret ?? '')
			const client = state.clients.find((c) => c.id === clientId)
			if (!client) {
				sendJson(res, 401, {error: 'invalid_client', error_description: 'Unknown client'}, {'www-authenticate': 'Basic realm="oidc"', ...CORS_HEADERS})
				return true
			}
			if (!client.publicClient) {
				if (!clientSecret || !client.secretHash || !safeEqual(sha256Hex(clientSecret), client.secretHash)) {
					sendJson(res, 401, {error: 'invalid_client', error_description: 'Invalid client credentials'}, {'www-authenticate': 'Basic realm="oidc"', ...CORS_HEADERS})
					return true
				}
			}
			if (body.grant_type !== 'authorization_code') {
				sendJson(res, 400, {error: 'unsupported_grant_type', error_description: 'Only authorization_code is supported'}, CORS_HEADERS)
				return true
			}
			const code = String(body.code ?? '')
			prune()
			const entry = codes.get(code)
			codes.delete(code) // single-use: always consume immediately
			if (!entry || entry.expiresAt <= now() || entry.clientId !== client.id || entry.redirectUri !== String(body.redirect_uri ?? '')) {
				sendJson(res, 400, {error: 'invalid_grant', error_description: 'Authorization code is invalid or expired'}, CORS_HEADERS)
				return true
			}
			const verifier = String(body.code_verifier ?? '')
			const needPkce = Boolean(entry.codeChallenge) || client.requirePkce !== false || !!client.publicClient
			if (needPkce) {
				if (!entry.codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256B64Url(verifier), entry.codeChallenge)) {
					sendJson(res, 400, {error: 'invalid_grant', error_description: 'PKCE code_verifier check failed'}, CORS_HEADERS)
					return true
				}
			} else if (verifier) {
				// RFC 9700 §2.1.1: reject unexpected code_verifier when no code_challenge was issued.
				sendJson(res, 400, {error: 'invalid_grant', error_description: 'Unexpected code_verifier for non-PKCE authorization code'}, CORS_HEADERS)
				return true
			}
			const user = accounts.getUser(entry.userId)
			if (!user) {
				sendJson(res, 400, {error: 'invalid_grant', error_description: 'Account no longer exists'}, CORS_HEADERS)
				return true
			}
			const iat = Math.floor(now() / 1000)
			const scopes = entry.scope.split(/\s+/).filter(Boolean)
			const claims = userClaims(user, scopes, entry.issuer)
			const idToken = signJwt({
				iss: entry.issuer,
				aud: client.id,
				iat,
				exp: iat + ID_TOKEN_TTL_S,
				auth_time: entry.authTime,
				...(entry.nonce ? {nonce: entry.nonce} : {}),
				...claims,
			})
			if (accessTokens.size >= MAX_TOKENS) {
				const oldest = accessTokens.keys().next().value
				if (oldest) accessTokens.delete(oldest)
			}
			const accessToken = `oidc_at_${randomBytes(32).toString('base64url')}`
			accessTokens.set(accessToken, {
				userId: user.userId,
				clientId: client.id,
				scope: entry.scope,
				issuer: entry.issuer,
				expiresAt: now() + ACCESS_TTL_MS,
			})
			sendJson(
				res,
				200,
				{
					access_token: accessToken,
					token_type: 'Bearer',
					expires_in: Math.floor(ACCESS_TTL_MS / 1000),
					id_token: idToken,
					scope: entry.scope,
				},
				CORS_HEADERS,
			)
			return true
		}

		if (path === '/oidc/userinfo' && (req.method === 'GET' || req.method === 'POST')) {
			await ensureReady()
			const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim())
			if (!m) {
				sendJson(res, 401, {error: 'invalid_token'}, {'www-authenticate': 'Bearer error="invalid_token"', ...CORS_HEADERS})
				return true
			}
			prune()
			const entry = accessTokens.get(m[1])
			if (!entry || entry.expiresAt <= now()) {
				sendJson(res, 401, {error: 'invalid_token'}, {'www-authenticate': 'Bearer error="invalid_token"', ...CORS_HEADERS})
				return true
			}
			const user = accounts.getUser(entry.userId)
			if (!user) {
				accessTokens.delete(m[1])
				sendJson(res, 401, {error: 'invalid_token'}, {'www-authenticate': 'Bearer error="invalid_token"', ...CORS_HEADERS})
				return true
			}
			const scopes = entry.scope.split(/\s+/).filter(Boolean)
			sendJson(res, 200, userClaims(user, scopes, entry.issuer), CORS_HEADERS)
			return true
		}

		return false
	}

	async function status() {
		await ensureReady()
		return {
			issuerUrl: state.issuerUrl,
			keyId: state.key.kid,
			clientCount: state.clients.length,
			presets: OIDC_PRESETS,
		}
	}

	async function setConfig(input = {}) {
		await ensureReady()
		const issuerUrl = normalizeIssuerUrl(input?.issuerUrl ?? '')
		await updateState((cur) => ({...cur, issuerUrl}))
		await audit?.record({action: 'oidc.setConfig', target: 'oidc', ok: true, detail: {issuerUrl}})
		return status()
	}

	async function listClients() {
		await ensureReady()
		return state.clients.map(publicClientView)
	}

	async function createClient(input = {}) {
		await ensureReady()
		const name = String(input?.name ?? '').trim()
		if (!name || name.length > 80) throw new RpcError('BAD_REQUEST', 'Enter an app name (1–80 characters)')
		const redirectUris = normalizeRedirectUris(input?.redirectUris)
		const publicClient = !!input?.publicClient
		const requirePkce = publicClient ? true : input?.requirePkce !== false
		const initialIssuer = input?.issuerUrl ? normalizeIssuerUrl(input.issuerUrl) : ''
		const id = `oidc_${randomBytes(12).toString('hex')}`
		const clientSecret = publicClient ? null : `omarchy_oidc_${randomBytes(24).toString('base64url')}`
		const record = {
			id,
			name,
			publicClient,
			requirePkce,
			secretHash: clientSecret ? sha256Hex(clientSecret) : '',
			redirectUris,
			scopes: [...ALLOWED_SCOPES],
			createdAt: now(),
		}
		await updateState((cur) => ({
			...cur,
			issuerUrl: cur.issuerUrl || initialIssuer,
			clients: [...cur.clients, record],
		}))
		await audit?.record({action: 'oidc.createClient', target: id, ok: true, detail: {name, publicClient}})
		return {client: publicClientView(record), clientSecret}
	}

	async function updateClient(input = {}) {
		await ensureReady()
		const id = String(input?.id ?? '').trim()
		const updated = await updateState((cur) => {
			const existing = cur.clients.find((c) => c.id === id)
			if (!existing) throw new RpcError('NOT_FOUND', 'OIDC client not found')
			if (existing.managedAppId) throw new RpcError('BAD_REQUEST', 'This client is managed by the App Store: change SSO settings from that app’s sheet instead')
			const name = input?.name !== undefined ? String(input.name).trim() : existing.name
			if (!name || name.length > 80) throw new RpcError('BAD_REQUEST', 'Enter an app name (1–80 characters)')
			const redirectUris = input?.redirectUris !== undefined ? normalizeRedirectUris(input.redirectUris) : existing.redirectUris
			const requirePkce = existing.publicClient ? true : input?.requirePkce !== undefined ? !!input.requirePkce : existing.requirePkce !== false
			const nextClient = {...existing, name, redirectUris, requirePkce}
			return {state: {...cur, clients: cur.clients.map((c) => (c.id === id ? nextClient : c))}, value: nextClient}
		})
		await audit?.record({action: 'oidc.updateClient', target: id, ok: true, detail: {name: updated.name}})
		return publicClientView(updated)
	}

	async function rotateSecret(input = {}) {
		await ensureReady()
		const id = String(input?.id ?? '').trim()
		const clientSecret = `omarchy_oidc_${randomBytes(24).toString('base64url')}`
		await updateState((cur) => {
			const existing = cur.clients.find((c) => c.id === id)
			if (!existing) throw new RpcError('NOT_FOUND', 'OIDC client not found')
			if (existing.managedAppId) throw new RpcError('BAD_REQUEST', 'This client is managed by the App Store: toggle SSO off and back on in that app’s sheet to rotate credentials')
			if (existing.publicClient) throw new RpcError('BAD_REQUEST', 'Public PKCE clients don’t have a client secret')
			const nextClient = {
				...existing,
				secretHash: sha256Hex(clientSecret),
			}
			return {...cur, clients: cur.clients.map((c) => (c.id === id ? nextClient : c))}
		})
		await audit?.record({action: 'oidc.rotateSecret', target: id, ok: true})
		return {id, clientSecret}
	}

	async function ensureAppClient({appId, name, redirectUris, existingSecret = ''} = {}) {
		await ensureReady()
		const cleanAppId = String(appId ?? '').trim()
		if (!cleanAppId) throw new RpcError('BAD_REQUEST', 'Missing appId')
		const cleanName = String(name ?? cleanAppId).trim().slice(0, 80) || cleanAppId
		const uris = normalizeRedirectUris(redirectUris)
		const candidateSecret = typeof existingSecret === 'string' && existingSecret.startsWith('omarchy_oidc_') ? existingSecret : ''
		const res = await updateState((cur) => {
			const existing = cur.clients.find((c) => c.managedAppId === cleanAppId)
			if (existing) {
				// Never persist plaintext secrets in oidc.json: reuse caller's compose secret if it matches secretHash, else rotate.
				const reuse = Boolean(candidateSecret && existing.secretHash && safeEqual(sha256Hex(candidateSecret), existing.secretHash))
				const secret = reuse ? candidateSecret : `omarchy_oidc_${randomBytes(24).toString('base64url')}`
				const {managedSecret: _drop, ...cleanExisting} = existing
				const updated = {
					...cleanExisting,
					name: cleanName,
					redirectUris: uris,
					requirePkce: true,
					secretHash: sha256Hex(secret),
				}
				return {
					state: {...cur, clients: cur.clients.map((c) => (c.id === existing.id ? updated : c))},
					value: {client: publicClientView(updated), clientSecret: secret, issuerUrl: cur.issuerUrl, created: false},
				}
			}
			const id = `oidc_${randomBytes(12).toString('hex')}`
			const secret = `omarchy_oidc_${randomBytes(24).toString('base64url')}`
			const record = {
				id,
				name: cleanName,
				managedAppId: cleanAppId,
				publicClient: false,
				requirePkce: true,
				secretHash: sha256Hex(secret),
				redirectUris: uris,
				scopes: [...ALLOWED_SCOPES],
				createdAt: now(),
			}
			return {
				state: {...cur, clients: [...cur.clients, record]},
				value: {client: publicClientView(record), clientSecret: secret, issuerUrl: cur.issuerUrl, created: true},
			}
		})
		if (res.created) await audit?.record({action: 'oidc.ensureAppClient', target: cleanAppId, ok: true, detail: {clientId: res.client.id}})
		return res
	}

	async function getAppClient(appId) {
		await ensureReady()
		const cleanAppId = String(appId ?? '').trim()
		const found = state.clients.find((c) => c.managedAppId === cleanAppId)
		if (!found) return null
		return {
			client: publicClientView(found),
			issuerUrl: state.issuerUrl,
		}
	}

	async function removeAppClient(appId) {
		await ensureReady()
		const cleanAppId = String(appId ?? '').trim()
		const removedIds = await updateState((cur) => {
			const matching = cur.clients.filter((c) => c.managedAppId === cleanAppId).map((c) => c.id)
			if (!matching.length) return {state: cur, value: []}
			return {state: {...cur, clients: cur.clients.filter((c) => c.managedAppId !== cleanAppId)}, value: matching}
		})
		for (const id of removedIds) {
			for (const [k, v] of codes) if (v.clientId === id) codes.delete(k)
			for (const [k, v] of accessTokens) if (v.clientId === id) accessTokens.delete(k)
		}
		if (removedIds.length) await audit?.record({action: 'oidc.removeAppClient', target: cleanAppId, ok: true})
		return removedIds.length > 0
	}

	async function deleteClient(input = {}) {
		await ensureReady()
		const id = String(input?.id ?? '').trim()
		await updateState((cur) => {
			const existing = cur.clients.find((c) => c.id === id)
			if (!existing) throw new RpcError('NOT_FOUND', 'OIDC client not found')
			if (existing.managedAppId) throw new RpcError('BAD_REQUEST', 'This client is managed by the App Store: disable SSO from that app’s sheet instead')
			return {...cur, clients: cur.clients.filter((c) => c.id !== id)}
		})
		for (const [k, v] of codes) if (v.clientId === id) codes.delete(k)
		for (const [k, v] of accessTokens) if (v.clientId === id) accessTokens.delete(k)
		await audit?.record({action: 'oidc.deleteClient', target: id, ok: true})
		return true
	}

	async function reset() {
		codes.clear()
		accessTokens.clear()
		await updateState(() => ({issuerUrl: '', key: generateRsaKey(), clients: []}))
	}

	return {
		handleHttp,
		reset,
		ensureAppClient,
		getAppClient,
		removeAppClient,
		procedures: {
			'oidc.status': {kind: 'query', run: status},
			'oidc.setConfig': {kind: 'mutation', run: setConfig},
			'oidc.clients': {kind: 'query', run: listClients},
			'oidc.createClient': {kind: 'mutation', run: createClient},
			'oidc.updateClient': {kind: 'mutation', run: updateClient},
			'oidc.rotateSecret': {kind: 'mutation', run: rotateSecret},
			'oidc.deleteClient': {kind: 'mutation', run: deleteClient},
		},
	}
}
