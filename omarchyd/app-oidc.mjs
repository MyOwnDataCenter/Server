// App Store OpenID Connect (OIDC) integration: built-in adapters, manifest parsing,
// redirect URI synthesis, CA bundle helpers, and compose.oidc.yml overlay generation.
import {chmod, readFile} from 'node:fs/promises'
import net from 'node:net'
import {join} from 'node:path'
import YAML from 'yaml'

import {writeAtomic} from './atomic.mjs'

const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,80}$/
const SAFE_SERVICE = /^[A-Za-z0-9._-]{1,64}$/
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])
const BLOCKED_ENV_KEYS = new Set([
	'PATH',
	'HOME',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'DOCKER_HOST',
	'NODE_OPTIONS',
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'BASH_ENV',
	'ENV',
	'IFS',
	'SSL_CERT_FILE',
	'REQUESTS_CA_BUNDLE',
	'NODE_EXTRA_CA_CERTS',
])

const OIDC_VAR_NAMES = new Set([
	'OIDC_ISSUER',
	'OIDC_DISCOVERY_URL',
	'OIDC_CLIENT_ID',
	'OIDC_CLIENT_SECRET',
	'OIDC_AUTHORIZE_URL',
	'OIDC_TOKEN_URL',
	'OIDC_USERINFO_URL',
	'OIDC_JWKS_URL',
	'OIDC_APP_URL',
])

const PAPERLESS_PROVIDERS_TEMPLATE = JSON.stringify({
	openid_connect: {
		OAUTH_PKCE_ENABLED: false,
		APPS: [
			{
				provider_id: 'omarchy',
				name: 'Omarchy Server',
				client_id: '${OIDC_CLIENT_ID}',
				secret: '${OIDC_CLIENT_SECRET}',
				settings: {
					server_url: '${OIDC_DISCOVERY_URL}',
				},
			},
		],
	},
})

