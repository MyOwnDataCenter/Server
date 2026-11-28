// The server's own history for the System dashboard: CPU, memory, load, network traffic per
// interface and disk reads/writes per drive. One sample every 10 s, always on (it reads four small
// /proc files, nothing that wakes hardware). Kept in three resolutions, like an RRD:
//   10 s for the last hour, 1 min for the last day, 5 min for the last week.
// Saved to <dataDir>/history.json every 5 minutes and on close, so a restart keeps the graphs.
import {readFile, writeFile, rename} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

export const TIERS = [
	{range: '1h', stepMs: 10_000, keep: 360},
	{range: '24h', stepMs: 60_000, keep: 1440},
	{range: '7d', stepMs: 300_000, keep: 2016},
]
// Live: one sample a second, the last five minutes. It runs only while someone is watching it and
// stops 30 s after the last look, so an idle server isn't sampling every second.
export const LIVE = {range: 'live', stepMs: 1_000, keep: 300, idleMs: 30_000}
export const RANGES = [LIVE.range, ...TIERS.map((t) => t.range)]
const SAVE_EVERY_MS = 5 * 60_000
const MAX_DEVICES = 16
const SECTOR = 512

// Interfaces that only carry traffic between containers or VMs on this server, counted already on
// the real interface (or not at all, for loopback).
const SKIP_IFACE = /^(lo|veth|podman|docker|br-|cni|vnet|virbr|flannel|kube)/
// Whole drives only: partitions would count the same bytes twice.
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/

export function parseCpu(text) {
	const line = String(text).split('\n').find((l) => l.startsWith('cpu '))
	if (!line) return null
	const v = line.trim().split(/\s+/).slice(1).map(Number)
	if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null
	const idle = v[3] + (v[4] ?? 0)
	const total = v.slice(0, 8).reduce((a, b) => a + b, 0)
	return {busy: total - idle, total}
}

export function parseMem(text) {
	const kb = (key) => {
		const m = String(text).match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
		return m ? Number(m[1]) * 1024 : null
	}
	const total = kb('MemTotal')
	const available = kb('MemAvailable')
	if (!total || available == null) return null
	return {total, used: Math.max(0, total - available)}
}

export function parseNet(text) {
	const out = {}
	for (const line of String(text).split('\n').slice(2)) {
		const m = line.match(/^\s*([^:\s]+):\s*(.*)$/)
		if (!m || SKIP_IFACE.test(m[1])) continue
		const f = m[2].trim().split(/\s+/).map(Number)
		if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue
		out[m[1]] = {rx: f[0], tx: f[8]}
		if (Object.keys(out).length >= MAX_DEVICES) break
	}
	return out
}

export function parseDisk(text) {
	const out = {}
	for (const line of String(text).split('\n')) {
		const f = line.trim().split(/\s+/)
		if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue
		const read = Number(f[5]) * SECTOR
		const written = Number(f[9]) * SECTOR
		if (!Number.isFinite(read) || !Number.isFinite(written)) continue
		out[f[2]] = {read, written}
		if (Object.keys(out).length >= MAX_DEVICES) break
	}
	return out
}

const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places
const perSecond = (now, before, seconds) => (now >= before && seconds > 0 ? Math.round((now - before) / seconds) : 0)

/** One point from two raw readings taken `seconds` apart. Counters that went backwards (a reboot, an interface that came back) read as 0. */
export function pointFrom(prev, cur, seconds, t) {
	const cpu = prev.cpu && cur.cpu && cur.cpu.total > prev.cpu.total ? round((100 * (cur.cpu.busy - prev.cpu.busy)) / (cur.cpu.total - prev.cpu.total)) : null
	const net = {}
	for (const [name, c] of Object.entries(cur.net ?? {})) {
		const p = prev.net?.[name]
		if (p) net[name] = [perSecond(c.rx, p.rx, seconds), perSecond(c.tx, p.tx, seconds)]
	}
	const disk = {}
	for (const [name, c] of Object.entries(cur.disk ?? {})) {
		const p = prev.disk?.[name]
		if (p) disk[name] = [perSecond(c.read, p.read, seconds), perSecond(c.written, p.written, seconds)]
	}
	return {
		t,
		cpu: cpu == null ? null : Math.max(0, Math.min(100, cpu)),
		mem: cur.mem ? round((100 * cur.mem.used) / cur.mem.total) : null,
		load: cur.load == null ? null : round(cur.load, 2),
		net,
		disk,
	}
}

/** The average of several points (for the 1 min and 5 min tiers). Network and disk keep the mean rate. */
export function averagePoints(points, t) {
	const mean = (vals) => {
		const ok = vals.filter((v) => typeof v === 'number')
		return ok.length ? round(ok.reduce((a, b) => a + b, 0) / ok.length, 2) : null
	}
	const pairs = (key) => {
		const names = new Set(points.flatMap((p) => Object.keys(p[key] ?? {})))
		const out = {}
		for (const n of names) {
			const rows = points.map((p) => p[key]?.[n]).filter(Boolean)
			out[n] = [Math.round(mean(rows.map((r) => r[0])) ?? 0), Math.round(mean(rows.map((r) => r[1])) ?? 0)]
		}
		return out
	}
	return {t, cpu: mean(points.map((p) => p.cpu)), mem: mean(points.map((p) => p.mem)), load: mean(points.map((p) => p.load)), net: pairs('net'), disk: pairs('disk')}
}

