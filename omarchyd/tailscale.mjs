// Native Tailscale visibility & management over tailscaled's local Unix socket (/localapi/v0/).
// Zero external dependencies; requires the current user to be tailscale's --operator (or root).
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'

import {RpcError} from './rpc.mjs'
import {TAILSCALE_SOCKET} from './system-apps.mjs'

const EXIT_ROUTES = ['0.0.0.0/0', '::/0']

function ipv4ToBigInt(ip) {
	const parts = ip.split('.').map(Number)
	return (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3])
}

function ipv6ToBigInt(ip) {
	let s = ip
	const lastColon = s.lastIndexOf(':')
	if (s.includes('.')) {
		const v4 = ipv4ToBigInt(s.slice(lastColon + 1))
		s = `${s.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`
	}
	const halves = s.split('::')
	if (halves.length > 2) return null
	const left = halves[0] ? halves[0].split(':') : []
	const right = halves[1] ? halves[1].split(':') : []
	const fill = halves.length === 2 ? 8 - (left.length + right.length) : 0
	if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null
	const groups = [...left, ...Array(fill).fill('0'), ...right]
	if (groups.length !== 8) return null
	let out = 0n
	for (const g of groups) out = (out << 16n) | BigInt(parseInt(g, 16))
	return out
}

export function isDefaultRouteCidr(s) {
	const v = String(s ?? '').trim()
	const slash = v.indexOf('/')
	if (slash <= 0 || slash !== v.lastIndexOf('/')) return false
	const ip = v.slice(0, slash)
	const bitsStr = v.slice(slash + 1)
	if (ip.includes('%') || bitsStr !== '0') return false
	if (net.isIPv4(ip)) return ipv4ToBigInt(ip) === 0n
	if (net.isIPv6(ip)) return ipv6ToBigInt(ip) === 0n
	return false
}

export function isValidCidr(s) {
	const v = String(s ?? '').trim()
	const slash = v.indexOf('/')
	if (slash <= 0 || slash !== v.lastIndexOf('/')) return false
	const ip = v.slice(0, slash)
	const bitsStr = v.slice(slash + 1)
	if (ip.includes('%') || !/^(0|[1-9]\d{0,2})$/.test(bitsStr)) return false
	const bits = Number(bitsStr)
	if (net.isIPv4(ip)) {
		if (bits < 0 || bits > 32) return false
		const hostMask = (1n << BigInt(32 - bits)) - 1n
		return (ipv4ToBigInt(ip) & hostMask) === 0n
	}
	if (net.isIPv6(ip)) {
		if (bits < 0 || bits > 128) return false
		const addr = ipv6ToBigInt(ip)
		if (addr === null) return false
		const hostMask = (1n << BigInt(128 - bits)) - 1n
		return (addr & hostMask) === 0n
	}
	return false
}

export function normalizeControlUrl(raw) {
	const v = String(raw ?? '').trim()
	if (!v) return ''
	let u
	try {
		u = new URL(v)
	} catch {
		throw new RpcError('BAD_REQUEST', 'Enter a valid https:// control server URL (or leave blank for Tailscale)')
	}
	if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) {
		throw new RpcError('BAD_REQUEST', 'Control server URL must be https:// with no embedded credentials')
	}
	return u.toString().replace(/\/+$/, '')
}

export function defaultTailscaleApi(socketPath = TAILSCALE_SOCKET) {
	return function localApi(method, path, body, {timeoutMs = 10_000} = {}) {
		return new Promise((resolve, reject) => {
			const payload = body !== undefined ? JSON.stringify(body) : undefined
			const req = http.request(
				{
					socketPath,
					path: `/localapi/v0/${path}`,
					method,
					timeout: timeoutMs,
					headers: {
						host: 'local-tailscaled.sock',
						...(payload !== undefined ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)} : {}),
					},
				},
				(res) => {
					let data = ''
					res.setEncoding('utf8')
					res.on('data', (c) => (data += c))
					res.on('end', () => {
						if ((res.statusCode ?? 500) < 300) resolve(data)
						else {
							const err = new Error(`Tailscale answered ${res.statusCode}: ${data.trim().slice(0, 200)}`)
							err.statusCode = res.statusCode
							reject(err)
						}
					})
				},
			)
			req.on('timeout', () => req.destroy(new Error('Tailscale didn’t answer')))
			req.on('error', reject)
			req.end(payload)
		})
	}
}

