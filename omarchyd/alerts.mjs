// Proactive alerts: RFC 8291/8292 Web Push (zero external dependencies, WebCrypto),
// optional SMTP email, and flap-damped background evaluation with quiet hours.
import {randomBytes} from 'node:crypto'
import {lookup} from 'node:dns/promises'
import {readFile} from 'node:fs/promises'
import net, {isIP} from 'node:net'
import {join} from 'node:path'
import tls from 'node:tls'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const enc = new TextEncoder()
export const b64urlEncode = (bytes) => Buffer.from(bytes).toString('base64url')
export const b64urlDecode = (s) => new Uint8Array(Buffer.from(String(s ?? ''), 'base64url'))

function concat(...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

async function hkdf(salt, ikm, info, bytes) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
	return new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, key, bytes * 8))
}

export async function generateVapidPair() {
	const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify'])
	const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
	const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
	return {publicKey, pkcs8}
}

export async function encryptPushPayload(plaintext, keys, opts = {}) {
	const uaPublic = b64urlDecode(keys.p256dh)
	const authSecret = b64urlDecode(keys.auth)
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 point')
	if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes')
	const rs = opts.recordSize ?? 4096
	if (plaintext.length + 17 > rs) throw new Error('payload too large for one record')

	const ephPair = opts.ephemeral
		? null
		: await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits'])
	const asPrivate = opts.ephemeral
		? await crypto.subtle.importKey('jwk', opts.ephemeral.privateJwk, {name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits'])
		: ephPair.privateKey
	const ephPubRaw = opts.ephemeral ? opts.ephemeral.publicRaw : new Uint8Array(await crypto.subtle.exportKey('raw', ephPair.publicKey))

	const uaKey = await crypto.subtle.importKey('raw', uaPublic, {name: 'ECDH', namedCurve: 'P-256'}, false, [])
	const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: uaKey}, asPrivate, 256))

	const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
	const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, ephPubRaw)
	const ikm = await hkdf(authSecret, ecdh, keyInfo, 32)
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

	const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
	const padded = concat(plaintext, new Uint8Array([2]))
	const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, aes, padded))

	const header = new Uint8Array(16 + 4 + 1 + 65)
	header.set(salt, 0)
	new DataView(header.buffer).setUint32(16, rs, false)
	header[20] = 65
	header.set(ephPubRaw, 21)
	return concat(header, cipher)
}

export async function vapidJwt(signer, audience, now = Date.now()) {
	const header = b64urlEncode(enc.encode(JSON.stringify({typ: 'JWT', alg: 'ES256'})))
	const claims = b64urlEncode(enc.encode(JSON.stringify({aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: signer.subject})))
	const signature = await signer.sign(enc.encode(`${header}.${claims}`))
	return `${header}.${claims}.${b64urlEncode(signature)}`
}

function ipv4Private(a, b) {
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

export function isPrivateAddress(address) {
	const a = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '')
	const family = isIP(a)
	if (family === 4) {
		const [x, y] = a.split('.').map(Number)
		return ipv4Private(x, y)
	}
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
		if (mapped) return isPrivateAddress(mapped[1])
		const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a)
		if (hex) {
			const hi = parseInt(hex[1], 16)
			const lo = parseInt(hex[2], 16)
			return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
		}
		return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)
	}
	return false
}

export async function checkPushEndpoint(endpoint, resolve = async (h) => (await lookup(h, {all: true})).map((r) => r.address)) {
	let url
	try {
		url = new URL(endpoint)
	} catch {
		return {ok: false, reason: 'invalid'}
	}
	if (url.protocol !== 'https:') return {ok: false, reason: 'not_https'}
	if (url.username || url.password) return {ok: false, reason: 'invalid'}
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return {ok: false, reason: 'private_address'}
	if (isIP(host)) return isPrivateAddress(host) ? {ok: false, reason: 'private_address'} : {ok: true, addresses: [host]}
	let addresses
	try {
		addresses = await resolve(host)
	} catch {
		return {ok: false, reason: 'invalid'}
	}
	if (!addresses.length || addresses.some(isPrivateAddress)) return {ok: false, reason: 'private_address'}
	return {ok: true, addresses}
}

