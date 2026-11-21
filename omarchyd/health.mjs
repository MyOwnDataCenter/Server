// Real self-health check (/api/health) + optional outbound dead-man heartbeat ping.
// Dead-man URLs may contain secret tokens (e.g. Healthchecks.io): never echo the URL in errors or API replies.
import {randomBytes} from 'node:crypto'
import {readFile, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

export function validatePingUrl(raw, allowHttp = false) {
	const text = String(raw ?? '').trim()
	if (!text || text.length > 2048) return {ok: false, reason: 'invalid_url'}
	let url
	try {
		url = new URL(text)
	} catch {
		return {ok: false, reason: 'invalid_url'}
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return {ok: false, reason: 'invalid_url'}
	if (!url.hostname || url.username || url.password) return {ok: false, reason: 'invalid_url'}
	if (url.protocol === 'http:' && !allowHttp) return {ok: false, reason: 'insecure_url'}
	return {ok: true, url, host: url.hostname}
}

export async function sendDeadmanPing(rawUrl, {allowHttp = false, timeoutMs = 10_000, fetchImpl = fetch} = {}) {
	const checked = validatePingUrl(rawUrl, allowHttp)
	if (!checked.ok) return {ok: false, reason: checked.reason}
	try {
		const res = await fetchImpl(checked.url.toString(), {
			method: 'GET',
			redirect: 'manual',
			credentials: 'omit',
			headers: {'User-Agent': 'omarchy-server-heartbeat/1'},
			signal: AbortSignal.timeout(timeoutMs),
		})
		try {
			await res.body?.cancel()
		} catch {}
		if (res.status >= 200 && res.status < 300) return {ok: true}
		if (res.status >= 300 && res.status < 400) return {ok: false, reason: 'http_3xx'}
		if (res.status >= 400 && res.status < 500) return {ok: false, reason: 'http_4xx'}
		return {ok: false, reason: 'http_5xx'}
	} catch (err) {
		const name = String(err?.name ?? '')
		const code = String(err?.code ?? '')
		if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') return {ok: false, reason: 'timeout'}
		if (/CERT|TLS|SSL/i.test(code) || /certificate|TLS|SSL/i.test(String(err?.message ?? ''))) return {ok: false, reason: 'tls'}
		if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return {ok: false, reason: 'dns'}
		return {ok: false, reason: 'connection'}
	}
}

export function createHealth({dataDir, version, startedAt = Date.now(), checks = [], now = () => Date.now(), fetchImpl = fetch, autoStart = true, audit = null}) {
	const file = join(dataDir, 'health.json')
	let config = {enabled: false, url: '', host: '', intervalMinutes: 5, allowHttp: false, lastOkAt: null, lastError: null}
	let timer = null

	const loaded = (async () => {
		try {
			const parsed = JSON.parse(await readFile(file, 'utf8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = {...config, ...parsed}
		} catch {}
	})()
	const save = () => writeAtomic(file, JSON.stringify(config, null, '\t'), {mode: 0o600})

	async function probeStorage() {
		const probe = join(dataDir, `.health-probe-${process.pid}-${randomBytes(4).toString('hex')}`)
		try {
			await writeFile(probe, 'ok', {mode: 0o600})
			const got = await readFile(probe, 'utf8')
			await unlink(probe).catch(() => {})
			return {name: 'storage', ok: got === 'ok', detail: got === 'ok' ? 'Data folder readable and writable' : 'Probe mismatch'}
		} catch {
			await unlink(probe).catch(() => {})
			return {name: 'storage', ok: false, detail: 'Data folder is not writable'}
		}
	}

	let cachedCheck = null
	let cachedAt = 0
	async function check({fresh = false} = {}) {
		const t = now()
		if (!fresh && cachedCheck && t - cachedAt < 5_000) return cachedCheck
		const results = [await probeStorage()]
		for (const fn of checks) {
			try {
				results.push(await fn())
			} catch (e) {
				results.push({name: 'check', ok: false, detail: String(e?.message ?? 'Check failed').slice(0, 120)})
			}
		}
		const ok = results.every((r) => r.ok)
		cachedCheck = {
			ok,
			status: ok ? 'ok' : 'degraded',
			version,
			uptimeSeconds: Math.max(0, Math.round((t - startedAt) / 1000)),
			checkedAt: t,
			checks: results,
		}
		cachedAt = t
		return cachedCheck
	}

	async function tickDeadman() {
		await loaded
		if (!config.enabled || !config.url) return {skipped: true}
		const h = await check()
		if (!h.ok) return {skipped: 'degraded'}
		const res = await sendDeadmanPing(config.url, {allowHttp: !!config.allowHttp, fetchImpl})
		if (res.ok) {
			config.lastOkAt = now()
			config.lastError = null
		} else {
			config.lastError = res.reason
		}
		await save().catch(() => {})
		return res
	}

	function schedule() {
		clearInterval(timer)
		if (!autoStart || !config.enabled || !config.url) return
		const ms = Math.max(60_000, Math.min(24 * 3600_000, (Number(config.intervalMinutes) || 5) * 60_000))
		timer = setInterval(() => {
			tickDeadman().catch(() => {})
		}, ms)
		timer.unref?.()
	}

	loaded.then(schedule)

	return {
		check,
		tickDeadman,
		close: () => clearInterval(timer),
		procedures: {
			'health.detail': {
				kind: 'query',
				run: async () => {
					await loaded
					const h = await check({fresh: true})
					return {
						...h,
						deadman: {
							enabled: !!config.enabled,
							configured: !!config.url,
							host: config.host || '',
							intervalMinutes: config.intervalMinutes,
							allowHttp: !!config.allowHttp,
							lastOkAt: config.lastOkAt,
							lastError: config.lastError,
						},
					}
				},
			},
			'health.setDeadman': {
				kind: 'mutation',
				run: async (input = {}) => {
					await loaded
					const allowHttp = typeof input.allowHttp === 'boolean' ? input.allowHttp : !!config.allowHttp
					if (typeof input.url === 'string' && input.url.trim()) {
						const v = validatePingUrl(input.url, allowHttp)
						if (!v.ok) throw new RpcError('BAD_REQUEST', v.reason === 'insecure_url' ? 'Use an https:// URL (or allow http:// explicitly)' : 'Enter a valid heartbeat URL')
						config.url = v.url.toString()
						config.host = v.host
					} else if (input.clear === true) {
						config.url = ''
						config.host = ''
						config.enabled = false
					}
					if (typeof input.enabled === 'boolean') config.enabled = input.enabled && !!config.url
					if (input.intervalMinutes != null) config.intervalMinutes = Math.max(1, Math.min(1440, Number(input.intervalMinutes) || 5))
					config.allowHttp = allowHttp
					await save()
					schedule()
					await audit?.record({action: 'health.setDeadman', target: config.host || 'cleared', ok: true})
					return true
				},
			},
			'health.testDeadman': {
				kind: 'mutation',
				run: async () => {
					await loaded
					if (!config.url) throw new RpcError('PRECONDITION_FAILED', 'Set a heartbeat URL first')
					const res = await sendDeadmanPing(config.url, {allowHttp: !!config.allowHttp, fetchImpl})
					if (!res.ok) throw new RpcError('BAD_GATEWAY', `Heartbeat ping failed (${res.reason})`)
					config.lastOkAt = now()
					config.lastError = null
					await save()
					return true
				},
			},
		},
	}
}
