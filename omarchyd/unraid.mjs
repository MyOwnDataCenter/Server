// Move from Unraid: connect to an Unraid server over SSH, see its shares, Docker containers and VMs,
// and bring the chosen ones over. Unraid itself isn't changed, except that a container being moved
// stops for a moment (while the last of its files are copied) and then starts again.
//
// - SSH as root, with password, pasted private key, or this server's existing SSH key. Secrets stay
//   in memory (or a 0o600 temp key file deleted on disconnect) and are handed to ssh via SSH_ASKPASS,
//   never on a command line. One authenticated ControlMaster connection is reused for rsync too.
// - Unraid's host key is recorded on first connect (its fingerprint is shown) and required after.
// - Shares: copied with rsync (resumable, optional bwlimit, excludes, checksum verify & delta resync)
//   into Home (or a storage pool) and shared on the network again.
// - Containers: each becomes an app (or multi-service Compose stack for VPN/shared-network groups),
//   from how it actually runs (docker inspect): image, settings, GPU/shm/tmpfs/dns/extra_hosts/limits,
//   named Docker volumes, appdata, icons, App Store matching, and port-conflict overrides.
// - VMs: their disks and UEFI NVRAM are copied (with optional graceful shutdown on Unraid) and become
//   machines here.
// - Share configs (/boot/config/shares/*.cfg) and User Scripts (/boot/config/plugins/user.scripts)
//   are surfaced as a migration checklist.
// Owner only (server.mjs wraps the procedures).
import {randomBytes} from 'node:crypto'
import {access, chmod, mkdir, readdir, readFile, rm, stat, statfs, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import YAML from 'yaml'

import {checkPushEndpoint} from './alerts.mjs'
import {writeAtomic} from './atomic.mjs'
import {defaultSpawn} from './backups.mjs'
import {RpcError} from './rpc.mjs'

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*|\d{1,3}(?:\.\d{1,3}){3})$/
const SHARE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$/
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,79}$/
const exists = (p) => access(p).then(() => true, () => false)
// Single-quoted for the remote shell (names are checked against the patterns above first).
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function slug(name) {
	return (
		String(name)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'app'
	)
}

// A path under a share. "." and ".." would copy or bind outside the folder chosen here.
function restStaysInside(rest) {
	return String(rest)
		.split('/')
		.every((p) => p !== '.' && p !== '..' && !p.includes('\\') && !p.includes('\0') && !/[\r\n]/.test(p))
}

