// Local swarm: other Linux computers joined to this server through the Omarchy Server connector
// (connector/agent.py). The connector dials *out* to this server over wss:// (pinned to this
// server's own certificate authority), so the other computer opens no ports.
//
// Joining: the owner makes a one-time pairing code (15 minutes, used once) with the abilities they
// allow (watching is always on; terminal, desktop, manage, storage, backup and files are optional). The connector trades
// it for its own id and key; only a hash of the key is kept here.
//
// Two limits on what a computer does: the abilities chosen when pairing, which the connector also
// keeps itself and enforces on its own side (so even this server can't widen them), and the
// owner's switches here, which can only narrow those.
//
// Wire format on the connector's WebSocket: JSON text messages for control, and binary frames
// starting with a 4-byte channel number for terminal, desktop, and file bytes.
import {X509Certificate, createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import dgram from 'node:dgram'
import {readFile, stat} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {WebSocketServer} from 'ws'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'
import {parseResize} from './terminal.mjs'

// backup: the computer backs up folders you choose to this server (see backups.mjs). Its restic
// uploads through the connector's own pinned connection, and can only add backups, never delete them.
// storage: see its drives, format extra disks, and manage pools on that computer (connector/helper.py).
// services: inspect and restart user systemd units and Podman/Docker containers.
// files: browse, upload, download, and copy files inside /Home and /Pools (and Clip Book home streaming).
const ABILITIES = ['terminal', 'desktop', 'manage', 'storage', 'backup', 'services', 'files']
const REMOTE_FILE_MAX = 20 * 1024 * 1024
const PAIR_TTL = 15 * 60_000
// A viewer that stops reading must not queue connector frames in memory without a bound.
const VIEWER_BUFFER_LIMIT = 1024 * 1024
// File bytes use their own channel. Chunks stay small, and only a few are in flight, so a big
// copy cannot fill the socket or stall a terminal on the same computer.
const FILE_CHUNK = 64 * 1024
const FILE_WINDOW = 4
const FILE_MS = 10 * 60_000
const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const clip = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)
// RFC 6455: a close reason longer than 123 bytes throws RangeError inside ws and takes the process down.
// clip() counts characters, so a name in another language still overflows. Cut on a byte boundary instead.
export function closeReason(text) {
	const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
	const buf = Buffer.from(clean)
	if (buf.length <= 123) return clean
	let end = 123
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
	return buf.subarray(0, end).toString('utf8')
}
function closeSocket(ws, code, reason) {
	try {
		ws.close(code, closeReason(reason))
	} catch (e) {
		if (!(e instanceof RangeError)) throw e
		ws.close(code)
	}
}
// Same sentence a refused new connection gets, so an open session ends with that reason too.
function switchedOff(name, ability) {
	const what = ability === 'terminal' ? 'The terminal' : ability === 'files' ? 'Files' : 'The desktop'
	return `${what} isn’t switched on for ${name}`
}
function closeLiveChannel(l, ch, reason) {
	const channel = l.channels.get(ch)
	if (!channel) return
	if (channel.kind === 'file') return channel.end(new RpcError('FORBIDDEN', reason))
	l.channels.delete(ch)
	closeSocket(channel.ws, 1011, reason)
	if (l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify({op: 'close', ch}))
}
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
// A dropped connection, a slow answer, or a reconnect is not a reason to reinstall.
// Only a connector that doesn't know the call, or a helper that isn't there, is.
function storageReadError(e, name) {
	const message = String(e?.message ?? '')
	const stale = /unknown action|storage helper|helper failed|helper\.py/i.test(message)
	const pass = /offline|reconnected|didn[\u2019']t answer in time/i.test(message)
	if (stale && !pass) return new RpcError('PRECONDITION_FAILED', `Run the connector install again on ${name}.`)
	return new RpcError('PRECONDITION_FAILED', message)
}

// Only the facts the page shows, checked and trimmed (a connector is another computer: don't
// trust its numbers to be well-formed).
const BATTERY_STATUS = new Set(['charging', 'discharging', 'full', 'not-charging', 'unknown'])

export function cleanMetrics(m = {}) {
	const disks = Array.isArray(m.disks)
		? m.disks.slice(0, 12).map((d) => ({mount: clip(d?.mount, 200), total: num(d?.total), used: num(d?.used)})).filter((d) => d.total > 0)
		: []
	const gpus = Array.isArray(m.gpus)
		? m.gpus
				.slice(0, 8)
				.map((g) => ({
					id: clip(g?.id, 80),
					index: num(g?.index) ?? 0,
					name: clip(g?.name, 80),
					used: num(g?.used),
					...(num(g?.vramUsed) !== null ? {vramUsed: num(g.vramUsed)} : {}),
					...(num(g?.vramTotal) !== null ? {vramTotal: num(g.vramTotal)} : {}),
					...(num(g?.temp) !== null ? {temp: num(g.temp)} : {}),
					...(num(g?.power) !== null ? {power: num(g.power)} : {}),
				}))
				.filter((g) => g.id)
		: []
	const net = m.net && typeof m.net === 'object' ? {rx: num(m.net.rx), tx: num(m.net.tx)} : null
	const batteries = Array.isArray(m.batteries)
		? m.batteries
				.slice(0, 4)
				.map((b) => ({
					id: clip(b?.id, 32),
					index: num(b?.index) ?? 0,
					name: clip(b?.name, 80),
					percent: num(b?.percent),
					status: BATTERY_STATUS.has(b?.status) ? b.status : 'unknown',
					secondsRemaining: num(b?.secondsRemaining),
					power: num(b?.power),
					energyNow: num(b?.energyNow),
					energyFull: num(b?.energyFull),
				}))
				.filter((b) => b.id)
		: []
	return {
		at: Date.now(),
		cpu: num(m.cpu),
		cores: num(m.cores),
		load: Array.isArray(m.load) ? m.load.slice(0, 3).map(num) : [],
		mem: {total: num(m.mem?.total), used: num(m.mem?.used)},
		swap: {total: num(m.swap?.total), used: num(m.swap?.used)},
		disks,
		gpus,
		batteries,
		net,
		temp: num(m.temp),
		uptime: num(m.uptime),
		updates: num(m.updates),
	}
}
const cleanSha = (v) => (/^[0-9a-f]{64}$/i.test(String(v ?? '')) ? String(v).toLowerCase() : '')
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i

export function buildWolPacket(mac) {
	if (!MAC_RE.test(String(mac ?? ''))) throw new RpcError('BAD_REQUEST', 'Invalid MAC address')
	const bytes = Buffer.from(mac.split(':').map((h) => parseInt(h, 16)))
	const packet = Buffer.alloc(6 + 16 * 6, 0xff)
	for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6)
	return packet
}

function subnetBroadcasts() {
	const targets = new Set(['255.255.255.255'])
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		if (/^(docker|podman|veth|virbr|br-|cni|lo)/.test(name)) continue
		for (const i of list ?? []) {
			if (i.internal || i.family !== 'IPv4' || !i.netmask) continue
			const ip = i.address.split('.').map(Number)
			const mask = i.netmask.split('.').map(Number)
			if (ip.length === 4 && mask.length === 4) targets.add(ip.map((b, idx) => (b | (~mask[idx] & 0xff)) & 0xff).join('.'))
		}
	}
	return [...targets]
}