export async function sendWebPush(target, payloadObj, signer, {fetchImpl = fetch, checkEndpoint = checkPushEndpoint, now = () => Date.now(), ttlSeconds = 3600, urgency = 'normal'} = {}) {
	const check = await checkEndpoint(target.endpoint)
	if (!check.ok) return {ok: false, reason: check.reason}
	const url = new URL(target.endpoint)
	const body = await encryptPushPayload(enc.encode(JSON.stringify(payloadObj)), {p256dh: target.p256dh, auth: target.auth})
	const jwt = await vapidJwt(signer, url.origin, now())
	try {
		const res = await fetchImpl(url.toString(), {
			method: 'POST',
			redirect: 'manual',
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Encoding': 'aes128gcm',
				TTL: String(ttlSeconds),
				Urgency: urgency,
				Authorization: `vapid t=${jwt}, k=${signer.publicKey}`,
			},
			body,
			signal: AbortSignal.timeout(15_000),
		})
		if (res.status >= 200 && res.status < 300) return {ok: true, status: res.status}
		if (res.status === 404 || res.status === 410) return {ok: false, reason: 'gone', status: res.status}
		return {ok: false, reason: `http_${res.status}`, status: res.status}
	} catch {
		return {ok: false, reason: 'network'}
	}
}

// Lightweight stdlib-only SMTP sender (supports implicit TLS 465 or STARTTLS 587/25 + AUTH PLAIN).
export async function sendSmtpMail({host, port = 587, secure = false, starttls = true, username = '', password = '', from, to, subject, text, timeoutMs = 15_000}) {
	if (!host || !from || !to) throw new RpcError('BAD_REQUEST', 'SMTP host, from, and to addresses are required')
	const cleanHeader = (v) => String(v ?? '').replace(/[\r\n]/g, ' ').trim()
	const deadline = Date.now() + timeoutMs
	let sock = await new Promise((resolve, reject) => {
		const s = secure ? tls.connect({host, port: Number(port), servername: host}) : net.connect({host, port: Number(port)})
		const timer = setTimeout(() => {
			s.destroy()
			reject(new Error('SMTP connect timed out'))
		}, Math.max(100, deadline - Date.now()))
		const done = (fn, arg) => {
			clearTimeout(timer)
			s.off('error', onErr)
			s.off('close', onClose)
			fn(arg)
		}
		const onErr = (e) => done(reject, e)
		const onClose = () => done(reject, new Error('SMTP connection closed'))
		s.once('error', onErr)
		s.once('close', onClose)
		s.once(secure ? 'secureConnect' : 'connect', () => done(resolve, s))
	})
	let encrypted = !!secure
	let buf = ''
	const takeReply = () => {
		const lines = buf.split('\r\n')
		for (let i = 0; i < lines.length - 1; i++) {
			const line = lines[i]
			if (/^\d{3} /.test(line)) {
				const code = Number(line.slice(0, 3))
				const msg = lines.slice(0, i + 1).join('\n')
				buf = lines.slice(i + 1).join('\r\n')
				return {code, msg}
			}
		}
		return null
	}
	const readReply = () =>
		new Promise((resolve, reject) => {
			const already = takeReply()
			if (already) return resolve(already)
			const remaining = deadline - Date.now()
			if (remaining <= 0) {
				sock.destroy()
				return reject(new Error('SMTP timed out'))
			}
			const timer = setTimeout(() => {
				cleanup()
				sock.destroy()
				reject(new Error('SMTP timed out'))
			}, remaining)
			const cleanup = () => {
				clearTimeout(timer)
				sock.off('data', onData)
				sock.off('error', onErr)
				sock.off('close', onClose)
				sock.off('end', onClose)
			}
			const onErr = (e) => (cleanup(), reject(e))
			const onClose = () => (cleanup(), reject(new Error('SMTP connection closed unexpectedly')))
			const onData = (chunk) => {
				buf += chunk.toString('utf8')
				const parsed = takeReply()
				if (parsed) {
					cleanup()
					resolve(parsed)
				}
			}
			sock.on('data', onData)
			sock.once('error', onErr)
			sock.once('close', onClose)
			sock.once('end', onClose)
		})
	const cmd = async (line, expectPrefix) => {
		sock.write(`${line}\r\n`)
		const r = await readReply()
		if (expectPrefix && !String(r.code).startsWith(expectPrefix)) throw new Error(`SMTP ${r.code}: ${r.msg.slice(0, 120)}`)
		return r
	}
	try {
		const greet = await readReply()
		if (greet.code !== 220) throw new Error(`SMTP greeting ${greet.code}`)
		const ehlo = await cmd('EHLO omarchy-server.local', '2')
		if (!secure && starttls) {
			if (!/STARTTLS/i.test(ehlo.msg)) throw new Error('SMTP server does not support STARTTLS')
			await cmd('STARTTLS', '2')
			sock = await new Promise((resolve, reject) => {
				const upgraded = tls.connect({socket: sock, servername: host})
				const remaining = Math.max(100, deadline - Date.now())
				const timer = setTimeout(() => {
					upgraded.destroy()
					reject(new Error('SMTP TLS timed out'))
				}, remaining)
				const done = (fn, arg) => {
					clearTimeout(timer)
					upgraded.off('error', onErr)
					upgraded.off('close', onClose)
					fn(arg)
				}
				const onErr = (e) => done(reject, e)
				const onClose = () => done(reject, new Error('SMTP TLS closed'))
				upgraded.once('error', onErr)
				upgraded.once('close', onClose)
				upgraded.once('secureConnect', () => done(resolve, upgraded))
			})
			encrypted = true
			buf = ''
			await cmd('EHLO omarchy-server.local', '2')
		}
		if (username && password) {
			if (!encrypted) throw new Error('Refusing SMTP authentication without TLS')
			const auth = Buffer.from(`\0${username}\0${password}`).toString('base64')
			await cmd(`AUTH PLAIN ${auth}`, '2')
		}
		await cmd(`MAIL FROM:<${cleanHeader(from)}>`, '2')
		await cmd(`RCPT TO:<${cleanHeader(to)}>`, '2')
		await cmd('DATA', '3')
		const safeBody = String(text ?? '').replace(/\r?\n\./g, '\r\n..').replace(/\r?\n/g, '\r\n')
		const msg = [
			`From: ${cleanHeader(from)}`,
			`To: ${cleanHeader(to)}`,
			`Subject: ${cleanHeader(subject)}`,
			`Date: ${new Date().toUTCString()}`,
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			safeBody,
			'.',
		].join('\r\n')
		await cmd(msg, '2')
		await cmd('QUIT').catch(() => {})
		return true
	} finally {
		try {
			sock.destroy()
		} catch {}
	}
}