// Built-in OIDC integration adapters for popular self-hosted App Store listings.
// A listing's own `oidc:` manifest block always overrides the built-in entry.
export const BUILTIN_APP_OIDC = {
	'open-webui': {
		mode: 'auto',
		requirePkce: true,
		redirectPaths: ['/oauth/oidc/callback'],
		env: {
			ENABLE_OAUTH_SIGNUP: 'true',
			OAUTH_MERGE_ACCOUNTS_BY_EMAIL: 'true',
			OAUTH_PROVIDER_NAME: 'Omarchy Server',
			OPENID_PROVIDER_URL: '${OIDC_DISCOVERY_URL}',
			OAUTH_CLIENT_ID: '${OIDC_CLIENT_ID}',
			OAUTH_CLIENT_SECRET: '${OIDC_CLIENT_SECRET}',
			OAUTH_SCOPES: 'openid profile email groups',
		},
		note: 'Open WebUI is configured automatically to sign in with your Omarchy Server account + 2FA.',
	},
	grafana: {
		mode: 'auto',
		requirePkce: true,
		redirectPaths: ['/login/generic_oauth'],
		env: {
			GF_SERVER_ROOT_URL: '${OIDC_APP_URL}',
			GF_AUTH_GENERIC_OAUTH_ENABLED: 'true',
			GF_AUTH_GENERIC_OAUTH_NAME: 'Omarchy Server',
			GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP: 'true',
			GF_AUTH_GENERIC_OAUTH_CLIENT_ID: '${OIDC_CLIENT_ID}',
			GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: '${OIDC_CLIENT_SECRET}',
			GF_AUTH_GENERIC_OAUTH_SCOPES: 'openid profile email groups',
			GF_AUTH_GENERIC_OAUTH_AUTH_URL: '${OIDC_AUTHORIZE_URL}',
			GF_AUTH_GENERIC_OAUTH_TOKEN_URL: '${OIDC_TOKEN_URL}',
			GF_AUTH_GENERIC_OAUTH_API_URL: '${OIDC_USERINFO_URL}',
			GF_AUTH_GENERIC_OAUTH_USE_PKCE: 'true',
		},
		note: 'Grafana is configured automatically with "Sign in with Omarchy Server" via Generic OAuth (PKCE S256).',
	},
	'paperless-ngx': {
		mode: 'auto',
		requirePkce: false,
		redirectPaths: ['/accounts/oidc/omarchy/login/callback/'],
		env: {
			PAPERLESS_APPS: 'allauth.socialaccount.providers.openid_connect',
			PAPERLESS_SOCIALACCOUNT_PROVIDERS: PAPERLESS_PROVIDERS_TEMPLATE,
			PAPERLESS_SOCIAL_AUTO_SIGNUP: 'true',
		},
		note: 'Paperless-ngx is configured automatically with django-allauth OpenID Connect.',
	},
	mealie: {
		mode: 'auto',
		requirePkce: false,
		redirectPaths: ['/login'],
		env: {
			OIDC_AUTH_ENABLED: 'true',
			OIDC_SIGNUP_ENABLED: 'true',
			OIDC_CONFIGURATION_URL: '${OIDC_DISCOVERY_URL}',
			OIDC_CLIENT_ID: '${OIDC_CLIENT_ID}',
			OIDC_CLIENT_SECRET: '${OIDC_CLIENT_SECRET}',
			OIDC_PROVIDER_NAME: 'Omarchy Server',
			OIDC_ADMIN_GROUP: 'owner',
			OIDC_USER_GROUP: 'member',
		},
		note: 'Mealie is configured automatically for Omarchy Server SSO (owner → admin, member → user).',
	},
	karakeep: {
		mode: 'auto',
		requirePkce: true,
		redirectPaths: ['/api/auth/callback/custom'],
		env: {
			OAUTH_WELLKNOWN_URL: '${OIDC_DISCOVERY_URL}',
			OAUTH_CLIENT_ID: '${OIDC_CLIENT_ID}',
			OAUTH_CLIENT_SECRET: '${OIDC_CLIENT_SECRET}',
			OAUTH_PROVIDER_NAME: 'Omarchy Server',
			OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING: 'true',
		},
		note: 'Karakeep is configured automatically to sign in with Omarchy Server.',
	},
	immich: {
		mode: 'assisted',
		requirePkce: true,
		redirectPaths: ['/auth/login', '/user-settings', 'app.immich:///oauth-callback'],
		env: {},
		note: 'In Immich Administration → Settings → OAuth Authentication, enable OAuth and paste the Issuer URL, Client ID, and Client Secret from this app’s SSO panel.',
	},
	forgejo: {
		mode: 'assisted',
		requirePkce: true,
		redirectPaths: ['/user/oauth2/omarchy/callback'],
		env: {},
		note: 'In Site Administration → Authentication Sources → Add Authentication Source → OAuth2 → OpenID Connect, paste the Discovery URL, Client ID, and Client Secret.',
	},
	jellyfin: {
		mode: 'assisted',
		requirePkce: false,
		redirectPaths: ['/sso/OID/redirect/omarchy'],
		env: {},
		note: 'With the Jellyfin SSO-Auth plugin, configure provider "omarchy" using the Issuer URL, Client ID, and Client Secret.',
	},
	audiobookshelf: {
		mode: 'assisted',
		requirePkce: true,
		redirectPaths: ['/auth/openid/callback', '/auth/openid/mobile-redirect', 'audiobookshelf://oauth'],
		env: {},
		note: 'In Audiobookshelf Settings → Authentication → OpenID Connect, paste the Issuer URL, Client ID, and Client Secret.',
	},
}

const APP_OIDC_ALIASES = {
	paperless: 'paperless-ngx',
	'immich-app': 'immich',
	gitea: 'forgejo',
	hoarder: 'karakeep',
}

function isValidRedirectPathOrScheme(raw) {
	const s = String(raw ?? '').trim()
	if (!s || s.length > 256 || s.includes('*') || s.includes('#') || /\s/.test(s) || s.includes('\\') || s.includes('\0')) return false
	if (s.startsWith('/')) return !s.startsWith('//')
	let u
	try {
		u = new URL(s)
	} catch {
		return false
	}
	const proto = u.protocol.toLowerCase()
	if (proto === 'http:' || proto === 'https:' || FORBIDDEN_SCHEMES.has(proto)) return false
	return /^[a-z][a-z0-9+.-]*:$/.test(proto)
}