// Where a path on Unraid is: in appdata, in a user share, or somewhere else.
export function unraidPath(p) {
	const m = /^\/mnt\/(?:user0?|cache|disk\d+|[A-Za-z0-9_-]+)\/([^/]+)(?:\/(.*))?$/.exec(String(p))
	if (!m || /^\/mnt\/(?:disks|remotes|addons|rootshare)\//.test(p)) return {kind: 'other'}
	const [, share, rest = ''] = m
	if (!restStaysInside(rest)) return {kind: 'other'}
	if (share === 'appdata') return {kind: 'appdata', rest}
	return {kind: 'share', share, rest}
}

// The web address an Unraid template shows, e.g. "http://[IP]:[PORT:8096]/web".
export function webuiPort(label) {
	const s = String(label ?? '')
	const m = /\[PORT:(\d{1,5})\]([^\s]*)/.exec(s)
	if (!m) return null
	return {port: Number(m[1]), path: m[2] && m[2] !== '/' ? m[2] : '', ...(/^\s*https:\/\//i.test(s) ? {https: true} : {})}
}

function imageVersion(image) {
	const name = String(image ?? '').split('@')[0]
	const last = name.slice(name.lastIndexOf('/') + 1)
	const colon = last.indexOf(':')
	const tag = colon >= 0 ? last.slice(colon + 1) : ''
	return (tag || 'latest').slice(0, 40)
}

// Compose would read "$" as one of its variables.
const escapeCompose = (s) => String(s).replace(/\$/g, '$$$$')

function asList(v) {
	if (Array.isArray(v)) return v.map((x) => String(x))
	if (typeof v === 'string' && v) return [v]
	return []
}
function peerLabel(ref, peers) {
	const id = String(ref)
	if (!(peers instanceof Map)) return id
	return peers.get(id) || peers.get(id.slice(0, 12)) || id
}
function byteSize(n) {
	const gb = n / (1024 * 1024 * 1024)
	if (gb >= 1 && Number.isInteger(gb)) return `${gb} GB`
	const mb = n / (1024 * 1024)
	return Number.isInteger(mb) ? `${mb} MB` : `${Math.round(mb * 10) / 10} MB`
}
function composeByteSize(n) {
	const gb = n / (1024 * 1024 * 1024)
	if (gb >= 1 && Number.isInteger(gb)) return `${gb}g`
	const mb = Math.max(1, Math.round(n / (1024 * 1024)))
	return `${mb}m`
}

// Sanitize user-supplied rsync exclude patterns: prevent option injection and control characters.
export function sanitizeRsyncExcludes(list) {
	if (!Array.isArray(list)) return []
	const out = []
	for (const raw of list) {
		const p = String(raw ?? '').trim()
		if (!p || p.length > 120 || p.startsWith('-') || /[\0\r\n]/.test(p)) continue
		if (!out.includes(p)) out.push(p)
		if (out.length >= 40) break
	}
	return out
}

// Parse /boot/config/shares/<name>.cfg key="value" lines.
export function parseUnraidShareCfg(text) {
	const raw = {}
	for (const line of String(text ?? '').split('\n')) {
		const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
		if (m) raw[m[1]] = m[2].trim()
	}
	return {
		comment: raw.shareComment || '',
		export: raw.shareExport || '',
		security: raw.shareSecurity || '',
		useCache: raw.shareUseCache || '',
		splitLevel: raw.shareSplitLevel || '',
	}
}

function normalizeImageKey(image) {
	const noDigest = String(image ?? '').trim().toLowerCase().split('@')[0]
	const lastSlash = noDigest.lastIndexOf('/')
	const colon = noDigest.indexOf(':', lastSlash + 1)
	const repo = colon >= 0 ? noDigest.slice(0, colon) : noDigest
	const stripped = repo.replace(/^(?:docker\.io\/|registry-1\.docker\.io\/|ghcr\.io\/|lscr\.io\/|quay\.io\/)/, '').replace(/^library\//, '')
	const tail = stripped.includes('/') ? stripped.slice(stripped.lastIndexOf('/') + 1) : stripped
	return {repo, stripped, tail}
}

// Match a Docker image against the Omarchy App Store registry to offer official-app adoption info.
export function matchStoreApp(image, registries) {
	if (!image || !Array.isArray(registries)) return null
	const target = normalizeImageKey(image)
	if (!target.tail) return null
	let fallback = null
	for (const reg of registries) {
		for (const app of reg?.apps ?? []) {
			if (!app?.id || String(app.id).startsWith('unraid-')) continue
			const id = String(app.id).toLowerCase()
			const candidates = [app.image, app.dockerImage].filter(Boolean).map(normalizeImageKey)
			for (const c of candidates) {
				if (c.repo === target.repo || c.stripped === target.stripped) {
					return {id: app.id, name: app.name || app.id, icon: app.icon || null}
				}
			}
			// Common image tail match (e.g. linuxserver/plex -> plex, immich-server -> immich, jellyfin -> jellyfin)
			const normalizedTail = target.tail.replace(/^(?:pms-docker|docker-)/, '').replace(/-(?:server|app|docker|ce)$/, '')
			if (!fallback && (id === target.tail || id === normalizedTail || (normalizedTail.length >= 4 && id === slug(normalizedTail)))) {
				fallback = {id: app.id, name: app.name || app.id, icon: app.icon || null}
			}
		}
	}
	return fallback
}

// Settings Compose here does not carry. One short note each, and only when the value is not Docker’s own default.
function noteDroppedContainerSettings(hc, notes, {preserveSettings = false} = {}) {
	const requests = Array.isArray(hc.DeviceRequests) ? hc.DeviceRequests : []
	const isNvidiaReq = requests.some((d) => /nvidia/i.test(String(d?.Driver ?? '')) || (Array.isArray(d?.Capabilities) ? d.Capabilities.flat(2) : []).some((cap) => String(cap).toLowerCase() === 'gpu'))
	if (requests.length && !(preserveSettings && isNvidiaReq)) {
		notes.push(isNvidiaReq ? 'The graphics card it asked Docker for isn’t brought over.' : 'Devices it asked Docker for aren’t brought over.')
	}
	const runtime = String(hc.Runtime ?? '')
	const isNvidiaRuntime = /nvidia/i.test(runtime)
	if (runtime && !/^runc$/i.test(runtime) && runtime !== 'io.containerd.runc.v2' && !(preserveSettings && isNvidiaRuntime)) {
		notes.push(isNvidiaRuntime ? 'It used NVIDIA’s runtime. That isn’t brought over.' : `It used the ${runtime} runtime. That isn’t brought over.`)
	}
	const sysctls = hc.Sysctls && typeof hc.Sysctls === 'object' ? Object.keys(hc.Sysctls) : []
	if (sysctls.length) notes.push(`Kernel settings it had (${sysctls.join(', ')}) aren’t brought over.`)
	if (!preserveSettings) {
		if (typeof hc.ShmSize === 'number' && hc.ShmSize > 0 && hc.ShmSize !== 64 * 1024 * 1024) notes.push(`Its shared memory (${byteSize(hc.ShmSize)}) isn’t brought over.`)
		if (Array.isArray(hc.Dns) && hc.Dns.length) notes.push(`DNS servers it used (${hc.Dns.join(', ')}) aren’t brought over.`)
		if (Array.isArray(hc.ExtraHosts) && hc.ExtraHosts.length) notes.push(`Extra host names it had (${hc.ExtraHosts.join(', ')}) aren’t brought over.`)
		if (typeof hc.Memory === 'number' && hc.Memory > 0) notes.push(`Its memory limit (${byteSize(hc.Memory)}) isn’t brought over.`)
		if (typeof hc.CpusetCpus === 'string' && hc.CpusetCpus) notes.push(`It was pinned to CPUs (${hc.CpusetCpus}). That isn’t brought over.`)
		const tmpfs = hc.Tmpfs && typeof hc.Tmpfs === 'object' ? Object.keys(hc.Tmpfs) : []
		if (tmpfs.length) notes.push(`Temporary folders it had in memory (${tmpfs.join(', ')}) aren’t brought over.`)
	}
	if (Array.isArray(hc.SecurityOpt) && hc.SecurityOpt.length) notes.push(`Security options it had (${hc.SecurityOpt.join(', ')}) aren’t brought over.`)
}

export function containerPlan(c, {imageEnv = [], imageCmd = null, imageEntrypoint, shareDest = () => null, takenIds = new Set(), appdataFiles = new Set(), peers = null, preserveSettings = false, portOverride = null} = {}) {
	const name = String(c?.Name ?? '').replace(/^\//, '')
	let id = `unraid-${slug(name)}`
	for (let n = 2; takenIds.has(id); n++) id = `unraid-${slug(name).slice(0, 44)}-${n}`
	const notes = []
	const problems = []
	const image = String(c?.Config?.Image ?? '')
	if (!image) problems.push('It has no image')
	const defaults = new Set(imageEnv)
	const env = {}
	for (const kv of c?.Config?.Env ?? []) {
		if (defaults.has(kv)) continue
		const i = kv.indexOf('=')
		if (i < 1) continue
		const k = kv.slice(0, i)
		const v = kv.slice(i + 1)
		if (k === 'PATH' || k === 'HOST_OS' || k === 'HOST_HOSTNAME' || k === 'HOST_CONTAINERNAME') continue
		// Unraid runs apps as nobody:users (99:100); here they run as the app user Omarchy Server sets.
		if (k === 'PUID' || k === 'PGID') env[k] = `\${${k}}`
		else env[k] = escapeCompose(v)
	}
	const hc = c?.HostConfig ?? {}
	if (hc.Privileged) notes.push('It ran with full access to the Unraid server (privileged). It’s brought over without that.')
	const rawDevices = Array.isArray(hc.Devices) ? hc.Devices : []
	const driDevices = preserveSettings ? rawDevices.filter((d) => /^\/dev\/dri(?:\/[A-Za-z0-9_-]+)?$/.test(String(d?.PathOnHost ?? ''))) : []
	const droppedDevices = preserveSettings ? rawDevices.filter((d) => !driDevices.includes(d)) : rawDevices
	if (droppedDevices.length) notes.push(`Hardware it used (${droppedDevices.map((d) => d.PathOnHost).join(', ')}) isn’t brought over.`)
	if ((hc.CapAdd ?? []).length) notes.push(`Extra permissions it had (${hc.CapAdd.join(', ')}) aren’t brought over.`)
	noteDroppedContainerSettings(hc, notes, {preserveSettings})

	// Ports: what Unraid published, or (own IP / host network) the ports the image exposes.
	const ports = []
	const bindings = hc.PortBindings ?? {}
	for (const [key, list] of Object.entries(bindings)) {
		const [cport, proto = 'tcp'] = key.split('/')
		for (const b of list ?? []) if (b?.HostPort) ports.push({host: Number(b.HostPort), container: Number(cport), proto})
	}
	const mode = String(hc.NetworkMode ?? 'bridge')
	const containerNet = /^container:(.+)$/.exec(mode)
	const networkParent = containerNet ? peerLabel(containerNet[1], peers) : null
	if (containerNet) notes.push(`Traffic through another container (${networkParent}) isn’t brought over.`)
	const customNetworks = Object.keys(c?.NetworkSettings?.Networks ?? {}).filter((n) => n && !['bridge', 'host', 'none'].includes(n))
	const composeProject = c?.Config?.Labels?.['com.docker.compose.project'] || null
	if (!ports.length && mode !== 'none') {
		for (const key of Object.keys(c?.Config?.ExposedPorts ?? {})) {
			const [cport, proto = 'tcp'] = key.split('/')
			ports.push({host: Number(cport), container: Number(cport), proto})
		}
		if (mode !== 'bridge' && ports.length) notes.push(`On Unraid it had its own network setting (${mode}). Here it’s reached at this server’s address.`)
	}
	const label = c?.Config?.Labels?.['net.unraid.docker.webui']
	const ui = webuiPort(label)
	const webPort = ui?.port ?? ports.find((p) => p.proto === 'tcp')?.container ?? null
	const webBinding = webPort ? ports.find((p) => p.container === webPort && p.proto === 'tcp') : null
	let publicPort = webBinding?.host ?? webPort ?? null
	if (publicPort && publicPort < 1024) publicPort = 10_000 + publicPort
	if (Number.isInteger(portOverride) && portOverride >= 1024 && portOverride <= 65535 && webPort) publicPort = portOverride
	const service = slug(name)
	const extra = ports.filter((p) => p !== webBinding)
	const lowDropped = extra.filter((p) => p.host < 1024)
	if (lowDropped.length) notes.push(`Ports below 1024 (${lowDropped.map((p) => p.host).join(', ')}) aren’t opened.`)
	const kept = extra.filter((p) => p.host >= 1024 && p.host !== 22)

	// Folders & named volumes.
	const volumes = []
	const copies = []
	const namedVolumes = []
	const shares = new Set()
	for (const m of c?.Mounts ?? []) {
		if (m.Type === 'volume') {
			const volName = String(m.Name || slug(m.Destination || 'vol'))
			const src = String(m.Source ?? '')
			const ro = m.RW === false ? ':ro' : ''
			const dst = escapeCompose(m.Destination)
			const rel = `_volumes/${slug(volName)}`
			namedVolumes.push({name: volName, from: src, to: rel, dest: m.Destination, ro: m.RW === false})
			if (preserveSettings && src && src.startsWith('/')) {
				copies.push({from: src, to: rel, volume: true})
				volumes.push(`\${APP_DATA_DIR:-.}/data/${escapeCompose(rel)}:${dst}${ro}`)
			} else {
				notes.push(`Its Docker volume for ${m.Destination} starts empty here.`)
			}
			continue
		}
		if (m.Type !== 'bind') continue
		const ro = m.RW === false ? ':ro' : ''
		const src = String(m.Source ?? '')
		const dst = escapeCompose(m.Destination)
		if (src === '/etc/localtime') {
			volumes.push(`/etc/localtime:${dst}:ro`)
			continue
		}
		if (src === '/var/run/docker.sock' || src === '/run/docker.sock') {
			volumes.push(`/var/run/docker.sock:${dst}${ro}`)
			notes.push('It manages containers. Here it gets your own (rootless) container engine, not a root one.')
			continue
		}
		const where = unraidPath(src)
		if (where.kind === 'appdata') {
			const rel = where.rest.replace(/\/+$/, '') || 'appdata'
			copies.push({from: src, to: rel, ...(appdataFiles.has(src) ? {file: true} : {})})
			volumes.push(`\${APP_DATA_DIR:-.}/data/${escapeCompose(rel)}:${dst}${ro}`)
		} else if (where.kind === 'share') {
			shares.add(where.share)
			const dest = shareDest(where.share)
			if (dest) volumes.push(`${escapeCompose(join(dest, where.rest))}:${dst}${ro}`)
			else {
				volumes.push(`\${APP_DATA_DIR:-.}/data/shares/${slug(where.share)}${where.rest ? `/${escapeCompose(where.rest)}` : ''}:${dst}${ro}`)
				notes.push(`It uses the ${where.share} share. Bring that share over too, or it starts with an empty folder there.`)
			}
		} else if (src.startsWith('/tmp')) {
			continue
		} else {
			notes.push(`It used ${src} on Unraid, which isn’t brought over.`)
		}
	}
	const svc = {image, restart: 'unless-stopped'}
	if (Object.keys(env).length) svc.environment = env
	const user = String(c?.Config?.User ?? '')
	if (/^(99|nobody)(:(100|users))?$/.test(user)) svc.user = '${PUID}:${PGID}'
	else if (user) svc.user = escapeCompose(user)
	const cmd = c?.Config?.Cmd
	if (Array.isArray(cmd) && cmd.length && JSON.stringify(cmd) !== JSON.stringify(imageCmd)) svc.command = cmd.map(escapeCompose)
	const entry = asList(c?.Config?.Entrypoint)
	if (entry.length && (imageEntrypoint === undefined || JSON.stringify(asList(imageEntrypoint)) !== JSON.stringify(entry))) {
		if (preserveSettings) svc.entrypoint = entry.map(escapeCompose)
		else notes.push(`It starts with its own command (${entry.join(' ').slice(0, 80)}). That isn’t brought over.`)
	}
	if (preserveSettings) {
		if (typeof hc.ShmSize === 'number' && hc.ShmSize > 0 && hc.ShmSize !== 64 * 1024 * 1024) svc.shm_size = composeByteSize(hc.ShmSize)
		if (Array.isArray(hc.Dns) && hc.Dns.length) svc.dns = hc.Dns.map(String)
		if (Array.isArray(hc.ExtraHosts) && hc.ExtraHosts.length) svc.extra_hosts = hc.ExtraHosts.map(escapeCompose)
		if (typeof hc.Memory === 'number' && hc.Memory > 0) svc.mem_limit = composeByteSize(hc.Memory)
		if (typeof hc.CpusetCpus === 'string' && hc.CpusetCpus) svc.cpuset = hc.CpusetCpus
		if (hc.Tmpfs && typeof hc.Tmpfs === 'object' && Object.keys(hc.Tmpfs).length) {
			svc.tmpfs = Object.entries(hc.Tmpfs).map(([p, o]) => (o ? `${p}:${o}` : p))
		}
		if (driDevices.length) svc.devices = driDevices.map((d) => `${d.PathOnHost}:${d.PathInContainer || d.PathOnHost}`)
		const requests = Array.isArray(hc.DeviceRequests) ? hc.DeviceRequests : []
		const wantsNvidia =
			/nvidia/i.test(String(hc.Runtime ?? '')) ||
			requests.some((d) => /nvidia/i.test(String(d?.Driver ?? '')) || (Array.isArray(d?.Capabilities) ? d.Capabilities.flat(2) : []).some((cap) => String(cap).toLowerCase() === 'gpu'))
		if (wantsNvidia) {
			svc.deploy = {resources: {reservations: {devices: [{driver: 'nvidia', count: 'all', capabilities: ['gpu']}]}}}
		}
	}
	if (volumes.length) svc.volumes = volumes
	const portLines = []
	if (webBinding || (publicPort && webPort)) portLines.push(`${publicPort}:${webPort}`)
	for (const p of kept) portLines.push(`${p.host}:${p.container}${p.proto === 'udp' ? '/udp' : ''}`)
	if (portLines.length) svc.ports = portLines
	const openPorts = [...new Set(kept.map((p) => p.host))]
	const listing = {
		manifestVersion: 1,
		id,
		name,
		tagline: 'Brought over from Unraid',
		category: 'utilities',
		version: imageVersion(image),
		...(publicPort && webPort ? {port: publicPort, web: {service, port: webPort, ...(ui?.https ? {https: true} : {})}, path: ui?.path ?? ''} : {}),
		...(openPorts.length ? {openPorts} : {}),
		description: `${name}, moved from your Unraid server (${image}).`,
		developer: 'Imported',
		website: '',
	}
	return {
		id,
		name,
		service,
		image,
		running: !!c?.State?.Running,
		icon: c?.Config?.Labels?.['net.unraid.docker.icon'] ?? null,
		web: publicPort && webPort ? {port: publicPort, containerPort: webPort, path: ui?.path ?? '', ...(ui?.https ? {https: true} : {})} : null,
		openPorts,
		networkMode: mode,
		networkParent,
		customNetworks,
		composeProject,
		namedVolumes,
		copies,
		shares: [...shares],
		notes,
		problems,
		files: {'omarchy-app.yml': YAML.stringify(listing), 'docker-compose.yml': YAML.stringify({services: {[service]: svc}})},
	}
}

// Detect VPN (container:<parent>) and Compose/shared-network stacks among scanned containers.
export function detectContainerStacks(containers) {
	const byName = new Map(containers.map((c) => [c.name, c]))
	const stacks = []
	const claimed = new Set()
	const usedIds = new Set()
	const uniqueStackId = (base) => {
		let id = `unraid-stack-${slug(base).slice(0, 34)}`
		for (let n = 2; usedIds.has(id); n++) id = `unraid-stack-${slug(base).slice(0, 30)}-${n}`
		usedIds.add(id)
		return id
	}

	// 1. VPN / sidecar stacks: parent + all containers using network_mode: container:<parent>
	const vpnChildren = new Map()
	for (const c of containers) {
		if (!c.networkParent || !byName.has(c.networkParent)) continue
		const list = vpnChildren.get(c.networkParent) ?? []
		list.push(c)
		vpnChildren.set(c.networkParent, list)
	}
	for (const [parentName, kids] of vpnChildren) {
		const parent = byName.get(parentName)
		if (!parent) continue
		const members = [parent, ...kids]
		for (const m of members) claimed.add(m.id)
		stacks.push({
			id: uniqueStackId(`vpn-${parent.name}`),
			name: `${parent.name} stack`,
			kind: 'vpn',
			parent: parent.name,
			members: members.map((m) => m.id),
			memberNames: members.map((m) => m.name),
		})
	}

	// 2. Docker Compose project groups
	const byProject = new Map()
	for (const c of containers) {
		if (claimed.has(c.id) || !c.composeProject) continue
		const list = byProject.get(c.composeProject) ?? []
		list.push(c)
		byProject.set(c.composeProject, list)
	}
	for (const [proj, members] of byProject) {
		if (members.length < 2) continue
		for (const m of members) claimed.add(m.id)
		stacks.push({
			id: uniqueStackId(`compose-${proj}`),
			name: `${proj} stack`,
			kind: 'compose',
			members: members.map((m) => m.id),
			memberNames: members.map((m) => m.name),
		})
	}

	// 3. Shared custom bridge networks (e.g. Immich/Paperless + Postgres + Redis)
	const byNet = new Map()
	for (const c of containers) {
		if (claimed.has(c.id) || !c.customNetworks?.length) continue
		const netName = c.customNetworks[0]
		const list = byNet.get(netName) ?? []
		list.push(c)
		byNet.set(netName, list)
	}
	for (const [netName, members] of byNet) {
		if (members.length < 2) continue
		for (const m of members) claimed.add(m.id)
		stacks.push({
			id: uniqueStackId(`net-${netName}`),
			name: `${netName} network stack`,
			kind: 'network',
			network: netName,
			members: members.map((m) => m.id),
			memberNames: members.map((m) => m.name),
		})
	}
	return stacks
}

// Merge multiple containerPlans into a single multi-service Compose stack (wiring VPN service:<parent>
// and shared inter-container DNS, prefixing each member's data paths so copies never collide).
export function mergeContainerStack(memberPlans, {stackId, stackName} = {}) {
	if (!memberPlans.length) throw new Error('Stack has no containers')
	const id = stackId || `unraid-stack-${slug(stackName || memberPlans[0].name)}`
	const name = stackName || `${memberPlans[0].name} stack`
	const services = {}
	const serviceByName = new Map()
	const copies = []
	const shares = new Set()
	const notes = []
	const openPorts = new Set()
	let primaryWeb = null
	let primaryIcon = null

	// Assign unique Compose service names per member
	for (const p of memberPlans) {
		let sname = slug(p.name)
		for (let n = 2; services[sname]; n++) sname = `${slug(p.name)}-${n}`
		serviceByName.set(p.name, sname)
		const parsed = YAML.parse(p.files['docker-compose.yml'])
		const svc = Object.values(parsed.services ?? {})[0]
		// Prefix per-service appdata/volume paths under data/<sname>/ to avoid collisions across services
		if (Array.isArray(svc.volumes)) {
			svc.volumes = svc.volumes.map((v) =>
				String(v).replace(/^\$\{APP_DATA_DIR:-\.\}\/data\/(?!shares\/)/, `\${APP_DATA_DIR:-.}/data/${sname}/`),
			)
		}
		for (const cp of p.copies ?? []) copies.push({...cp, to: `${sname}/${cp.to}`})
		for (const sh of p.shares ?? []) shares.add(sh)
		if (!primaryWeb && p.web) primaryWeb = {service: sname, port: p.web.containerPort || p.web.port, publicPort: p.web.port, path: p.web.path ?? '', ...(p.web.https ? {https: true} : {})}
		if (!primaryIcon && p.icon) primaryIcon = p.icon
		for (const op of p.openPorts ?? []) openPorts.add(op)
		services[sname] = svc
	}

	// Wire container:<parent> dependencies -> network_mode: service:<parentService>, hoisting ports onto parent.
	// For non-sidecar members, preserve original container names as Compose default-network DNS aliases.
	for (const p of memberPlans) {
		const sname = serviceByName.get(p.name)
		const svc = services[sname]
		if (p.networkParent && serviceByName.has(p.networkParent)) {
			const parentSvcName = serviceByName.get(p.networkParent)
			svc.network_mode = `service:${parentSvcName}`
			svc.depends_on = [...new Set([...(svc.depends_on ?? []), parentSvcName])]
			if (Array.isArray(svc.ports) && svc.ports.length) {
				services[parentSvcName].ports = [...new Set([...(services[parentSvcName].ports ?? []), ...svc.ports])]
				delete svc.ports
			}
			if (primaryWeb?.service === sname) primaryWeb.service = parentSvcName
			for (const note of p.notes ?? []) {
				if (!note.includes(`Traffic through another container (${p.networkParent})`)) notes.push(`${p.name}: ${note}`)
			}
		} else {
			if (p.name && p.name !== sname) {
				svc.networks = {default: {aliases: [p.name]}}
			}
			for (const note of p.notes ?? []) notes.push(`${p.name}: ${note}`)
		}
	}

	const listing = {
		manifestVersion: 1,
		id,
		name,
		tagline: `Stack of ${memberPlans.length} containers from Unraid`,
		category: 'utilities',
		version: 'stack',
		...(primaryWeb ? {port: primaryWeb.publicPort, web: {service: primaryWeb.service, port: primaryWeb.port, ...(primaryWeb.https ? {https: true} : {})}, path: primaryWeb.path ?? ''} : {}),
		...(openPorts.size ? {openPorts: [...openPorts]} : {}),
		description: `Combined stack (${memberPlans.map((p) => p.name).join(', ')}) moved from your Unraid server.`,
		developer: 'Imported',
		website: '',
	}
	return {
		id,
		name,
		isStack: true,
		members: memberPlans.map((p) => ({id: p.id, name: p.name, running: p.running})),
		icon: primaryIcon,
		web: primaryWeb ? {port: primaryWeb.publicPort} : null,
		copies,
		shares: [...shares],
		notes,
		files: {'omarchy-app.yml': YAML.stringify(listing), 'docker-compose.yml': YAML.stringify({services})},
	}
}

const XML_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}
function unescapeXml(s) {
	return String(s).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, named) => {
		if (named) return XML_ENTITIES[named]
		const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16)
		return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m
	})
}

// virsh dumpxml → what's needed to make a machine here.
export function vmPlan(xml, state = '', cpuCount = os.cpus().length) {
	const text = String(xml)
	const nameMatch = /<name>([^<]+)<\/name>/.exec(text)
	const name = nameMatch ? unescapeXml(nameMatch[1]) : 'VM'
	const memKiB = Number(/<memory[^>]*unit=['"]KiB['"][^>]*>(\d+)</.exec(text)?.[1] ?? /<memory[^>]*>(\d+)</.exec(text)?.[1] ?? 0)
	const cores = Number(/<vcpu[^>]*>(\d+)</.exec(text)?.[1] ?? 1)
	const firmware = /<loader[^>]*>[^<]*(?:OVMF|ovmf|edk2)[^<]*<\/loader>/.test(text) || /firmware=['"]efi['"]/.test(text) ? 'efi' : 'bios'
	const machineType = /machine=['"][^'"]*q35[^'"]*['"]/.test(text) ? 'q35' : 'pc'
	const nvramMatch = /<nvram\b[^>]*>([^<]+)<\/nvram>/i.exec(text)
	const nvram = nvramMatch ? unescapeXml(nvramMatch[1].trim()) : null
	const hasTpm = /<tpm\b/i.test(text)
	const disks = []
	const notes = []
	for (const m of text.matchAll(/<disk\s+type=['"](\w+)['"]\s+device=['"](\w+)['"][^>]*>([\s\S]*?)<\/disk>/g)) {
		const [, type, device, body] = m
		if (device !== 'disk') continue
		const srcMatch = /<source\b[^>]*?\s(?:file|dev)=(?:'([^']+)'|"([^"]+)")/.exec(body)
		const rawFile = srcMatch ? (srcMatch[1] ?? srcMatch[2]) : undefined
		const file = rawFile ? unescapeXml(rawFile) : undefined
		const bus = /<target[^>]*bus=['"](\w+)['"]/.exec(body)?.[1] ?? 'sata'
		const format = /<driver[^>]*type=['"](\w+)['"]/.exec(body)?.[1] ?? 'raw'
		if (type !== 'file' || !file) {
			notes.push(`A whole drive passed to it (${file ?? type}) isn’t brought over.`)
			continue
		}
		disks.push({file, bus, format: format === 'qcow2' ? 'qcow2' : 'raw'})
	}
	if (/<hostdev\b/.test(text)) notes.push('Hardware passed through to it (a graphics card or USB device) isn’t brought over.')
	if (hasTpm) notes.push('Its TPM isn’t brought over.')
	if (/<nvram\b/i.test(text)) notes.push('Its saved firmware settings (NVRAM) aren’t brought over.')
	if (/<cputune\b/i.test(text) || /<vcpupin\b/i.test(text)) notes.push('CPU pinning it had isn’t brought over.')
	// importVm caps cores at the server’s CPU count. Say so here; the machine import itself is unchanged.
	const cpuLimit = cpuCount > 0 ? cpuCount : os.cpus().length || 1
	if (cores > cpuLimit) notes.push(`It has ${cores} CPU cores. This server has ${cpuLimit}, so it comes over with ${cpuLimit}.`)
	const nicModel = /<interface[\s\S]*?<model\s+type=['"]([\w-]+)['"]/.exec(text)?.[1] ?? 'virtio'
	return {
		name,
		state,
		cores: Math.max(1, cores),
		memoryMb: Math.max(256, Math.round(memKiB / 1024)),
		firmware,
		machineType,
		nic: /^e1000/.test(nicModel) ? 'e1000e' : 'virtio',
		nvram,
		hasTpm,
		disks,
		notes,
		problems: disks.length ? [] : ['It has no disk image to copy'],
	}
}

// rsync --info=progress2: "  1,234,567  45%   10.00MB/s    0:01:23 (xfr#…)"
export function rsyncProgress(line) {
	const m = /^\s*([\d,]+)\s+(\d{1,3})%/.exec(String(line))
	return m ? {bytes: Number(m[1].replace(/,/g, '')), percent: Number(m[2]) / 100} : null
}

async function verifyIconUrl(iconUrl, {fetchImpl = fetch, checkUrl = checkPushEndpoint} = {}) {
	const raw = String(iconUrl ?? '').trim()
	if (!raw || !raw.startsWith('https://')) return null
	const safe = await checkUrl(raw).catch(() => ({ok: false}))
	if (!safe.ok) return null
	try {
		const res = await fetchImpl(raw, {method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000)})
		if (!res.ok) {
			await res.body?.cancel?.().catch(() => {})
			return null
		}
		const ct = (res.headers.get('content-type') ?? '').toLowerCase()
		const validType = ct.includes('png') || ct.includes('svg') || ct.includes('webp') || ct.includes('jpeg') || ct.includes('jpg') || ct.includes('x-icon') || ct.includes('vnd.microsoft.icon')
		const lenHeader = Number(res.headers.get('content-length'))
		await res.body?.cancel?.().catch(() => {})
		if (!validType || (Number.isFinite(lenHeader) && lenHeader > 512 * 1024)) return null
		return raw
	} catch {
		return null
	}
}

export function createUnraid({dataDir, files, apps, machines, storage, run = defaultSpawn, now = () => Date.now(), user = 'root', runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir(), fetchImpl = fetch, checkIconUrl = checkPushEndpoint}) {
	const dir = join(dataDir, 'unraid')
	const knownHosts = join(dir, 'known_hosts')
	const askpass = join(dir, 'askpass.sh')
	const stagingDir = join(dir, 'staging')
	const jobFile = join(dir, 'job.json')
	// A short path: a UNIX socket's name can't be long.
	const controlPath = join(runtimeDir, `omarchy-unraid-${process.getuid?.() ?? 0}-%C`)
	let session = null // {host, port, authMode, password, keyFile, version, fingerprint, scannedAt, scan, rawInspect, rawByImage, rawAppdataFiles, rawPeers}
	let job = null
	let starting = false // set for the gap before job is assigned, so a second start cannot pass the check
	let idle = null
	const importedVms = new Map() // vmName -> machineId

	const ready = (async () => {
		await mkdir(dir, {recursive: true, mode: 0o700})
		// Clean up any leftover temp SSH private keys from a prior crash/restart.
		for (const f of await readdir(dir).catch(() => [])) {
			if (/^key-[0-9a-f]{16}$/.test(f)) await rm(join(dir, f), {force: true}).catch(() => {})
		}
		await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$OMARCHY_UNRAID_SECRET"\n', {mode: 0o700})
		await chmod(askpass, 0o700)
		// A missing file is no previous job. Empty, truncated, or non-object JSON stays on disk;
		// rewriting it here would destroy the only copy. The log names the file, never its path or contents.
		const text = await readFile(jobFile, 'utf8').catch(() => null)
		if (text !== null) {
			let parsed = null
			try {
				parsed = JSON.parse(text)
			} catch {
				/* not JSON */
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) console.error('[omarchyd] job.json is empty or invalid and was left unchanged')
			else {
				job = parsed
				for (const item of job.items ?? []) {
					if (item?.kind === 'vm' && item.status === 'done' && item.machineId) importedVms.set(item.key || item.name, item.machineId)
				}
				if (!job.endedAt) {
					const paused = typeof job.paused === 'string' && job.paused ? job.paused : null
					const pausedSet = new Set(paused ? paused.split(', ').map((s) => s.trim()).filter(Boolean) : [])
					const stopped = paused
						? `The server restarted while ${paused} was paused on Unraid. Start ${paused} on Unraid, then choose Done and connect again to pick up where it left off.`
						: 'The server restarted. Choose Done, then connect again to pick up where it left off.'
					Object.assign(job, {endedAt: now(), stopped})
					if (Array.isArray(job.items)) {
						for (const item of job.items) {
							if (item?.status === 'running') {
								item.status = 'failed'
								const wasPaused = paused && (pausedSet.has(item.name) || (Array.isArray(item.stackMembers) && item.stackMembers.some((m) => pausedSet.has(m))))
								item.error = wasPaused ? `Stopped when the server restarted. Start ${paused} on Unraid.` : 'Stopped when the server restarted'
								delete item.step
							} else if (item?.status === 'waiting') {
								item.status = 'skipped'
								delete item.step
							}
						}
					}
				}
			}
		}
	})()
	const saveJob = (record = job) => writeAtomic(jobFile, JSON.stringify(record, null, '\t'), {mode: 0o600})

	function vmInstalled(name) {
		if (machines?.importedVm?.(name)) return true
		const id = importedVms.get(name)
		if (!id) return false
		const st = machines?.importState?.(id)
		if (st && st.error === 'It was removed') {
			importedVms.delete(name)
			return false
		}
		return true
	}

	function baseEnv() {
		const env = {LC_ALL: 'C'}
		for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]
		return env
	}
	const sshOpts = (first) => {
		const common = [
			'-o', `ControlPath=${controlPath}`,
			'-o', 'ControlMaster=auto',
			'-o', 'ControlPersist=20m',
			'-o', `UserKnownHostsFile=${knownHosts}`,
			'-o', `StrictHostKeyChecking=${first ? 'accept-new' : 'yes'}`,
			'-o', 'ConnectTimeout=15',
			'-o', 'ServerAliveInterval=30',
			'-p', String(session.port),
			'-l', user,
		]
		if (session.authMode === 'key' && session.keyFile) {
			return [
				...common,
				'-i', session.keyFile,
				'-o', 'IdentitiesOnly=yes',
				'-o', 'PreferredAuthentications=publickey',
				'-o', 'PubkeyAuthentication=yes',
				'-o', 'PasswordAuthentication=no',
				...(session.password ? [] : ['-o', 'BatchMode=yes']),
			]
		}
		if (session.authMode === 'hostKey') {
			return [
				...common,
				'-o', 'PreferredAuthentications=publickey',
				'-o', 'PubkeyAuthentication=yes',
				'-o', 'PasswordAuthentication=no',
				'-o', 'BatchMode=yes',
			]
		}
		return [
			...common,
			'-o', 'PreferredAuthentications=password,keyboard-interactive',
			'-o', 'PubkeyAuthentication=no',
			'-o', 'NumberOfPasswordPrompts=1',
		]
	}
	const sshEnv = () => (session?.password ? {...baseEnv(), SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', OMARCHY_UNRAID_SECRET: session.password} : baseEnv())
	function touch() {
		clearTimeout(idle)
		// Forget the password/key when nothing has happened for a while. rsync never calls remote, so a running import arms the next window instead of dropping it.
		idle = setTimeout(() => {
			if (job && !job.endedAt) touch()
			else forget()
		}, 2 * 60 * 60_000)
		idle.unref?.()
	}
	function forget() {
		if (!session) return Promise.resolve()
		const old = session
		session = null
		run('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', '-p', String(old.port), '-l', user, old.host], {env: baseEnv(), timeout: 10_000}).catch(() => {})
		return old.keyFile ? rm(old.keyFile, {force: true}).catch(() => {}) : Promise.resolve()
	}
	async function remote(command, {timeout = 120_000, first = false} = {}) {
		if (!session) throw new RpcError('PRECONDITION_FAILED', 'Connect to your Unraid server first')
		touch()
		try {
			const {stdout} = await run('ssh', [...sshOpts(first), session.host, command], {env: sshEnv(), timeout})
			return stdout
		} catch (e) {
			const msg = String(e.message)
			if (e.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'This server needs ssh. Run Omarchy Server’s installer once more.')
			if (/Permission denied|Authentication failed/i.test(msg)) {
				throw new RpcError(
					'FORBIDDEN',
					session?.authMode === 'password'
						? 'Unraid didn’t accept that password (it’s the root password, the one you sign in to Unraid’s web page with).'
						: 'Unraid didn’t accept that SSH key. Make sure its public key is in /root/.ssh/authorized_keys on Unraid.',
				)
			}
			if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) throw new RpcError('FORBIDDEN', 'That server isn’t the one you connected to before (its key changed). If you reinstalled Unraid, choose Forget this server’s key and connect again.')
			if (/Connection refused/i.test(msg)) throw new RpcError('PRECONDITION_FAILED', 'Unraid isn’t accepting SSH. Turn it on in Unraid: Settings › Management Access › Use SSH.')
			if (/timed out|No route|Could not resolve|Name or service not known/i.test(msg)) throw new RpcError('PRECONDITION_FAILED', 'Couldn’t reach that server. Check its name or address, and that it’s on.')
			throw new RpcError('INTERNAL_SERVER_ERROR', msg.replace(/^ssh: /, '').slice(0, 300))
		}
	}

	function parseHostPort(input = {}) {
		let host = String(input.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
		let port = 22
		const hp = /^(.+):(\d{1,5})$/.exec(host)
		if (hp) [host, port] = [hp[1], Number(hp[2])]
		if (input.port !== undefined && input.port !== null && input.port !== '') port = Number(input.port)
		return {host, port}
	}

	// ---- connect and look around ---------------------------------------------------------------
	async function connect(input = {}) {
		await ready
		if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is running')
		const {host, port} = parseHostPort(input)
		if (!HOST.test(host) || !Number.isInteger(port) || !(port > 0 && port < 65536)) throw new RpcError('BAD_REQUEST', 'Enter your Unraid server’s name or address, like tower.local or 192.168.1.10')
		const privateKey = typeof input.privateKey === 'string' ? input.privateKey.trim() : ''
		const authMode = input.authMode === 'hostKey' || input.useHostKey === true ? 'hostKey' : input.authMode === 'key' || privateKey ? 'key' : 'password'
		let password = ''
		let keyFile = null
		if (authMode === 'password') {
			password = String(input.password ?? '')
			if (!password || /[\r\n]/.test(password) || password.length > 512) throw new RpcError('BAD_REQUEST', 'Enter Unraid’s root password')
		} else if (authMode === 'key') {
			if (!privateKey || privateKey.length > 32_768 || !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) {
				throw new RpcError('BAD_REQUEST', 'Paste a valid OpenSSH or PEM private key')
			}
			const pass = String(input.passphrase ?? '')
			if (/[\r\n]/.test(pass) || pass.length > 512) throw new RpcError('BAD_REQUEST', 'Invalid key passphrase')
			password = pass
			keyFile = join(dir, `key-${randomBytes(8).toString('hex')}`)
			await writeFile(keyFile, `${privateKey}\n`, {mode: 0o600})
			await chmod(keyFile, 0o600).catch(() => {})
		}
		forget()
		session = {host, port, authMode, password, keyFile}
		try {
			const out = await remote('cat /etc/unraid-version 2>/dev/null; echo; command -v rsync >/dev/null && echo has-rsync; command -v docker >/dev/null && echo has-docker; command -v virsh >/dev/null && echo has-virsh', {first: true, timeout: 40_000})
			const version = /version="?([\w.-]+)"?/.exec(out)?.[1] ?? null
			if (!version) throw new RpcError('PRECONDITION_FAILED', 'That server doesn’t look like Unraid')
			if (!/has-rsync/.test(out)) throw new RpcError('PRECONDITION_FAILED', 'That Unraid server is missing rsync')
			const fp = await run('ssh-keygen', ['-l', '-F', port === 22 ? host : `[${host}]:${port}`, '-f', knownHosts], {env: baseEnv(), timeout: 10_000}).then((r) => /(SHA256:[A-Za-z0-9+/=]+)/.exec(r.stdout)?.[1] ?? null, () => null)
			Object.assign(session, {version, fingerprint: fp, docker: /has-docker/.test(out), virsh: /has-virsh/.test(out)})
			return {host, port, authMode, version, fingerprint: fp}
		} catch (e) {
			forget()
			throw e
		}
	}

	async function forgetHost(input = {}) {
		await ready
		const {host, port} = parseHostPort(input)
		if (!HOST.test(host) || !Number.isInteger(port) || !(port > 0 && port < 65536)) throw new RpcError('BAD_REQUEST', 'Bad host')
		const target = port === 22 ? host : `[${host}]:${port}`
		await run('ssh-keygen', ['-R', target, '-f', knownHosts], {env: baseEnv(), timeout: 10_000}).catch(() => {})
		return true
	}

	async function scan() {
		await ready
		if (!session) throw new RpcError('PRECONDITION_FAILED', 'Connect to your Unraid server first')
		// Shares and their sizes (each size gets a minute; very large ones may show as unknown).
		const sharesOut = await remote(`for d in /mnt/user/*/; do n="\${d%/}"; n="\${n##*/}"; s=$(timeout 60 du -sb "$d" 2>/dev/null | cut -f1); printf '%s\\t%s\\n' "$n" "\${s:-}"; done`, {timeout: 30 * 60_000})
		const shareRows = sharesOut
			.split('\n')
			.map((l) => l.split('\t'))
			.filter(([n]) => n)

		// Best-effort read of Unraid share config metadata (/boot/config/shares/*.cfg)
		const shareCfgs = new Map()
		const cfgOut = await remote(`for f in /boot/config/shares/*.cfg; do [ -f "$f" ] || continue; n="\${f##*/}"; n="\${n%.cfg}"; printf '===SHARE:%s===\\n' "$n"; cat "$f" 2>/dev/null; printf '\\n'; done`, {timeout: 30_000}).catch(() => '')
		for (const block of cfgOut.split(/^===SHARE:/m).slice(1)) {
			const nl = block.indexOf('===\n')
			if (nl < 1) continue
			const sname = block.slice(0, nl).trim()
			if (sname) shareCfgs.set(sname, parseUnraidShareCfg(block.slice(nl + 4)))
		}

		// Names outside SHARE stay listed as skipped. The pattern is unchanged, and start() only copies shares.
		const shares = shareRows
			.filter(([n]) => SHARE.test(n))
			.map(([n, size]) => ({
				name: n,
				size: size ? Number(size) : null,
				kind: n === 'appdata' ? 'appdata' : n === 'system' ? 'system' : n === 'domains' ? 'domains' : n === 'isos' ? 'isos' : 'share',
				...(shareCfgs.has(n) ? {config: shareCfgs.get(n)} : {}),
			}))
		const skippedShares = shareRows.filter(([n]) => !SHARE.test(n)).map(([n]) => n)

		const storeRegistry = (await apps?.procedures?.['appStore.registry']?.run?.().catch(() => [])) ?? []

		let containers = []
		let rawInspect = new Map()
		let rawByImage = new Map()
		let rawAppdataFiles = new Set()
		let rawPeers = new Map()
		if (session.docker) {
			const names = (await remote(`docker ps -a --format '{{.Names}}'`)).split('\n').filter((n) => CONTAINER.test(n))
			if (names.length) {
				const inspect = JSON.parse(await remote(`docker inspect ${names.map(sq).join(' ')}`, {timeout: 120_000}))
				const images = [...new Set(inspect.map((c) => c.Image).filter((i) => /^sha256:[0-9a-f]{64}$/.test(i)))]
				const imageInfo = images.length ? JSON.parse(await remote(`docker image inspect ${images.map(sq).join(' ')}`, {timeout: 120_000})) : []
				rawByImage = new Map(imageInfo.map((i) => [i.Id, i]))
				const appdataSizes = new Map()
				rawAppdataFiles = new Set()
				const appdataPaths = [
					...new Set(
						inspect.flatMap((c) =>
							(c.Mounts ?? [])
								.filter((m) => (m.Type === 'bind' && unraidPath(m.Source).kind === 'appdata') || (m.Type === 'volume' && String(m.Source ?? '').startsWith('/')))
								.map((m) => m.Source),
						),
					),
				]
				if (appdataPaths.length) {
					const out = await remote(`for p in ${appdataPaths.map(sq).join(' ')}; do t=d; [ -f "$p" ] && t=f; printf '%s\\t%s\\t%s\\n' "$p" "$(timeout 60 du -sb "$p" 2>/dev/null | cut -f1)" "$t"; done`, {timeout: 20 * 60_000})
					for (const l of out.split('\n')) {
						const [p, s, t] = l.split('\t')
						if (!p) continue
						const rawSize = (s ?? '').trim()
						appdataSizes.set(p, /^\d+$/.test(rawSize) ? Number(rawSize) : null)
						if (t?.trim() === 'f') rawAppdataFiles.add(p)
					}
				}
				const taken = new Set()
				rawPeers = new Map()
				for (const other of inspect) {
					const id = String(other.Id ?? '')
					const nm = String(other.Name ?? '').replace(/^\//, '')
					if (!nm) continue
					rawPeers.set(nm, nm)
					if (id) {
						rawPeers.set(id, nm)
						if (id.length >= 12) rawPeers.set(id.slice(0, 12), nm)
					}
				}
				containers = inspect.map((c) => {
					const img = rawByImage.get(c.Image)
					const plan = containerPlan(c, {imageEnv: img?.Config?.Env ?? [], imageCmd: img?.Config?.Cmd ?? null, ...(img ? {imageEntrypoint: img.Config?.Entrypoint ?? null} : {}), takenIds: taken, appdataFiles: rawAppdataFiles, peers: rawPeers})
					taken.add(plan.id)
					rawInspect.set(plan.id, c)
					const appdataCopyPaths = plan.copies.map((cp) => cp.from)
					const volPaths = (plan.namedVolumes ?? []).map((v) => v.from).filter(Boolean)
					const size = appdataCopyPaths.some((p) => appdataSizes.get(p) == null)
						? null
						: appdataCopyPaths.reduce((t, p) => t + (appdataSizes.get(p) ?? 0), 0)
					const namedVolumesSize = volPaths.length
						? volPaths.some((p) => appdataSizes.get(p) == null)
							? null
							: volPaths.reduce((t, p) => t + (appdataSizes.get(p) ?? 0), 0)
						: 0
					const storeMatch = matchStoreApp(plan.image, storeRegistry)
					return {...plan, size, namedVolumesSize, installed: apps.installed(plan.id), ...(storeMatch ? {storeMatch} : {})}
				})
			}
		}
		const stacks = detectContainerStacks(containers)

		let vms = []
		let skippedVms = []
		if (session.virsh) {
			const listed = (await remote('virsh list --all --name 2>/dev/null')).split('\n').map((n) => n.trim()).filter(Boolean)
			const names = listed.filter((n) => VM_NAME.test(n))
			skippedVms = listed.filter((n) => !VM_NAME.test(n))
			for (const n of names) {
				const [xml, st] = await Promise.all([remote(`virsh dumpxml ${sq(n)}`), remote(`virsh domstate ${sq(n)}`).catch(() => '')])
				const plan = vmPlan(xml, st.trim())
				const sizes = plan.disks.length ? await remote(`stat -c %s ${plan.disks.map((d) => sq(d.file)).join(' ')}`).catch(() => '') : ''
				vms.push({...plan, size: sizes.split('\n').filter(Boolean).reduce((t, s) => t + Number(s), 0), installed: vmInstalled(plan.name)})
			}
		}

		// Best-effort scan of Unraid User Scripts plugin (/boot/config/plugins/user.scripts/scripts/*)
		const userScripts = []
		const scriptsRaw = await remote(
			`for d in /boot/config/plugins/user.scripts/scripts/*/; do [ -d "$d" ] || continue; id="\${d%/}"; id="\${id##*/}"; nm=$(cat "$d/name" 2>/dev/null || printf '%s' "$id"); desc=$(cat "$d/description" 2>/dev/null); printf '===SCRIPT:%s===\\nNAME:%s\\nDESC:%s\\nBODY:\\n' "$id" "$nm" "$desc"; head -c 2048 "$d/script" 2>/dev/null; printf '\\n'; done`,
			{timeout: 30_000},
		).catch(() => '')
		const scheduleRaw = await remote(`cat /boot/config/plugins/user.scripts/schedule.json 2>/dev/null || true`, {timeout: 10_000}).catch(() => '')
		let scheduleMap = {}
		try {
			const parsed = JSON.parse(scheduleRaw)
			if (parsed && typeof parsed === 'object') scheduleMap = parsed
		} catch {}
		for (const block of scriptsRaw.split(/^===SCRIPT:/m).slice(1)) {
			const endId = block.indexOf('===\n')
			if (endId < 1) continue
			const id = block.slice(0, endId).trim()
			const rest = block.slice(endId + 4)
			const bodyIdx = rest.indexOf('\nBODY:\n')
			const head = bodyIdx >= 0 ? rest.slice(0, bodyIdx) : rest
			const script = bodyIdx >= 0 ? rest.slice(bodyIdx + 7).trim() : ''
			const nm = /^NAME:(.*)$/m.exec(head)?.[1]?.trim() || id
			const desc = /^DESC:(.*)$/m.exec(head)?.[1]?.trim() || ''
			const schedEntry = Object.values(scheduleMap).find((s) => s?.script?.endsWith(`/${id}/script`))
			userScripts.push({id, name: nm, description: desc, schedule: schedEntry?.frequency || '', script})
		}

		session.rawInspect = rawInspect
		session.rawByImage = rawByImage
		session.rawAppdataFiles = rawAppdataFiles
		session.rawPeers = rawPeers
		session.scan = {shares, containers, stacks, vms, userScripts, skippedShares, skippedVms, at: now()}
		return {...session.scan, containers: containers.map(({files: _f, ...c}) => c)}
	}

	// ---- pre-flight checks (space, port conflicts, running VMs, stacks) -------------------------
	async function nearestExistingReal(virtual) {
		const parts = virtual.split('/').filter(Boolean)
		for (let i = parts.length; i >= 1; i--) {
			const candidate = `/${parts.slice(0, i).join('/')}`
			try {
				const r = await files.resolve(candidate, {mustExist: false})
				if (r?.real && (await exists(r.real))) return r.real
			} catch {}
		}
		return null
	}

	async function preflight(input = {}) {
		await ready
		if (!session?.scan) throw new RpcError('PRECONDITION_FAILED', 'Connect and look at your Unraid server first')
		const dest = destRoot(input)
		const want = (list) => new Set(Array.isArray(list) ? list.map(String) : [])
		const sharesWanted = want(input.shares)
		const containersWanted = want(input.containers)
		const vmsWanted = want(input.vms)
		const portOverrides = input.portOverrides && typeof input.portOverrides === 'object' ? input.portOverrides : {}
		const scan = session.scan

		let requiredBytes = 0
		let hasUnknownSize = false
		for (const s of scan.shares) {
			if (!sharesWanted.has(s.name)) continue
			if (s.size == null) hasUnknownSize = true
			else requiredBytes += s.size
		}
		for (const c of scan.containers) {
			if (!containersWanted.has(c.id)) continue
			if (c.size == null) hasUnknownSize = true
			else requiredBytes += c.size
			if (input.preserveSettings === true && c.namedVolumesSize != null) requiredBytes += c.namedVolumesSize
			else if (input.preserveSettings === true && c.namedVolumesSize === null) hasUnknownSize = true
		}
		for (const v of scan.vms) {
			if (!vmsWanted.has(v.name)) continue
			requiredBytes += v.size || 0
		}

		let freeBytes = null
		const realParent = await nearestExistingReal(dest)
		if (realParent) {
			const st = await statfs(realParent).catch(() => null)
			if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') freeBytes = st.bavail * st.bsize
		}
		const headroomBytes = freeBytes != null ? freeBytes - requiredBytes : null
		const spaceOk = freeBytes == null ? true : headroomBytes >= 0
		const spaceWarning =
			freeBytes == null
				? null
				: headroomBytes < 0
					? `Not enough free space on destination (need ${byteSize(requiredBytes)}, have ${byteSize(freeBytes)})`
					: freeBytes > 0 && headroomBytes / freeBytes < 0.1
						? `Low disk headroom after import (${byteSize(headroomBytes)} left)`
						: hasUnknownSize
							? 'Some share or container sizes are unknown; verify free space before starting.'
							: null

		// Collect ports already bound on Omarchy Server
		const existingApps = (await apps?.procedures?.['apps.list']?.run?.().catch(() => [])) ?? []
		const usedPorts = new Map() // port -> owner label
		for (const a of existingApps) {
			if (Number.isInteger(a?.port) && a.port > 0) usedPorts.set(a.port, a.name || a.id)
			for (const op of a?.openPorts ?? []) if (Number.isInteger(op) && op > 0) usedPorts.set(op, a.name || a.id)
		}
		const nextFreePort = (start) => {
			let p = Math.max(1024, start + 1)
			while (usedPorts.has(p) && p < 65535) p++
			return p
		}
		const portConflicts = []
		for (const c of scan.containers) {
			if (!containersWanted.has(c.id)) continue
			const override = Number(portOverrides[c.id])
			const primaryPort = Number.isInteger(override) && override >= 1024 && override <= 65535 ? override : c.web?.port ?? null
			if (primaryPort) {
				if (usedPorts.has(primaryPort)) {
					const suggestedPort = nextFreePort(primaryPort)
					portConflicts.push({containerId: c.id, containerName: c.name, port: primaryPort, conflictWith: usedPorts.get(primaryPort), suggestedPort})
					usedPorts.set(suggestedPort, c.name)
				} else {
					usedPorts.set(primaryPort, c.name)
				}
			}
		}

		const runningVms = scan.vms.filter((v) => vmsWanted.has(v.name) && v.state !== 'shut off').map((v) => ({name: v.name, state: v.state}))
		const activeStacks = (scan.stacks ?? []).filter((st) => st.members.filter((id) => containersWanted.has(id)).length >= 2)

		return {
			ok: spaceOk && portConflicts.length === 0 && (input.shutdownRunningVms === true || runningVms.length === 0),
			requiredBytes,
			freeBytes,
			headroomBytes,
			hasUnknownSize,
			spaceOk,
			spaceWarning,
			portConflicts,
			runningVms,
			activeStacks,
		}
	}

	// ---- the import -----------------------------------------------------------------------------
	// Where shares go: Home › Unraid (or a storage pool's Unraid folder), as Files paths.
	function destRoot(input) {
		const d = String(input?.destination ?? '/Home/Unraid').replace(/\/+$/, '')
		if (!/^\/Home(\/[^/\x00-\x1f"]+){1,6}$/.test(d) || d.split('/').some((p) => p === '..' || p === '.')) throw new RpcError('BAD_REQUEST', 'Choose a folder in Home or on a storage pool')
		return d
	}
	async function realOf(virtual) {
		const parts = virtual.split('/').filter(Boolean)
		for (let i = 2; i <= parts.length; i++) {
			const level = await files.resolve(`/${parts.slice(0, i).join('/')}`, {mustExist: false})
			if (!(await exists(level.real))) await mkdir(level.real, {mode: 0o755})
		}
		return (await files.resolve(virtual)).real
	}

	async function rsync(from, to, onProgress, {file = false, bwlimitMbps = 0, excludes = [], verifyChecksum = false, deleteRemoved = false} = {}) {
		await mkdir(file ? dirname(to) : to, {recursive: true})
		const e = ['ssh', ...sshOpts(false)].map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(' ')
		const src = from.replace(/\/+$/, '')
		const extraArgs = []
		const bw = Number(bwlimitMbps)
		if (Number.isFinite(bw) && bw > 0) extraArgs.push(`--bwlimit=${Math.max(100, Math.round(bw * 1000))}`)
		if (verifyChecksum) extraArgs.push('--checksum')
		if (!file && deleteRemoved) extraArgs.push('--delete')
		if (!file) {
			for (const pat of sanitizeRsyncExcludes(excludes)) extraArgs.push('--exclude', pat)
		}
		const args = file
			? ['-lt', '--partial', '--protect-args', '--info=progress2', ...extraArgs, '-e', e, `${session.host}:${src}`, to]
			: ['-rlt', '-H', '--partial', '--protect-args', '--info=progress2', '--no-inc-recursive', ...extraArgs, '-e', e, `${session.host}:${src}/`, `${to}/`]
		try {
			await run('rsync', args, {
				env: sshEnv(),
				timeout: 7 * 24 * 60 * 60_000,
				split: /[\r\n]/,
				onLine: (l) => {
					const p = rsyncProgress(l)
					if (p) onProgress(p)
				},
			})
		} catch (err) {
			if (err?.code === 24) {
				console.warn('[omarchyd] unraid rsync: some source files vanished while copying (exit 24)')
				return
			}
			if (err.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'This server needs rsync. Run Omarchy Server’s installer once more.')
			throw new RpcError('INTERNAL_SERVER_ERROR', `Copying ${from} didn’t finish: ${String(err.message).replace(/^rsync: /, '').slice(0, 200)}`)
		}
	}

	function rebuildContainerPlan(basePlan, {preserveSettings = false, portOverride = null} = {}) {
		const raw = session?.rawInspect?.get(basePlan.id)
		if (!raw || (!preserveSettings && !portOverride)) return basePlan
		const img = session.rawByImage?.get(raw.Image)
		const rebuilt = containerPlan(raw, {
			imageEnv: img?.Config?.Env ?? [],
			imageCmd: img?.Config?.Cmd ?? null,
			...(img ? {imageEntrypoint: img.Config?.Entrypoint ?? null} : {}),
			appdataFiles: session.rawAppdataFiles ?? new Set(),
			peers: session.rawPeers ?? null,
			preserveSettings,
			portOverride,
		})
		// Keep the original unique id assigned during scan
		if (rebuilt.id !== basePlan.id) {
			rebuilt.id = basePlan.id
			const app = YAML.parse(rebuilt.files['omarchy-app.yml'])
			app.id = basePlan.id
			rebuilt.files['omarchy-app.yml'] = YAML.stringify(app)
		}
		return rebuilt
	}

	async function start(input = {}) {
		if (starting || (job && !job.endedAt)) throw new RpcError('CONFLICT', 'An import is already running')
		starting = true
		let dest
		let shareDest
		let plans
		let vmPlans
		try {
			await ready
			if (!session?.scan) throw new RpcError('PRECONDITION_FAILED', 'Connect and look at your Unraid server first')
			if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is already running')
			dest = destRoot(input)
			const want = (list) => new Set(Array.isArray(list) ? list.map(String) : [])
			const sharesWanted = want(input.shares)
			const containersWanted = want(input.containers)
			const vmsWanted = want(input.vms)
			const preserveSettings = input.preserveSettings === true
			const groupStacks = input.groupStacks === true
			const portOverrides = input.portOverrides && typeof input.portOverrides === 'object' ? input.portOverrides : {}
			const bwlimitMbps = Number(input.bwlimitMbps) > 0 ? Number(input.bwlimitMbps) : 0
			const excludes = sanitizeRsyncExcludes(input.excludes)
			const verifyChecksum = input.verifyChecksum === true
			const shutdownRunningVms = input.shutdownRunningVms === true
			const downloadIcons = input.downloadIcons !== false
			const scan = session.scan
			const items = []
			for (const s of scan.shares) if (sharesWanted.has(s.name) && s.kind !== 'system' && s.kind !== 'appdata') items.push({kind: 'share', key: s.name, name: s.name, size: s.size, status: 'waiting'})
			// Containers' share folders point at where those shares are being copied.
			shareDest = (share) => (sharesWanted.has(share) ? `${dest}/${share}` : null)

			plans = new Map()
			const stackedMemberIds = new Set()
			if (groupStacks) {
				for (const st of scan.stacks ?? []) {
					const selectedMembers = st.members.filter((id) => containersWanted.has(id))
					if (selectedMembers.length < 2) continue
					const memberPlans = selectedMembers
						.map((id) => scan.containers.find((c) => c.id === id))
						.filter(Boolean)
						.map((p) => rebuildContainerPlan(p, {preserveSettings, portOverride: Number(portOverrides[p.id]) || null}))
					if (memberPlans.length < 2) continue
					const merged = mergeContainerStack(memberPlans, {stackId: st.id, stackName: st.name})
					for (const id of selectedMembers) stackedMemberIds.add(id)
					plans.set(merged.id, merged)
					const size = memberPlans.some((p) => p.size == null) ? null : memberPlans.reduce((t, p) => t + (p.size ?? 0), 0)
					items.push({kind: 'container', key: merged.id, name: merged.name, size, status: 'waiting', stackMembers: memberPlans.map((p) => p.name)})
				}
			}
			for (const c of scan.containers) {
				if (!containersWanted.has(c.id) || stackedMemberIds.has(c.id)) continue
				const rebuilt = rebuildContainerPlan(c, {preserveSettings, portOverride: Number(portOverrides[c.id]) || null})
				plans.set(c.id, rebuilt)
				items.push({kind: 'container', key: c.id, name: c.name, size: c.size, status: 'waiting'})
			}
			for (const v of scan.vms) if (vmsWanted.has(v.name)) items.push({kind: 'vm', key: v.name, name: v.name, size: v.size, status: 'waiting'})
			if (!items.length) throw new RpcError('BAD_REQUEST', 'Choose something to bring over')
			const next = {
				id: randomBytes(4).toString('hex'),
				host: session.host,
				startedAt: now(),
				endedAt: null,
				destination: dest,
				shareOnNetwork: input.shareOnNetwork !== false,
				pauseContainers: input.pauseContainers !== false,
				preserveSettings,
				groupStacks,
				bwlimitMbps,
				excludes,
				verifyChecksum,
				shutdownRunningVms,
				downloadIcons,
				items,
				shareDest: Object.fromEntries([...sharesWanted].map((s) => [s, `${dest}/${s}`])),
			}
			await saveJob(next)
			job = next
			vmPlans = new Map(scan.vms.map((v) => [v.name, v]))
		} catch (err) {
			starting = false
			throw err
		}
		starting = false
		touch()
		job.done = (async () => {
			for (const item of job.items) {
				if (job.cancelled) {
					item.status = 'skipped'
					continue
				}
				item.status = 'running'
				item.progress = 0
				await saveJob().catch(() => {})
				try {
					if (item.kind === 'share') await importShare(item, dest)
					else if (item.kind === 'container') await importContainer(item, plans.get(item.key), shareDest)
					else await importVm(item, vmPlans.get(item.key))
					item.status = 'done'
					item.progress = 1
				} catch (e) {
					item.status = 'failed'
					item.error = e.message
				}
				await saveJob().catch(() => {})
			}
			job.endedAt = now()
			touch()
			await saveJob().catch(() => {})
		})()
		return {id: job.id}
	}

	// Incremental delta cutover re-sync for shares & appdata copied in the last job (no re-install).
	async function resync(input = {}) {
		if (starting || (job && !job.endedAt)) throw new RpcError('CONFLICT', 'An import is already running')
		await ready
		if (!session) throw new RpcError('PRECONDITION_FAILED', 'Connect to your Unraid server first')
		if (!job || job.host !== session.host) throw new RpcError('PRECONDITION_FAILED', 'Run an initial move from this Unraid server first')
		const prev = job
		const deleteRemoved = input.deleteRemoved === true
		const bwlimitMbps = Number(input.bwlimitMbps ?? prev.bwlimitMbps) > 0 ? Number(input.bwlimitMbps ?? prev.bwlimitMbps) : 0
		const excludes = sanitizeRsyncExcludes(input.excludes ?? prev.excludes ?? [])
		const verifyChecksum = input.verifyChecksum === true
		const pauseContainers = input.pauseContainers !== undefined ? input.pauseContainers !== false : prev.pauseContainers !== false
		const prevDoneShares = (prev.items ?? []).filter((i) => i.kind === 'share' && i.status === 'done')
		const prevDoneContainers = (prev.items ?? []).filter((i) => i.kind === 'container' && i.status === 'done' && Array.isArray(i.copies) && i.copies.length)
		const items = [
			...prevDoneShares.map((s) => ({kind: 'share', key: s.key, name: s.name, size: s.size, status: 'waiting', path: s.path || `${prev.destination}/${s.key}`})),
			...prevDoneContainers.map((c) => ({kind: 'container', key: c.key, name: c.name, size: c.size, status: 'waiting', copies: c.copies, pauseNames: c.pauseNames ?? [c.name]})),
		]
		if (!items.length) throw new RpcError('BAD_REQUEST', 'Nothing from the previous move is eligible for re-sync')
		const next = {
			id: randomBytes(4).toString('hex'),
			host: session.host,
			resync: true,
			startedAt: now(),
			endedAt: null,
			destination: prev.destination,
			pauseContainers,
			bwlimitMbps,
			excludes,
			verifyChecksum,
			deleteRemoved,
			items,
		}
		await saveJob(next)
		job = next
		touch()
		job.done = (async () => {
			for (const item of job.items) {
				if (job.cancelled) {
					item.status = 'skipped'
					continue
				}
				item.status = 'running'
				item.progress = 0
				await saveJob().catch(() => {})
				try {
					const opts = {bwlimitMbps, excludes, verifyChecksum, deleteRemoved}
					if (item.kind === 'share') {
						item.step = 'Syncing changes'
						const real = await realOf(item.path)
						await rsync(`/mnt/user/${item.key}`, real, (p) => (item.progress = p.percent), opts)
					} else {
						const appData = join(apps.appDirFor(item.key), 'data')
						const names = item.pauseNames ?? [item.name]
						// Pause the migrated Omarchy app locally only if it is currently running (never auto-start a stopped app).
						let pausedLocal = false
						if (apps?.pauseForBackup) {
							let shouldPause = true
							if (apps.backupTargets) {
								const targets = await apps.backupTargets().catch(() => null)
								const match = Array.isArray(targets) ? targets.find((t) => t.id === item.key) : null
								if (match && !match.running) shouldPause = false
							}
							if (shouldPause) {
								item.step = 'Pausing local app'
								await apps.pauseForBackup(item.key)
								pausedLocal = true
							}
						}
						try {
							if (pauseContainers && names.length) {
								// Query live state on Unraid first: never restart containers the user intentionally stopped.
								const runningNow = []
								for (const nm of names) {
									const st = (await remote(`docker inspect -f '{{.State.Running}}' ${sq(nm)}`, {timeout: 30_000}).catch(() => '')).trim()
									if (st === 'true') runningNow.push(nm)
								}
								if (runningNow.length) {
									item.step = 'Syncing final changes (paused on Unraid)'
									job.paused = runningNow.join(', ')
									await saveJob().catch(() => {})
									const stoppedHere = []
									try {
										for (const nm of runningNow) {
											await remote(`docker stop ${sq(nm)}`, {timeout: 5 * 60_000})
											stoppedHere.push(nm)
										}
										let idx = 0
										for (const cp of item.copies) {
											await rsync(cp.from, join(appData, cp.to), (p) => (item.progress = (idx + p.percent) / item.copies.length), {...opts, file: !!cp.file})
											idx++
										}
									} finally {
										let allRestarted = true
										for (const nm of stoppedHere) {
											await remote(`docker start ${sq(nm)}`, {timeout: 5 * 60_000}).catch((e) => {
												allRestarted = false
												item.note = [item.note, `It may still be stopped on Unraid — start ${nm} there (${e.message}).`].filter(Boolean).join(' ')
											})
										}
										if (allRestarted) {
											delete job.paused
											await saveJob().catch(() => {})
										}
									}
								} else {
									item.step = 'Syncing changes'
									let idx = 0
									for (const cp of item.copies) {
										await rsync(cp.from, join(appData, cp.to), (p) => (item.progress = (idx + p.percent) / item.copies.length), {...opts, file: !!cp.file})
										idx++
									}
								}
							} else {
								item.step = 'Syncing changes'
								let idx = 0
								for (const cp of item.copies) {
									await rsync(cp.from, join(appData, cp.to), (p) => (item.progress = (idx + p.percent) / item.copies.length), {...opts, file: !!cp.file})
									idx++
								}
							}
						} finally {
							if (pausedLocal && apps?.resumeAfterBackup) {
								item.step = 'Starting local app'
								await apps.resumeAfterBackup(item.key).catch((e) => {
									item.note = [item.note, `Synced, but the local app didn’t start automatically (${e.message}).`].filter(Boolean).join(' ')
								})
							}
						}
					}
					item.status = 'done'
					item.progress = 1
				} catch (e) {
					item.status = 'failed'
					item.error = e.message
				}
				await saveJob().catch(() => {})
			}
			job.endedAt = now()
			touch()
			await saveJob().catch(() => {})
		})()
		return {id: job.id}
	}

	async function importShare(item, dest) {
		const virtual = `${dest}/${item.key}`
		const real = await realOf(virtual)
		item.step = 'Copying'
		await rsync(`/mnt/user/${item.key}`, real, (p) => (item.progress = p.percent), {
			bwlimitMbps: job.bwlimitMbps,
			excludes: job.excludes,
			verifyChecksum: job.verifyChecksum,
		})
		item.path = virtual
		if (job.shareOnNetwork && storage) {
			item.step = 'Sharing on the network'
			try {
				const chosen = await storage.procedures['files.addShare'].run({path: virtual})
				if (typeof chosen === 'string' && chosen !== item.key) item.note = `Shared on the network as “${chosen}”.`
			} catch (e) {
				item.note = `Copied, but not shared on the network: ${e.message}`
			}
		}
	}

	async function importContainer(item, plan, shareDest) {
		if (!plan) throw new Error('It isn’t on the Unraid server any more')
		if (apps.installed(plan.id)) throw new Error('It’s already here')
		// The listing, in the "Imported from Unraid" store.
		const storeDir = apps.importedStoreDir
		await mkdir(storeDir, {recursive: true, mode: 0o700})
		await writeFile(join(storeDir, 'omarchy-app-store.yml'), 'id: imported\nname: Imported from Unraid\n')
		const listingDir = join(storeDir, plan.id)
		await mkdir(listingDir, {recursive: true})
		const compose = YAML.parse(plan.files['docker-compose.yml'])
		// Folders from shares point at where those shares are being copied (as real paths).
		for (const svc of Object.values(compose.services ?? {})) {
			svc.volumes = await Promise.all(
				(svc.volumes ?? []).map(async (v) => {
					// "${APP_DATA_DIR:-.}/data/shares/<share>[/rest]:<in the container>[:ro]" (the variable has a colon of its own).
					const m = /^\$\{APP_DATA_DIR:-\.\}\/data\/shares\/([^/:]+)((?:\/[^:]*)?)(:.+)$/.exec(String(v))
					const share = m && plan.shares.find((s) => slug(s) === m[1])
					if (share && shareDest(share)) return `${join(escapeCompose(await realOf(shareDest(share))), m[2] ?? '')}${m[3]}`
					return v
				}),
			)
		}
		await writeFile(join(listingDir, 'docker-compose.yml'), YAML.stringify(compose))
		let listingText = plan.files['omarchy-app.yml']
		if (job.downloadIcons && plan.icon) {
			const verifiedIcon = await verifyIconUrl(plan.icon, {fetchImpl, checkUrl: checkIconUrl})
			if (verifiedIcon) {
				const parsedListing = YAML.parse(listingText)
				parsedListing.icon = verifiedIcon
				listingText = YAML.stringify(parsedListing)
			}
		}
		await writeFile(join(listingDir, 'omarchy-app.yml'), listingText)
		// Remember copies & container names on the item so unraid.resync can do a cutover delta sync later.
		item.copies = plan.copies
		const pauseTargets = plan.isStack ? plan.members.filter((m) => m.running).map((m) => m.name) : plan.running ? [plan.name] : []
		item.pauseNames = pauseTargets

		// Its files: copied while it runs, then once more while it's stopped on Unraid (only what changed).
		const appData = join(apps.appDirFor(plan.id), 'data')
		const total = plan.copies.length || 1
		const rsyncOpts = {bwlimitMbps: job.bwlimitMbps, excludes: job.excludes, verifyChecksum: job.verifyChecksum}
		let n = 0
		for (const cp of plan.copies) {
			item.step = cp.volume ? 'Copying Docker volumes' : 'Copying its files'
			await rsync(cp.from, join(appData, cp.to), (p) => (item.progress = 0.7 * ((n + p.percent) / total)), {...rsyncOpts, file: !!cp.file})
			n++
		}
		const pause = job.pauseContainers && pauseTargets.length && plan.copies.length
		if (pause) {
			item.step = 'Copying the last changes (paused on Unraid)'
			job.paused = pauseTargets.join(', ')
			await saveJob().catch(() => {})
			try {
				for (const nm of pauseTargets) await remote(`docker stop ${sq(nm)}`, {timeout: 5 * 60_000})
				for (const cp of plan.copies) await rsync(cp.from, join(appData, cp.to), () => {}, {...rsyncOpts, file: !!cp.file})
			} finally {
				let allRestarted = true
				for (const nm of pauseTargets) {
					await remote(`docker start ${sq(nm)}`, {timeout: 5 * 60_000}).catch((e) => {
						allRestarted = false
						item.note = [item.note, `It may still be stopped on Unraid — start ${nm} there (${e.message}).`].filter(Boolean).join(' ')
					})
				}
				if (allRestarted) {
					delete job.paused
					await saveJob().catch(() => {})
				}
			}
		}
		item.step = 'Installing'
		item.progress = 0.8
		await apps.installImported(plan.id)
		const end = now() + 60 * 60_000
		for (;;) {
			const st = apps.importState(plan.id)
			if (st.done) {
				if (st.error) throw new Error(st.error)
				break
			}
			if (now() > end) throw new Error('Installing took too long')
			await new Promise((r) => setTimeout(r, 2000))
		}
		const notes = plan.notes.filter((t) => !plan.shares.some((sh) => shareDest(sh) && t.includes(`the ${sh} share`)))
		if (notes.length) item.note = [item.note, ...notes].filter(Boolean).join(' ')
	}

	async function importVm(item, plan) {
		if (!plan) throw new Error('It isn’t on the Unraid server any more')
		let st = (await remote(`virsh domstate ${sq(plan.name)}`).catch(() => '')).trim()
		if (st && st !== 'shut off') {
			if (!job.shutdownRunningVms) throw new Error(`Shut down ${plan.name} on Unraid first (it’s ${st}), then bring it over`)
			item.step = 'Shutting down on Unraid'
			await remote(`virsh shutdown ${sq(plan.name)}`, {timeout: 30_000})
			const deadline = now() + 120_000
			while (now() < deadline) {
				await new Promise((r) => setTimeout(r, 2000))
				st = (await remote(`virsh domstate ${sq(plan.name)}`).catch(() => '')).trim()
				if (st === 'shut off') break
			}
			if (st !== 'shut off') throw new Error(`${plan.name} didn’t shut down within 2 minutes (still ${st}). Shut it down on Unraid first.`)
		}
		if (vmInstalled(plan.name)) throw new Error('It’s already here')
		const stage = join(stagingDir, `vm-${randomBytes(4).toString('hex')}`)
		await mkdir(stage, {recursive: true, mode: 0o700})
		try {
			const local = []
			const extraArgs = []
			if (job.bwlimitMbps > 0) extraArgs.push(`--bwlimit=${Math.max(100, Math.round(job.bwlimitMbps * 1000))}`)
			if (job.verifyChecksum) extraArgs.push('--checksum')
			const e = ['ssh', ...sshOpts(false)].map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(' ')
			let i = 0
			for (const d of plan.disks) {
				item.step = `Copying disk ${i + 1} of ${plan.disks.length}`
				const to = join(stage, `d${i}`)
				// rsync copies a folder's contents: copy the disk's folder, only that file.
				const folder = d.file.slice(0, d.file.lastIndexOf('/'))
				const file = d.file.slice(d.file.lastIndexOf('/') + 1)
				await mkdir(to, {recursive: true})
				await run('rsync', ['-t', '--partial', '--sparse', '--protect-args', '--info=progress2', ...extraArgs, '-e', e, `${session.host}:${folder}/${file}`, `${to}/`], {
					env: sshEnv(),
					timeout: 7 * 24 * 60 * 60_000,
					split: /[\r\n]/,
					onLine: (l) => {
						const p = rsyncProgress(l)
						if (p) item.progress = 0.8 * ((i + p.percent) / plan.disks.length)
					},
				}).catch((err) => {
					throw new Error(`Copying its disk didn’t finish: ${String(err.message).slice(0, 200)}`)
				})
				local.push({file: join(to, file), bus: d.bus, format: d.format})
				i++
			}
			// Copy UEFI NVRAM varstore if present so Windows/EFI boot entries survive migration!
			let localNvram = null
			if (plan.firmware === 'efi' && plan.nvram) {
				item.step = 'Copying UEFI firmware settings'
				const nvramDst = join(stage, 'nvram')
				await mkdir(nvramDst, {recursive: true})
				const nvramFile = plan.nvram.slice(plan.nvram.lastIndexOf('/') + 1)
				try {
					await run('rsync', ['-t', '--partial', '--protect-args', '-e', e, `${session.host}:${plan.nvram}`, `${nvramDst}/`], {env: sshEnv(), timeout: 60_000})
					localNvram = join(nvramDst, nvramFile)
				} catch {
					localNvram = null
				}
			}
			item.step = 'Making the machine'
			item.progress = 0.85
			const {id} = await machines.importVm({...plan, disks: local, ...(localNvram ? {nvram: localNvram} : {})})
			const end = now() + 12 * 60 * 60_000
			let finalState
			for (;;) {
				const s = machines.importState(id)
				if (s.done) {
					if (s.error) throw new Error(s.error)
					finalState = s
					break
				}
				if (now() > end) throw new Error('Making the machine took too long')
				await new Promise((r) => setTimeout(r, 3000))
			}
			item.machineId = id
			importedVms.set(plan.name, id)
			const notes = localNvram ? plan.notes.filter((n) => !/NVRAM/.test(n)) : [...plan.notes]
			const finalName = finalState?.name || plan.name
			if (finalName !== plan.name) {
				item.machineName = finalName
				notes.unshift(`Saved here as “${finalName}” because a machine named ${plan.name} already existed.`)
			}
			if (notes.length) item.note = notes.join(' ')
		} finally {
			await rm(stage, {recursive: true, force: true})
		}
	}

	async function status() {
		await ready
		const {done: _d, ...j} = job ?? {}
		return {
			connected: session ? {host: session.host, port: session.port, authMode: session.authMode, version: session.version, fingerprint: session.fingerprint} : null,
			scanned: !!session?.scan,
			job: job ? j : null,
		}
	}

	async function cancel() {
		await ready
		if (job && !job.endedAt) job.cancelled = true
		return true
	}

	async function disconnect() {
		await ready
		if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is running')
		await forget()
		return true
	}

	return {
		ready,
		close: () => (clearTimeout(idle), forget()),
		procedures: {
			'unraid.status': {kind: 'query', run: status},
			'unraid.connect': {kind: 'mutation', run: connect},
			'unraid.scan': {kind: 'mutation', run: scan},
			'unraid.preflight': {kind: 'mutation', run: preflight},
			'unraid.start': {kind: 'mutation', run: start},
			'unraid.resync': {kind: 'mutation', run: resync},
			'unraid.cancel': {kind: 'mutation', run: cancel},
			'unraid.disconnect': {kind: 'mutation', run: disconnect},
			'unraid.forgetHost': {kind: 'mutation', run: forgetHost},
		},
	}
}