export function parseTailscaleStatus(rawStatus, rawPrefs = null, {operator = true} = {}) {
	const st = rawStatus && typeof rawStatus === 'object' ? rawStatus : {}
	const pr = rawPrefs && typeof rawPrefs === 'object' ? rawPrefs : {}
	const selfRaw = st.Self && typeof st.Self === 'object' ? st.Self : null
	const stripDot = (s) => String(s ?? '').replace(/\.$/, '')
	const cleanDate = (s) => (!s || String(s).startsWith('0001-01-01') ? null : String(s))

	const advertiseRoutesAll = Array.isArray(pr.AdvertiseRoutes) ? pr.AdvertiseRoutes.map(String) : []
	const advertisingExitNode = advertiseRoutesAll.some((r) => isDefaultRouteCidr(r))
	const subnetRoutes = advertiseRoutesAll.filter((r) => !isDefaultRouteCidr(r))

	const peersObj = st.Peer && typeof st.Peer === 'object' ? st.Peer : {}
	const peers = Object.values(peersObj)
		.filter((p) => p && typeof p === 'object')
		.map((p) => {
			const ips = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.map(String) : []
			const curAddr = String(p.CurAddr ?? '').trim()
			return {
				id: String(p.ID ?? ''),
				hostName: String(p.HostName ?? ''),
				dnsName: stripDot(p.DNSName),
				os: String(p.OS ?? ''),
				ips,
				online: !!p.Online,
				active: !!p.Active,
				direct: Boolean(curAddr),
				curAddr,
				relay: String(p.Relay ?? ''),
				rxBytes: Number(p.RxBytes) || 0,
				txBytes: Number(p.TxBytes) || 0,
				lastSeen: cleanDate(p.LastSeen),
				lastHandshake: cleanDate(p.LastHandshake),
				exitNode: !!p.ExitNode,
				exitNodeOption: !!p.ExitNodeOption,
				tags: Array.isArray(p.Tags) ? p.Tags.map(String) : [],
			}
		})
		.sort((a, b) => Number(b.online) - Number(a.online) || (a.dnsName || a.hostName).localeCompare(b.dnsName || b.hostName))

	const selfIps = Array.isArray(st.TailscaleIPs) ? st.TailscaleIPs.map(String) : Array.isArray(selfRaw?.TailscaleIPs) ? selfRaw.TailscaleIPs.map(String) : []
	const health = Array.isArray(st.Health) ? st.Health.map((h) => String(h ?? '').trim()).filter(Boolean) : []

	return {
		available: true,
		operator,
		version: String(st.Version ?? ''),
		backendState: String(st.BackendState ?? 'Unknown'),
		authUrl: String(st.AuthURL ?? ''),
		tailnet: String(st.CurrentTailnet?.Name ?? ''),
		magicDnsSuffix: stripDot(st.MagicDNSSuffix || st.CurrentTailnet?.MagicDNSSuffix || ''),
		health,
		self: selfRaw
			? {
					id: String(selfRaw.ID ?? ''),
					hostName: String(selfRaw.HostName ?? ''),
					dnsName: stripDot(selfRaw.DNSName),
					os: String(selfRaw.OS ?? ''),
					ips: selfIps,
					relay: String(selfRaw.Relay ?? ''),
					online: !!selfRaw.Online,
					exitNode: !!selfRaw.ExitNode,
					advertisingExitNode,
					subnetRoutes,
				}
			: null,
		prefs: rawPrefs
			? {
					wantRunning: !!pr.WantRunning,
					controlUrl: String(pr.ControlURL ?? ''),
					acceptDns: pr.CorpDNS !== false,
					acceptRoutes: !!pr.RouteAll,
					runSsh: !!pr.RunSSH,
					shieldsUp: !!pr.ShieldsUp,
					exitNodeId: String(pr.ExitNodeID ?? ''),
					exitNodeAllowLan: !!pr.ExitNodeAllowLANAccess,
					advertiseExitNode: advertisingExitNode,
					subnetRoutes,
				}
			: null,
		peers,
		summary: {
			totalPeers: peers.length,
			onlinePeers: peers.filter((p) => p.online).length,
			directPeers: peers.filter((p) => p.online && p.direct).length,
			exitNodeOptions: peers.filter((p) => p.exitNodeOption).length,
		},
	}
}

