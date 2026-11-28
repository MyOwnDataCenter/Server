// Direct 60 FPS GPU Hyprland capture & WebCodecs streamer (owner-only).
//
// Capabilities:
//   - Zero-copy 60 FPS GPU DMA-BUF -> VA-API H.264/HEVC/AV1 C engine (`hypr-rail-capture.c`, auto-built once on demand,
//     with transparent fallback to `hypr-stream.py` on hosts without gcc/VA-API headers).
//   - Dedicated headless 60 Hz output (`RAIL-1`) so streams render at 60 FPS even when the physical display is asleep.
//   - Dual Hyprland 0.57+ Lua (`hyprctl eval`) + legacy `hyprctl dispatch` window control (focus, resize, close, workspace).
//   - Silence-gated low-latency PipeWire audio, native cursor shape forwarding, full binary input fast paths, and
//     session lock-state reporting wired into Lock-after-viewing-remotely.
import {execFile, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {access, chmod, lstat, mkdir, open as fsOpen, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {dirname, extname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {RpcError} from './rpc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM_SCRIPT = join(HERE, 'hypr-stream.py')
const CAPTURE_SOURCE = join(HERE, 'hypr-rail-capture.c')
const ADDRESS_RE = /^0x[0-9a-f]{4,16}$/i
const DESKTOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const OUTPUT_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_STREAMS = 12
const MAX_SSE_SUBSCRIBERS = 32
const MAX_PENDING_LAUNCHES = 8
const MAX_CLIPBOARD_BYTES = 128 * 1024
const RAIL_OUTPUT = 'RAIL-1'

// Deterministic selector algorithm for ranking measured GPU encode presets against client RTT & target frame rate.
export function scoreProfileCandidate(cand, {rttMs = 15} = {}) {
	const fps = Number(cand.fps) || 0
	const targetFps = Math.max(15, Number(cand.targetFps) || 60)
	const p95 = Number(cand.p95Ms) || 999
	const keyKb = Number(cand.keyKb) || 0
	const codec = String(cand.codec || 'h264')
	const quality = Number(cand.quality) || 22
	const bitrate = Number(cand.bitrate) || 20000
	const rtt = Math.max(0, Number(rttMs) || 0)

	if (!cand.ok || fps < 12) return 0

	// 1. Frame-rate adherence (0..45 pts) - heavily penalize stuttery presets that drop below 88% of target FPS
	const fpsRatio = Math.min(1, fps / targetFps)
	let score = fpsRatio >= 0.9 ? 45 : fpsRatio >= 0.78 ? 28 * fpsRatio : 12 * fpsRatio

	// 2. Frame-pacing stability (0..25 pts) - reward tight p95 frame times near 16.7ms
	const budgetMs = 1000 / targetFps
	if (p95 <= budgetMs * 1.15) score += 25
	else if (p95 <= budgetMs * 1.45) score += 16
	else if (p95 <= budgetMs * 1.9) score += 7

	// 3. Visual sharpness & codec efficiency (0..23 pts)
	const codecBonus = codec === 'hevc444' ? 14 : codec === 'hevc10' ? 13 : codec === 'hevc' ? 12 : 8
	const sharpBonus = quality <= 14 ? 9 : quality <= 17 ? 8 : quality <= 20 ? 7 : quality <= 22 ? 5 : quality <= 25 ? 3 : 1
	score += codecBonus + sharpBonus

	// 4. Network-aware WAN/LAN fit (0..10 pts) - reward high-bitrate presets on LAN while penalizing oversized WAN streams
	const idealMaxBitrate = rtt >= 45 ? 18000 : rtt >= 18 ? 28000 : 100000
	const idealMinBitrate = rtt >= 45 ? 12000 : rtt >= 18 ? 16000 : 24000
	let netScore = 10
	if (bitrate > idealMaxBitrate) netScore -= Math.min(6, (bitrate - idealMaxBitrate) / 4000)
	if (bitrate < idealMinBitrate) netScore -= Math.min(4, (idealMinBitrate - bitrate) / 4000)
	if (rtt >= 25 && keyKb > 450) netScore -= Math.min(4, (keyKb - 450) / 120)
	score += Math.max(0, netScore)

	return Math.max(0, Math.min(100, Math.round(score)))
}

// O(1)-amortized chunk queue for framed stdout streams ([u8 type][u32be len][payload]), avoiding O(N^2) Buffer.concat and Array.shift().
export function createFrameReader() {
	let chunks = []
	let headIdx = 0
	let headOff = 0
	let total = 0

	const advanceHead = () => {
		headIdx++
		headOff = 0
		if (headIdx >= chunks.length) {
			chunks = []
			headIdx = 0
		} else if (headIdx >= 64 && headIdx * 2 >= chunks.length) {
			chunks = chunks.slice(headIdx)
			headIdx = 0
		}
	}

	const consume = (n) => {
		if (n <= 0) return Buffer.alloc(0)
		const first = chunks[headIdx]
		if (first && first.length - headOff >= n) {
			const out = first.subarray(headOff, headOff + n)
			headOff += n
			total -= n
			if (headOff >= first.length) advanceHead()
			return out
		}
		const out = Buffer.allocUnsafe(n)
		let written = 0
		while (written < n && headIdx < chunks.length) {
			const cur = chunks[headIdx]
			const avail = cur.length - headOff
			const take = Math.min(avail, n - written)
			cur.copy(out, written, headOff, headOff + take)
			written += take
			headOff += take
			total -= take
			if (headOff >= cur.length) advanceHead()
		}
		return out
	}

	const peekHeader = () => {
		const first = chunks[headIdx]
		if (first && first.length - headOff >= 5) {
			return {type: first[headOff], len: first.readUInt32BE(headOff + 1)}
		}
		const hdr = Buffer.allocUnsafe(5)
		let filled = 0
		for (let i = headIdx; i < chunks.length && filled < 5; i++) {
			const c = chunks[i]
			const off = i === headIdx ? headOff : 0
			const take = Math.min(c.length - off, 5 - filled)
			c.copy(hdr, filled, off, off + take)
			filled += take
		}
		return {type: hdr[0], len: hdr.readUInt32BE(1)}
	}

	return {
		push(chunk) {
			if (!chunk || chunk.length === 0) return
			chunks.push(chunk)
			total += chunk.length
		},
		drain(onFrame, maxLen = 16 * 1024 * 1024) {
			while (total >= 5) {
				const {type, len} = peekHeader()
				if (len > maxLen) return false
				if (total < 5 + len) break
				consume(5)
				const payload = consume(len)
				onFrame(type, payload)
			}
			return true
		},
		clear() {
			chunks = []
			headIdx = 0
			headOff = 0
			total = 0
		},
	}
}

// Fast silence detector for 16-bit signed little-endian stereo PCM (threshold ~ -66 dBFS).
export function isPcmSilent(buf, threshold = 16) {
	const limit = buf.length - 1
	for (let i = 0; i < limit; i += 2) {
		const s = buf.readInt16LE(i)
		if (s > threshold || s < -threshold) return false
	}
	return true
}

// Bitrate-proportional WebSocket backpressure ceilings (~250 ms budget):
// stays tight on WAN (384 KiB at 16 Mbps) while giving high-bitrate LAN (80-120 Mbps, 1.5+ MiB near-lossless 4K keyframes) headroom without false drops.
export function backpressureBudgets(bitrateKbps = 22000) {
	const kbps = Math.max(1000, Math.min(150000, Math.round(Number(bitrateKbps) || 22000)))
	const deltaDropBytes = Math.max(384 * 1024, Math.min(4 * 1024 * 1024, Math.round(((kbps * 1000) / 8) * 0.25)))
	const hardDropBytes = Math.max(1536 * 1024, deltaDropBytes * 4)
	const keyDrainBytes = Math.max(64 * 1024, Math.round(deltaDropBytes / 4))
	return {deltaDropBytes, hardDropBytes, keyDrainBytes}
}

const exists = (p) => access(p).then(() => true, () => false)

function execOut(cmd, args, {env, timeout = 5000, input = null, maxBuffer = 4 * 1024 * 1024} = {}) {
	return new Promise((resolveDone) => {
		const child = execFile(cmd, args, {env, timeout, maxBuffer}, (err, stdout, stderr) => {
			resolveDone({ok: !err, code: err?.code ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '')})
		})
		if (input != null && child.stdin) {
			child.stdin.on('error', () => {})
			child.stdin.end(input)
		}
	})
}

async function readBoundedRegularFile(filePath, maxBytes) {
	let fh = null
	try {
		fh = await fsOpen(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
		const st = await fh.stat()
		if (!st.isFile() || st.size > maxBytes) return null
		const cap = Math.min(maxBytes, Math.max(0, st.size))
		const buf = Buffer.allocUnsafe(cap + 1)
		let total = 0
		while (total <= maxBytes) {
			const {bytesRead} = await fh.read(buf, total, buf.length - total, null)
			if (bytesRead <= 0) break
			total += bytesRead
			if (total > maxBytes) return null
		}
		return buf.subarray(0, total)
	} catch {
		return null
	} finally {
		await fh?.close().catch(() => {})
	}
}

export function parseDesktopEntry(text, id) {
	let inMain = false
	const fields = {}
	for (const rawLine of String(text ?? '').split('\n')) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		if (line.startsWith('[')) {
			inMain = line === '[Desktop Entry]'
			continue
		}
		if (!inMain) continue
		const eq = line.indexOf('=')
		if (eq <= 0) continue
		const k = line.slice(0, eq).trim()
		if (k.includes('[')) continue // skip localized duplicates; keep base English/default keys
		if (!Object.hasOwn(fields, k)) fields[k] = line.slice(eq + 1).trim()
	}
	if (fields.Type !== 'Application') return null
	if (fields.NoDisplay === 'true' || fields.Hidden === 'true') return null
	if (!fields.Name || !fields.Exec) return null
	const cats = String(fields.Categories ?? '')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)
	return {
		id,
		name: fields.Name.slice(0, 80),
		comment: String(fields.Comment || fields.GenericName || '').slice(0, 140),
		icon: String(fields.Icon || '').slice(0, 160),
		categories: cats.slice(0, 6),
		terminal: fields.Terminal === 'true',
		wmClass: String(fields.StartupWMClass || '').slice(0, 80),
	}
}

export function createHyprland({
	dataDir = join(os.tmpdir(), 'omarchy-hypr'),
	home = os.homedir(),
	runtimeDir = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : ''),
	exec = execOut,
	spawnImpl = spawn,
	scriptPath = STREAM_SCRIPT,
	captureSource = CAPTURE_SOURCE,
	captureBin = null,
	vaapiDevice = '/dev/dri/renderD128',
	appDirs = null,
	onRemoteUnlock = null,
} = {}) {
	const activeStreams = new Set()
	let pendingStreams = 0
	const eventListeners = new Set()
	let busClosed = false
	let eventSock = null
	let eventSockConnecting = false
	let eventReconnectTimer = null
	let currentEventInstance = null
	let rectSyncTimer = null
	let lastLockedState = null
	let lockProbeSeq = 0
	let lastAppliedLockSeq = 0
	let lastFocusedAddr = ''
	let appsCache = {at: 0, list: [], iconPaths: new Map()}
	let appsScanPromise = null
	let compilePromise = null
	let compiledBin = captureBin || null
	let compileFailedAt = 0

	const iconRoots = [
		{path: '/usr/share/icons', userOwned: false},
		{path: '/usr/share/pixmaps', userOwned: false},
		{path: '/usr/local/share/icons', userOwned: false},
		{path: join(home, '.local/share/icons'), userOwned: true},
		{path: join(home, '.icons'), userOwned: true},
	]

	function resolveXdgDataEnv() {
		const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.startsWith('/') ? process.env.XDG_DATA_HOME : join(home, '.local/share')
		const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
			.split(':')
			.map((d) => d.trim())
			.filter((d) => d.startsWith('/'))
		return {dataHome, dataDirs: dataDirs.length ? dataDirs : ['/usr/local/share', '/usr/share']}
	}

	async function cleanGuiEnv(env) {
		const keep = [
			'HOME',
			'USER',
			'LOGNAME',
			'PATH',
			'SHELL',
			'LANG',
			'LC_ALL',
			'TERM',
			'XDG_RUNTIME_DIR',
			'XDG_DATA_HOME',
			'XDG_DATA_DIRS',
			'XDG_CONFIG_DIRS',
			'XDG_CONFIG_HOME',
			'XDG_CACHE_HOME',
			'XDG_STATE_HOME',
			'WAYLAND_DISPLAY',
			'HYPRLAND_INSTANCE_SIGNATURE',
			'DBUS_SESSION_BUS_ADDRESS',
			'QT_QPA_PLATFORM',
			'GDK_BACKEND',
			'MOZ_ENABLE_WAYLAND',
			'ELECTRON_OZONE_PLATFORM_HINT',
		]
		const out = {}
		for (const k of keep) {
			if (env[k] != null) out[k] = env[k]
		}
		// Keep scanner and gtk-launch aligned on the exact same XDG data roots.
		const xdg = resolveXdgDataEnv()
		out.XDG_DATA_HOME = xdg.dataHome
		out.XDG_DATA_DIRS = xdg.dataDirs.join(':')
		// Ensure Wayland/Electron/GTK/Qt/D-Bus vars are always present even when omarchyd runs as a minimal systemd user service
		if (!out.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
			const bus = join(env.XDG_RUNTIME_DIR, 'bus')
			if (await exists(bus)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`
		}
		out.XDG_SESSION_TYPE = 'wayland'
		out.XDG_CURRENT_DESKTOP = 'Hyprland'
		out.ELECTRON_OZONE_PLATFORM_HINT = out.ELECTRON_OZONE_PLATFORM_HINT || 'wayland'
		out.GDK_BACKEND = out.GDK_BACKEND || 'wayland,x11,*'
		out.QT_QPA_PLATFORM = out.QT_QPA_PLATFORM || 'wayland;xcb'
		out.MOZ_ENABLE_WAYLAND = out.MOZ_ENABLE_WAYLAND || '1'
		out.SDL_VIDEODRIVER = 'wayland'
		// Only forward DISPLAY if Xwayland is actually live (a stale DISPLAY=:0 socket causes Electron/AppImage apps to hang!)
		if (env.DISPLAY) {
			const xw = await exec('pgrep', ['-x', 'Xwayland'], {timeout: 1500})
			if (xw.ok && xw.stdout.trim()) out.DISPLAY = env.DISPLAY
		}
		return out
	}

	async function discoverEnv() {
		if (!runtimeDir) return null
		const entries = await readdir(runtimeDir).catch(() => [])
		const wlCands = []
		for (const f of entries) {
			if (!/^wayland-\d+$/.test(f)) continue
			const st = await stat(join(runtimeDir, f)).catch(() => null)
			if (st) wlCands.push({f, mtime: st.mtimeMs})
		}
		wlCands.sort((a, b) => b.mtime - a.mtime)
		const wayland = wlCands[0]?.f
		const hyprDir = join(runtimeDir, 'hypr')
		const sigs = await readdir(hyprDir).catch(() => [])
		let sig = process.env.HYPRLAND_INSTANCE_SIGNATURE || ''
		if (!sig || !sigs.includes(sig)) {
			// Pick the newest live Hyprland instance (stale dirs from prior crashed sessions can leave old .socket.sock files behind)
			const live = []
			for (const cand of sigs) {
				const st = await stat(join(hyprDir, cand, '.socket.sock')).catch(() => null)
				if (st) live.push({cand, mtime: st.mtimeMs})
			}
			live.sort((a, b) => b.mtime - a.mtime)
			if (live.length) sig = live[0].cand
		}
		if (!wayland && !sig) return null
		return {
			...process.env,
			XDG_RUNTIME_DIR: runtimeDir,
			...(wayland ? {WAYLAND_DISPLAY: wayland} : {}),
			...(sig ? {HYPRLAND_INSTANCE_SIGNATURE: sig} : {}),
		}
	}

	async function hyprctl(args) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
		}
		const r = await exec('hyprctl', args, {env, timeout: 4000})
		if (!r.ok) throw new RpcError('BAD_GATEWAY', `hyprctl failed: ${r.stderr.trim() || 'no response'}`)
		return r.stdout
	}

	// Run a Hyprland 0.57+ Lua eval with automatic fallback to legacy `hyprctl dispatch` for older Hyprland releases.
	async function hyprDispatch(luaExpr, legacyArgs, {beforeAttempt} = {}) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
		}
		if (luaExpr) {
			if (beforeAttempt && !(await beforeAttempt())) return null
			const r = await exec('hyprctl', ['eval', luaExpr], {env, timeout: 4000})
			if (r.ok && r.stdout.trim() === 'ok') return r.stdout
		}
		if (legacyArgs?.length) {
			if (beforeAttempt && !(await beforeAttempt())) return null
			const r2 = await exec('hyprctl', legacyArgs, {env, timeout: 4000})
			const out2 = r2.stdout.trim()
			if (r2.ok && (!out2 || out2 === 'ok')) return r2.stdout
			throw new RpcError('BAD_GATEWAY', `hyprctl failed: ${r2.stderr.trim() || out2 || 'no response'}`)
		}
		throw new RpcError('BAD_GATEWAY', 'Hyprland dispatch failed')
	}

	// Auto-build the zero-copy 60 FPS DMA-BUF/VA-API C capture engine once into <dataDir>/bin/hypr-rail-capture-<sha12>.
	async function ensureCaptureBinary() {
		if (compiledBin && (await exists(compiledBin))) return compiledBin
		if (compileFailedAt && Date.now() - compileFailedAt < 5 * 60_000) return null
		if (compilePromise) return compilePromise
		compilePromise = (async () => {
			if (!(await exists(captureSource)) || !(await exists(vaapiDevice))) {
				compileFailedAt = Date.now()
				return null
			}
			const srcBytes = await readFile(captureSource).catch(() => null)
			if (!srcBytes) {
				compileFailedAt = Date.now()
				return null
			}
			const hash = createHash('sha256').update(srcBytes).digest('hex').slice(0, 12)
			const binDir = join(dataDir, 'bin')
			const outBin = join(binDir, `hypr-rail-capture-${hash}`)
			const binSt = await stat(outBin).catch(() => null)
			if (binSt && binSt.size > 8192) {
				compiledBin = outBin
				return outBin
			}
			const pkg = await exec('pkg-config', ['--cflags', '--libs', 'gbm', 'libva', 'libva-drm', 'libavcodec', 'libavfilter', 'libavutil', 'libdrm'], {timeout: 4000})
			if (!pkg.ok) {
				compileFailedAt = Date.now()
				return null
			}
			await mkdir(binDir, {recursive: true, mode: 0o700})
			const flags = pkg.stdout.trim().split(/\s+/).filter(Boolean)
			const tmpBin = `${outBin}.${process.pid}.tmp`
			const cc = await exec('gcc', ['-O2', '-pthread', captureSource, '-o', tmpBin, ...flags, '-ldl'], {timeout: 30_000})
			if (!cc.ok) {
				await rm(tmpBin, {force: true}).catch(() => {})
				compileFailedAt = Date.now()
				return null
			}
			await chmod(tmpBin, 0o755)
			await rename(tmpBin, outBin)
			// Clean up older hashed binaries in binDir
			for (const f of await readdir(binDir).catch(() => [])) {
				if (f.startsWith('hypr-rail-capture-') && f !== `hypr-rail-capture-${hash}`) {
					await rm(join(binDir, f), {force: true}).catch(() => {})
				}
			}
			compiledBin = outBin
			return outBin
		})().finally(() => {
			compilePromise = null
		})
		return compilePromise
	}

	async function monitorsInfo() {
		try {
			const raw = await hyprctl(['monitors', '-j'])
			return JSON.parse(raw || '[]').map((m) => ({
				id: m.id,
				name: String(m.name ?? ''),
				x: Number(m.x) || 0,
				y: Number(m.y) || 0,
				width: Number(m.width) || 0,
				height: Number(m.height) || 0,
				scale: Number(m.scale) || 1,
				refreshRate: Math.round(Number(m.refreshRate) || 60),
				dpmsStatus: m.dpmsStatus !== false,
				activeWorkspace: Number.isInteger(m.activeWorkspace?.id) ? m.activeWorkspace.id : null,
				reserved: Array.isArray(m.reserved) && m.reserved.length === 4 ? m.reserved.map((n) => Number(n) || 0) : [0, 0, 0, 0],
				locked: Array.isArray(m.solitaryBlockedBy) && m.solitaryBlockedBy.includes('LOCK'),
				hasLockInfo: Array.isArray(m.solitaryBlockedBy),
				focused: m.focused === true,
			}))
		} catch {
			return []
		}
	}

	// Compute the global logical coordinate bounding box across all Hyprland monitors (for pointer_move/button mapping).
	function layoutBounds(mons) {
		if (!mons.length) return {lx: 0, ly: 0, lw: 1920, lh: 1080}
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		for (const m of mons) {
			const sc = m.scale > 0 ? m.scale : 1
			const lw = Math.round(m.width / sc)
			const lh = Math.round(m.height / sc)
			if (m.x < minX) minX = m.x
			if (m.y < minY) minY = m.y
			if (m.x + lw > maxX) maxX = m.x + lw
			if (m.y + lh > maxY) maxY = m.y + lh
		}
		return {lx: minX, ly: minY, lw: Math.max(1, maxX - minX), lh: Math.max(1, maxY - minY)}
	}

	// Wake the headless RAIL-1 monitor without lighting up physical displays (eDP-1 stays dark/asleep).
	async function wakeRailOutput() {
		await hyprDispatch(
			`hl.dispatch(hl.dsp.dpms({action = "on", monitor = "${RAIL_OUTPUT}"}))`,
			['dispatch', 'dpms', 'on', RAIL_OUTPUT],
		).catch(() => {})
	}

	// Ensure a dedicated headless 60 Hz output (`RAIL-1`) exists at 3840x2160@60 scale=1 and is awake even when the physical display is asleep.
	// Note: RAIL-1 is kept persistently for the session rather than torn down when idle; removing a headless output on a lid-closed laptop triggers clamshell monitor watchers.
	async function ensureRailOutput() {
		let mons = await monitorsInfo()
		let rail = mons.find((m) => m.name === RAIL_OUTPUT)
		if (!rail) {
			const env = await discoverEnv()
			if (!env?.HYPRLAND_INSTANCE_SIGNATURE) return null
			await exec('hyprctl', ['output', 'create', 'headless', RAIL_OUTPUT], {env, timeout: 4000})
			await new Promise((r) => setTimeout(r, 250))
			await hyprDispatch(
				`hl.monitor({output = "${RAIL_OUTPUT}", mode = "3840x2160@60", position = "auto", scale = 1})`,
				['keyword', 'monitor', `${RAIL_OUTPUT},3840x2160@60,auto,1`],
			).catch(() => {})
			await new Promise((r) => setTimeout(r, 150))
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT)
			if (rail) syncAllStreamRects().catch(() => {})
		} else if (rail.scale !== 1 || rail.width < 3840 || rail.height < 2160) {
			await hyprDispatch(
				`hl.monitor({output = "${RAIL_OUTPUT}", mode = "3840x2160@60", position = "auto", scale = 1})`,
				['keyword', 'monitor', `${RAIL_OUTPUT},3840x2160@60,auto,1`],
			).catch(() => {})
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT) ?? null
			if (rail) syncAllStreamRects().catch(() => {})
		}
		if (rail && !rail.dpmsStatus) {
			await wakeRailOutput()
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT) ?? null
		}
		if (!rail || !Number.isInteger(rail.activeWorkspace) || rail.activeWorkspace < 1 || rail.activeWorkspace > 99) {
			return null
		}
		return rail
	}

	// The screen-share view (wayvnc) shows the real display, not the headless RAIL-1 that desktop-mode
	// app windows use. Launching an app from desktop mode leaves focus on RAIL-1, so an app opened later
	// from the screen-share view (Super+Space, say) would open there, out of sight. When the shared
	// screen is opened, put focus back on the real display's workspace. Nothing moves; windows already
	// on RAIL-1 stay where they are.
	async function focusSharedScreen() {
		const mons = await monitorsInfo()
		const rail = mons.find((m) => m.name === RAIL_OUTPUT)
		const shown = mons.find((m) => m.name !== RAIL_OUTPUT && Number.isInteger(m.activeWorkspace) && m.activeWorkspace >= 1)
		if (!rail?.focused || !shown) return false
		await hyprDispatch(`hl.dispatch(hl.dsp.focus({workspace = ${shown.activeWorkspace}}))`, ['dispatch', 'workspace', String(shown.activeWorkspace)])
		return true
	}

	// Size & position a floating window strictly inside RAIL-1's usable rect.
	async function placeOnRail(addr, reqW, reqH, {strict = false, expectedWorkspace = null} = {}) {
		const checkOwnership = async () => {
			if (!Number.isInteger(expectedWorkspace)) return true
			const cur = await windows({strict: true}).catch(() => [])
			const found = cur.find((w) => w.address.toLowerCase() === String(addr).toLowerCase())
			return !!found && found.workspace === expectedWorkspace
		}
		const rail = await ensureRailOutput().catch(() => null)
		if (strict && !rail) {
			throw new RpcError('BAD_GATEWAY', 'Headless RAIL-1 display disappeared during window placement')
		}
		if (Number.isInteger(expectedWorkspace) && !(await checkOwnership())) {
			return null
		}
		const beforeAttempt = Number.isInteger(expectedWorkspace) ? checkOwnership : null
		const padL = rail?.reserved?.[0] ?? 0
		const padT = rail?.reserved?.[1] ?? 0
		const padR = rail?.reserved?.[2] ?? 0
		const padB = rail?.reserved?.[3] ?? 0
		const maxW = rail ? Math.max(360, Math.round(rail.width / (rail.scale || 1)) - padL - padR) : 3840
		const maxH = rail ? Math.max(260, Math.round(rail.height / (rail.scale || 1)) - padT - padB) : 2160
		const w = Math.max(240, Math.min(maxW, Math.round(Number(reqW) || 1100)))
		const h = Math.max(180, Math.min(maxH, Math.round(Number(reqH) || 740)))
		let resized
		try {
			resized = await hyprDispatch(
				`hl.dispatch(hl.dsp.window.resize({window = "address:${addr}", x = ${w}, y = ${h}, relative = false}))`,
				['dispatch', 'resizewindowpixel', `exact ${w} ${h},address:${addr}`],
				{beforeAttempt},
			)
		} catch (err) {
			if (strict) throw err
		}
		if (beforeAttempt && resized === null) return null
		if (rail) {
			const tx = rail.x + padL
			const ty = rail.y + padT
			let moved
			try {
				moved = await hyprDispatch(
					`hl.dispatch(hl.dsp.window.move({window = "address:${addr}", x = ${tx}, y = ${ty}, relative = false}))`,
					['dispatch', 'movewindowpixel', `exact ${tx} ${ty},address:${addr}`],
					{beforeAttempt},
				)
			} catch (err) {
				if (strict) throw err
			}
			if (beforeAttempt && moved === null) return null
		}
		return {w, h}
	}

	// ---- Native .desktop application catalog & icon resolver ------------------------------------
	async function isAllowedIconPath(real) {
		const ext = extname(real).toLowerCase()
		if (ext !== '.svg' && ext !== '.png') return false
		const realHome = await realpath(home).catch(() => null)
		for (const root of iconRoots) {
			if (root.userOwned) {
				// Reject user-writable icon roots that are themselves symlinks escaping home
				const lst = await lstat(root.path).catch(() => null)
				if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue
				const realRoot = await realpath(root.path).catch(() => null)
				if (!realRoot || (realHome && realRoot !== realHome && !realRoot.startsWith(`${realHome}/`))) continue
				if (real.startsWith(`${realRoot}/`)) return true
			} else {
				const realRoot = await realpath(root.path).catch(() => null)
				if (realRoot && real.startsWith(`${realRoot}/`)) return true
			}
		}
		return false
	}

	async function resolveIconPath(iconName) {
		if (!iconName || iconName.includes('..') || iconName.includes('\0')) return null
		if (iconName.startsWith('/')) {
			if (!(await exists(iconName))) return null
			const real = await realpath(iconName).catch(() => null)
			if (!real) return null
			return (await isAllowedIconPath(real)) ? real : null
		}
		const exts = /\.(svg|png)$/i.test(iconName) ? [''] : ['.svg', '.png']
		const subdirs = [
			'/usr/share/icons/hicolor/scalable/apps',
			'/usr/share/icons/hicolor/256x256/apps',
			'/usr/share/icons/hicolor/128x128/apps',
			'/usr/share/icons/hicolor/64x64/apps',
			'/usr/share/icons/hicolor/48x48/apps',
			'/usr/share/icons/Adwaita/scalable/apps',
			'/usr/share/icons/Adwaita/48x48/apps',
			'/usr/share/pixmaps',
			join(home, '.local/share/icons/hicolor/scalable/apps'),
			join(home, '.local/share/icons/hicolor/128x128/apps'),
			join(home, '.local/share/icons'),
		]
		for (const dir of subdirs) {
			for (const ext of exts) {
				const cand = join(dir, `${iconName}${ext}`)
				if (await exists(cand)) {
					const real = await realpath(cand).catch(() => null)
					if (real && (await isAllowedIconPath(real))) return real
				}
			}
		}
		return null
	}

	function resolveDesktopAppDirs() {
		if (appDirs) return appDirs
		const {dataHome, dataDirs} = resolveXdgDataEnv()
		const dirs = [join(dataHome, 'applications')]
		for (const d of dataDirs) {
			const p = join(d, 'applications')
			if (!dirs.includes(p)) dirs.push(p)
		}
		return dirs
	}

	async function apps({refresh = false} = {}) {
		if (!refresh && appsCache.list.length && Date.now() - appsCache.at < 60_000) {
			return appsCache.list
		}
		if (appsScanPromise) return appsScanPromise
		appsScanPromise = (async () => {
			const dirs = resolveDesktopAppDirs()
			const reservedIds = new Set()
			const seen = new Map()
			const iconMap = new Map()
			for (const dir of dirs) {
				const files = await readdir(dir).catch(() => [])
				for (const file of files) {
					if (!file.endsWith('.desktop')) continue
					const id = file.slice(0, -'.desktop'.length)
					if (!DESKTOP_ID_RE.test(id) || reservedIds.has(id)) continue
					const rawBuf = await readBoundedRegularFile(join(dir, file), 64 * 1024)
					if (!rawBuf) continue
					// Reserve ID on the highest-priority desktop file so Hidden=true / NoDisplay=true properly shadows lower-priority system entries.
					reservedIds.add(id)
					const parsed = parseDesktopEntry(rawBuf.toString('utf8'), id)
					if (!parsed) continue
					const iconPath = await resolveIconPath(parsed.icon)
					if (iconPath) iconMap.set(id, iconPath)
					seen.set(id, {
						id: parsed.id,
						name: parsed.name,
						comment: parsed.comment,
						categories: parsed.categories,
						terminal: parsed.terminal,
						wmClass: parsed.wmClass,
						hasIcon: !!iconPath,
					})
				}
			}
			const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
			appsCache = {at: Date.now(), list, iconPaths: iconMap}
			return list
		})().finally(() => {
			appsScanPromise = null
		})
		return appsScanPromise
	}

	async function readAppIcon(id) {
		const clean = String(id ?? '')
		if (!DESKTOP_ID_RE.test(clean)) return null
		if (!appsCache.list.length) await apps()
		const file = appsCache.iconPaths.get(clean)
		if (!file) return null
		const real = await realpath(resolve(file)).catch(() => null)
		if (!real || !(await isAllowedIconPath(real))) return null
		// Verify canonical target, open once with O_NOFOLLOW, and bind containment to the opened descriptor before reading any bytes.
		let fh = null
		try {
			fh = await fsOpen(real, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0))
			const st = await fh.stat()
			if (!st.isFile() || st.size > 2 * 1024 * 1024) return null
			// Bind the opened descriptor's kernel path (Linux /proc/self/fd) and post-open (dev, ino) to an allowed icon root so an ancestor swap cannot escape the jail.
			const procFdReal = await realpath(`/proc/self/fd/${fh.fd}`).catch(() => null)
			if (procFdReal) {
				if (!(await isAllowedIconPath(procFdReal))) return null
			} else {
				const postReal = await realpath(real).catch(() => null)
				const postStat = postReal ? await lstat(postReal).catch(() => null) : null
				if (!postReal || !postStat || postStat.dev !== st.dev || postStat.ino !== st.ino || !(await isAllowedIconPath(postReal))) {
					return null
				}
			}
			const buf = Buffer.allocUnsafe(st.size + 1)
			let total = 0
			while (total <= 2 * 1024 * 1024) {
				const {bytesRead} = await fh.read(buf, total, buf.length - total, null)
				if (bytesRead <= 0) break
				total += bytesRead
				if (total > 2 * 1024 * 1024) return null
			}
			const data = buf.subarray(0, total)
			const ext = extname(real).toLowerCase()
			const contentType = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : null
			if (!contentType) return null
			return {data, contentType}
		} catch {
			return null
		} finally {
			await fh?.close().catch(() => {})
		}
	}

	// ---- Real-time Hyprland .socket2.sock IPC event bus -----------------------------------------
	function emitEvent(evt) {
		for (const fn of [...eventListeners]) {
			try {
				fn(evt)
			} catch {}
		}
	}

	function parseSocket2Line(line) {
		const sep = line.indexOf('>>')
		if (sep <= 0) return null
		const kind = line.slice(0, sep)
		const rest = line.slice(sep + 2)
		if (kind === 'openwindow') {
			const p = rest.split(',')
			if (p.length >= 4) {
				const addr = p[0].startsWith('0x') ? p[0] : `0x${p[0]}`
				return {type: 'openwindow', address: addr, workspace: p[1], class: p[2], title: p.slice(3).join(',')}
			}
		} else if (kind === 'closewindow') {
			const addr = rest.startsWith('0x') ? rest : `0x${rest}`
			return {type: 'closewindow', address: addr}
		} else if (kind === 'windowtitlev2') {
			const c = rest.indexOf(',')
			if (c > 0) {
				const rawAddr = rest.slice(0, c)
				const addr = rawAddr.startsWith('0x') ? rawAddr : `0x${rawAddr}`
				return {type: 'windowtitle', address: addr, title: rest.slice(c + 1)}
			}
		} else if (kind === 'activewindowv2') {
			const addr = rest.startsWith('0x') ? rest : `0x${rest}`
			return {type: 'activewindow', address: addr}
		} else if (kind === 'movewindowv2' || kind === 'changefloatingmode' || kind === 'fullscreen') {
			return {type: 'layoutchange'}
		}
		return null
	}

	function scheduleEventReconnect() {
		if (busClosed || eventListeners.size === 0 || eventReconnectTimer || eventSock) return
		eventReconnectTimer = setTimeout(() => {
			eventReconnectTimer = null
			ensureEventSocket().catch(() => {})
		}, 2000)
		eventReconnectTimer.unref?.()
	}

	let eventSockReady = false
	let eventSnapSeq = 0
	const eventReadyWaiters = new Set()
	function notifyEventReady() {
		for (const fn of [...eventReadyWaiters]) {
			eventReadyWaiters.delete(fn)
			try {
				fn()
			} catch {}
		}
	}
	function waitForEventSocketReady(timeoutMs = 1500) {
		if (eventSockReady && eventSock) return Promise.resolve(true)
		return new Promise((resolveReady) => {
			let done = false
			const finish = (ok) => {
				if (done) return
				done = true
				clearTimeout(t)
				eventReadyWaiters.delete(onReady)
				resolveReady(ok)
			}
			const onReady = () => finish(true)
			eventReadyWaiters.add(onReady)
			const t = setTimeout(() => finish(false), timeoutMs)
			t.unref?.()
			ensureEventSocket().catch(() => {})
		})
	}

	async function ensureEventSocket() {
		if (busClosed || eventSock || eventSockConnecting || eventListeners.size === 0) return
		eventSockConnecting = true
		try {
			const env = await discoverEnv()
			if (busClosed || eventListeners.size === 0 || eventSock) return
			if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
				scheduleEventReconnect()
				return
			}
			const instanceId = env.HYPRLAND_INSTANCE_SIGNATURE
			const sockPath = join(env.XDG_RUNTIME_DIR, 'hypr', instanceId, '.socket2.sock')
			if (!(await exists(sockPath))) {
				scheduleEventReconnect()
				return
			}
			if (busClosed || eventListeners.size === 0 || eventSock) return
			currentEventInstance = instanceId
			const sock = net.connect(sockPath)
			eventSock = sock
			eventSockReady = false
			let buf = ''
			let buffering = true
			let bufferOverflow = false
			const bufferedEvts = []
			let resyncTimer = null
			const dispatchParsed = (evt) => {
				if (evt.type === 'layoutchange') {
					if (activeStreams.size > 0) syncAllStreamRects().catch(() => {})
				} else {
					if (evt.type === 'activewindow') lastFocusedAddr = String(evt.address || '').toLowerCase()
					emitEvent(evt)
				}
			}
			const syncAuthoritative = () => {
				if (busClosed || eventSock !== sock) return
				buffering = true
				bufferOverflow = false
				bufferedEvts.length = 0
				const snapSeq = ++eventSnapSeq
				windowsSnapshot()
					.then((snap) => {
						if (busClosed || eventSock !== sock) return
						if (bufferOverflow) {
							syncAuthoritative()
							return
						}
						emitEvent({type: 'windows', instanceId, windows: snap, authoritative: true, seq: snapSeq})
						buffering = false
						for (const evt of bufferedEvts.splice(0)) {
							if (!busClosed && eventSock === sock) dispatchParsed(evt)
						}
					})
					.catch(() => {
						if (busClosed || eventSock !== sock) return
						// Never resume incremental events on stale state; retry authoritative snapshot until it succeeds or socket drops.
						resyncTimer = setTimeout(() => {
							resyncTimer = null
							syncAuthoritative()
						}, 750)
						resyncTimer.unref?.()
					})
			}
			sock.setEncoding('utf8')
			sock.on('data', (chunk) => {
				buf += chunk
				if (buf.length > 64 * 1024 && !buf.includes('\n')) {
					buf = ''
					return
				}
				const lines = buf.split('\n')
				buf = lines.pop() ?? ''
				if (buf.length > 64 * 1024) buf = ''
				for (const line of lines) {
					if (line.length > 16 * 1024) continue
					const evt = parseSocket2Line(line.trim())
					if (!evt) continue
					if (buffering) {
						if (bufferedEvts.length >= 256) bufferOverflow = true
						else bufferedEvts.push(evt)
					} else {
						dispatchParsed(evt)
					}
				}
			})
			sock.once('connect', () => {
				if (busClosed || eventSock !== sock) return
				eventSockReady = true
				notifyEventReady()
				syncAuthoritative()
			})
			const onEnd = () => {
				if (resyncTimer) {
					clearTimeout(resyncTimer)
					resyncTimer = null
				}
				if (eventSock === sock) {
					eventSock = null
					eventSockReady = false
				}
				scheduleEventReconnect()
			}
			sock.on('error', onEnd)
			sock.on('close', onEnd)
		} finally {
			eventSockConnecting = false
		}
	}

	function subscribeEvents(listener) {
		if (busClosed || eventListeners.size >= MAX_SSE_SUBSCRIBERS) return null
		eventListeners.add(listener)
		ensureEventSocket().catch(() => {})
		return () => {
			eventListeners.delete(listener)
			if (eventListeners.size === 0 && eventSock) {
				try {
					eventSock.destroy()
				} catch {}
				eventSock = null
			}
		}
	}

	// Detect whether Wayland ext_session_lock_v1 (e.g. Omarchy shell lockscreen) is holding pointer/keyboard input.
	// Returns true (locked), false (unlocked), or null (unknown/probe failed) so transient hyprctl failures never fabricate an unlock.
	async function isSessionLocked() {
		try {
			const rawMons = await hyprctl(['monitors', '-j'])
			const parsedMons = JSON.parse(rawMons || '[]')
			if (!Array.isArray(parsedMons)) return null
			const mons = parsedMons.map((m) => ({
				locked: Array.isArray(m.solitaryBlockedBy) && m.solitaryBlockedBy.includes('LOCK'),
				hasLockInfo: Array.isArray(m.solitaryBlockedBy),
			}))
			if (mons.some((m) => m.locked)) return true
			// When Hyprland reports solitaryBlockedBy, trust it directly so an unlocked empty workspace is never misclassified as locked.
			if (mons.some((m) => m.hasLockInfo)) return false
			const wins = await windows({strict: true})
			if (!wins.length) return false
			const raw = await hyprctl(['activewindow', '-j'])
			const active = JSON.parse(raw || '{}')
			return !active || !active.address
		} catch {
			return null
		}
	}

	// ---- Status, Windows, Dispatch --------------------------------------------------------------
	async function status() {
		const env = await discoverEnv()
		const hasVaapi = await exists(vaapiDevice)
		// Never block the fast status RPC on a 10-30s cold gcc compile; kick off compile in background if needed.
		let hasNativeCapture = !!(compiledBin && (await exists(compiledBin)))
		if (!hasNativeCapture && env?.WAYLAND_DISPLAY && hasVaapi) {
			ensureCaptureBinary().catch(() => {})
		}
		const hasFfmpeg = hasNativeCapture || (await exec('ffmpeg', ['-version'], {timeout: 3000})).ok
		const hasPython = (await exec('python3', ['--version'], {timeout: 3000})).ok
		const available = !!(env?.WAYLAND_DISPLAY && env?.HYPRLAND_INSTANCE_SIGNATURE && (hasNativeCapture || (hasFfmpeg && hasPython)))
		const [monitors, rawLocked] = available ? await Promise.all([monitorsInfo(), isSessionLocked()]) : [[], false]
		const sessionLocked = rawLocked === true
		return {
			available,
			wayland: env?.WAYLAND_DISPLAY ?? null,
			vaapi: hasVaapi,
			nativeEngine: hasNativeCapture,
			railReady: available,
			sessionLocked,
			encoder: hasNativeCapture ? 'h264_vaapi_dmabuf' : hasVaapi ? 'h264_vaapi' : hasFfmpeg ? 'libx264' : null,
			monitors,
			activeStreams: activeStreams.size,
		}
	}

	async function windows({strict = false} = {}) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			if (strict) throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session is unavailable')
			return []
		}
		const raw = await hyprctl(['clients', '-j'])
		const list = strict ? JSON.parse(raw) : JSON.parse(raw || '[]')
		if (!Array.isArray(list)) {
			if (strict) throw new RpcError('BAD_GATEWAY', 'Unexpected hyprctl clients response')
			return []
		}
		return list
			.filter((c) => c && c.mapped !== false && ADDRESS_RE.test(String(c.address ?? '')))
			.map((c) => ({
				address: String(c.address),
				title: String(c.title || c.initialTitle || c.class || 'Window').slice(0, 140),
				class: String(c.class || c.initialClass || '').slice(0, 80),
				workspace: Number.isInteger(c.workspace?.id) ? c.workspace.id : null,
				at: Array.isArray(c.at) ? [Number(c.at[0]) || 0, Number(c.at[1]) || 0] : [0, 0],
				size: Array.isArray(c.size) ? [Number(c.size[0]) || 0, Number(c.size[1]) || 0] : [0, 0],
				floating: !!c.floating,
				fullscreen: !!c.fullscreen,
				pid: Number(c.pid) || 0,
			}))
			.sort((a, b) => a.workspace - b.workspace || a.title.localeCompare(b.title))
	}

	const windowsSnapshot = () => windows({strict: true})

	// Push updated window or monitor logical rect straight to live streams so pointer clicks stay pixel-perfect across multi-monitor layouts.
	function writeRectForEntry(entry, mons, wins) {
		const b = layoutBounds(mons)
		let rect = null
		if (entry.mode === 'window' && entry.address) {
			const w = wins.find((x) => x.address.toLowerCase() === entry.address.toLowerCase())
			if (w) rect = {x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1]}
		} else if (entry.mode === 'output') {
			const m = (entry.output ? mons.find((x) => x.name === entry.output) : null) ?? mons[0]
			if (m) {
				const sc = m.scale > 0 ? m.scale : 1
				rect = {x: m.x, y: m.y, w: Math.round(m.width / sc), h: Math.round(m.height / sc)}
			}
		}
		if (!rect) return
		const msg = JSON.stringify({type: 'win_rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, lx: b.lx, ly: b.ly, lw: b.lw, lh: b.lh}) + '\n'
		try {
			if (entry.child.stdin?.writable) entry.child.stdin.write(msg)
		} catch {}
	}

	async function syncStreamRect(address) {
		const target = String(address).toLowerCase()
		const matching = [...activeStreams].filter((s) => s.address && s.address.toLowerCase() === target)
		if (!matching.length) return
		const [mons, wins] = await Promise.all([monitorsInfo(), windows().catch(() => [])])
		for (const s of matching) writeRectForEntry(s, mons, wins)
	}

	async function syncAllStreamRects() {
		if (activeStreams.size === 0) return
		const [mons, wins] = await Promise.all([monitorsInfo(), windows().catch(() => [])])
		for (const s of [...activeStreams]) writeRectForEntry(s, mons, wins)
	}

	async function notifyUnlocked() {
		await new Promise((r) => setTimeout(r, 300))
		const seq = ++lockProbeSeq
		const locked = await isSessionLocked().catch(() => null)
		if (locked === null) return
		if (seq < lastAppliedLockSeq) return
		lastAppliedLockSeq = seq
		lastLockedState = locked
		for (const s of [...activeStreams]) {
			if (s.ws.readyState === s.ws.OPEN) {
				try {
					s.ws.send(JSON.stringify({type: 'lock', locked}))
				} catch {}
			}
		}
		if (!locked) {
			await wakeRailOutput()
			await syncAllStreamRects().catch(() => {})
			const lastWin = [...activeStreams].reverse().find((s) => s.mode === 'window' && s.address)
			if (lastWin) {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.focus({window = "address:${lastWin.address}"}))`,
					['dispatch', 'focuswindow', `address:${lastWin.address}`],
				).catch(() => {})
			}
		}
	}

	function applyLockState(locked, {hadViewer = activeStreams.size > 0, seq = ++lockProbeSeq} = {}) {
		if (locked === null) return
		if (seq < lastAppliedLockSeq) return
		lastAppliedLockSeq = seq
		if (locked === lastLockedState) return
		const prev = lastLockedState
		lastLockedState = locked
		// Initial unlocked state on first connect needs no redundant unlock broadcast.
		if (prev === null && !locked) return
		if (prev === true && !locked && hadViewer) {
			onRemoteUnlock?.()
		}
		for (const s of [...activeStreams]) {
			if (s.ws.readyState === s.ws.OPEN) {
				try {
					s.ws.send(JSON.stringify({type: 'lock', locked}))
				} catch {}
			}
		}
		if (!locked) {
			const lastWin = [...activeStreams].reverse().find((s) => s.mode === 'window' && s.address)
			if (lastWin) {
				hyprDispatch(
					`hl.dispatch(hl.dsp.focus({window = "address:${lastWin.address}"}))`,
					['dispatch', 'focuswindow', `address:${lastWin.address}`],
				).catch(() => {})
			}
		}
	}

	function ensureRectSyncTimer() {
		if (activeStreams.size > 0 && !rectSyncTimer) {
			rectSyncTimer = setInterval(() => {
				if (activeStreams.size === 0) {
					clearInterval(rectSyncTimer)
					rectSyncTimer = null
					return
				}
				monitorsInfo()
					.then((mons) => {
						const rail = mons.find((m) => m.name === RAIL_OUTPUT)
						if (rail && !rail.dpmsStatus) return wakeRailOutput()
					})
					.catch(() => {})
				const hadViewer = activeStreams.size > 0
				const seq = ++lockProbeSeq
				isSessionLocked()
					.then((locked) => applyLockState(locked, {hadViewer: hadViewer || activeStreams.size > 0, seq}))
					.catch(() => {})
				syncAllStreamRects().catch(() => {})
			}, 1200)
			rectSyncTimer.unref?.()
		} else if (activeStreams.size === 0 && rectSyncTimer) {
			clearInterval(rectSyncTimer)
			rectSyncTimer = null
		}
	}

	// Sanitize browser input messages strictly before forwarding to the C/Python stream engine.
	function sanitizeInputMsg(msg) {
		if (!msg || typeof msg !== 'object') return null
		const clamp = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null)
		if (msg.type === 'keyframe') return {type: 'keyframe'}
		if (msg.type === 'pointer_move') {
			const x = clamp(msg.x, 0, 1)
			const y = clamp(msg.y, 0, 1)
			if (x === null || y === null) return null
			return {type: 'pointer_move', x, y}
		}
		if (msg.type === 'pointer_button') {
			const btn = clamp(msg.button, 272, 279)
			if (btn === null || typeof msg.down !== 'boolean') return null
			const out = {type: 'pointer_button', button: Math.round(btn), down: msg.down}
			const x = clamp(msg.x, 0, 1)
			const y = clamp(msg.y, 0, 1)
			if (x !== null && y !== null) {
				out.x = x
				out.y = y
			}
			return out
		}
		if (msg.type === 'pointer_scroll') {
			const dx = clamp(msg.dx ?? 0, -10000, 10000) ?? 0
			const dy = clamp(msg.dy ?? 0, -10000, 10000) ?? 0
			return {type: 'pointer_scroll', dx, dy}
		}
		if (msg.type === 'key') {
			const code = clamp(msg.code, 1, 247)
			if (code === null || typeof msg.down !== 'boolean') return null
			const out = {type: 'key', code: Math.round(code), down: msg.down}
			const mods = clamp(msg.mods, 0, 255)
			if (mods !== null) out.mods = Math.round(mods)
			return out
		}
		if (msg.type === 'audio' && typeof msg.enabled === 'boolean') {
			const out = {type: 'audio', enabled: msg.enabled}
			if (msg.codec === 'pcm' || msg.codec === 'opus') out.codec = msg.codec
			return out
		}
		if (msg.type === 'unlock_check') return {type: 'unlock_check'}
		if (msg.type === 'reconfig') {
			const out = {type: 'reconfig'}
			const br = clamp(msg.bitrate, 1000, 150000)
			if (br !== null) out.bitrate = Math.round(br)
			const q = clamp(msg.quality, 0, 34)
			if (q !== null && (q === 0 || q >= 10)) out.quality = Math.round(q)
			if (msg.codec === 'h264' || msg.codec === 'hevc' || msg.codec === 'hevc10' || msg.codec === 'hevc444') {
				out.codec = msg.codec
			}
			return out
		}
		return null
	}

	const claimedLaunchAddrs = new Map() // lowercase address -> timestamp
	const pendingLaunches = new Set() // {app}

	function matchesLaunchedApp(app, winClass, winTitle = '') {
		// Preserve punctuation (hyphens, dots, underscores) so distinct classes like "foo-bar" and "foobar" never collide.
		const norm = (s) => String(s || '').trim().toLowerCase()
		const cls = norm(winClass)
		const title = norm(winTitle)
		if (!cls && !title) return false
		// When the desktop entry declares StartupWMClass, require an exact case-insensitive class match.
		if (app.wmClass) {
			const expected = norm(app.wmClass)
			return !!cls && !!expected && cls === expected
		}
		const targets = new Set()
		if (app.id) {
			const idLeaf = app.id.includes('.') ? app.id.split('.').at(-1) : app.id
			targets.add(norm(app.id))
			if (idLeaf) targets.add(norm(idLeaf))
		}
		if (app.name) targets.add(norm(app.name))
		targets.delete('')
		if (cls) {
			for (const t of targets) {
				if (t.length >= 3 && cls === t) return true
			}
			return false
		}
		if (title) {
			for (const t of targets) {
				if (t.length >= 4 && title === t) return true
			}
		}
		return false
	}

	// Launch an allowlisted installed `.desktop` app onto the headless RAIL output and return its newly mapped window.
	async function launch(input = {}) {
		const id = String(input.id ?? '').trim()
		if (!DESKTOP_ID_RE.test(id)) throw new RpcError('BAD_REQUEST', 'Invalid application ID')
		// Reserve launch capacity synchronously BEFORE the first await so concurrent requests cannot race past MAX_PENDING_LAUNCHES.
		if (pendingLaunches.size >= MAX_PENDING_LAUNCHES) {
			throw new RpcError('TOO_MANY_REQUESTS', 'Too many applications are launching at once; wait a moment and try again')
		}
		const launchEntry = {app: null, markAmbiguous: () => {}}
		pendingLaunches.add(launchEntry)

		let settled = false
		let openedAddr = null
		let openedWs = null
		let ambiguous = false
		let launchErr = null
		let pollTimer = null
		let deadlineTimer = null
		let unsub = null

		try {
			const catalog = await apps()
			const app = catalog.find((a) => a.id === id)
			if (!app) throw new RpcError('NOT_FOUND', `Application “${id}” is not installed`)
			const env = await discoverEnv()
			if (!env?.WAYLAND_DISPLAY || !env?.HYPRLAND_INSTANCE_SIGNATURE) {
				throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
			}
			const railMon = await ensureRailOutput()
			if (!railMon || !Number.isInteger(railMon.activeWorkspace) || railMon.activeWorkspace < 1 || railMon.activeWorkspace > 99) {
				throw new RpcError('PRECONDITION_FAILED', 'Headless RAIL-1 display is unavailable; refusing to launch on physical display')
			}
			const railWs = railMon.activeWorkspace
			const reqW = Math.max(360, Math.min(3840, Math.round(Number(input.width) || 1100)))
			const reqH = Math.max(260, Math.min(2160, Math.round(Number(input.height) || 740)))

			// Prune stale claims older than 30s
			const nowMs = Date.now()
			for (const [k, ts] of claimedLaunchAddrs) {
				if (nowMs - ts > 30_000) claimedLaunchAddrs.delete(k)
			}

			// Switch active workspace to RAIL-1 and capture strict window baseline BEFORE spawning so physical-display windows are never treated as new.
			await hyprDispatch(`hl.dispatch(hl.dsp.focus({workspace = ${railWs}}))`, ['dispatch', 'workspace', String(railWs)])
			const baselineWins = await windows({strict: true})
			const beforeAddrs = new Set(baselineWins.map((w) => w.address.toLowerCase()))

			let resolveOpen
			const openPromise = new Promise((r) => (resolveOpen = r))
			const markAmbiguous = () => {
				if (settled) return
				settled = true
				ambiguous = true
				resolveOpen(null)
			}
			launchEntry.app = app
			launchEntry.markAmbiguous = markAmbiguous

			const findAmbiguousPeers = (winClass, winTitle) => {
				const peers = []
				for (const peer of pendingLaunches) {
					if (peer === launchEntry || !peer.app) continue
					if (matchesLaunchedApp(peer.app, winClass, winTitle)) peers.push(peer)
				}
				return peers
			}

			// Claim the new window of this app wherever Hyprland put it. Focus can leave RAIL-1 before the
			// app maps its window (a physical-display click, the screen-share view, an app that reuses its
			// running process like Chrome), and the window then opened on the physical display: the launch
			// used to wait 15 s, give up, and the app never showed. Only a window that did not exist when
			// this launch started and that matches this app is claimed; it is then moved to RAIL-1 below.
			const canClaim = (addr, winWorkspace, winClass, winTitle) => {
				const lower = String(addr || '').toLowerCase()
				if (!lower || beforeAddrs.has(lower) || claimedLaunchAddrs.has(lower)) return false
				const wsNum = Number(winWorkspace)
				if (!Number.isInteger(wsNum) || wsNum < 1) return false
				return matchesLaunchedApp(app, winClass, winTitle)
			}

			const tryClaim = (addr, winWorkspace, winClass, winTitle) => {
				if (settled) return false
				if (!canClaim(addr, winWorkspace, winClass, winTitle)) return false
				const peers = findAmbiguousPeers(winClass, winTitle)
				if (peers.length > 0) {
					markAmbiguous()
					for (const peer of peers) peer.markAmbiguous()
					return false
				}
				settled = true
				openedAddr = addr
				openedWs = Number(winWorkspace)
				claimedLaunchAddrs.set(String(addr).toLowerCase(), Date.now())
				resolveOpen(addr)
				return true
			}

			const launchEnv = await cleanGuiEnv(env)
			unsub = subscribeEvents((evt) => {
				if (settled) return
				if (evt.type === 'openwindow') {
					tryClaim(evt.address, evt.workspace, evt.class, evt.title)
				}
			})
			const child = spawnImpl('gtk-launch', [id], {env: launchEnv, detached: true, stdio: 'ignore'})
			child.once('error', (err) => {
				if (!settled) {
					settled = true
					launchErr = new RpcError('BAD_GATEWAY', `Failed to launch “${id}”: ${err?.message || 'gtk-launch unavailable'}`)
					resolveOpen(null)
				}
			})
			child.once('exit', (code) => {
				if (!settled && typeof code === 'number' && code !== 0) {
					settled = true
					launchErr = new RpcError('BAD_GATEWAY', `Application launcher exited with status ${code}`)
					resolveOpen(null)
				}
			})
			child.unref?.()

			// Sequential poll loop (never overlapping hyprctl calls); checks settled immediately before claiming.
			const schedulePoll = () => {
				if (settled) return
				pollTimer = setTimeout(async () => {
					pollTimer = null
					if (settled) return
					const cur = await windows({strict: true}).catch(() => null)
					if (settled || !Array.isArray(cur)) {
						if (!settled) schedulePoll()
						return
					}
					const matches = cur.filter((w) => canClaim(w.address, w.workspace, w.class, w.title))
					if (matches.length > 1) {
						markAmbiguous()
						for (const m of matches) {
							for (const peer of findAmbiguousPeers(m.class, m.title)) peer.markAmbiguous()
						}
						return
					}
					if (matches.length === 1) {
						tryClaim(matches[0].address, matches[0].workspace, matches[0].class, matches[0].title)
						return
					}
					schedulePoll()
				}, 450)
				pollTimer.unref?.()
			}
			schedulePoll()
			deadlineTimer = setTimeout(() => {
				if (!settled) {
					settled = true
					resolveOpen(null)
				}
			}, 15_000)
			await openPromise
			if (deadlineTimer) {
				clearTimeout(deadlineTimer)
				deadlineTimer = null
			}
			if (pollTimer) {
				clearTimeout(pollTimer)
				pollTimer = null
			}
			if (launchErr) throw launchErr
			if (ambiguous || !openedAddr) {
				return {launched: true, app, window: null, ...(ambiguous ? {ambiguous: true} : {})}
			}

			// Wake RAIL-1 BEFORE checking ownership, then revalidate RAIL workspace immediately before every mutation so a window moved to a physical workspace is never touched.
			await wakeRailOutput()
			let list = await windows({strict: true}).catch(() => [])
			let win = list.find((w) => w.address.toLowerCase() === openedAddr.toLowerCase())
			// Only a window that opened elsewhere is brought over; one that opened on RAIL-1 and was then
			// moved away (by the person, say) is left where they put it.
			if (win && win.workspace !== railWs && openedWs !== railWs && win.workspace === openedWs) {
				// It opened on another display: bring it to RAIL-1 (silently, so focus doesn't jump).
				await hyprDispatch(
					`hl.dispatch(hl.dsp.window.move({window = "address:${win.address}", workspace = ${railWs}, silent = true}))`,
					['dispatch', 'movetoworkspacesilent', `${railWs},address:${win.address}`],
				).catch(() => {})
				list = await windows({strict: true}).catch(() => [])
				win = list.find((w) => w.address.toLowerCase() === openedAddr.toLowerCase())
			}
			if (!win || win.workspace !== railWs) {
				return {launched: true, app, window: null}
			}
			if (!win.floating) {
				const checkFloatOwnership = async () => {
					const cur = await windows({strict: true}).catch(() => [])
					const found = cur.find((w) => w.address.toLowerCase() === win.address.toLowerCase())
					return !!found && found.workspace === railWs
				}
				const floated = await hyprDispatch(
					`hl.dispatch(hl.dsp.window.float({window = "address:${win.address}", action = "set"}))`,
					['dispatch', 'setfloating', `address:${win.address}`],
					{beforeAttempt: checkFloatOwnership},
				)
				if (floated === null) {
					return {launched: true, app, window: null}
				}
			}
			const placed = await placeOnRail(win.address, reqW, reqH, {strict: true, expectedWorkspace: railWs})
			if (!placed) {
				return {launched: true, app, window: null}
			}
			await new Promise((r) => setTimeout(r, 150))
			const [freshMons, freshWins] = await Promise.all([monitorsInfo(), windows({strict: true}).catch(() => [])])
			const freshRail = freshMons.find((m) => m.name === RAIL_OUTPUT)
			const updated = freshWins.find((w) => w.address.toLowerCase() === win.address.toLowerCase())
			if (!freshRail || !Number.isInteger(freshRail.activeWorkspace) || !updated || updated.workspace !== freshRail.activeWorkspace) {
				throw new RpcError('BAD_GATEWAY', 'Launched window could not be verified on the RAIL-1 workspace')
			}
			return {launched: true, app, window: updated}
		} finally {
			settled = true
			pendingLaunches.delete(launchEntry)
			if (deadlineTimer) clearTimeout(deadlineTimer)
			if (pollTimer) clearTimeout(pollTimer)
			unsub?.()
		}
	}

	async function clipboardRead() {
		const env = await discoverEnv()
		if (!env?.WAYLAND_DISPLAY) throw new RpcError('PRECONDITION_FAILED', 'Wayland display unavailable')
		const r = await exec('wl-paste', ['--no-newline', '--type', 'text/plain;charset=utf-8'], {env, timeout: 2000, maxBuffer: MAX_CLIPBOARD_BYTES + 4096})
		if (!r.ok) {
			if (r.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
				throw new RpcError('PAYLOAD_TOO_LARGE', 'Wayland clipboard text exceeds 128 KiB limit')
			}
			const msg = r.stderr.trim().toLowerCase()
			if (msg.includes('nothing is copied') || msg.includes('no selection') || msg.includes('clipboard is empty') || msg.includes('no matching type')) {
				return {text: ''}
			}
			throw new RpcError('INTERNAL_SERVER_ERROR', r.stderr.trim() || 'Failed to read Wayland clipboard')
		}
		if (Buffer.byteLength(r.stdout, 'utf8') > MAX_CLIPBOARD_BYTES) {
			throw new RpcError('PAYLOAD_TOO_LARGE', 'Wayland clipboard text exceeds 128 KiB limit')
		}
		return {text: r.stdout}
	}

	async function clipboardWrite(input = {}) {
		const text = String(input.text ?? '')
		if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) throw new RpcError('PAYLOAD_TOO_LARGE', 'Clipboard text too large')
		const env = await discoverEnv()
		if (!env?.WAYLAND_DISPLAY) throw new RpcError('PRECONDITION_FAILED', 'Wayland display unavailable')
		const r = await exec('wl-copy', [], {env, timeout: 2000, input: text})
		if (!r.ok) throw new RpcError('INTERNAL_SERVER_ERROR', r.stderr.trim() || 'Failed to update Wayland clipboard')
		return true
	}

	// Strict allowlisted Hyprland window controls (never arbitrary exec/shell).
	async function dispatch(input = {}) {
		const action = String(input.action ?? '')
		if (action === 'focus') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			await hyprDispatch(`hl.dispatch(hl.dsp.focus({window = "address:${addr}"}))`, ['dispatch', 'focuswindow', `address:${addr}`])
			await syncStreamRect(addr).catch(() => {})
			return true
		}
		if (action === 'close') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			await hyprDispatch(`hl.dispatch(hl.dsp.window.close({window = "address:${addr}"}))`, ['dispatch', 'closewindow', `address:${addr}`])
			return true
		}
		if (action === 'resize') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			const w = Math.max(240, Math.min(3840, Math.round(Number(input.width) || 0)))
			const h = Math.max(180, Math.min(2160, Math.round(Number(input.height) || 0)))
			const cur = (await windows().catch(() => [])).find((x) => x.address.toLowerCase() === addr.toLowerCase())
			if (cur && !cur.floating) {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.window.float({window = "address:${addr}", action = "set"}))`,
					['dispatch', 'setfloating', `address:${addr}`],
				).catch(() => {})
			}
			const mons = await monitorsInfo()
			const rail = mons.find((m) => m.name === RAIL_OUTPUT)
			if (rail && cur && cur.workspace === rail.activeWorkspace) {
				await placeOnRail(addr, w, h)
			} else {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.window.resize({window = "address:${addr}", x = ${w}, y = ${h}, relative = false}))`,
					['dispatch', 'resizewindowpixel', `exact ${w} ${h},address:${addr}`],
				)
			}
			await syncStreamRect(addr).catch(() => {})
			return true
		}
		if (action === 'moveToRail') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			const railMon = await ensureRailOutput()
			const railWs = Number.isInteger(railMon?.activeWorkspace) && railMon.activeWorkspace >= 1 && railMon.activeWorkspace <= 99 ? railMon.activeWorkspace : 11
			await hyprDispatch(
				`hl.dispatch(hl.dsp.window.move({window = "address:${addr}", workspace = ${railWs}, silent = true}))`,
				['dispatch', 'movetoworkspacesilent', `${railWs},address:${addr}`],
			)
			await syncStreamRect(addr).catch(() => {})
			return {workspace: railWs}
		}
		if (action === 'workspace') {
			const id = Number(input.workspace)
			if (!Number.isInteger(id) || id < 1 || id > 20) throw new RpcError('BAD_REQUEST', 'Invalid workspace')
			await hyprDispatch(`hl.dispatch(hl.dsp.focus({workspace = ${id}}))`, ['dispatch', 'workspace', String(id)])
			return true
		}
		throw new RpcError('BAD_REQUEST', 'Unsupported Hyprland action')
	}

	let disconnectLockRetryTimer = null

	// ---- Stream Profiler & Per-Device Saved Profiles --------------------------------------------
	const profilesPath = join(dataDir, 'hyprland-profiles.json')
	let profileStoreChain = Promise.resolve()
	let profileBenchChain = Promise.resolve()
	let stuckBenchChild = null
	let profileTmpSeq = 0
	let profileResetGen = 0

	function withProfileStoreLock(fn) {
		const run = profileStoreChain.then(fn, fn)
		profileStoreChain = run.then(() => {}, () => {})
		return run
	}

	function withProfileBenchLock(fn) {
		const run = profileBenchChain.then(fn, fn)
		profileBenchChain = run.then(() => {}, () => {})
		return run
	}

	function resetProfiles() {
		profileResetGen++
		return withProfileStoreLock(async () => {
			await rm(profilesPath, {force: true})
		})
	}

	function codecFromEncoderName(encoderName, fallbackCodec) {
		const name = String(encoderName || '').toLowerCase()
		if (name.startsWith('hevc444')) return 'hevc444'
		if (name.startsWith('hevc10')) return 'hevc10'
		if (name.startsWith('hevc')) return 'hevc'
		if (name.startsWith('h264') || name.includes('264')) return 'h264'
		return fallbackCodec
	}

	const VALID_CODECS = new Set(['hevc444', 'hevc10', 'hevc', 'h264'])

	function sanitizeProfile(raw, fallbackId = '', {strict = false} = {}) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
		let id
		if (strict) {
			if (raw.id !== undefined) {
				if (typeof raw.id !== 'string') return null
				const trimmed = raw.id.trim()
				if (!PROFILE_ID_RE.test(trimmed)) return null
				id = trimmed
			} else {
				const trimmed = String(fallbackId ?? '').trim()
				if (!PROFILE_ID_RE.test(trimmed)) return null
				id = trimmed
			}
		} else {
			const hasExplicitId = raw.id !== undefined && raw.id !== null && String(raw.id).trim() !== ''
			id = hasExplicitId
				? String(raw.id).trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
				: String(fallbackId ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
		}
		if (!PROFILE_ID_RE.test(id)) return null
		let codec
		if (strict) {
			if (typeof raw.codec !== 'string' || !VALID_CODECS.has(raw.codec)) return null
			codec = raw.codec
		} else {
			codec = VALID_CODECS.has(raw.codec) ? raw.codec : 'h264'
		}
		const rawFps = raw.fps === undefined ? 60 : Number(raw.fps)
		const rawBitrate = raw.bitrate === undefined ? 22000 : Number(raw.bitrate)
		const rawQuality = raw.quality === undefined ? 20 : Number(raw.quality)
		const rawCompression = raw.compression === undefined ? 7 : Number(raw.compression)
		if (strict) {
			if (!Number.isFinite(rawFps) || rawFps < 15 || rawFps > 60) return null
			if (!Number.isFinite(rawBitrate) || rawBitrate < 4000 || rawBitrate > 150000) return null
			if (!Number.isFinite(rawQuality) || rawQuality < 10 || rawQuality > 34) return null
			if (!Number.isFinite(rawCompression) || rawCompression < 1 || rawCompression > 7) return null
		}
		const fps = Math.max(15, Math.min(60, Math.round(Number.isFinite(rawFps) ? rawFps : 60)))
		const bitrate = Math.max(4000, Math.min(150000, Math.round(Number.isFinite(rawBitrate) ? rawBitrate : 22000)))
		const quality = Math.max(10, Math.min(34, Math.round(Number.isFinite(rawQuality) ? rawQuality : 20)))
		const compression = Math.max(1, Math.min(7, Math.round(Number.isFinite(rawCompression) ? rawCompression : 7)))
		return {
			id,
			name: String(raw.name || id).trim().slice(0, 64) || id,
			deviceHint: String(raw.deviceHint || '').trim().slice(0, 100),
			codec,
			fps,
			bitrate,
			quality,
			compression,
			...(raw.measuredFps != null && Number.isFinite(Number(raw.measuredFps)) ? {measuredFps: Math.round(Number(raw.measuredFps) * 10) / 10} : {}),
			...(raw.measuredP95Ms != null && Number.isFinite(Number(raw.measuredP95Ms)) ? {measuredP95Ms: Math.round(Number(raw.measuredP95Ms) * 10) / 10} : {}),
			...(raw.measuredRttMs != null && Number.isFinite(Number(raw.measuredRttMs)) ? {measuredRttMs: Math.round(Number(raw.measuredRttMs))} : {}),
			...(raw.measuredMbps != null && Number.isFinite(Number(raw.measuredMbps)) ? {measuredMbps: Math.round(Number(raw.measuredMbps) * 10) / 10} : {}),
			...(typeof raw.encoder === 'string' && raw.encoder ? {encoder: raw.encoder.slice(0, 40)} : {}),
			...(raw.score != null && Number.isFinite(Number(raw.score)) ? {score: Math.round(Number(raw.score))} : {}),
			...(raw.testedAt != null && Number.isFinite(Number(raw.testedAt)) ? {testedAt: Number(raw.testedAt)} : {}),
			autoSelected: raw.autoSelected === true,
		}
	}

	async function readProfilesStore({strict = false} = {}) {
		let text
		try {
			text = await readFile(profilesPath, 'utf8')
		} catch (err) {
			if (err && err.code === 'ENOENT') return {profiles: [], activeByDevice: {}, defaultProfileId: null}
			if (strict) throw new RpcError('INTERNAL_SERVER_ERROR', `Failed to read saved stream profiles: ${err?.message || 'IO error'}`)
			return {profiles: [], activeByDevice: {}, defaultProfileId: null}
		}
		try {
			const raw = JSON.parse(text)
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				throw new Error('Root must be a JSON object')
			}
			if (!Array.isArray(raw.profiles)) {
				if (strict) throw new Error('profiles must be an array')
			}
			const list = []
			if (Array.isArray(raw.profiles)) {
				for (const item of raw.profiles) {
					const clean = sanitizeProfile(item, '', {strict})
					if (!clean) {
						if (strict) throw new Error('Invalid profile entry in store')
						continue
					}
					list.push(clean)
				}
			}
			if (raw.activeByDevice !== undefined && (raw.activeByDevice === null || typeof raw.activeByDevice !== 'object' || Array.isArray(raw.activeByDevice))) {
				if (strict) throw new Error('activeByDevice must be an object')
			}
			if (raw.defaultProfileId !== undefined && raw.defaultProfileId !== null && typeof raw.defaultProfileId !== 'string') {
				if (strict) throw new Error('defaultProfileId must be a string or null')
			}
			const validIds = new Set(list.map((p) => p.id))
			const activeByDevice = {}
			if (raw.activeByDevice && typeof raw.activeByDevice === 'object' && !Array.isArray(raw.activeByDevice)) {
				for (const [dev, pid] of Object.entries(raw.activeByDevice)) {
					if (PROFILE_ID_RE.test(dev) && typeof pid === 'string' && validIds.has(pid)) {
						activeByDevice[dev] = pid
					} else if (strict) {
						throw new Error('Invalid activeByDevice reference in store')
					}
				}
			}
			if (strict && raw.defaultProfileId !== undefined && raw.defaultProfileId !== null && !validIds.has(raw.defaultProfileId)) {
				throw new Error('Dangling defaultProfileId in store')
			}
			const defaultProfileId =
				typeof raw.defaultProfileId === 'string' && validIds.has(raw.defaultProfileId)
					? raw.defaultProfileId
					: strict
						? null
						: (list[0]?.id ?? null)
			return {profiles: list, activeByDevice, defaultProfileId}
		} catch {
			if (strict) throw new RpcError('INTERNAL_SERVER_ERROR', 'Saved stream profiles file is corrupted; refusing to overwrite')
			return {profiles: [], activeByDevice: {}, defaultProfileId: null}
		}
	}

	async function writeProfilesStore(store) {
		await mkdir(dataDir, {recursive: true, mode: 0o700})
		const tmp = `${profilesPath}.${process.pid}.${++profileTmpSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`
		try {
			await writeFile(tmp, JSON.stringify(store, null, '\t') + '\n', {mode: 0o600})
			await rename(tmp, profilesPath)
		} catch (err) {
			await rm(tmp, {force: true}).catch(() => {})
			throw err
		}
	}

	async function profiles() {
		const store = await readProfilesStore({strict: true})
		const hasVaapi = await exists(vaapiDevice)
		const hasNative = !!(compiledBin && (await exists(compiledBin)))
		return {...store, vaapi: hasVaapi, nativeEngine: hasNative}
	}

	function profileSave(input = {}, {expectedResetGen = null} = {}) {
		return withProfileStoreLock(async () => {
			if (expectedResetGen !== null && expectedResetGen !== profileResetGen) {
				return {profiles: [], activeByDevice: {}, defaultProfileId: null, saved: null, abortedByReset: true}
			}
			const rawProf = input?.profile ?? input
			if (!rawProf || typeof rawProf !== 'object' || Array.isArray(rawProf)) {
				throw new RpcError('BAD_REQUEST', 'Invalid stream profile')
			}
			let explicitId = null
			if (rawProf.id !== undefined) {
				if (typeof rawProf.id !== 'string' || !PROFILE_ID_RE.test(rawProf.id.trim())) {
					throw new RpcError('BAD_REQUEST', 'Invalid profile ID')
				}
				explicitId = rawProf.id.trim()
			}
			if (input?.id !== undefined) {
				if (typeof input.id !== 'string' || !PROFILE_ID_RE.test(input.id.trim())) {
					throw new RpcError('BAD_REQUEST', 'Invalid profile ID')
				}
				if (explicitId === null) explicitId = input.id.trim()
			}
			if (typeof rawProf.codec !== 'string' || !VALID_CODECS.has(rawProf.codec)) {
				throw new RpcError('BAD_REQUEST', 'Unsupported video codec')
			}
			const rawDev = input?.deviceId
			let dev = ''
			if (rawDev !== undefined) {
				if (typeof rawDev !== 'string' || !PROFILE_ID_RE.test(rawDev.trim())) {
					throw new RpcError('BAD_REQUEST', 'Invalid device ID')
				}
				dev = rawDev.trim()
			}
			const store = await readProfilesStore({strict: true})
			const candidate = explicitId !== null ? {...rawProf, id: explicitId} : rawProf
			const clean = sanitizeProfile(candidate, `profile-${Date.now().toString(36)}`, {strict: true})
			if (!clean) throw new RpcError('BAD_REQUEST', 'Invalid stream profile parameters')
			const idx = store.profiles.findIndex((p) => p.id === clean.id)
			if (idx >= 0) store.profiles[idx] = clean
			else store.profiles.push(clean)
			if (dev && input?.activate !== false) store.activeByDevice[dev] = clean.id
			if (input?.setDefault || !store.defaultProfileId) store.defaultProfileId = clean.id
			await writeProfilesStore(store)
			return {...store, saved: clean}
		})
	}

	function profileDelete(input = {}) {
		return withProfileStoreLock(async () => {
			if (typeof input?.id !== 'string') throw new RpcError('BAD_REQUEST', 'Invalid profile ID')
			const id = input.id.trim()
			if (!PROFILE_ID_RE.test(id)) throw new RpcError('BAD_REQUEST', 'Invalid profile ID')
			const store = await readProfilesStore({strict: true})
			store.profiles = store.profiles.filter((p) => p.id !== id)
			for (const [dev, pid] of Object.entries(store.activeByDevice)) {
				if (pid === id) delete store.activeByDevice[dev]
			}
			if (store.defaultProfileId === id) store.defaultProfileId = store.profiles[0]?.id ?? null
			await writeProfilesStore(store)
			return store
		})
	}

	function runCaptureBenchmark(bin, env, {codec, fps, bitrate, quality, compression, outputName, durationMs = 750}) {
		return new Promise((resolveDone) => {
			const args = [
				'--mode',
				'output',
				'--output',
				outputName,
				'--fps',
				String(fps),
				'--bitrate',
				String(bitrate),
				'--codec',
				codec,
				'--quality',
				String(quality),
				'--compression',
				String(compression),
				'--vaapi-device',
				vaapiDevice,
				'--continuous',
			]
			const child = spawnImpl(bin, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
			child.stdin?.on('error', () => {})
			const frameReader = createFrameReader()
			let meta = null
			let firstFrameAt = 0
			let lastFrameAt = 0
			let windowEndAt = 0
			let frames = 0
			let totalBytes = 0
			let keyKb = 0
			const dts = []
			let stopping = false
			let exited = false
			let hasStarted = false
			let stuck = false
			let hadError = false
			let errorMsg = null
			let framingError = false
			let prematureExit = false
			let settled = false
			let killTimer = null
			let closeWaitTimer = null
			let sampleTimer = null

			const resolveResult = () => {
				if (settled) return
				settled = true
				frameReader.clear()
				clearTimeout(stopTimer)
				if (sampleTimer) clearTimeout(sampleTimer)
				if (killTimer) clearTimeout(killTimer)
				if (closeWaitTimer) clearTimeout(closeWaitTimer)
				// Measure sustained FPS across the full observation window and reject streams that stalled before the window ended.
				const endAt = windowEndAt || performance.now()
				const observedMs = firstFrameAt > 0 && endAt > firstFrameAt ? Math.max(durationMs * 0.95, endAt - firstFrameAt) : 0
				const spanSec = observedMs / 1000
				const measuredFps = frames > 1 && spanSec > 0.05 ? (frames - 1) / spanSec : 0
				const trailingGapMs = lastFrameAt > 0 ? Math.max(0, endAt - lastFrameAt) : durationMs
				const maxTrailingGapMs = Math.max(250, Math.round((1000 / Math.max(15, fps)) * 8))
				const stalled = frames > 0 && trailingGapMs > maxTrailingGapMs
				const allDts = [...dts]
				if (lastFrameAt > 0 && trailingGapMs > 50) allDts.push(trailingGapMs)
				allDts.sort((a, b) => a - b)
				const p50Ms = allDts.length ? allDts[Math.floor(allDts.length / 2)] : 0
				const p95Ms = allDts.length ? allDts[Math.min(allDts.length - 1, Math.floor(allDts.length * 0.95))] : 0
				const mbps = spanSec > 0.05 ? (totalBytes * 8) / spanSec / 1e6 : 0
				const cleanTermination = !stuck && !hadError && !framingError && !prematureExit && !stalled
				resolveDone({
					ok: cleanTermination && frames >= 6 && !!meta,
					stuck,
					...(errorMsg || framingError || prematureExit || stalled || stuck
						? {
								error:
									errorMsg ||
									(framingError
										? 'Malformed capture wire framing'
										: prematureExit
											? 'Capture worker exited unexpectedly'
											: stalled
												? 'Capture encoder stalled before benchmark window ended'
												: 'Capture worker timed out on shutdown'),
							}
						: {}),
					frames,
					fps: Math.round(measuredFps * 10) / 10,
					p50Ms: Math.round(p50Ms * 10) / 10,
					p95Ms: Math.round(p95Ms * 10) / 10,
					mbps: Math.round(mbps * 10) / 10,
					keyKb: Math.round(keyKb * 10) / 10,
					encoder: meta?.encoder ?? null,
					codecStr: meta?.codec ?? null,
				})
			}

			const finish = () => {
				if (stopping) return
				stopping = true
				if (!windowEndAt) windowEndAt = performance.now()
				clearTimeout(stopTimer)
				if (sampleTimer) clearTimeout(sampleTimer)
				try {
					child.stdin?.end()
				} catch {}
				if (exited || child.exitCode != null) {
					resolveResult()
					return
				}
				try {
					child.kill('SIGTERM')
				} catch {}
				// Track actual exit (NOT child.killed, which becomes true immediately on SIGTERM!) and hold the GPU lock until exit/close is observed.
				killTimer = setTimeout(() => {
					try {
						if (!exited && child.exitCode == null) child.kill('SIGKILL')
					} catch {}
				}, 350)
				killTimer.unref?.()
				// Emergency uninterruptible-D-state cap so the RPC cannot hang forever; hold stuckBenchChild until real exit so no later run overlaps it.
				closeWaitTimer = setTimeout(() => {
					if (!exited && child.exitCode == null) {
						try {
							child.kill('SIGKILL')
						} catch {}
						stuck = true
						stuckBenchChild = child
						frames = 0
						meta = null
						resolveResult()
					}
				}, 5000)
				closeWaitTimer.unref?.()
			}

			// Keep sampleTimer and stopTimer ref'd (both are cleared in resolveResult/finish) so Node 22 never exits early when awaiting mocked PassThrough workers.
			const stopTimer = setTimeout(finish, durationMs + 700)

			child.once('spawn', () => {
				hasStarted = true
			})
			child.stdout?.on('data', (chunk) => {
				hasStarted = true
				if (stopping) return
				frameReader.push(chunk)
				const ok = frameReader.drain((typ, pl) => {
					if (stopping) return
					if (typ === 1) {
						try {
							meta = JSON.parse(pl.toString('utf8'))
						} catch {}
					} else if (typ === 2 && pl.length > 9) {
						const now = performance.now()
						const payloadBytes = pl.length - 9
						if (pl[0] === 1 && keyKb === 0) keyKb = payloadBytes / 1024
						if (firstFrameAt === 0) {
							firstFrameAt = now
							clearTimeout(stopTimer)
							sampleTimer = setTimeout(finish, durationMs)
						} else {
							dts.push(now - lastFrameAt)
							totalBytes += payloadBytes
						}
						lastFrameAt = now
						frames++
					} else if (typ === 3) {
						hadError = true
						try {
							const parsed = JSON.parse(pl.toString('utf8'))
							if (typeof parsed?.error === 'string' && parsed.error) errorMsg = parsed.error.slice(0, 200)
						} catch {}
						if (!errorMsg) errorMsg = 'Capture encoder reported fatal error'
						finish()
					}
				})
				if (!ok) {
					framingError = true
					finish()
				}
			})
			const onExit = () => {
				if (!stopping) prematureExit = true
				if (!windowEndAt) windowEndAt = performance.now()
				exited = true
				if (stuckBenchChild === child) stuckBenchChild = null
				resolveResult()
			}
			// Only treat 'error' as immediate exit when spawn itself failed (process never started);
			// post-spawn kill errors leave the worker alive, so retain the GPU guard until 'exit' or 'close'.
			child.once('error', () => {
				if (!hasStarted && child.pid == null) onExit()
			})
			child.once('exit', onExit)
			child.once('close', onExit)
		})
	}

	function profileRun(input = {}) {
		const runGen = profileResetGen
		return withProfileBenchLock(async () => {
			if (runGen !== profileResetGen) {
				return {winner: null, results: [], rttMs: null, profiles: [], activeByDevice: {}, defaultProfileId: null}
			}
			if (stuckBenchChild && stuckBenchChild.exitCode == null) {
				throw new RpcError('CONFLICT', 'A previous GPU benchmark worker is still exiting; wait a moment and try again')
			}
			stuckBenchChild = null
			const env = await discoverEnv()
			if (!env?.WAYLAND_DISPLAY || !env?.HYPRLAND_INSTANCE_SIGNATURE) {
				throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
			}
			const bin = await ensureCaptureBinary().catch(() => null)
			if (!bin) {
				throw new RpcError('PRECONDITION_FAILED', 'Native VA-API GPU capture engine is unavailable on this host')
			}
			const hasMeasuredRtt = input?.clientRttMs != null && Number.isFinite(Number(input.clientRttMs))
			const measuredRttMs = hasMeasuredRtt ? Math.max(0, Math.min(2000, Math.round(Number(input.clientRttMs)))) : null
			const effectiveRttMs = measuredRttMs ?? 20
			const explicitCodecs = Array.isArray(input?.clientCodecs)
			const rawClientCodecs = explicitCodecs ? input.clientCodecs.filter((c) => VALID_CODECS.has(c)) : ['hevc', 'h264']
			const clientCodecs = [...new Set(rawClientCodecs)]
			if (!clientCodecs.length) {
				throw new RpcError('PRECONDITION_FAILED', 'Client browser reported no supported WebCodecs video codecs')
			}
			const rail = await ensureRailOutput().catch(() => null)
			const outputName = rail?.name || RAIL_OUTPUT

			// Tailor candidate matrix to client RTT + EVERY advertised WebCodecs codec (never injecting unadvertised codecs)
			const isHighWan = effectiveRttMs >= 45
			const isModWan = effectiveRttMs >= 18 && effectiveRttMs < 45
			const isLan = effectiveRttMs < 12
			const candidates = []
			if (clientCodecs.includes('hevc444')) {
				candidates.push({
					label: isLan ? 'HEVC 4:4:4 Ultra LAN 60' : 'HEVC 4:4:4 Crisp 60',
					codec: 'hevc444',
					fps: 60,
					bitrate: isLan ? 100000 : isHighWan ? 18000 : isModWan ? 24000 : 32000,
					quality: isLan ? 12 : isHighWan ? 21 : 19,
					compression: 7,
				})
			}
			if (clientCodecs.includes('hevc')) {
				if (isLan) {
					candidates.push({
						label: 'HEVC Ultra LAN 60',
						codec: 'hevc',
						fps: 60,
						bitrate: 80000,
						quality: 14,
						compression: 7,
					})
					candidates.push({
						label: 'HEVC High LAN 60',
						codec: 'hevc',
						fps: 60,
						bitrate: 45000,
						quality: 16,
						compression: 7,
					})
				} else {
					candidates.push({
						label: 'HEVC Crisp Low-Latency 60',
						codec: 'hevc',
						fps: 60,
						bitrate: isHighWan ? 16000 : isModWan ? 22000 : 28000,
						quality: isHighWan ? 21 : 20,
						compression: 7,
					})
					candidates.push({
						label: 'HEVC Balanced 60',
						codec: 'hevc',
						fps: 60,
						bitrate: isHighWan ? 14000 : 18000,
						quality: 22,
						compression: 5,
					})
				}
			}
			if (clientCodecs.includes('hevc10')) {
				candidates.push({
					label: 'HEVC 10-bit Deep Color',
					codec: 'hevc10',
					fps: 60,
					bitrate: isHighWan ? 16000 : isLan ? 60000 : 24000,
					quality: isLan ? 16 : 21,
					compression: 7,
				})
			}
			if (clientCodecs.includes('h264')) {
				candidates.push({
					label: isLan ? 'H.264 High LAN 60' : 'H.264 High Universal',
					codec: 'h264',
					fps: 60,
					bitrate: isHighWan ? 16000 : isLan ? 60000 : 22000,
					quality: isLan ? 16 : 21,
					compression: 7,
				})
			}

			const CODEC_DISPLAY = {hevc444: 'HEVC 4:4:4', hevc10: 'HEVC 10-bit', hevc: 'HEVC', h264: 'H.264'}
			const results = []
			for (const c of candidates) {
				if (runGen !== profileResetGen) break
				const m = await runCaptureBenchmark(bin, env, {...c, outputName})
				// Score the codec the encoder ACTUALLY used (in case hardware fell back from HEVC -> H.264), and reflect any codec fallback in the displayed label.
				const actualCodec = m.ok ? codecFromEncoderName(m.encoder, c.codec) : c.codec
				const label = m.ok && actualCodec !== c.codec ? `${CODEC_DISPLAY[actualCodec] || actualCodec} (fallback from ${CODEC_DISPLAY[c.codec] || c.codec})` : c.label
				const clientSupportsActual = clientCodecs.includes(actualCodec)
				const score = clientSupportsActual ? scoreProfileCandidate({...c, ...m, codec: actualCodec, targetFps: c.fps}, {rttMs: effectiveRttMs}) : 0
				results.push({...c, ...m, label, codec: actualCodec, targetFps: c.fps, score})
				if (m.stuck) break
			}
			if (runGen !== profileResetGen) {
				return {winner: null, results: [], rttMs: measuredRttMs, profiles: [], activeByDevice: {}, defaultProfileId: null}
			}
			results.sort((a, b) => b.score - a.score)
			const best = results.find((r) => r.ok && r.score > 0 && clientCodecs.includes(r.codec)) ?? null

			let store = await readProfilesStore()
			if (!best) {
				return {winner: null, results, rttMs: measuredRttMs, ...store}
			}

			const deviceId = typeof input?.deviceId === 'string' && PROFILE_ID_RE.test(input.deviceId.trim()) ? input.deviceId.trim() : `device-${Date.now().toString(36)}`
			const netTag = effectiveRttMs >= 45 ? 'WAN' : effectiveRttMs >= 18 ? 'Remote' : 'LAN'
			const profileName = String(input?.deviceName || '').trim().slice(0, 48) || `Auto (${netTag})`
			const winner = sanitizeProfile(
				{
					id: deviceId,
					name: `${profileName} · ${best.label}`,
					deviceHint: String(input?.deviceHint || '').trim().slice(0, 100),
					codec: best.codec,
					fps: best.targetFps ?? 60,
					bitrate: best.bitrate,
					quality: best.quality,
					compression: best.compression,
					measuredFps: best.fps,
					measuredP95Ms: best.p95Ms,
					...(measuredRttMs !== null ? {measuredRttMs} : {}),
					measuredMbps: best.mbps,
					encoder: best.encoder || undefined,
					score: best.score,
					testedAt: Date.now(),
					autoSelected: true,
				},
				'',
				{strict: true},
			)

			if (input?.saveAsActive !== false && winner) {
				const saved = await profileSave(
					{profile: winner, deviceId, activate: true, setDefault: !store.defaultProfileId},
					{expectedResetGen: runGen},
				)
				if (saved?.abortedByReset) {
					return {winner: null, results: [], rttMs: measuredRttMs, profiles: [], activeByDevice: {}, defaultProfileId: null}
				}
				store = saved
			}
			return {winner, results, rttMs: measuredRttMs, ...store}
		})
	}

	// Attach an authenticated owner WebSocket to a live 60 FPS GPU H.264/HEVC/HEVC-4:4:4 Hyprland stream (with 10 ms Opus or silence-gated PCM PipeWire audio).
	async function attachStream(ws, {mode = 'output', address = '', output = '', fps = 60, bitrate = 22000, audio = false, audioCodec = 'pcm', codec = 'h264', quality = 0, compression = 0} = {}) {
		if (activeStreams.size + pendingStreams >= MAX_STREAMS) {
			ws.close(1013, 'Too many active Hyprland streams')
			return
		}
		pendingStreams++
		let closedEarly = false
		let revoked = false
		let cleanupRef = null
		let wantAudio = !!audio
		let earlyAudioCodec = null
		let earlyReconfig = null
		ws.__omarchyRevoke = (code = 1008, reason = 'Session ended') => {
			revoked = true
			closedEarly = true
			try {
				cleanupRef?.()
			} catch {}
			try {
				ws.close(code, reason)
			} catch {}
		}
		const onEarlyClose = () => {
			closedEarly = true
		}
		// Capture any audio mute/codec or live reconfig sent immediately on ws.onopen while attachStream is still awaiting setup.
		const onEarlyMessage = (data, isBinary) => {
			if (revoked || isBinary) return
			const text = String(data ?? '')
			if (text.length > 512) return
			try {
				const clean = sanitizeInputMsg(JSON.parse(text))
				if (!clean) return
				if (clean.type === 'audio') {
					wantAudio = clean.enabled
					if (clean.codec) earlyAudioCodec = clean.codec
				} else if (clean.type === 'reconfig') {
					earlyReconfig = {...(earlyReconfig || {}), ...clean}
				}
			} catch {}
		}
		ws.once('close', onEarlyClose)
		ws.once('error', onEarlyClose)
		ws.on('message', onEarlyMessage)

		let entry = null
		try {
			const cleanMode = mode === 'window' ? 'window' : 'output'
			const cleanAddr = cleanMode === 'window' ? String(address ?? '') : ''
			const cleanOutput = cleanMode === 'output' && OUTPUT_NAME_RE.test(String(output ?? '')) ? String(output) : ''
			if (cleanMode === 'window' && !ADDRESS_RE.test(cleanAddr)) {
				ws.close(1008, 'Invalid window address')
				return
			}
			const env = await discoverEnv()
			if (closedEarly || ws.readyState !== ws.OPEN) return
			if (!env?.WAYLAND_DISPLAY) {
				ws.close(1011, 'Hyprland desktop session is not active')
				return
			}
			const cleanFps = Math.max(5, Math.min(120, Math.round(Number(fps) || 60)))
			let curBitrate = Math.max(1000, Math.min(150000, Math.round(Number(bitrate) || 22000)))
			let curCodec = codec === 'hevc444' || codec === 'hevc10' || codec === 'hevc' ? codec : 'h264'
			let curQuality = Number.isFinite(Number(quality)) && Number(quality) >= 10 && Number(quality) <= 34 ? Math.round(Number(quality)) : 0
			const cleanComp = Number.isFinite(Number(compression)) && Number(compression) >= 1 && Number(compression) <= 7 ? Math.round(Number(compression)) : 0
			let wantOpus = (earlyAudioCodec ?? audioCodec) === 'opus'
			let opusFailed = false

			// Ensure target window is on an awake, active workspace (move onto awake headless RAIL-1 if its monitor is asleep or workspace is hidden)
			if (cleanMode === 'window') {
				const mons = await monitorsInfo()
				const wins = await windows().catch(() => [])
				const targetWin = wins.find((w) => w.address.toLowerCase() === cleanAddr.toLowerCase())
				const railMon = mons.find((m) => m.name === RAIL_OUTPUT)
				const visibleAwake = targetWin && mons.some((m) => m.dpmsStatus && m.activeWorkspace === targetWin.workspace)
				if (targetWin && !visibleAwake) {
					const ensured = await ensureRailOutput().catch(() => null)
					const railWs = Number.isInteger(ensured?.activeWorkspace) && ensured.activeWorkspace >= 1 && ensured.activeWorkspace <= 99 ? ensured.activeWorkspace : 11
					if (ensured) {
						await hyprDispatch(
							`hl.dispatch(hl.dsp.window.move({window = "address:${cleanAddr}", workspace = ${railWs}, silent = true}))`,
							['dispatch', 'movetoworkspacesilent', `${railWs},address:${cleanAddr}`],
						).catch(() => {})
						await placeOnRail(cleanAddr, targetWin.size[0], targetWin.size[1]).catch(() => {})
					}
				} else if (targetWin && railMon && targetWin.workspace === railMon.activeWorkspace) {
					const padL = railMon.reserved?.[0] ?? 0
					const padT = railMon.reserved?.[1] ?? 0
					const padR = railMon.reserved?.[2] ?? 0
					const padB = railMon.reserved?.[3] ?? 0
					const overflows =
						targetWin.at[0] < railMon.x + padL ||
						targetWin.at[1] < railMon.y + padT ||
						targetWin.at[0] + targetWin.size[0] > railMon.x + railMon.width - padR ||
						targetWin.at[1] + targetWin.size[1] > railMon.y + railMon.height - padB
					if (overflows || railMon.width < 3840 || railMon.height < 2160) {
						await placeOnRail(cleanAddr, targetWin.size[0], targetWin.size[1]).catch(() => {})
					}
				}
			}

			if (cleanMode === 'output' && cleanOutput === RAIL_OUTPUT) {
				await ensureRailOutput().catch(() => null)
			}
			let resolvedOutput = cleanOutput
			if (cleanMode === 'output' && !resolvedOutput) {
				const mons = await monitorsInfo()
				if (mons.length && !mons[0].dpmsStatus) {
					const awake = mons.find((m) => m.dpmsStatus)
					if (awake) resolvedOutput = awake.name
				}
			}

			const nativeBin = await ensureCaptureBinary().catch(() => null)
			if (revoked || closedEarly || ws.readyState !== ws.OPEN) return

			let earlyReconfigPending = false
			let sentReconfigGen = 0
			let ackedReconfigGen = 0
			if (earlyReconfig) {
				if (nativeBin) {
					if (earlyReconfig.bitrate !== undefined) curBitrate = earlyReconfig.bitrate
					if (earlyReconfig.quality !== undefined) curQuality = earlyReconfig.quality
					if (earlyReconfig.codec !== undefined) curCodec = earlyReconfig.codec
					earlyReconfigPending = true
				} else {
					try {
						ws.send(JSON.stringify({type: 'reconfig_unsupported'}))
					} catch {}
				}
			}
			if (earlyAudioCodec) wantOpus = earlyAudioCodec === 'opus'
			let bp = backpressureBudgets(curBitrate)

			let child
			if (nativeBin) {
				const args = ['--mode', cleanMode, '--fps', String(cleanFps), '--bitrate', String(curBitrate), '--codec', curCodec, '--vaapi-device', vaapiDevice]
				if (curQuality) args.push('--quality', String(curQuality))
				if (cleanComp) args.push('--compression', String(cleanComp))
				if (cleanAddr) args.push('--address', cleanAddr)
				if (resolvedOutput) args.push('--output', resolvedOutput)
				child = spawnImpl(nativeBin, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
			} else {
				const args = [scriptPath, '--mode', cleanMode, '--fps', String(Math.min(60, cleanFps)), '--bitrate', String(curBitrate)]
				if (cleanAddr) args.push('--address', cleanAddr)
				if (resolvedOutput) args.push('--output', resolvedOutput)
				child = spawnImpl('python3', args, {env, stdio: ['pipe', 'pipe', 'pipe']})
			}

			entry = {child, ws, mode: cleanMode, address: cleanAddr, output: resolvedOutput}
			if (disconnectLockRetryTimer) {
				clearTimeout(disconnectLockRetryTimer)
				disconnectLockRetryTimer = null
			}
			activeStreams.add(entry)
			ensureRectSyncTimer()
			let stderrBuf = ''
			const frameReader = createFrameReader()
			let dropUntilKey = false
			let pendingKeyReq = false
			let lastKeyframeReqAt = 0
			let keyframeTimer = null
			let cleaned = false
			let childExited = false
			let killTimer = null
			// Track per-child exit state & kill timers so rapid mute/unmute toggles can never orphan parec or opus workers.
			let audioState = null // {procs: [{proc, exited, killTimer}]}
			let audioRx = Buffer.alloc(0)
			let audioHangFrames = 0 // keep sending ~240ms of tail after non-silent audio, then gate to 0 kbps during silence
			const AUDIO_CHUNK = 3840 // 20 ms of 48 kHz 16-bit stereo PCM (960 frames * 4 bytes)

			const killAudioProc = (item) => {
				if (item.killTimer) {
					clearTimeout(item.killTimer)
					item.killTimer = null
				}
				if (item.exited || item.proc.exitCode != null) return
				try {
					item.proc.kill('SIGTERM')
					item.killTimer = setTimeout(() => {
						item.killTimer = null
						try {
							if (!item.exited && item.proc.exitCode == null) item.proc.kill('SIGKILL')
						} catch {}
					}, 1000)
					item.killTimer.unref?.()
				} catch {}
			}

			const stopAudio = () => {
				if (!audioState) return
				const st = audioState
				audioState = null
				audioRx = Buffer.alloc(0)
				audioHangFrames = 0
				for (const item of st.procs) killAudioProc(item)
			}

			const startAudio = () => {
				if (cleaned || audioState) return
				// Prefer 10 ms Opus (128 kbps active, 0 kbps silent) via nativeBin --opus-stdin when supported; fallback cleanly to PCM 0x02.
				if (wantOpus && nativeBin && !opusFailed) {
					let ac = null
					let pItem = null
					try {
						ac = spawnImpl('parec', ['--device=@DEFAULT_MONITOR@', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=10'], {env, stdio: ['ignore', 'pipe', 'ignore']})
						pItem = {proc: ac, exited: false, killTimer: null}
						const st = {procs: [pItem]}
						audioState = st
						const oe = spawnImpl(nativeBin, ['--opus-stdin'], {env, stdio: ['pipe', 'pipe', 'ignore']})
						const oItem = {proc: oe, exited: false, killTimer: null}
						st.procs.push(oItem)
						let opusRx = Buffer.alloc(0)
						const onProcDone = (item, other, isOpus, code) => {
							item.exited = true
							if (item.killTimer) {
								clearTimeout(item.killTimer)
								item.killTimer = null
							}
							if (audioState === st) {
								audioState = null
								killAudioProc(other)
								if (isOpus && !cleaned && code !== 0) {
									opusFailed = true
									if (wantAudio) startAudio()
								}
							}
						}
						ac.once('error', () => onProcDone(pItem, oItem, false, 1))
						ac.once('exit', (code) => onProcDone(pItem, oItem, false, code))
						ac.once('close', (code) => onProcDone(pItem, oItem, false, code))
						oe.once('error', () => onProcDone(oItem, pItem, true, 2))
						oe.once('exit', (code) => onProcDone(oItem, pItem, true, code))
						oe.once('close', (code) => onProcDone(oItem, pItem, true, code))
						oe.stdin?.on('error', () => {})
						ac.stdout?.on('data', (chunk) => {
							if (cleaned || audioState !== st || !oe.stdin?.writable) return
							try {
								if (!oe.stdin.write(chunk)) {
									ac.stdout.pause?.()
									oe.stdin.once('drain', () => {
										if (!cleaned && audioState === st) ac.stdout?.resume?.()
									})
								}
							} catch {}
						})
						oe.stdout?.on('data', (chunk) => {
							if (cleaned || audioState !== st || ws.readyState !== ws.OPEN) return
							opusRx = opusRx.length ? Buffer.concat([opusRx, chunk]) : chunk
							while (opusRx.length >= 2) {
								const len = opusRx.readUInt16BE(0)
								if (len === 0 || len > 4096) {
									opusRx = Buffer.alloc(0)
									break
								}
								if (opusRx.length < 2 + len) break
								const frame = opusRx.subarray(2, 2 + len)
								opusRx = opusRx.subarray(2 + len)
								if (ws.bufferedAmount > 256 * 1024) continue
								const pkt = Buffer.allocUnsafe(1 + len)
								pkt[0] = 3 // 3 = 10 ms 48 kHz stereo Opus packet
								frame.copy(pkt, 1)
								ws.send(pkt, {binary: true})
							}
						})
						return
					} catch {
						if (pItem) killAudioProc(pItem)
						opusFailed = true
						audioState = null
					}
				}
				try {
					const ac = spawnImpl('parec', ['--device=@DEFAULT_MONITOR@', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20'], {env, stdio: ['ignore', 'pipe', 'ignore']})
					const pItem = {proc: ac, exited: false, killTimer: null}
					const st = {procs: [pItem]}
					audioState = st
					const onAudioEnd = () => {
						pItem.exited = true
						if (audioState === st) audioState = null
						if (pItem.killTimer) {
							clearTimeout(pItem.killTimer)
							pItem.killTimer = null
						}
					}
					ac.once('error', onAudioEnd)
					ac.once('exit', onAudioEnd)
					ac.once('close', onAudioEnd)
					ac.stdout?.on('data', (chunk) => {
						if (cleaned || audioState !== st || ws.readyState !== ws.OPEN) return
						audioRx = audioRx.length ? Buffer.concat([audioRx, chunk]) : chunk
						while (audioRx.length >= AUDIO_CHUNK) {
							const pcm = audioRx.subarray(0, AUDIO_CHUNK)
							audioRx = audioRx.subarray(AUDIO_CHUNK)
							if (!isPcmSilent(pcm)) {
								audioHangFrames = 12 // 240 ms tail
							} else if (audioHangFrames > 0) {
								audioHangFrames--
							} else {
								continue // silence-gated: 0 kbps on TCP socket when desktop audio is silent
							}
							if (ws.bufferedAmount > 256 * 1024) continue
							const pkt = Buffer.allocUnsafe(1 + AUDIO_CHUNK)
							pkt[0] = 2 // 0=video delta, 1=video keyframe, 2=48kHz s16le stereo PCM, 3=Opus
							pcm.copy(pkt, 1)
							ws.send(pkt, {binary: true})
						}
					})
				} catch {
					audioState = null
				}
			}

			if (wantAudio) startAudio()

			// Single ordered input writer: synchronous fast path in steady state, strict FIFO + coalesced motion during focus switch or pipe backpressure.
			let focusing = false
			let stdinBackpressured = false
			let pendingMoveLine = null
			const pendingControl = []
			const MAX_PENDING_INPUT = 256

			const cleanup = () => {
				if (cleaned) return
				cleaned = true
				focusing = false
				pendingMoveLine = null
				pendingControl.length = 0
				if (keyframeTimer) {
					clearTimeout(keyframeTimer)
					keyframeTimer = null
				}
				frameReader.clear()
				stopAudio()
				const wasLastLocked = lastLockedState === true
				activeStreams.delete(entry)
				ensureRectSyncTimer()
				// If the last viewer closes right after unlocking (before the 1.2s poll tick), check lock state with bounded retries across transient unknown probes so remoteSignIn relock still arms.
				if (activeStreams.size === 0) {
					if (disconnectLockRetryTimer) {
						clearTimeout(disconnectLockRetryTimer)
						disconnectLockRetryTimer = null
					}
					if (wasLastLocked) {
						const retryDelays = [0, 300, 700, 1200]
						const probeAttempt = (idx) => {
							if (activeStreams.size > 0) return
							const seq = ++lockProbeSeq
							isSessionLocked()
								.then((locked) => {
									if (activeStreams.size > 0) return
									if (locked === null) {
										if (idx + 1 < retryDelays.length) {
											disconnectLockRetryTimer = setTimeout(() => {
												disconnectLockRetryTimer = null
												probeAttempt(idx + 1)
											}, retryDelays[idx + 1])
											disconnectLockRetryTimer.unref?.()
										} else {
											lastLockedState = null
										}
										return
									}
									applyLockState(locked, {hadViewer: true, seq})
									if (activeStreams.size === 0) lastLockedState = null
								})
								.catch(() => {
									if (activeStreams.size > 0) return
									if (idx + 1 < retryDelays.length) {
										disconnectLockRetryTimer = setTimeout(() => {
											disconnectLockRetryTimer = null
											probeAttempt(idx + 1)
										}, retryDelays[idx + 1])
										disconnectLockRetryTimer.unref?.()
									} else {
										lastLockedState = null
									}
								})
						}
						probeAttempt(0)
					} else {
						lastLockedState = null
					}
				}
				try {
					child.stdin?.end()
				} catch {}
				if (childExited || child.exitCode != null) return
				try {
					child.kill('SIGTERM')
					// Track actual exit (NOT child.killed, which turns true immediately on SIGTERM!)
					killTimer = setTimeout(() => {
						try {
							if (!childExited && child.exitCode == null) child.kill('SIGKILL')
						} catch {}
					}, 1500)
					killTimer.unref?.()
				} catch {}
			}
			cleanupRef = cleanup
			if (revoked) {
				cleanup()
				return
			}

			// Guard against async EPIPE/broken-pipe errors on child.stdin so a crashing worker never crashes omarchyd.
			child.stdin?.on('error', () => cleanup())

			const rawWriteStdin = (line) => {
				if (cleaned || !child.stdin?.writable) return true
				try {
					const ok = child.stdin.write(line)
					if (!ok) stdinBackpressured = true
					return ok
				} catch {
					cleanup()
					return false
				}
			}

			const flushInputQueue = () => {
				while (!cleaned && !focusing && !stdinBackpressured) {
					if (pendingControl.length > 0) {
						const next = pendingControl.shift()
						if (!rawWriteStdin(next)) return
					} else if (pendingMoveLine !== null) {
						const mv = pendingMoveLine
						pendingMoveLine = null
						if (!rawWriteStdin(mv)) return
					} else {
						break
					}
				}
			}

			child.stdin?.on('drain', () => {
				stdinBackpressured = false
				flushInputQueue()
			})

			const enqueueMoveLine = (line) => {
				if (cleaned) return
				if (!focusing && !stdinBackpressured && pendingControl.length === 0 && pendingMoveLine === null) {
					rawWriteStdin(line)
					return
				}
				// Coalesce consecutive pointer moves into the latest coordinate only.
				pendingMoveLine = line
			}

			const enqueueControlLine = (line) => {
				if (cleaned) return
				if (!focusing && !stdinBackpressured && pendingControl.length === 0 && pendingMoveLine === null) {
					rawWriteStdin(line)
					return
				}
				const extra = pendingMoveLine !== null ? 2 : 1
				if (pendingControl.length + extra > MAX_PENDING_INPUT) {
					// Never silently drop key/button releases (which would leave inputs stuck held); tear down the stalled worker so Wayland releases all virtual inputs.
					cleanup()
					if (ws.readyState === ws.OPEN) {
						try {
							ws.close(1013, 'Input queue overflow')
						} catch {}
					}
					return
				}
				if (pendingMoveLine !== null) {
					pendingControl.push(pendingMoveLine)
					pendingMoveLine = null
				}
				pendingControl.push(line)
			}

			const enqueueButtonLine = (line, isDown) => {
				if (isDown && cleanAddr) {
					const targetLower = cleanAddr.toLowerCase()
					const needsFocus = lastFocusedAddr !== targetLower
					if (needsFocus && !focusing) {
						focusing = true
						enqueueControlLine(line)
						// Raise & sync rect before button-down only when switching focus to another window; all subsequent moves/events queue cleanly behind it.
						;(async () => {
							if (cleaned) return
							await hyprDispatch(`hl.dispatch(hl.dsp.focus({window = "address:${cleanAddr}"}))`, ['dispatch', 'focuswindow', `address:${cleanAddr}`]).catch(() => {})
							lastFocusedAddr = targetLower
							await syncStreamRect(cleanAddr).catch(() => {})
						})().finally(() => {
							focusing = false
							flushInputQueue()
						})
						return
					}
				}
				enqueueControlLine(line)
			}

			const scheduleKeyframeRecovery = () => {
				if (cleaned || !pendingKeyReq || ws.readyState !== ws.OPEN) return
				const nowMs = Date.now()
				const cooldownLeft = Math.max(0, 1500 - (nowMs - lastKeyframeReqAt))
				if (ws.bufferedAmount <= bp.keyDrainBytes && cooldownLeft === 0) {
					lastKeyframeReqAt = nowMs
					enqueueControlLine(nativeBin ? 'F\n' : '{"type":"keyframe"}\n')
					if (keyframeTimer) {
						clearTimeout(keyframeTimer)
						keyframeTimer = null
					}
					// Re-check after 1500 ms if still waiting on a keyframe (e.g., static screen or second drop inside one cooldown)
					keyframeTimer = setTimeout(() => {
						keyframeTimer = null
						if (dropUntilKey && pendingKeyReq) scheduleKeyframeRecovery()
					}, 1500)
					keyframeTimer.unref?.()
					return
				}
				if (!keyframeTimer) {
					const waitMs = cooldownLeft > 0 ? cooldownLeft : 120
					keyframeTimer = setTimeout(() => {
						keyframeTimer = null
						scheduleKeyframeRecovery()
					}, waitMs)
					keyframeTimer.unref?.()
				}
			}

			// Push initial window or monitor logical rect for pixel-perfect pointer mapping (window AND multi-monitor output mode)
			syncAllStreamRects().catch(() => {})
			const initHadViewer = activeStreams.size > 0
			const initSeq = ++lockProbeSeq
			isSessionLocked()
				.then((locked) => {
					if (locked === null) return
					const changed = locked !== lastLockedState
					applyLockState(locked, {hadViewer: initHadViewer || activeStreams.size > 0, seq: initSeq})
					if (!changed && locked && ws.readyState === ws.OPEN) {
						ws.send(JSON.stringify({type: 'lock', locked: true}))
					}
				})
				.catch(() => {})

			child.stderr?.on('data', (d) => {
				stderrBuf = (stderrBuf + d.toString('utf8')).slice(-2048)
			})

			child.stdout?.on('data', (chunk) => {
				if (cleaned) return
				frameReader.push(chunk)
				const ok = frameReader.drain((msgType, payload) => {
					if (ws.readyState !== ws.OPEN) return

					if (msgType === 1) {
						try {
							const info = JSON.parse(payload.toString('utf8'))
							const encName = String(info.encoder || '').toLowerCase()
							const actualCodec = encName.startsWith('hevc444')
								? 'hevc444'
								: encName.startsWith('hevc10')
									? 'hevc10'
									: encName.startsWith('hevc')
										? 'hevc'
										: 'h264'
							const actualBitrate = Number.isFinite(Number(info.bitrate)) && Number(info.bitrate) > 0 ? Math.round(Number(info.bitrate)) : curBitrate
							const actualQuality = Number.isFinite(Number(info.quality)) ? Math.round(Number(info.quality)) : curQuality
							const metaGen = Number.isInteger(info.reconfigGen) ? info.reconfigGen : null
							bp = backpressureBudgets(actualBitrate)
							ws.send(JSON.stringify({type: 'meta', ...info, bitrate: actualBitrate, quality: actualQuality}))
							const matchesEarly = earlyReconfigPending && (metaGen === null || metaGen === 0) && sentReconfigGen === 0
							const matchesLive = sentReconfigGen > ackedReconfigGen && metaGen !== null && metaGen >= sentReconfigGen
							if (matchesEarly) {
								earlyReconfigPending = false
								ws.send(JSON.stringify({type: 'reconfig_applied', bitrate: actualBitrate, quality: actualQuality, codec: actualCodec, reconfigGen: 0}))
							} else if (matchesLive) {
								earlyReconfigPending = false
								ackedReconfigGen = metaGen
								ws.send(JSON.stringify({type: 'reconfig_applied', bitrate: actualBitrate, quality: actualQuality, codec: actualCodec, reconfigGen: ackedReconfigGen}))
							}
						} catch {}
					} else if (msgType === 3) {
						try {
							const info = JSON.parse(payload.toString('utf8'))
							ws.send(JSON.stringify({type: 'error', error: info.error || 'Stream error'}))
						} catch {}
					} else if (msgType === 4) {
						try {
							const info = JSON.parse(payload.toString('utf8'))
							if (typeof info.cursor === 'string') ws.send(JSON.stringify({type: 'cursor', cursor: info.cursor}))
						} catch {}
					} else if (msgType === 5) {
						try {
							ws.send(JSON.stringify({type: 'stats', ...JSON.parse(payload.toString('utf8'))}))
						} catch {}
					} else if (msgType === 2 && payload.length > 9) {
						const isKey = payload[0] === 1
						// Bitrate-proportional bufferbloat ceiling (~250 ms of stream bitrate) prevents WAN lag while giving high-bitrate LAN keyframes headroom.
						if (ws.bufferedAmount > bp.hardDropBytes) {
							dropUntilKey = true
							pendingKeyReq = true
							scheduleKeyframeRecovery()
							return
						}
						if (ws.bufferedAmount > bp.deltaDropBytes && !isKey) {
							dropUntilKey = true
							pendingKeyReq = true
							scheduleKeyframeRecovery()
							return
						}
						// Wait for TCP send queue to drain below keyDrainBytes before requesting a recovery IDR so keyframes never pile onto congestion.
						if (pendingKeyReq && ws.bufferedAmount <= bp.keyDrainBytes) {
							scheduleKeyframeRecovery()
						}
						if (dropUntilKey && !isKey) return
						if (isKey) {
							dropUntilKey = false
							pendingKeyReq = false
							if (keyframeTimer) {
								clearTimeout(keyframeTimer)
								keyframeTimer = null
							}
						}
						ws.send(payload, {binary: true})
					}
				})
				if (!ok) {
					cleanup()
					ws.close(1011, 'Stream framing error')
				}
			})

			ws.off?.('message', onEarlyMessage)
			ws.on('message', (data, isBinary) => {
				if (cleaned) return
				if (isBinary) {
					// Zero-overhead binary input fast paths routed through ordered writer:
					//   0x10 (5B): pointer_move   [0x10][u16be x][u16be y]
					//   0x11 (7B): pointer_button [0x11][u8 btnOffset(0..7)][u8 down][u16be x][u16be y]
					//   0x12 (9B): pointer_scroll [0x12][i32be dx256][i32be dy256]
					//   0x13 (4B): key            [0x13][u8 evdevCode(1..247)][u8 down][u8 mods]
					const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
					const tag = buf[0]
					if (tag === 0x10 && buf.length === 5) {
						const ux = buf.readUInt16BE(1)
						const uy = buf.readUInt16BE(3)
						enqueueMoveLine(
							nativeBin
								? `M ${ux} ${uy}\n`
								: `{"type":"pointer_move","x":${(ux / 65535).toFixed(5)},"y":${(uy / 65535).toFixed(5)}}\n`,
						)
					} else if (tag === 0x11 && buf.length === 7) {
						const btnOff = buf[1]
						const down = buf[2]
						if (btnOff <= 7 && (down === 0 || down === 1)) {
							const btn = 272 + btnOff
							const ux = buf.readUInt16BE(3)
							const uy = buf.readUInt16BE(5)
							const line = nativeBin
								? `B ${btn} ${down} ${ux} ${uy}\n`
								: `{"type":"pointer_button","button":${btn},"down":${down === 1},"x":${(ux / 65535).toFixed(5)},"y":${(uy / 65535).toFixed(5)}}\n`
							enqueueButtonLine(line, down === 1)
						}
					} else if (tag === 0x12 && buf.length === 9) {
						const dx256 = Math.max(-2560000, Math.min(2560000, buf.readInt32BE(1)))
						const dy256 = Math.max(-2560000, Math.min(2560000, buf.readInt32BE(5)))
						enqueueControlLine(
							nativeBin
								? `S ${dx256} ${dy256}\n`
								: `{"type":"pointer_scroll","dx":${(dx256 / 256).toFixed(3)},"dy":${(dy256 / 256).toFixed(3)}}\n`,
						)
					} else if (tag === 0x13 && buf.length === 4) {
						const code = buf[1]
						const down = buf[2]
						const mods = buf[3]
						if (code >= 1 && code <= 247 && (down === 0 || down === 1)) {
							enqueueControlLine(
								nativeBin
									? `K ${code} ${down} ${mods}\n`
									: `{"type":"key","code":${code},"down":${down === 1},"mods":${mods}}\n`,
							)
						}
					} else if (tag === 0x14 && buf.length === 9) {
						// Sub-millisecond binary RTT ping -> immediate 0x04 pong echo
						if (ws.readyState === ws.OPEN) {
							const pong = Buffer.allocUnsafe(9)
							pong[0] = 0x04
							buf.copy(pong, 1, 1, 9)
							ws.send(pong, {binary: true})
						}
					}
					return
				}
				const text = String(data ?? '')
				if (text.length > 1024) return
				let clean
				try {
					clean = sanitizeInputMsg(JSON.parse(text))
				} catch {
					return
				}
				if (!clean) return
				if (clean.type === 'audio') {
					wantAudio = clean.enabled
					if (clean.codec === 'pcm') {
						wantOpus = false
						opusFailed = true
						stopAudio()
						if (clean.enabled) startAudio()
						return
					}
					if (clean.enabled) startAudio()
					else stopAudio()
					return
				}
				if (clean.type === 'reconfig') {
					if (!nativeBin) {
						if (ws.readyState === ws.OPEN) {
							try {
								ws.send(JSON.stringify({type: 'reconfig_unsupported'}))
							} catch {}
						}
						return
					}
					if (clean.bitrate !== undefined) curBitrate = clean.bitrate
					if (clean.quality !== undefined) curQuality = clean.quality
					if (clean.codec !== undefined) curCodec = clean.codec
					bp = backpressureBudgets(curBitrate)
					sentReconfigGen++
					enqueueControlLine(`R ${curBitrate} ${curQuality} ${curCodec}\n`)
					return
				}
				if (clean.type === 'unlock_check') {
					// Read-only lock-state refresh probes
					for (const ms of [300, 900, 1800, 3000]) {
						const t = setTimeout(() => {
							if (cleaned) return
							const hadViewer = activeStreams.size > 0
							const seq = ++lockProbeSeq
							isSessionLocked()
								.then((locked) => applyLockState(locked, {hadViewer: hadViewer || activeStreams.size > 0, seq}))
								.catch(() => {})
						}, ms)
						t.unref?.()
					}
					return
				}
				if (clean.type === 'keyframe' && nativeBin) {
					enqueueControlLine('F\n')
					return
				}
				const line = `${JSON.stringify(clean)}\n`
				if (clean.type === 'pointer_move') {
					enqueueMoveLine(line)
				} else if (clean.type === 'pointer_button') {
					enqueueButtonLine(line, clean.down)
				} else {
					enqueueControlLine(line)
				}
			})

			const onChildEnd = () => {
				childExited = true
				if (killTimer) {
					clearTimeout(killTimer)
					killTimer = null
				}
			}
			child.on('exit', () => {
				onChildEnd()
				stopAudio()
				activeStreams.delete(entry)
				ensureRectSyncTimer()
				if (ws.readyState === ws.OPEN) {
					if (stderrBuf.trim()) ws.send(JSON.stringify({type: 'error', error: stderrBuf.trim().slice(0, 300)}))
					ws.close(1000)
				}
			})
			child.on('close', onChildEnd)
			child.on('error', () => {
				onChildEnd()
				cleanup()
				if (ws.readyState === ws.OPEN) ws.close(1011, 'Streamer failed to start')
			})
			ws.on('close', cleanup)
			ws.on('error', cleanup)
		} finally {
			pendingStreams = Math.max(0, pendingStreams - 1)
			ws.off?.('close', onEarlyClose)
			ws.off?.('error', onEarlyClose)
			ws.off?.('message', onEarlyMessage)
		}
	}

	return {
		attachStream,
		focusSharedScreen,
		readAppIcon,
		subscribeEvents,
		waitForEventSocketReady,
		nextEventSnapSeq: () => ++eventSnapSeq,
		notifyUnlocked,
		resetProfiles,
		windows,
		windowsSnapshot,
		async currentInstanceId() {
			const env = await discoverEnv()
			return env?.HYPRLAND_INSTANCE_SIGNATURE ?? null
		},
		close() {
			busClosed = true
			eventSockReady = false
			notifyEventReady()
			if (disconnectLockRetryTimer) clearTimeout(disconnectLockRetryTimer)
			disconnectLockRetryTimer = null
			if (eventReconnectTimer) clearTimeout(eventReconnectTimer)
			eventReconnectTimer = null
			if (rectSyncTimer) clearInterval(rectSyncTimer)
			rectSyncTimer = null
			if (eventSock) {
				try {
					eventSock.destroy()
				} catch {}
				eventSock = null
			}
			eventListeners.clear()
			for (const e of [...activeStreams]) {
				try {
					e.child.kill('SIGTERM')
				} catch {}
				try {
					e.ws.close(1001)
				} catch {}
			}
			activeStreams.clear()
		},
		procedures: {
			'hyprland.status': {kind: 'query', run: status},
			'hyprland.windows': {kind: 'query', run: (input) => windows({strict: input?.strict === true})},
			'hyprland.apps': {kind: 'query', run: (input) => apps({refresh: input?.refresh === true})},
			'hyprland.launch': {kind: 'mutation', run: launch},
			'hyprland.dispatch': {kind: 'mutation', run: dispatch},
			'hyprland.clipboardRead': {kind: 'query', run: clipboardRead},
			'hyprland.clipboardWrite': {kind: 'mutation', run: clipboardWrite},
			'hyprland.profiles': {kind: 'query', run: profiles},
			'hyprland.profileRun': {kind: 'mutation', run: profileRun},
			'hyprland.profileSave': {kind: 'mutation', run: profileSave},
			'hyprland.profileDelete': {kind: 'mutation', run: profileDelete},
		},
	}
}