export function parseManifestOidc(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const rawPaths = Array.isArray(raw.redirectPaths) ? raw.redirectPaths : []
	const redirectPaths = []
	for (const p of rawPaths) {
		const s = String(p ?? '').trim()
		if (!isValidRedirectPathOrScheme(s)) return null
		if (!redirectPaths.includes(s)) redirectPaths.push(s)
	}
	if (!redirectPaths.length || redirectPaths.length > 10) return null

	let service = null
	if (raw.service !== undefined && raw.service !== null && raw.service !== '') {
		const sv = String(raw.service).trim()
		if (!SAFE_SERVICE.test(sv)) return null
		service = sv
	}

	const env = {}
	if (raw.env !== undefined && raw.env !== null) {
		if (typeof raw.env !== 'object' || Array.isArray(raw.env)) return null
		const entries = Object.entries(raw.env)
		if (entries.length > 30) return null
		for (const [k, v] of entries) {
			if (!SAFE_ENV_KEY.test(k) || BLOCKED_ENV_KEYS.has(k)) return null
			if (typeof v !== 'string' || v.length > 2048) return null
			env[k] = v
		}
	}

	const requirePkce = raw.requirePkce !== false
	const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 400) : ''
	return {
		mode: Object.keys(env).length > 0 ? 'auto' : 'assisted',
		requirePkce,
		redirectPaths,
		...(service ? {service} : {}),
		env,
		note,
	}
}

export function resolveAppOidcSpec(appId, manifestOidc = null) {
	if (manifestOidc) {
		const parsed = parseManifestOidc(manifestOidc)
		if (parsed) return parsed
	}
	const key = String(appId ?? '').trim().toLowerCase()
	if (!key) return null
	const canonical = APP_OIDC_ALIASES[key] ?? key
	const builtin = BUILTIN_APP_OIDC[canonical]
	return builtin ? {...builtin, redirectPaths: [...builtin.redirectPaths], env: {...builtin.env}} : null
}

export function oidcSummaryForStore(appId, manifestOidc = null) {
	const spec = resolveAppOidcSpec(appId, manifestOidc)
	if (!spec) return undefined
	return {
		supported: true,
		mode: spec.mode,
		...(spec.note ? {note: spec.note} : {}),
	}
}

export function oidcVarsFor(issuerUrl, clientId, clientSecret, appPort = null) {
	const iss = String(issuerUrl ?? '').replace(/\/+$/, '')
	let appUrl = iss
	if (iss && appPort) {
		try {
			const u = new URL(iss)
			const h = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname
			appUrl = `${u.protocol}//${h}:${appPort}`
		} catch {
			/* keep issuer */
		}
	}
	return {
		OIDC_ISSUER: iss,
		OIDC_DISCOVERY_URL: `${iss}/.well-known/openid-configuration`,
		OIDC_CLIENT_ID: String(clientId ?? ''),
		OIDC_CLIENT_SECRET: String(clientSecret ?? ''),
		OIDC_AUTHORIZE_URL: `${iss}/oidc/authorize`,
		OIDC_TOKEN_URL: `${iss}/oidc/token`,
		OIDC_USERINFO_URL: `${iss}/oidc/userinfo`,
		OIDC_JWKS_URL: `${iss}/oidc/jwks.json`,
		OIDC_APP_URL: appUrl,
	}
}

export function expandOidcTemplates(envMap, vars, {escapeCompose = false} = {}) {
	const out = {}
	for (const [k, tmpl] of Object.entries(envMap ?? {})) {
		const expanded = String(tmpl).replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => (OIDC_VAR_NAMES.has(name) ? (vars[name] ?? '') : match))
		out[k] = escapeCompose ? expanded.replace(/\$/g, '$$$$') : expanded
	}
	return out
}

export function buildAppRedirectUris({port, redirectPaths = [], issuerUrl = '', hostname = '', ips = [], tailscaleDns = '', tailscaleIps = [], appHostUrl = ''}) {
	const out = []
	const add = (uri) => {
		if (!uri || out.includes(uri) || out.length >= 20) return
		out.push(uri)
	}
	const customSchemes = redirectPaths.filter((p) => !p.startsWith('/'))
	const paths = redirectPaths.filter((p) => p.startsWith('/'))
	for (const s of customSchemes) add(s)
	if (!paths.length) return out

	const hostCandidates = []
	const addHost = (h, preferProto = 'https') => {
		const clean = String(h ?? '').trim().replace(/\.$/, '')
		if (!clean || hostCandidates.some((x) => x.host.toLowerCase() === clean.toLowerCase())) return
		hostCandidates.push({host: clean, preferProto})
	}

	if (issuerUrl) {
		try {
			const u = new URL(issuerUrl)
			addHost(u.hostname, u.protocol === 'http:' ? 'http' : 'https')
		} catch {
			/* ignore */
		}
	}
	if (tailscaleDns) addHost(tailscaleDns, 'https')
	for (const ip of tailscaleIps ?? []) if (net.isIPv4(ip)) addHost(ip, 'https')
	for (const ip of ips ?? []) if (net.isIPv4(ip)) addHost(ip, 'https')
	if (hostname) addHost(`${hostname}.local`, 'https')
	addHost('localhost', 'http')

	// Optional reverse-proxied app subdomain (TOUCH_APP_HOSTS) needs no port.
	if (appHostUrl) {
		const base = String(appHostUrl).replace(/\/+$/, '')
		for (const p of paths) add(`${base}${p}`)
	}

	if (port) {
		// Pass 1: preferred scheme for every host; Pass 2: alternate scheme (dual-protocol gateway serves both).
		for (const pass of [0, 1]) {
			for (const {host, preferProto} of hostCandidates) {
				const proto = pass === 0 ? preferProto : preferProto === 'https' ? 'http' : 'https'
				const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
				for (const p of paths) add(`${proto}://${bracketed}:${port}${p}`)
			}
		}
	}
	return out
}