export function createTailscale({socketPath = TAILSCALE_SOCKET, localApi = defaultTailscaleApi(socketPath), audit = null, currentUser = null} = {}) {
	const username = currentUser ?? os.userInfo().username
	const isRoot = currentUser == null && typeof process.getuid === 'function' && process.getuid() === 0

	async function readStatus() {
		let rawStatus
		try {
			rawStatus = JSON.parse(await localApi('GET', 'status'))
		} catch (e) {
			if (e?.code === 'ENOENT' || e?.code === 'ECONNREFUSED' || e?.code === 'EACCES') {
				return {
					available: false,
					operator: false,
					version: '',
					backendState: 'Unavailable',
					authUrl: '',
					tailnet: '',
					magicDnsSuffix: '',
					health: [],
					self: null,
					prefs: null,
					peers: [],
					summary: {totalPeers: 0, onlinePeers: 0, directPeers: 0, exitNodeOptions: 0},
					error: e.code === 'EACCES' ? 'Run Tailscale setup to grant operator access' : 'Tailscale isn’t running on this server',
				}
			}
			throw new RpcError('BAD_GATEWAY', e.message || 'Couldn’t read Tailscale status')
		}
		let rawPrefs = null
		let operator = false
		try {
			rawPrefs = JSON.parse(await localApi('GET', 'prefs'))
			operator = Boolean(isRoot || (typeof rawPrefs?.OperatorUser === 'string' && rawPrefs.OperatorUser === username))
		} catch {
			operator = false
		}
		return parseTailscaleStatus(rawStatus, rawPrefs, {operator})
	}

	async function setPrefs(input = {}) {
		const current = await readStatus()
		if (!current.available) throw new RpcError('PRECONDITION_FAILED', 'Tailscale isn’t running on this server')
		if (!current.operator) throw new RpcError('FORBIDDEN', 'Omarchy Server needs Tailscale operator permission to change settings')

		const nextExitNodeId = typeof input.exitNodeId === 'string' ? input.exitNodeId.trim() : current.prefs?.exitNodeId ?? ''
		const nextAdvertiseExit = typeof input.advertiseExitNode === 'boolean' ? input.advertiseExitNode : !!current.prefs?.advertiseExitNode
		if (nextExitNodeId && nextAdvertiseExit) {
			throw new RpcError('BAD_REQUEST', 'A server can’t advertise an exit node and use another exit node at the same time')
		}

		const patch = {}
		if (typeof input.wantRunning === 'boolean') {
			patch.WantRunning = input.wantRunning
			patch.WantRunningSet = true
		}
		if (typeof input.acceptDns === 'boolean') {
			patch.CorpDNS = input.acceptDns
			patch.CorpDNSSet = true
		}
		if (typeof input.acceptRoutes === 'boolean') {
			patch.RouteAll = input.acceptRoutes
			patch.RouteAllSet = true
		}
		if (typeof input.runSsh === 'boolean') {
			patch.RunSSH = input.runSsh
			patch.RunSSHSet = true
		}
		if (typeof input.shieldsUp === 'boolean') {
			patch.ShieldsUp = input.shieldsUp
			patch.ShieldsUpSet = true
		}
		if (typeof input.exitNodeAllowLan === 'boolean') {
			patch.ExitNodeAllowLANAccess = input.exitNodeAllowLan
			patch.ExitNodeAllowLANAccessSet = true
		}
		if (typeof input.exitNodeId === 'string') {
			const id = input.exitNodeId.trim()
			if (id && !current.peers.some((p) => p.id === id && p.exitNodeOption)) {
				throw new RpcError('BAD_REQUEST', 'Choose an available exit node peer')
			}
			patch.ExitNodeID = id
			patch.ExitNodeIDSet = true
			patch.ExitNodeIP = ''
			patch.ExitNodeIPSet = true
		}
		if (typeof input.advertiseExitNode === 'boolean' || Array.isArray(input.subnetRoutes)) {
			const wantExit = typeof input.advertiseExitNode === 'boolean' ? input.advertiseExitNode : !!current.prefs?.advertiseExitNode
			const rawRoutes = Array.isArray(input.subnetRoutes) ? input.subnetRoutes : current.prefs?.subnetRoutes ?? []
			const cleaned = []
			for (const r of rawRoutes) {
				const c = String(r ?? '').trim()
				if (!c) continue
				if (isDefaultRouteCidr(c)) throw new RpcError('BAD_REQUEST', 'Use the "Advertise as exit node" toggle for default routes (0.0.0.0/0 or ::/0)')
				if (!isValidCidr(c)) throw new RpcError('BAD_REQUEST', `Invalid subnet route CIDR (host bits must be 0): ${c}`)
				if (!cleaned.includes(c)) cleaned.push(c)
			}
			patch.AdvertiseRoutes = wantExit ? [...cleaned, ...EXIT_ROUTES] : cleaned
			patch.AdvertiseRoutesSet = true
		}
		if (typeof input.controlUrl === 'string') {
			patch.ControlURL = normalizeControlUrl(input.controlUrl)
			patch.ControlURLSet = true
		}
		if (!Object.keys(patch).length) return readStatus()
		try {
			await localApi('PATCH', 'prefs', patch)
		} catch (e) {
			await audit?.record({action: 'tailscale.setPrefs', target: 'tailscale', ok: false, detail: e.message})
			throw new RpcError('BAD_GATEWAY', e.message || 'Couldn’t update Tailscale settings')
		}
		await audit?.record({action: 'tailscale.setPrefs', target: 'tailscale', ok: true, detail: Object.keys(patch).filter((k) => !k.endsWith('Set'))})
		return readStatus()
	}

	async function login() {
		const current = await readStatus()
		if (!current.available) throw new RpcError('PRECONDITION_FAILED', 'Tailscale isn’t running on this server')
		if (!current.operator) throw new RpcError('FORBIDDEN', 'Omarchy Server needs Tailscale operator permission')
		await localApi('PATCH', 'prefs', {WantRunning: true, WantRunningSet: true}).catch(() => {})
		await localApi('POST', 'login-interactive', undefined, {timeoutMs: 15_000}).catch(() => {})
		for (let i = 0; i < 8; i++) {
			const st = await readStatus()
			if (st.authUrl || st.backendState === 'Running') return {authUrl: st.authUrl, backendState: st.backendState}
			await new Promise((r) => setTimeout(r, 300))
		}
		const st = await readStatus()
		return {authUrl: st.authUrl, backendState: st.backendState}
	}

	async function logout() {
		const current = await readStatus()
		if (!current.available) throw new RpcError('PRECONDITION_FAILED', 'Tailscale isn’t running on this server')
		if (!current.operator) throw new RpcError('FORBIDDEN', 'Omarchy Server needs Tailscale operator permission')
		await localApi('POST', 'logout', undefined, {timeoutMs: 15_000})
		await audit?.record({action: 'tailscale.logout', target: 'tailscale', ok: true})
		return true
	}

	async function ping(input = {}) {
		const ip = String(input?.ip ?? '').trim()
		const current = await readStatus()
		if (!current.available) throw new RpcError('PRECONDITION_FAILED', 'Tailscale isn’t running on this server')
		const knownPeer = current.peers.find((p) => p.ips.includes(ip))
		if (!knownPeer) throw new RpcError('BAD_REQUEST', 'Choose a peer on your tailnet to ping')
		try {
			const raw = JSON.parse(await localApi('POST', `ping?ip=${encodeURIComponent(ip)}&type=disco`, undefined, {timeoutMs: 10_000}))
			return {
				ip,
				peer: knownPeer.dnsName || knownPeer.hostName,
				latencyMs: typeof raw.LatencySeconds === 'number' ? Math.round(raw.LatencySeconds * 10000) / 10 : null,
				direct: Boolean(raw.Endpoint),
				endpoint: String(raw.Endpoint ?? ''),
				derpRegionCode: String(raw.DERPRegionCode ?? ''),
				error: String(raw.Err ?? ''),
			}
		} catch (e) {
			throw new RpcError('BAD_GATEWAY', e.message || 'Ping failed')
		}
	}

	return {
		procedures: {
			'tailscale.status': {kind: 'query', run: readStatus},
			'tailscale.setPrefs': {kind: 'mutation', run: setPrefs},
			'tailscale.login': {kind: 'mutation', run: login},
			'tailscale.logout': {kind: 'mutation', run: logout},
			'tailscale.ping': {kind: 'mutation', run: ping},
		},
	}
}