export async function sendWolPacket(mac) {
	const packet = buildWolPacket(mac)
	const sock = dgram.createSocket('udp4')
	try {
		await new Promise((resolve, reject) => {
			sock.once('error', reject)
			sock.bind(0, () => {
				sock.setBroadcast(true)
				resolve()
			})
		})
		for (const host of subnetBroadcasts()) {
			await new Promise((resolve) => sock.send(packet, 9, host, () => resolve()))
		}
	} finally {
		try {
			sock.close()
		} catch {}
	}
}

function cleanPosture(p) {
	if (!p || typeof p !== 'object') return null
	const ports = Array.isArray(p.listeningPorts)
		? p.listeningPorts
				.slice(0, 50)
				.map((x) => ({
					port: num(x?.port),
					proto: x?.proto === 'tcp6' ? 'tcp6' : 'tcp',
					addr: clip(x?.addr, 32),
				}))
				.filter((x) => x.port && x.port > 0 && x.port <= 65535)
		: []
	return {
		rebootRequired: !!p.rebootRequired,
		rebootReason: clip(p.rebootReason, 120),
		securityUpdates: num(p.securityUpdates),
		listeningPorts: ports,
		failedUnits: num(p.failedUnits) ?? 0,
	}
}

function cleanInfo(i = {}) {
	return {
		hostname: clip(i.hostname, 64),
		os: clip(i.os, 80),
		osId: clip(i.osId, 32).toLowerCase(),
		kernel: clip(i.kernel, 64),
		arch: clip(i.arch, 16),
		user: clip(i.user, 32),
		version: clip(i.version, 16),
		agentSha: cleanSha(i.agentSha),
		helperSha: cleanSha(i.helperSha),
		macs: Array.isArray(i.macs) ? i.macs.filter((m) => MAC_RE.test(String(m ?? ''))).map((m) => String(m).toLowerCase()).slice(0, 8) : [],
		posture: cleanPosture(i.posture),
		pkg: clip(i.pkg, 16),
		updateCommand: clip(i.updateCommand, 160),
		omarchy: !!i.omarchy,
		plugins: Array.isArray(i.plugins) ? i.plugins.slice(0, 200).map((p) => clip(p, 80)) : [],
		themes: Array.isArray(i.themes) ? i.themes.slice(0, 200).map((t) => clip(t, 80)) : [],
		theme: clip(i.theme, 80),
		desktop: {kind: clip(i.desktop?.kind, 32), ok: !!i.desktop?.ok, why: clip(i.desktop?.why, 200)},
	}
}

// This server's addresses other computers can reach: its network addresses (Tailscale's too).
function serverAddresses() {
	const out = []
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const i of list ?? []) {
			if (i.internal || i.family !== 'IPv4' || /^(docker|podman|veth|virbr|br-|cni)/.test(name)) continue
			out.push({address: i.address, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address) || name.startsWith('tailscale')})
		}
	}
	return out
}

