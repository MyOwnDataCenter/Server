// Tamper-evident hash-chained activity/audit journal (append-only NDJSON).
import {createHash} from 'node:crypto'
import {appendFile, chmod, readFile} from 'node:fs/promises'
import {join} from 'node:path'

const SECRET_KEY = /(?:password|passphrase|secret|token|api[-_]?key|credential|authorization)/i

function redact(value, depth = 0) {
	if (depth > 6) return null
	if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
	if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1))
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const [k, v] of Object.entries(value)) {
		if (SECRET_KEY.test(k)) continue
		out[k] = redact(v, depth + 1)
	}
	return out
}

function hashEntry(prev, entry) {
	return createHash('sha256')
		.update(`${prev}\n${JSON.stringify(entry)}`)
		.digest('hex')
}

export function verifyAuditLines(ndjsonText) {
	const lines = String(ndjsonText ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
	let prev = '0'.repeat(64)
	let seq = 0
	for (const line of lines) {
		seq++
		let row
		try {
			row = JSON.parse(line)
		} catch {
			return {ok: false, count: seq - 1, brokenAt: seq, reason: 'Corrupt JSON line'}
		}
		if (row.seq !== seq || row.prev !== prev) return {ok: false, count: seq - 1, brokenAt: seq, reason: 'Chain sequence or previous hash mismatch'}
		const {hash, ...body} = row
		const expected = hashEntry(prev, body)
		if (hash !== expected) return {ok: false, count: seq - 1, brokenAt: seq, reason: 'Hash mismatch (entry was modified)'}
		prev = hash
	}
	return {ok: true, count: seq, head: prev}
}

export function createAudit({dataDir, now = () => Date.now()}) {
	const file = join(dataDir, 'audit.ndjson')
	let seq = 0
	let head = '0'.repeat(64)
	let chain = Promise.resolve()

	const ready = (async () => {
		const text = await readFile(file, 'utf8').catch(() => '')
		const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
		if (lines.length) {
			try {
				const last = JSON.parse(lines[lines.length - 1])
				if (typeof last?.seq === 'number' && typeof last?.hash === 'string') {
					seq = last.seq
					head = last.hash
				}
			} catch {}
		}
	})()

	function record({actor = 'owner', action, target = '', ok = true, detail = null}) {
		const next = chain.then(async () => {
			await ready
			const nextSeq = seq + 1
			const body = {
				seq: nextSeq,
				at: now(),
				actor: String(actor).slice(0, 40),
				action: String(action).slice(0, 80),
				target: String(target ?? '').slice(0, 120),
				ok: !!ok,
				...(detail != null ? {detail: redact(detail)} : {}),
				prev: head,
			}
			const hash = hashEntry(head, body)
			await appendFile(file, `${JSON.stringify({...body, hash})}\n`, {mode: 0o600})
			await chmod(file, 0o600).catch(() => {})
			seq = nextSeq
			head = hash
			return {...body, hash}
		})
		chain = next.catch(() => {})
		return next
	}

	async function readRaw() {
		await ready
		await chain
		return readFile(file, 'utf8').catch(() => '')
	}

	async function list(input = {}) {
		const raw = await readRaw()
		const limit = Math.max(1, Math.min(500, Number(input?.limit) || 100))
		const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
		const out = []
		for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
			try {
				out.push(JSON.parse(lines[i]))
			} catch {}
		}
		return out
	}

	async function verify() {
		const raw = await readRaw()
		return verifyAuditLines(raw)
	}

	return {
		ready,
		record,
		exportNdjson: readRaw,
		procedures: {
			'audit.list': {kind: 'query', run: list},
			'audit.verify': {kind: 'query', run: verify},
		},
	}
}