export function createAlerts({dataDir, collectAlerts = async () => [], now = () => Date.now(), fetchImpl = fetch, checkEndpoint = checkPushEndpoint, sendEmail = sendSmtpMail, autoStart = true, intervalMs = 60_000, audit = null}) {
	const file = join(dataDir, 'alerts.json')
	let state = {
		vapid: null, // {publicKey, pkcs8, subject}
		subscriptions: [], // [{id, endpoint, p256dh, auth, label, createdAt}]
		smtp: {enabled: false, host: '', port: 587, secure: false, starttls: true, username: '', password: '', from: '', to: ''},
		quietHours: {enabled: false, startHour: 22, endHour: 7},
		dailyCap: 30,
		history: [], // [{id, key, severity, title, message, at, channels}]
	}
	const seenCounts = new Map() // key -> consecutive ticks seen
	const activeKeys = new Set() // currently fired alert keys
	let signerCache = null
	let lastTickAt = null

	const loaded = (async () => {
		try {
			const parsed = JSON.parse(await readFile(file, 'utf8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				state = {
					...state,
					...parsed,
					smtp: {...state.smtp, ...(parsed.smtp ?? {})},
					quietHours: {...state.quietHours, ...(parsed.quietHours ?? {})},
					subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
					history: Array.isArray(parsed.history) ? parsed.history.slice(-100) : [],
				}
			}
		} catch {}
	})()
	const save = () => writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600})

	async function ensureVapid() {
		await loaded
		if (!state.vapid) {
			const pair = await generateVapidPair()
			state.vapid = {...pair, subject: state.smtp?.from ? `mailto:${state.smtp.from}` : 'https://omarchy.local'}
			await save()
		}
		return state.vapid.publicKey
	}

	async function getSigner() {
		await ensureVapid()
		if (!signerCache || signerCache.publicKey !== state.vapid.publicKey) {
			const pkcs8 = Buffer.from(state.vapid.pkcs8, 'base64')
			const key = await crypto.subtle.importKey('pkcs8', pkcs8, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign'])
			signerCache = {
				publicKey: state.vapid.publicKey,
				subject: state.vapid.subject || 'https://omarchy.local',
				sign: async (data) => new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, data)),
			}
		}
		return signerCache
	}

	function inQuietHours(t) {
		if (!state.quietHours?.enabled) return false
		const h = new Date(t).getHours()
		const s = Number.isFinite(Number(state.quietHours.startHour)) ? Number(state.quietHours.startHour) : 22
		const e = Number.isFinite(Number(state.quietHours.endHour)) ? Number(state.quietHours.endHour) : 7
		return s > e ? h >= s || h < e : h >= s && h < e
	}

	function sentToday(t) {
		const cutoff = t - 24 * 3600_000
		return state.history.filter((h) => h.at >= cutoff).length
	}

	async function dispatchAlert(alert) {
		const t = now()
		if (alert.severity !== 'critical' && inQuietHours(t)) return {skipped: 'quiet-hours'}
		if (sentToday(t) >= (Number(state.dailyCap) || 30)) return {skipped: 'daily-cap'}
		const channels = []
		const payload = {
			title: alert.title || 'Omarchy Server alert',
			body: String(alert.message ?? '').slice(0, 240),
			tag: String(alert.id ?? 'alert').slice(0, 80),
			url: '/',
		}
		if (state.subscriptions.length) {
			const signer = await getSigner()
			const gone = new Set()
			for (const sub of state.subscriptions) {
				const r = await sendWebPush(sub, payload, signer, {fetchImpl, checkEndpoint, now, urgency: alert.severity === 'critical' ? 'high' : 'normal'})
				if (r.ok) channels.push('push')
				else if (r.reason === 'gone') gone.add(sub.id)
			}
			if (gone.size) {
				state.subscriptions = state.subscriptions.filter((s) => !gone.has(s.id))
			}
		}
		if (state.smtp?.enabled && state.smtp.host && state.smtp.from && state.smtp.to) {
			try {
				await sendEmail({
					...state.smtp,
					subject: `[Omarchy Server] ${payload.title}`,
					text: `${payload.body}\n\nTime: ${new Date(t).toISOString()}\n`,
				})
				channels.push('email')
			} catch {}
		}
		const uniqueChannels = [...new Set(channels)]
		if (!uniqueChannels.length) return {dispatched: false, channels: []}
		state.history.push({id: randomBytes(6).toString('hex'), key: alert.id, severity: alert.severity, title: payload.title, message: payload.body, at: t, channels: uniqueChannels})
		if (state.history.length > 100) state.history.splice(0, state.history.length - 100)
		await save()
		return {dispatched: true, channels: uniqueChannels}
	}

	// Flap-damped evaluation: warnings require 2 consecutive ticks, criticals fire immediately; cleared causes reset.
	async function evaluate() {
		await loaded
		lastTickAt = now()
		const current = (await collectAlerts().catch(() => [])) || []
		const actionable = current.filter((a) => a && (a.severity === 'warning' || a.severity === 'critical'))
		const presentKeys = new Set(actionable.map((a) => String(a.id)))
		for (const k of [...seenCounts.keys()]) {
			if (!presentKeys.has(k)) {
				seenCounts.delete(k)
				activeKeys.delete(k)
			}
		}
		const fired = []
		for (const a of actionable) {
			const key = String(a.id)
			const count = (seenCounts.get(key) ?? 0) + 1
			seenCounts.set(key, count)
			const threshold = a.severity === 'critical' ? 1 : 2
			if (count >= threshold && !activeKeys.has(key)) {
				const res = await dispatchAlert({id: key, severity: a.severity, title: a.name ? `${a.name}: ${a.kind}` : 'Server alert', message: a.message})
				if (res.dispatched) activeKeys.add(key)
				fired.push({key, ...res})
			}
		}
		return {checked: actionable.length, fired}
	}

	let timer = null
	if (autoStart) {
		timer = setInterval(() => {
			evaluate().catch(() => {})
		}, intervalMs)
		timer.unref?.()
	}

	return {
		evaluate,
		lastTickAt: () => lastTickAt,
		close: () => clearInterval(timer),
		procedures: {
			'alerts.settings': {
				kind: 'query',
				run: async () => {
					await loaded
					return {
						pushEnabled: state.subscriptions.length > 0,
						subscriptions: state.subscriptions.map(({id, label, createdAt}) => ({id, label, createdAt})),
						vapidPublicKey: state.vapid?.publicKey ?? null,
						smtp: {...state.smtp, password: '', hasPassword: !!state.smtp?.password},
						quietHours: state.quietHours,
						dailyCap: state.dailyCap,
					}
				},
			},
			'alerts.saveSettings': {
				kind: 'mutation',
				run: async (input = {}) => {
					await loaded
					if (input.smtp && typeof input.smtp === 'object') {
						const next = {...state.smtp}
						if (typeof input.smtp.enabled === 'boolean') next.enabled = input.smtp.enabled
						if (typeof input.smtp.host === 'string') next.host = input.smtp.host.trim().slice(0, 120)
						if (input.smtp.port != null) next.port = Math.max(1, Math.min(65535, Number(input.smtp.port) || 587))
						if (typeof input.smtp.secure === 'boolean') next.secure = input.smtp.secure
						if (typeof input.smtp.starttls === 'boolean') next.starttls = input.smtp.starttls
						if (typeof input.smtp.username === 'string') next.username = input.smtp.username.trim().slice(0, 120)
						if (typeof input.smtp.password === 'string' && input.smtp.password) next.password = input.smtp.password.slice(0, 256)
						if (typeof input.smtp.from === 'string') next.from = input.smtp.from.trim().slice(0, 160)
						if (typeof input.smtp.to === 'string') next.to = input.smtp.to.trim().slice(0, 160)
						state.smtp = next
					}
					if (input.quietHours && typeof input.quietHours === 'object') {
						const rawStart = Number(input.quietHours.startHour)
						const rawEnd = Number(input.quietHours.endHour)
						state.quietHours = {
							enabled: !!input.quietHours.enabled,
							startHour: Math.max(0, Math.min(23, Number.isFinite(rawStart) ? rawStart : 22)),
							endHour: Math.max(0, Math.min(23, Number.isFinite(rawEnd) ? rawEnd : 7)),
						}
					}
					if (input.dailyCap != null) state.dailyCap = Math.max(1, Math.min(500, Number(input.dailyCap) || 30))
					await save()
					await audit?.record({action: 'alerts.saveSettings', target: 'alerts', ok: true})
					return true
				},
			},
			'alerts.vapidKey': {
				kind: 'query',
				run: async () => ({publicKey: await ensureVapid()}),
			},
			'alerts.subscribePush': {
				kind: 'mutation',
				run: async (input = {}) => {
					await loaded
					const endpoint = String(input.endpoint ?? '').trim()
					const p256dh = String(input.p256dh ?? '').trim()
					const auth = String(input.auth ?? '').trim()
					const label = String(input.label ?? 'Browser').trim().slice(0, 60) || 'Browser'
					const check = await checkEndpoint(endpoint)
					if (!check.ok) throw new RpcError('BAD_REQUEST', 'Push endpoint must be a valid public HTTPS URL')
					if (b64urlDecode(p256dh).length !== 65 || b64urlDecode(auth).length !== 16) throw new RpcError('BAD_REQUEST', 'Invalid push encryption keys')
					await ensureVapid()
					state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint)
					const id = randomBytes(6).toString('hex')
					state.subscriptions.push({id, endpoint, p256dh, auth, label, createdAt: now()})
					await save()
					return {id, count: state.subscriptions.length}
				},
			},
			'alerts.unsubscribePush': {
				kind: 'mutation',
				run: async (input = {}) => {
					await loaded
					const id = String(input.id ?? '')
					const endpoint = String(input.endpoint ?? '')
					state.subscriptions = state.subscriptions.filter((s) => (id ? s.id !== id : s.endpoint !== endpoint))
					await save()
					return {count: state.subscriptions.length}
				},
			},
			'alerts.testPush': {
				kind: 'mutation',
				run: async () => {
					await loaded
					if (!state.subscriptions.length) throw new RpcError('PRECONDITION_FAILED', 'Enable push notifications on this device first')
					const signer = await getSigner()
					let delivered = 0
					for (const sub of state.subscriptions) {
						const r = await sendWebPush(sub, {title: 'Omarchy Server', body: 'Test alert — push notifications are working.', tag: 'test', url: '/'}, signer, {fetchImpl, checkEndpoint, now})
						if (r.ok) delivered++
					}
					if (!delivered) throw new RpcError('BAD_GATEWAY', 'Couldn’t reach the push service')
					return {delivered}
				},
			},
			'alerts.testEmail': {
				kind: 'mutation',
				run: async () => {
					await loaded
					if (!state.smtp?.host || !state.smtp.from || !state.smtp.to) throw new RpcError('PRECONDITION_FAILED', 'Enter SMTP host, From, and To addresses first')
					await sendEmail({...state.smtp, subject: '[Omarchy Server] Test alert', text: 'Email alerts from Omarchy Server are working.\n'})
					return true
				},
			},
			'alerts.history': {
				kind: 'query',
				run: async () => {
					await loaded
					return [...state.history].reverse()
				},
			},
		},
	}
}