export async function buildOidcCaBundle({caCertPath, outDir, systemBundlePath = '/etc/ssl/certs/ca-certificates.crt'}) {
	if (!caCertPath || !outDir) return {caPath: null, bundlePath: null}
	let caPem
	try {
		caPem = await readFile(caCertPath, 'utf8')
	} catch {
		return {caPath: null, bundlePath: null}
	}
	if (!caPem.includes('BEGIN CERTIFICATE')) return {caPath: null, bundlePath: null}
	const caPath = join(outDir, 'omarchy-ca.crt')
	await writeAtomic(caPath, caPem, {mode: 0o644})
	await chmod(caPath, 0o644).catch(() => {})

	let bundlePath = null
	try {
		const sysRoots = await readFile(systemBundlePath, 'utf8')
		if (sysRoots.includes('BEGIN CERTIFICATE')) {
			bundlePath = join(outDir, 'omarchy-ca-bundle.pem')
			await writeAtomic(bundlePath, `${sysRoots.trimEnd()}\n${caPem.trimStart()}`, {mode: 0o644})
			await chmod(bundlePath, 0o644).catch(() => {})
		}
	} catch {
		/* non-Linux or missing system root bundle: keep additive NODE_EXTRA_CA_CERTS only */
	}
	return {caPath, bundlePath}
}

export function oidcComposeOverlay({composeText, app, spec, oidcVars, caPath = null, bundlePath = null, issuerUrl = ''}) {
	const doc = (() => {
		try {
			return YAML.parse(String(composeText ?? '')) ?? {}
		} catch {
			return {}
		}
	})()
	const services = doc?.services && typeof doc.services === 'object' ? doc.services : {}
	const names = Object.keys(services)
	if (!names.length) return null

	let targetName = spec?.service && Object.hasOwn(services, spec.service) ? spec.service : null
	if (!targetName && app?.internalPort) {
		targetName =
			names.find((n) =>
				(services[n]?.ports ?? []).some((p) => {
					const s = typeof p === 'string' ? p : `${p?.host_ip ?? ''}:${p?.published ?? ''}:`
					return s.includes(`127.0.0.1:${app.internalPort}:`)
				}),
			) ?? null
	}
	targetName ??= names[0]
	const targetSvc = services[targetName] ?? {}

	const env = expandOidcTemplates(spec?.env ?? {}, oidcVars, {escapeCompose: true})
	const volumes = []
	const isHttps = String(issuerUrl ?? '').startsWith('https://')
	if (isHttps && caPath) {
		volumes.push(`${caPath}:/etc/omarchy-ca.crt:ro`)
		env.NODE_EXTRA_CA_CERTS = '/etc/omarchy-ca.crt'
	}
	if (isHttps && bundlePath) {
		volumes.push(`${bundlePath}:/etc/omarchy-ca-bundle.pem:ro`)
		env.SSL_CERT_FILE = '/etc/omarchy-ca-bundle.pem'
		env.REQUESTS_CA_BUNDLE = '/etc/omarchy-ca-bundle.pem'
	}

	const extraHosts = []
	if (issuerUrl && !targetSvc.network_mode) {
		try {
			const host = new URL(issuerUrl).hostname
			if (host && host !== 'localhost' && net.isIP(host) === 0 && /^[a-z0-9.-]{1,253}$/i.test(host)) {
				extraHosts.push(`${host}:host-gateway`)
			}
		} catch {
			/* ignore */
		}
	}

	if (!Object.keys(env).length && !volumes.length && !extraHosts.length) return null
	const patch = {}
	if (Object.keys(env).length) patch.environment = env
	if (volumes.length) patch.volumes = volumes
	if (extraHosts.length) patch.extra_hosts = extraHosts
	return YAML.stringify({services: {[targetName]: patch}})
}