function cleanPoint(p) {
	if (!p || typeof p !== 'object' || !Number.isFinite(p.t)) return null
	const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
	const pairs = (o) => {
		const out = {}
		for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {}).slice(0, MAX_DEVICES)) {
			if (/^[\w.:-]{1,32}$/.test(k) && Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n >= 0)) out[k] = [v[0], v[1]]
		}
		return out
	}
	return {t: p.t, cpu: num(p.cpu), mem: num(p.mem), load: num(p.load), net: pairs(p.net), disk: pairs(p.disk)}
}

export async function readRaw(readText = (p) => readFile(p, 'utf8')) {
	const [stat, mem, net, disk] = await Promise.all(['/proc/stat', '/proc/meminfo', '/proc/net/dev', '/proc/diskstats'].map((p) => readText(p).catch(() => '')))
	return {cpu: parseCpu(stat), mem: parseMem(mem), net: parseNet(net), disk: parseDisk(disk), load: os.loadavg()[0]}
}

export function createHistory({dataDir, now = Date.now, read = readRaw, setIntervalFn = setInterval, clearIntervalFn = clearInterval} = {}) {
	const file = dataDir ? join(dataDir, 'history.json') : null
	const tiers = TIERS.map(() => [])
	const pendingUp = TIERS.map(() => [])
	let prev = null
	let prevAt = 0
	let timer = null
	let lastSave = now()
	const live = {points: [], prev: null, prevAt: 0, timer: null, lastRead: 0, busy: false}

	function push(i, point) {
		const list = tiers[i]
		list.push(point)
		if (list.length > TIERS[i].keep) list.splice(0, list.length - TIERS[i].keep)
		const next = i + 1
		if (next >= TIERS.length) return
		pendingUp[next].push(point)
		const span = TIERS[next].stepMs / TIERS[i].stepMs
		if (pendingUp[next].length >= span) {
			const group = pendingUp[next].splice(0)
			push(next, averagePoints(group, group[group.length - 1].t))
		}
	}

	async function sample() {
		const cur = await read()
		const at = now()
		if (prev) {
			const seconds = (at - prevAt) / 1000
			if (seconds > 0 && seconds < 120) push(0, pointFrom(prev, cur, seconds, at))
		}
		prev = cur
		prevAt = at
		if (at - lastSave >= SAVE_EVERY_MS) await save()
	}

	async function save() {
		lastSave = now()
		if (!file) return
		const tmp = `${file}.tmp`
		await writeFile(tmp, JSON.stringify({v: 1, tiers}), {mode: 0o600})
		await rename(tmp, file)
	}

	async function load() {
		if (!file) return
		try {
			const saved = JSON.parse(await readFile(file, 'utf8'))
			if (saved?.v !== 1 || !Array.isArray(saved.tiers)) return
			saved.tiers.slice(0, TIERS.length).forEach((list, i) => {
				if (!Array.isArray(list)) return
				const oldest = now() - TIERS[i].stepMs * TIERS[i].keep
				tiers[i] = list.map(cleanPoint).filter((p) => p && p.t >= oldest && p.t <= now()).slice(-TIERS[i].keep)
			})
		} catch {
			/* no history yet, or a damaged file: start fresh */
		}
	}

	function stopLive() {
		if (live.timer != null) clearIntervalFn(live.timer)
		Object.assign(live, {timer: null, prev: null, points: []})
	}

	async function liveSample() {
		if (now() - live.lastRead > LIVE.idleMs) return stopLive()
		if (live.busy) return
		live.busy = true
		try {
			const cur = await read()
			const at = now()
			if (live.prev) {
				const seconds = (at - live.prevAt) / 1000
				if (seconds > 0 && seconds < 10) {
					live.points.push(pointFrom(live.prev, cur, seconds, at))
					if (live.points.length > LIVE.keep) live.points.splice(0, live.points.length - LIVE.keep)
				}
			}
			live.prev = cur
			live.prevAt = at
		} finally {
			live.busy = false
		}
	}

	function get(range = '1h') {
		if (range === LIVE.range) {
			live.lastRead = now()
			if (live.timer == null) {
				// Start from the recent 10 s history so the chart isn't empty while the first seconds arrive.
				live.points = tiers[0].filter((p) => p.t >= now() - LIVE.keep * LIVE.stepMs).slice(-30)
				void liveSample().catch(() => {})
				live.timer = setIntervalFn(() => void liveSample().catch(() => {}), LIVE.stepMs)
				live.timer?.unref?.()
			}
			return {range, stepMs: LIVE.stepMs, points: live.points}
		}
		const i = TIERS.findIndex((t) => t.range === range)
		if (i < 0) throw new Error('Unknown range')
		return {range, stepMs: TIERS[i].stepMs, points: tiers[i]}
	}

	async function start() {
		await load()
		await sample().catch(() => {})
		timer = setIntervalFn(() => void sample().catch(() => {}), TIERS[0].stepMs)
		timer?.unref?.()
	}

	async function stop() {
		stopLive()
		if (timer != null) clearIntervalFn(timer)
		timer = null
		await save().catch(() => {})
	}

	return {start, stop, get, sample, save, load, liveSample}
}