export function createConnector({dataDir, tlsDir, connectorDir = fileURLToPath(new URL('../connector', import.meta.url)), plugins = null, files = null, source = async () => 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server', webPort = 7780, now = () => Date.now(), pingInterval = 25_000, sendWol = sendWolPacket}) {
	const file = join(dataDir, 'swarm.json')
	let state = {agents: []}
	// Set when swarm.json exists but cannot be used. Nothing may write it until the owner repairs it.
	let damaged = false
	const bundledCache = new Map()
	let bundledShas = {agentSha: '', helperSha: ''}
	async function readBundledFile(name) {
		const path = join(connectorDir, name)
		try {
			const st = await stat(path)
			const prev = bundledCache.get(name)
			if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev
			const bytes = await readFile(path)
			const entry = {bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: st.mtimeMs, size: st.size}
			bundledCache.set(name, entry)
			return entry
		} catch {
			return null
		}
	}
	async function refreshBundledShas() {
		const [agent, helper] = await Promise.all([readBundledFile('agent.py'), readBundledFile('helper.py')])
		bundledShas = {agentSha: agent?.sha256 ?? '', helperSha: helper?.sha256 ?? ''}
		return bundledShas
	}
	async function readAgentScript() {
		const entry = await readBundledFile('agent.py')
		if (!entry) throw new RpcError('PRECONDITION_FAILED', 'The bundled connector script wasn’t found on this server')
		bundledShas.agentSha = entry.sha256
		return {bytes: entry.bytes, sha256: entry.sha256}
	}
	const agentOk = (a) => !!a && typeof a === 'object' && !Array.isArray(a) && typeof a.id === 'string' && !!a.allowed && typeof a.allowed === 'object' && !Array.isArray(a.allowed) && !!a.on && typeof a.on === 'object' && !Array.isArray(a.on)
	// A missing file is no computers yet. A parse error used to reject this promise with nobody
	// waiting, which ended the process. The file stays so its key hashes can be repaired.
	const loaded = (async () => {
		let text
		try {
			text = await readFile(file, 'utf8')
		} catch (error) {
			if (error.code === 'ENOENT') return
			damaged = true
			console.error('[omarchyd] couldn’t load swarm.json; leaving it unchanged')
			return
		}
		let data
		try {
			data = JSON.parse(text)
		} catch {
			data = undefined
		}
		const ok = !!data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.agents) && data.agents.every(agentOk)
		if (ok) state = data
		else {
			damaged = true
			console.error('[omarchyd] couldn’t load swarm.json; leaving it unchanged')
		}
	})()
	const save = () => (damaged ? Promise.reject(new RpcError('PRECONDITION_FAILED', 'swarm.json is damaged and was left unchanged.')) : writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600}))
	const pairings = new Map() // sha(token) -> {abilities, expires}
	const live = new Map() // agentId -> {ws, metrics, info, channels: Map, nextCh, calls: Map, nextCall}
	const history = new Map() // agentId -> {fine: Point[], coarse: Point[]}
	const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})

	function recordHistory(agentId, m) {
		const root = m.disks?.find((d) => d.mount === '/') ?? m.disks?.[0]
		const pt = {
			at: m.at ?? now(),
			cpu: m.cpu,
			memPct: m.mem?.total > 0 && m.mem?.used != null ? Math.round((1000 * m.mem.used) / m.mem.total) / 10 : null,
			diskPct: root?.total > 0 && root?.used != null ? Math.round((1000 * root.used) / root.total) / 10 : null,
			gpuPct: m.gpus?.length ? (m.gpus.reduce((s, g) => s + (g.used ?? 0), 0) / m.gpus.length) : null,
			temp: m.temp,
			netRx: m.net?.rx ?? null,
			netTx: m.net?.tx ?? null,
		}
		let ring = history.get(agentId)
		if (!ring) {
			ring = {fine: [], coarse: []}
			history.set(agentId, ring)
		}
		ring.fine.push(pt)
		if (ring.fine.length > 1200) ring.fine.splice(0, ring.fine.length - 1200)
		const lastCoarse = ring.coarse[ring.coarse.length - 1]
		if (!lastCoarse || pt.at - lastCoarse.at >= 60_000) {
			ring.coarse.push(pt)
			if (ring.coarse.length > 1440) ring.coarse.splice(0, ring.coarse.length - 1440)
		}
	}

	const find = (id) => state.agents.find((a) => a.id === id)
	const view = (a) => {
		const l = live.get(a.id)
		const agentSha = a.info?.agentSha || ''
		const helperSha = a.info?.helperSha || ''
		const t = now()
		const m = l?.metrics ?? a.metrics ?? null
		const lastSeen = l ? (l.lastActivity ?? t) : (a.lastSeen ?? null)
		const activityAgeMs = l ? Math.max(0, t - (l.lastActivity ?? t)) : null
		const freshness = !l ? 'offline' : activityAgeMs > 120_000 ? 'stale' : 'live'
		return {
			id: a.id,
			name: a.name,
			online: !!l,
			lastSeen,
			asOf: lastSeen,
			freshness,
			enrolledAt: a.enrolledAt,
			// What it may do: allowed at pairing (and by the connector itself) and still switched on here.
			allowed: a.allowed,
			on: a.on,
			info: a.info ?? null,
			metrics: m,
			updateAvailable: Boolean(a.info && bundledShas.agentSha && agentSha !== bundledShas.agentSha),
			helperUpdateAvailable: Boolean(a.info && a.allowed?.storage && bundledShas.helperSha && helperSha && helperSha !== bundledShas.helperSha),
		}
	}

	async function caFingerprint() {
		const pem = await readFile(join(tlsDir, 'ca.crt'), 'utf8').catch(() => null)
		if (!pem) throw new RpcError('PRECONDITION_FAILED', 'This server’s secure address (https) isn’t set up yet, and the connector needs it.')
		return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase()
	}

	// ---- owner actions (tRPC) ------------------------------------------------------------------
	async function pair(input = {}) {
		await loaded
		const abilities = Object.fromEntries(ABILITIES.map((k) => [k, input?.[k] === true]))
		const token = randomBytes(24).toString('base64url')
		for (const [k, p] of pairings) if (p.expires < now()) pairings.delete(k)
		pairings.set(sha(token), {abilities, expires: now() + PAIR_TTL})
		return {token, ca: await caFingerprint(), expiresAt: now() + PAIR_TTL, abilities, source: await source(), port: webPort, addresses: serverAddresses()}
	}
	// Re-authorize an existing computer in place so its name, id, metrics and backups stay intact.
	async function reauthorize(input = {}) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const abilities = Object.fromEntries(ABILITIES.map((k) => [k, input?.[k] === true]))
		const token = randomBytes(24).toString('base64url')
		for (const [k, p] of pairings) if (p.expires < now()) pairings.delete(k)
		pairings.set(sha(token), {abilities, expires: now() + PAIR_TTL, agentId: a.id})
		return {token, ca: await caFingerprint(), expiresAt: now() + PAIR_TTL, abilities, source: await source(), port: webPort, addresses: serverAddresses(), agentId: a.id, name: a.name}
	}
	async function updateConnector(input = {}) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!may(a, 'manage')) throw new RpcError('FORBIDDEN', `Managing ${a.name} isn’t switched on`)
		if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
		const {sha256} = await readAgentScript()
		await call(a.id, 'update-self', {sha256}, 60_000)
		return {ok: true, sha256}
	}
	async function updateAllConnectors() {
		await loaded
		await refreshBundledShas()
		const updated = []
		const skipped = []
		const failed = []
		for (const a of state.agents) {
			const v = view(a)
			if (!v.online || !may(a, 'manage') || !v.updateAvailable) {
				skipped.push(a.id)
				continue
			}
			try {
				await updateConnector({id: a.id})
				updated.push(a.id)
			} catch (e) {
				failed.push({id: a.id, name: a.name, error: String(e?.message ?? 'Update failed')})
			}
		}
		return {updated, skipped, failed}
	}
	// Fleet gauges sample only while this server is reading them. A list (the swarm
	// screen, or the assistant) asks each computer to sample; the connector stops
	// on its own about 15s after the last ask.
	let watchedAt = 0
	function watchLive() {
		const t = Date.now()
		if (t - watchedAt < 2_000) return
		watchedAt = t
		for (const l of live.values()) {
			if (l.ws.readyState !== l.ws.OPEN) continue
			try {
				l.ws.send(JSON.stringify({op: 'watch'}))
			} catch {}
		}
	}
	async function getHistory(input = {}) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const range = input?.range === '24h' ? '24h' : '1h'
		const ring = history.get(a.id)
		const cutoff = now() - (range === '24h' ? 24 * 3600_000 : 3600_000)
		const src = range === '24h' && (ring?.coarse?.length ?? 0) >= 2 ? ring.coarse : (ring?.fine ?? [])
		return {id: a.id, range, points: src.filter((p) => p.at >= cutoff)}
	}
	async function getAlerts() {
		await loaded
		await refreshBundledShas()
		const t = now()
		const out = []
		for (const a of state.agents) {
			const v = view(a)
			if (!v.online) {
				if (a.lastSeen && t - a.lastSeen > 120_000) {
					const mins = Math.max(2, Math.round((t - a.lastSeen) / 60_000))
					out.push({id: `${a.id}:offline`, agentId: a.id, name: a.name, kind: 'offline', severity: 'warning', message: `${a.name} has been offline for ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}`})
				}
				continue
			}
			const m = v.metrics
			if (m) {
				for (const d of m.disks ?? []) {
					if (d.total > 0 && d.used != null) {
						const p = Math.round((100 * d.used) / d.total)
						if (p >= 90) out.push({id: `${a.id}:disk:${d.mount}`, agentId: a.id, name: a.name, kind: 'disk', severity: p >= 95 ? 'critical' : 'warning', message: `${a.name} disk ${d.mount} is ${p}% full`})
					}
				}
				if (typeof m.temp === 'number' && m.temp >= 85) {
					out.push({id: `${a.id}:temp`, agentId: a.id, name: a.name, kind: 'temp', severity: m.temp >= 95 ? 'critical' : 'warning', message: `${a.name} is running hot (${Math.round(m.temp)}°C)`})
				}
				if (typeof m.updates === 'number' && m.updates > 0) {
					out.push({id: `${a.id}:updates`, agentId: a.id, name: a.name, kind: 'updates', severity: 'info', message: `${a.name} has ${m.updates} update${m.updates === 1 ? '' : 's'} waiting`})
				}
			}
			if (v.updateAvailable) {
				out.push({id: `${a.id}:connector`, agentId: a.id, name: a.name, kind: 'connector-update', severity: 'info', message: `Connector update available for ${a.name}`})
			}
			const posture = a.info?.posture
			if (posture?.rebootRequired) {
				out.push({id: `${a.id}:reboot`, agentId: a.id, name: a.name, kind: 'reboot-required', severity: 'warning', message: `${a.name} needs a restart${posture.rebootReason ? ` (${posture.rebootReason})` : ''}`})
			}
			if (typeof posture?.securityUpdates === 'number' && posture.securityUpdates > 0) {
				out.push({id: `${a.id}:security-updates`, agentId: a.id, name: a.name, kind: 'security-updates', severity: 'warning', message: `${a.name} has ${posture.securityUpdates} security update${posture.securityUpdates === 1 ? '' : 's'} waiting`})
			}
			if (typeof posture?.failedUnits === 'number' && posture.failedUnits > 0) {
				out.push({id: `${a.id}:failed-units`, agentId: a.id, name: a.name, kind: 'failed-units', severity: 'warning', message: `${a.name} has ${posture.failedUnits} failed system service${posture.failedUnits === 1 ? '' : 's'}`})
			}
		}
		return out
	}
	async function wake(input = {}) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const mac = String(input?.mac || a.info?.macs?.[0] || '').trim().toLowerCase()
		if (!mac || !MAC_RE.test(mac)) throw new RpcError('PRECONDITION_FAILED', `No network adapter address has been recorded for ${a.name} yet`)
		await sendWol(mac)
		return {ok: true, mac}
	}
	async function list() {
		await loaded
		await refreshBundledShas()
		watchLive()
		return state.agents.map(view)
	}
	async function remove(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		state.agents = state.agents.filter((x) => x !== a)
		await save()
		const l = live.get(a.id)
		// Tell it to forget this server and stop; then cut it off either way.
		if (l) {
			try {
				l.ws.send(JSON.stringify({op: 'removed'}))
			} catch {}
			setTimeout(() => l.ws.terminate(), 500).unref?.()
		}
		return true
	}
	async function rename(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const name = clip(input?.name, 48).trim()
		if (!name) throw new RpcError('BAD_REQUEST', 'Give it a name')
		// Joining already picks a free suffix. A person renaming is told the name is taken.
		if (name !== a.name && state.agents.some((other) => other.name === name)) throw new RpcError('CONFLICT', 'That name’s already taken')
		a.name = name
		await save()
		return true
	}
	// Switch abilities on or off here. Never more than it was allowed when it joined.
	async function setAbilities(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		// Check the whole request before changing anything, so a later refusal cannot leave
		// earlier abilities off in memory while the file and the open session still say on.
		const next = {...a.on}
		for (const k of ABILITIES) {
			if (input?.[k] === undefined) continue
			if (input[k] === true && !a.allowed[k]) throw new RpcError('FORBIDDEN', `${a.name} wasn’t allowed ${k} when it joined. Pair it again with ${k} switched on to allow it.`)
			next[k] = input[k] === true && a.allowed[k]
		}
		a.on = next
		await save()
		// A switch only saved before, so a terminal or desktop already open kept forwarding.
		const l = live.get(a.id)
		if (l) {
			for (const [ch, channel] of [...l.channels]) {
				const ability = channel.kind === 'pty' ? 'terminal' : channel.kind === 'vnc' ? 'desktop' : channel.kind === 'file' ? 'files' : null
				if (ability && !may(a, ability)) closeLiveChannel(l, ch, switchedOff(a.name, ability))
			}
			if (!may(a, 'terminal') && l.ws.readyState === l.ws.OPEN) {
				try {
					l.ws.send(JSON.stringify({op: 'kill', session: '*'}))
				} catch {}
			}
		}
		return true
	}
	const may = (a, ability) => a.allowed[ability] && a.on[ability]

	async function requireAgent(input, needStorage) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', 'That computer is offline right now')
		if (needStorage && !may(a, 'storage')) throw new RpcError('FORBIDDEN', `Pair ${a.name} again with Storage switched on`)
		return a
	}
	async function requireAbility(input, ability, label) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
		if (!may(a, ability)) throw new RpcError('FORBIDDEN', `${label} isn’t switched on for ${a.name}`)
		return a
	}
	async function readRemoteFile(id, remotePath) {
		const a = await requireAbility({id}, 'files', 'File access')
		const res = await call(a.id, 'files-read', {path: String(remotePath ?? '')}, 60_000)
		const buf = Buffer.from(String(res?.data ?? ''), 'base64')
		if (buf.length > REMOTE_FILE_MAX) throw new RpcError('BAD_REQUEST', 'File is larger than 20 MB')
		return {name: clip(res?.name || basename(String(remotePath ?? 'file')), 200) || 'file', path: String(res?.path ?? remotePath), data: buf}
	}
	async function writeRemoteFile(id, remotePath, buf) {
		const a = await requireAbility({id}, 'files', 'File access')
		if (!Buffer.isBuffer(buf) || buf.length > REMOTE_FILE_MAX) throw new RpcError('BAD_REQUEST', 'Files larger than 20 MB can’t be transferred through the swarm')
		return call(a.id, 'files-write', {path: String(remotePath ?? ''), data: buf.toString('base64')}, 60_000)
	}

	function call(id, name, args = {}, timeout = 10 * 60_000) {
		const l = live.get(id)
		if (!l) return Promise.reject(new RpcError('PRECONDITION_FAILED', 'That computer is offline right now'))
		const n = ++l.nextCall
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => (l.calls.delete(n), reject(new RpcError('BAD_GATEWAY', 'That computer didn’t answer in time'))), timeout)
			l.calls.set(n, {resolve, reject, timer})
			l.ws.send(JSON.stringify({op: 'call', id: n, name, args}))
		})
	}
	// Manage: a short list of things the connector knows how to do itself (it has no "run this").
	async function action(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!may(a, 'manage')) throw new RpcError('FORBIDDEN', `Managing ${a.name} isn’t switched on`)
		const name = String(input?.name ?? '')
		if (name === 'plugin-install') {
			// Same rule as the App Store: only verified plugins, at the verified commit.
			const p = await plugins?.find(String(input?.pluginId ?? ''))
			if (!p) throw new RpcError('NOT_FOUND', 'That plugin isn’t in the verified list')
			return call(a.id, 'plugin-install', {id: p.id, repo: p.repo, commit: p.commit})
		}
		if (name === 'plugin-remove') return call(a.id, 'plugin-remove', {id: clip(input?.pluginId, 80)})
		if (name === 'theme-set') return call(a.id, 'theme-set', {name: clip(input?.theme, 80)})
		if (name === 'reboot') return call(a.id, 'reboot', {}, 30_000)
		if (name === 'shutdown') return call(a.id, 'shutdown', {}, 30_000)
		if (name === 'suspend') return call(a.id, 'suspend', {}, 30_000)
		throw new RpcError('BAD_REQUEST', 'Unknown action')
	}
	async function fleetAction(input = {}) {
		await loaded
		const name = String(input?.name ?? '')
		if (!['theme-set', 'plugin-install', 'plugin-remove', 'update-connector'].includes(name)) throw new RpcError('BAD_REQUEST', 'Unknown fleet action')
		const wanted = Array.isArray(input?.ids) && input.ids.length ? new Set(input.ids.map(String)) : null
		const targets = wanted ? state.agents.filter((a) => wanted.has(a.id)) : [...state.agents]
		const ok = []
		const skipped = []
		const failed = []
		for (const a of targets) {
			if (!live.has(a.id)) {
				skipped.push({id: a.id, name: a.name, reason: 'Offline'})
				continue
			}
			if (!may(a, 'manage')) {
				skipped.push({id: a.id, name: a.name, reason: 'Manage isn’t switched on'})
				continue
			}
			try {
				if (name === 'update-connector') await updateConnector({id: a.id})
				else await action({id: a.id, name, theme: input?.theme, pluginId: input?.pluginId})
				ok.push({id: a.id, name: a.name})
			} catch (e) {
				failed.push({id: a.id, name: a.name, error: String(e?.message ?? 'Action failed')})
			}
		}
		return {ok, skipped, failed}
	}

	// ---- connector side (HTTP enroll + WebSocket) ----------------------------------------------
	const enrollTries = []
	async function enroll(body) {
		await loaded
		// An error string, the shape the installer already prints, instead of a thrown object.
		// The pairing code is not used, and this does not count toward the rate limit.
		if (damaged) return {status: 503, body: {error: 'swarm.json is damaged and was left unchanged.'}}
		// A handful of tries a minute is plenty for people; it stops guessing.
		const t = now()
		while (enrollTries.length && enrollTries[0] < t - 60_000) enrollTries.shift()
		if (enrollTries.length >= 20) return {status: 429, body: {error: 'Too many tries. Wait a minute.'}}
		enrollTries.push(t)
		const p = pairings.get(sha(body?.token ?? ''))
		pairings.delete(sha(body?.token ?? ''))
		if (!p || p.expires < t) return {status: 401, body: {error: 'That pairing code isn’t valid any more. Make a new one in Machines → Local swarm → Add a computer.'}}
		const info = cleanInfo(body?.info)
		// The connector's own limits (what its installer was told) and the pairing's, together.
		const local = body?.abilities ?? {}
		const allowed = Object.fromEntries(ABILITIES.map((k) => [k, p.abilities[k] === true && local[k] === true]))
		if (p.agentId) {
			const existing = find(p.agentId)
			if (!existing) return {status: 404, body: {error: 'That computer is no longer in your swarm.'}}
			const key = randomBytes(32).toString('base64url')
			existing.keyHash = sha(key)
			existing.allowed = allowed
			existing.on = {...allowed}
			existing.info = info
			await save()
			const old = live.get(existing.id)
			if (old) {
				old.progress = null
				for (const ch of old.channels.values()) closeSocket(ch.ws, 1000, 'Permissions updated')
				for (const c of old.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'Permissions updated')))
				old.channels.clear()
				old.calls.clear()
				live.delete(existing.id)
				old.ws.terminate()
			}
			return {status: 200, body: {id: existing.id, key, name: existing.name, abilities: allowed, reauthorized: true}}
		}
		const id = randomBytes(6).toString('hex')
		const key = randomBytes(32).toString('base64url')
		let name = info.hostname || 'computer'
		for (let n = 2; state.agents.some((a) => a.name === name); n++) name = `${info.hostname || 'computer'} ${n}`
		state.agents.push({id, name, keyHash: sha(key), allowed, on: {...allowed}, enrolledAt: t, lastSeen: null, info})
		await save()
		return {status: 200, body: {id, key, name, abilities: allowed}}
	}

	function authAgent(req) {
		const m = /^Bearer ([0-9a-f]{12}):([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))
		if (!m) return null
		const a = find(m[1])
		return a && sameHash(a.keyHash, sha(m[2])) ? a : null
	}

	async function upgradeAgent(req, socket, head) {
		await loaded
		// 401 is the connector's signal that this computer was removed, and it then deletes its key.
		// A file that cannot be read is not that: answer 503 so the computer keeps its key and retries.
		if (damaged) {
			socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
			return socket.destroy()
		}
		const a = authAgent(req)
		if (!a) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
			return socket.destroy()
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// One connection per computer: a new one replaces the old. Its viewers and waiting calls
			// end now (its own close handler sees it's no longer the live one and skips this).
			const old = live.get(a.id)
			if (old) {
				old.progress = null
				for (const ch of [...old.channels.values()]) {
					if (ch.kind === 'file') ch.end(new RpcError('BAD_GATEWAY', 'The computer reconnected'))
					else closeSocket(ch.ws, 1000, 'The computer reconnected')
				}
				for (const c of old.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'The computer reconnected')))
				old.channels.clear()
				old.calls.clear()
				old.ws.terminate()
			}
			const l = {ws, metrics: a.metrics ?? null, lastActivity: now(), channels: new Map(), nextCh: 0, calls: new Map(), nextCall: 0}
			live.set(a.id, l)
			let ponged = true
			ws.on('pong', () => {
				ponged = true
				l.lastActivity = now()
			})
			const alive = setInterval(() => {
				if (ws.readyState !== ws.OPEN) return
				if (!ponged) return ws.terminate()
				ponged = false
				ws.ping()
			}, pingInterval)
			alive.unref?.()
			ws.on('message', async (data, isBinary) => {
				l.lastActivity = now()
				try {
					if (isBinary) {
						const buf = Buffer.from(data)
						if (buf.length < 4) return
						const id = buf.readUInt32BE(0)
						const ch = l.channels.get(id)
						// A file channel has no browser socket. Touching ch.ws here would throw.
						if (ch?.kind === 'file') {
							ch.onBinary(buf.subarray(4))
							return
						}
						if (ch && ch.ws.readyState === ch.ws.OPEN) {
							if (ch.ws.bufferedAmount > VIEWER_BUFFER_LIMIT) closeLiveChannel(l, id, 'The viewer fell behind')
							else ch.ws.send(buf.subarray(4), {binary: true})
						}
						return
					}
					let msg
					try {
						msg = JSON.parse(String(data))
					} catch {
						return
					}
					if (msg.op === 'hello') {
						a.info = cleanInfo(msg.info)
						// The connector's own limits win if they're narrower than what was stored.
						for (const k of ABILITIES) if (msg.abilities?.[k] !== true) a.allowed[k] = a.on[k] = false
						a.lastSeen = now()
						// A full disk must not reject this listener: that rejection is unhandled and exits the process.
						try {
							await save()
						} catch {
							console.error('[omarchyd] couldn’t save swarm.json')
						}
					} else if (msg.op === 'metrics') {
						l.metrics = cleanMetrics(msg.metrics)
						a.metrics = l.metrics
						recordHistory(a.id, l.metrics)
					} else if (msg.op === 'file' || msg.op === 'ack') {
						const ch = l.channels.get(Number(msg.ch))
						if (ch?.kind === 'file') ch.onControl(msg)
					} else if (msg.op === 'attached') {
						const ch = l.channels.get(Number(msg.ch))
						if (ch && ch.kind === 'pty' && ch.ws.readyState === ch.ws.OPEN) {
							ch.ws.send(JSON.stringify({type: 'session', resumed: !!msg.resumed, cols: num(msg.cols), rows: num(msg.rows)}))
						}
					} else if (msg.op === 'closed') {
						const ch = l.channels.get(Number(msg.ch))
						if (!ch) return
						if (ch.kind === 'file') {
							ch.onControl(msg)
							return
						}
						l.channels.delete(Number(msg.ch))
						closeSocket(ch.ws, msg.code === 1011 ? 1011 : 1000, msg.reason)
					} else if (msg.op === 'progress') {
						// A long call (a backup) saying how far it's got. A report for a call that
						// already finished must not become the next call's progress.
						const callId = Number(msg.id)
						if (!l.calls.has(callId)) return
						l.progress = {call: callId, percent: Math.max(0, Math.min(1, num(msg.percent) ?? 0)), step: clip(msg.step, 80), at: now()}
					} else if (msg.op === 'result') {
						const callId = Number(msg.id)
						const c = l.calls.get(callId)
						if (!c) return
						l.calls.delete(callId)
						clearTimeout(c.timer)
						if (l.progress?.call === callId) l.progress = null
						if (msg.ok) c.resolve(msg.data ?? true)
						else c.reject(new RpcError('BAD_GATEWAY', clip(msg.error, 400) || 'That didn’t work'))
					}
				} catch {
					console.error('[omarchyd] couldn’t handle a connector message')
				}
			})
			const gone = async () => {
				clearInterval(alive)
				if (live.get(a.id)?.ws !== ws) return
				l.progress = null
				live.delete(a.id)
				for (const ch of [...l.channels.values()]) {
					if (ch.kind === 'file') ch.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
					else closeSocket(ch.ws, 1000, 'The computer went offline')
				}
				for (const c of l.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'The computer went offline')))
				a.lastSeen = now()
				await save().catch(() => {})
			}
			ws.on('close', gone)
			ws.on('error', gone)
		})
	}

	// A browser's terminal or desktop viewer, joined to a channel on the computer's connector.
	function openChannel(agentId, kind, browserWs, opts = {}) {
		const a = find(agentId)
		const l = live.get(agentId)
		// Only a terminal or a desktop is a browser socket. A file channel is opened by the server
		// itself (files.pull / files.push). Treating "file" as a desktop would let a browser read it.
		const ability = kind === 'pty' ? 'terminal' : kind === 'vnc' ? 'desktop' : null
		const why = !a ? 'Unknown computer' : !l ? 'That computer is offline' : !ability ? 'That isn’t a terminal or a desktop' : switchedOff(a.name, ability)
		if (!a || !l || !ability || !may(a, ability)) return closeSocket(browserWs, 1011, why)
		const ch = ++l.nextCh
		l.channels.set(ch, {ws: browserWs, kind})
		const openMsg = {op: 'open', ch, kind, cols: opts.cols, rows: opts.rows}
		if (kind === 'pty') {
			openMsg.session = typeof opts.session === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(opts.session) ? opts.session : 'main'
			if (opts.fresh) openMsg.fresh = true
		}
		l.ws.send(JSON.stringify(openMsg))
		const head = Buffer.alloc(4)
		head.writeUInt32BE(ch)
		browserWs.on('message', (d, isBinary) => {
			if (l.ws.readyState !== l.ws.OPEN) return
			// A terminal's binary frames are size changes (what's typed is text); the connector
			// resizes its shell. (A desktop's binary frames are the screen's own data.)
			if (kind === 'pty' && isBinary) {
				const size = parseResize(d, true)
				if (size) l.ws.send(JSON.stringify({op: 'resize', ch, cols: size.cols, rows: size.rows}))
				return
			}
			l.ws.send(Buffer.concat([head, Buffer.from(d)]), {binary: true})
		})
		const end = () => {
			if (!l.channels.delete(ch)) return
			if (l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify({op: 'close', ch}))
		}
		browserWs.on('close', end)
		browserWs.on('error', end)
	}

	// A path the connector may open: relative to that computer's home folder. Empty is only "list home".
	function safeHomePath(input, {empty = false} = {}) {
		const raw = String(input ?? '').replace(/\\/g, '/').trim()
		if (raw.startsWith('/') || raw.startsWith('~') || /[\u0000-\u001f\u007f]/.test(raw)) return null
		if (raw === '') return empty ? '' : null
		const parts = raw.split('/').filter((part) => part.length > 0)
		if (!parts.length) return empty ? '' : null
		for (const part of parts) {
			if (part === '.' || part === '..' || part.length > 200) return null
		}
		const path = parts.join('/')
		return path.length > 1024 ? null : path
	}
	function cleanFileRow(row) {
		if (!row || typeof row !== 'object') return null
		const name = typeof row.name === 'string' ? row.name : ''
		if (!name || name.length > 200 || name === '.' || name === '..' || /[\u0000-\u001f\u007f/\\]/.test(name)) return null
		const dir = row.dir === true
		const size = !dir && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : 0
		const mtime = Number.isSafeInteger(row.mtime) ? row.mtime : null
		return {name, size, mtime, dir}
	}
	async function requireFilesAgent(id) {
		await loaded
		const a = find(String(id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const l = live.get(a.id)
		if (!l) throw new RpcError('PRECONDITION_FAILED', 'That computer is offline right now')
		if (!may(a, 'files')) throw new RpcError('FORBIDDEN', `Add ${a.name} again with Files switched on.`)
		return {a, l}
	}
	// One file transfer on the connector socket. The promise only ever resolves; the caller throws
	// session.failure, so a drop before the first await cannot become an unhandled rejection.
	function openFileSession(l, open, writeChunk) {
		const ch = ++l.nextCh
		let dead = false
		let failure = null
		let result = null
		let meta = null
		let got = 0
		let unacked = 0
		let committed = false
		let chain = Promise.resolve()
		const ackWaiters = []
		let markReady = () => {}
		const ready = new Promise((resolve) => {
			markReady = resolve
		})
		let settle = () => {}
		const settled = new Promise((resolve) => {
			settle = resolve
		})
		const timer = setTimeout(() => finish(new RpcError('BAD_GATEWAY', 'That computer didn’t answer in time')), FILE_MS)
		timer.unref?.()
		const wakeAcks = () => {
			for (const wait of ackWaiters.splice(0)) wait()
		}
		function sendJson(obj) {
			if (l.ws.readyState !== l.ws.OPEN) return false
			try {
				l.ws.send(JSON.stringify(obj))
				return true
			} catch {
				return false
			}
		}
		function finish(err, value) {
			if (dead) return
			dead = true
			clearTimeout(timer)
			l.channels.delete(ch)
			failure = err ?? null
			result = value ?? null
			markReady()
			wakeAcks()
			if (err) sendJson({op: 'close', ch})
			settle()
		}
		async function applyBinary(buf) {
			if (dead) return
			if (open.mode !== 'read') return finish(new RpcError('BAD_GATEWAY', 'That computer sent file bytes it wasn’t asked for'))
			if (!meta || !Number.isSafeInteger(meta.size) || meta.size < 0) return finish(new RpcError('BAD_GATEWAY', 'The file started before its size arrived'))
			if (got + buf.length > meta.size) return finish(new RpcError('BAD_GATEWAY', 'That file is larger than it said'))
			got += buf.length
			await writeChunk(buf)
			if (dead) return
			sendJson({op: 'ack', ch})
		}
		function applyClosed(msg) {
			if (dead) return
			const reason = clip(msg.reason, 200)
			if (msg.code === 1011) return finish(new RpcError('BAD_GATEWAY', reason || 'That computer couldn’t transfer the file'))
			if (open.mode === 'read') {
				if (!meta || !Number.isSafeInteger(meta.size) || got !== meta.size) return finish(new RpcError('BAD_GATEWAY', reason || 'The file changed while it was being read'))
				return finish(null, {size: meta.size, mtime: Number.isSafeInteger(meta.mtime) ? meta.mtime : null})
			}
			if (!committed) return finish(new RpcError('BAD_GATEWAY', reason || 'That computer closed the file early'))
			return finish(null, {size: open.size})
		}
		const channel = {
			kind: 'file',
			end: (err) => finish(err instanceof RpcError ? err : new RpcError('BAD_GATEWAY', 'The computer went offline')),
			onBinary(buf) {
				chain = chain.then(() => applyBinary(buf)).catch((e) => finish(e instanceof RpcError ? e : new RpcError('BAD_GATEWAY', 'Couldn’t transfer that file')))
			},
			onControl(msg) {
				if (msg.op === 'file') {
					meta = msg
					markReady()
					return
				}
				if (msg.op === 'ack') {
					unacked = Math.max(0, unacked - 1)
					wakeAcks()
					return
				}
				if (msg.op === 'closed') chain = chain.then(() => applyClosed(msg)).catch((e) => finish(e instanceof RpcError ? e : new RpcError('BAD_GATEWAY', 'Couldn’t transfer that file')))
			},
		}
		l.channels.set(ch, channel)
		if (!sendJson({op: 'open', ch, ...open})) finish(new RpcError('BAD_GATEWAY', 'The computer went offline'))
		return {
			get failure() {
				return failure
			},
			get result() {
				return result
			},
			get meta() {
				return meta
			},
			ready,
			settled,
			end: channel.end,
			async waitWindow() {
				while (unacked >= FILE_WINDOW && !dead) await new Promise((resolve) => ackWaiters.push(resolve))
			},
			async waitDrained() {
				while (unacked > 0 && !dead) await new Promise((resolve) => ackWaiters.push(resolve))
			},
			noteSent() {
				unacked += 1
			},
			sendFrame(payload) {
				if (l.ws.readyState !== l.ws.OPEN) return false
				const frame = Buffer.alloc(4 + payload.length)
				frame.writeUInt32BE(ch, 0)
				payload.copy(frame, 4)
				try {
					l.ws.send(frame)
					return true
				} catch {
					return false
				}
			},
			sendJson,
			commit() {
				committed = true
				return sendJson({op: 'commit', ch})
			},
		}
	}
	async function statFile(id, path) {
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		const {a} = await requireFilesAgent(id)
		const row = cleanFileRow(await call(a.id, 'files-stat', {path: rel}))
		if (!row) throw new RpcError('BAD_GATEWAY', 'That computer’s answer wasn’t a file')
		return row
	}
	async function listFiles(id, path) {
		const rel = safeHomePath(path ?? '', {empty: true})
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		const {a} = await requireFilesAgent(id)
		const data = await call(a.id, 'files-list', {path: rel})
		const entries = Array.isArray(data?.entries) ? data.entries.slice(0, 200).map(cleanFileRow).filter(Boolean) : []
		return {path: rel, entries, truncated: data?.truncated === true}
	}
	async function pullFile(id, path, writeChunk) {
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		if (typeof writeChunk !== 'function') throw new RpcError('BAD_REQUEST', 'Nowhere to write that file')
		const {l} = await requireFilesAgent(id)
		const session = openFileSession(l, {kind: 'file', mode: 'read', path: rel}, writeChunk)
		await session.ready
		if (session.failure) throw session.failure
		const size = session.meta?.size
		if (!Number.isSafeInteger(size) || size < 0) {
			session.end(new RpcError('BAD_GATEWAY', 'That computer didn’t say how big the file is'))
			throw session.failure
		}
		await session.settled
		if (session.failure) throw session.failure
		return session.result
	}
	async function pushFile(id, path, size, readChunk) {
		if (!Number.isSafeInteger(size) || size < 0) throw new RpcError('BAD_REQUEST', 'That file’s size isn’t usable')
		const rel = safeHomePath(path)
		if (rel == null) throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
		if (typeof readChunk !== 'function') throw new RpcError('BAD_REQUEST', 'Nowhere to read that file')
		const {l} = await requireFilesAgent(id)
		const session = openFileSession(l, {kind: 'file', mode: 'write', path: rel, size}, async () => {})
		await session.ready
		if (session.failure) throw session.failure
		if (session.meta?.ready !== true) {
			session.end(new RpcError('BAD_GATEWAY', 'That computer didn’t open the file'))
			throw session.failure
		}
		let sent = 0
		while (sent < size) {
			if (session.failure) throw session.failure
			await session.waitWindow()
			if (session.failure) throw session.failure
			let chunk
			try {
				chunk = await readChunk(Math.min(FILE_CHUNK, size - sent))
			} catch {
				session.end(new RpcError('BAD_GATEWAY', 'Couldn’t read that file'))
				throw session.failure
			}
			const payload = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : null
			if (!payload || payload.length === 0 || payload.length > Math.min(FILE_CHUNK, size - sent)) {
				session.end(new RpcError('BAD_GATEWAY', 'The file arrived short'))
				throw session.failure
			}
			session.noteSent()
			if (!session.sendFrame(payload)) {
				session.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
				throw session.failure
			}
			sent += payload.length
		}
		await session.waitDrained()
		if (session.failure) throw session.failure
		if (!session.commit()) {
			session.end(new RpcError('BAD_GATEWAY', 'The computer went offline'))
			throw session.failure
		}
		await session.settled
		if (session.failure) throw session.failure
		return session.result
	}

	// For backups.mjs: the computers that may back up, and calls to their connector's backup side.
	const backupCalls = new Set(['backup-folders', 'backup-run', 'backup-restore'])
	const backup = {
		async agents() {
			await loaded
			return state.agents.map((a) => ({id: a.id, name: a.name, online: live.has(a.id), allowed: !!a.allowed.backup, on: may(a, 'backup'), user: a.info?.user ?? '', hostname: a.info?.hostname ?? ''}))
		},
		async call(id, name, args, timeout) {
			await loaded
			const a = find(id)
			if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
			if (!backupCalls.has(name)) throw new RpcError('BAD_REQUEST', 'Unknown action')
			if (!may(a, 'backup')) throw new RpcError('FORBIDDEN', `Backups aren’t switched on for ${a.name}`)
			return call(a.id, name, args, timeout)
		},
		progress: (id) => live.get(id)?.progress ?? null,
		// The backup store's HTTP side: which computer is asking (its own key), if it may back up.
		authenticate(req) {
			const a = authAgent(req)
			return a && may(a, 'backup') ? a.id : null
		},
	}

	const fleetFiles = {stat: statFile, list: listFiles, pull: pullFile, push: pushFile}

	return {
		files: fleetFiles,
		backup,
		procedures: {
			'swarm.list': {kind: 'query', run: list},
			'swarm.history': {kind: 'query', run: getHistory},
			'swarm.alerts': {kind: 'query', run: getAlerts},
			'swarm.wake': {kind: 'mutation', run: wake},
			'swarm.pair': {kind: 'mutation', run: pair},
			'swarm.reauthorize': {kind: 'mutation', run: reauthorize},
			'swarm.updateConnector': {kind: 'mutation', run: updateConnector},
			'swarm.updateAllConnectors': {kind: 'mutation', run: updateAllConnectors},
			'swarm.remove': {kind: 'mutation', run: remove},
			'swarm.rename': {kind: 'mutation', run: rename},
			'swarm.setAbilities': {kind: 'mutation', run: setAbilities},
			'swarm.action': {kind: 'mutation', run: action},
			'swarm.fleetAction': {kind: 'mutation', run: fleetAction},
			'swarm.storage.status': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, false)
					const storageAllowed = may(a, 'storage')
					if (!storageAllowed) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
					try {
						const s = await call(a.id, 'storage-status', {})
						return {helperAvailable: !!s?.helperAvailable, zfsAvailable: !!s?.zfsAvailable, storageAllowed: true}
					} catch (e) {
						if (/allow Storage|doesn’t allow/i.test(e.message)) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.disks': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-disks', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.unmount': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-unmount', {device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.mount': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-mount', {device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.format': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					const filesystem = String(input?.filesystem ?? '')
					if (!['blank', 'ext4', 'exfat'].includes(filesystem)) throw new RpcError('BAD_REQUEST', 'Choose blank, ext4 or exfat')
					try {
						await call(a.id, 'storage-format', {device: String(input?.device ?? ''), filesystem})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.pools': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-pools', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.importable': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						return await call(a.id, 'storage-importable', {})
					} catch (e) {
						throw storageReadError(e, a.name)
					}
				},
			},
			'swarm.storage.createPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-createPool', {
							name: String(input?.name ?? ''),
							fs: input?.fs,
							profile: String(input?.profile ?? ''),
							devices: Array.isArray(input?.devices) ? input.devices.map(String) : [],
						})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.addToPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-addToPool', {name: String(input?.name ?? ''), device: String(input?.device ?? '')})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.importPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-importPool', {name: String(input?.name ?? ''), uuid: String(input?.uuid ?? ''), force: input?.force === true})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.forgetPool': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-forgetPool', {name: String(input?.name ?? ''), kind: input?.kind})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.scrub': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-scrub', {name: String(input?.name ?? ''), kind: input?.kind})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			'swarm.storage.setSleep': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAgent(input, true)
					try {
						await call(a.id, 'storage-setSleep', {device: String(input?.device ?? ''), minutes: Number(input?.minutes)})
						return true
					} catch (e) {
						throw new RpcError('PRECONDITION_FAILED', e.message)
					}
				},
			},
			// Before showing a computer's screen: can it, and if not, why (in words, not a socket code).
			'swarm.desktopCheck': {
				kind: 'query',
				run: async (input) => {
					await loaded
					const a = find(String(input?.id ?? ''))
					if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
					if (!may(a, 'desktop')) throw new RpcError('FORBIDDEN', `Seeing ${a.name}’s desktop isn’t switched on`)
					if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
					const d = a.info?.desktop
					if (d && !d.ok) throw new RpcError('PRECONDITION_FAILED', d.why || 'Its desktop can’t be shown')
					return true
				},
			},
			'swarm.services.list': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAbility(input, 'services', 'Services')
					return call(a.id, 'services-list', {}, 30_000)
				},
			},
			'swarm.services.logs': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAbility(input, 'services', 'Services')
					return call(a.id, 'services-logs', {kind: String(input?.kind ?? ''), name: String(input?.name ?? ''), lines: Number(input?.lines) || 200}, 30_000)
				},
			},
			'swarm.services.control': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAbility(input, 'services', 'Services')
					return call(a.id, 'services-control', {kind: String(input?.kind ?? ''), name: String(input?.name ?? ''), action: String(input?.action ?? '')}, 60_000)
				},
			},
			'swarm.files.list': {
				kind: 'query',
				run: async (input) => {
					const a = await requireAbility(input, 'files', 'File access')
					return call(a.id, 'files-list', {path: String(input?.path || '/')}, 30_000)
				},
			},
			'swarm.files.mkdir': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAbility(input, 'files', 'File access')
					return call(a.id, 'files-mkdir', {path: String(input?.path ?? '')}, 30_000)
				},
			},
			'swarm.files.rename': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAbility(input, 'files', 'File access')
					return call(a.id, 'files-rename', {path: String(input?.path ?? ''), newName: String(input?.newName ?? '')}, 30_000)
				},
			},
			'swarm.files.trash': {
				kind: 'mutation',
				run: async (input) => {
					const a = await requireAbility(input, 'files', 'File access')
					return call(a.id, 'files-trash', {path: String(input?.path ?? '')}, 30_000)
				},
			},
			'swarm.files.copyToServer': {
				kind: 'mutation',
				run: async (input) => {
					if (!files?.resolve) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
					const remote = await readRemoteFile(input?.id, input?.remotePath)
					const destVirtual = String(input?.serverDir || '/Home').replace(/\/+$/, '') || '/Home'
					const safeName = remote.name.replace(/[/\\\0]/g, '_')
					if (!safeName || safeName === '.' || safeName === '..') throw new RpcError('BAD_REQUEST', 'Invalid file name')
					const {real: destDir} = await files.resolve(destVirtual, {mustExist: true})
					const destSt = await stat(destDir).catch(() => null)
					if (!destSt?.isDirectory()) throw new RpcError('BAD_REQUEST', 'Destination must be a folder')
					const fullVirtual = `${destVirtual}/${safeName}`
					const {real: destFile} = await files.resolve(fullVirtual, {mustExist: false})
					await writeAtomic(destFile, remote.data)
					return {path: fullVirtual, size: remote.data.length}
				},
			},
			'swarm.files.copyFromServer': {
				kind: 'mutation',
				run: async (input) => {
					if (!files?.resolve) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
					const srcVirtual = String(input?.serverPath ?? '')
					const {real: srcPath} = await files.resolve(srcVirtual, {mustExist: true})
					const srcSt = await stat(srcPath)
					if (!srcSt.isFile()) throw new RpcError('BAD_REQUEST', 'Only regular files can be copied')
					if (srcSt.size > REMOTE_FILE_MAX) throw new RpcError('BAD_REQUEST', 'Files larger than 20 MB can’t be transferred through the swarm')
					const buf = await readFile(srcPath)
					const remoteDir = String(input?.remoteDir || '/Home').replace(/\/+$/, '') || '/Home'
					const name = basename(srcPath)
					return writeRemoteFile(input?.id, `${remoteDir}/${name}`, buf)
				},
			},
		},
		enroll,
		authenticateAgent: async (req) => {
			await loaded
			return authAgent(req)
		},
		readAgentScript,
		readRemoteFile,
		writeRemoteFile,
		summary: async () => {
			await loaded
			return {total: state.agents.length, online: state.agents.filter((a) => live.has(a.id)).length}
		},
		upgradeAgent,
		openChannel,
		isAgentMachine: (machineId) => /^agent-[0-9a-f]{12}$/.test(machineId),
		close: () => {
			for (const l of live.values()) l.ws.terminate()
		},
	}
}
