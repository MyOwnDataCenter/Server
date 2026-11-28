// The System dashboard: what the server is doing now and over the last hour, day or week.
// Summary first (tiles with a status word), then the graphs, then what is using the server.
import {useMemo, useState, type CSSProperties} from 'react'
import {useQuery} from '@tanstack/react-query'
import {query, type UsageItem} from '../api'
import {useCpu, useDisk, useMemory, useUptime} from '../data'
import {Icon, type IconName} from '../icons'
import {Segmented} from '../ui'
import {TimeChart, type Series} from './TimeChart'
import './dashboard.css'

type Point = {t: number; cpu: number | null; mem: number | null; load: number | null; net: Record<string, [number, number]>; disk: Record<string, [number, number]>}
type History = {range: Range; stepMs: number; points: Point[]}
type Range = 'live' | '1h' | '24h' | '7d'

const RANGES: {id: Range; label: string}[] = [
	{id: 'live', label: 'Live'},
	{id: '1h', label: 'Last hour'},
	{id: '24h', label: 'Last day'},
	{id: '7d', label: 'Last week'},
]

export function rate(bytesPerSecond: number): string {
	const v = Math.max(0, bytesPerSecond)
	if (v < 1024) return `${Math.round(v)} B/s`
	if (v < 1024 ** 2) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB/s`
	if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(v < 10 * 1024 ** 2 ? 1 : 0)} MB/s`
	return `${(v / 1024 ** 3).toFixed(1)} GB/s`
}
const bytes = (v: number) => (v >= 1024 ** 4 ? `${(v / 1024 ** 4).toFixed(1)} TB` : v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GB` : `${Math.round(v / 1024 ** 2)} MB`)
const pct = (v: number) => `${Math.round(v)}%`
const uptimeText = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)

/** Good / warning / critical for a percentage, with the word shown next to the colour. */
export function level(v: number | null | undefined, warn = 80, crit = 90): {kind: 'ok' | 'warn' | 'crit' | 'none'; word: string} {
	if (v == null) return {kind: 'none', word: 'No data'}
	if (v >= crit) return {kind: 'crit', word: 'Critical'}
	if (v >= warn) return {kind: 'warn', word: 'High'}
	return {kind: 'ok', word: 'Normal'}
}

/** The busiest device in the newest point, so the chooser starts on the interface or drive that matters. */
export function busiest(points: Point[], key: 'net' | 'disk'): string | null {
	const names = [...new Set(points.flatMap((p) => Object.keys(p[key])))]
	if (!names.length) return null
	const total = (n: string) => points.reduce((sum, p) => sum + (p[key][n]?.[0] ?? 0) + (p[key][n]?.[1] ?? 0), 0)
	return names.sort((a, b) => total(b) - total(a))[0]
}

function Tile({icon, label, value, sub, state, values, color}: {icon: IconName; label: string; value: string; sub: string; state: ReturnType<typeof level>; values: (number | null)[]; color: string}) {
	const last = values.slice(-60)
	const top = Math.max(1, ...last.filter((v): v is number => v != null))
	const d = last.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, last.length - 1)) * 100).toFixed(1)},${(30 - ((v ?? 0) / top) * 28).toFixed(1)}`).join('')
	return (
		<div className={`dash-tile glass is-${state.kind}`}>
			<div className="dash-tile-head">
				<span className="dash-ico" style={{color}}>
					<Icon name={icon} size={16} />
				</span>
				<span className="dash-tile-label">{label}</span>
				{state.kind !== 'none' && <span className={`dash-state is-${state.kind}`}>{state.word}</span>}
			</div>
			<b className="dash-tile-value num">{value}</b>
			<span className="dash-tile-sub">{sub}</span>
			{last.length > 1 && (
				<svg className="dash-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
					<path d={d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
				</svg>
			)}
		</div>
	)
}

function Chooser({names, value, onChange, label}: {names: string[]; value: string | null; onChange: (v: string) => void; label: string}) {
	if (names.length < 2) return value ? <span className="dash-dev mono">{value}</span> : null
	return (
		<label className="dash-select">
			<span className="sr-only">{label}</span>
			<select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
				{names.map((n) => (
					<option key={n} value={n}>
						{n}
					</option>
				))}
			</select>
		</label>
	)
}

function Consumers({cpu, memory}: {cpu?: {apps: UsageItem[]; machines: UsageItem[]; system: number}; memory?: {apps: UsageItem[]; machines: UsageItem[]; system: number; size: number}}) {
	const rows = useMemo(() => {
		if (!cpu || !memory) return []
		const byId = new Map<string, {id: string; name: string; kind: string; cpu: number; mem: number}>()
		const add = (list: UsageItem[], kind: string, field: 'cpu' | 'mem') =>
			list.forEach((u) => {
				const row = byId.get(u.id) ?? {id: u.id, name: u.name ?? u.id, kind, cpu: 0, mem: 0}
				byId.set(u.id, {...row, [field]: u.used})
			})
		add(cpu.machines, 'Machine', 'cpu')
		add(cpu.apps, 'App', 'cpu')
		add(memory.machines, 'Machine', 'mem')
		add(memory.apps, 'App', 'mem')
		return [{id: 'system', name: 'The server itself', kind: 'System', cpu: cpu.system, mem: memory.system}, ...byId.values()].sort((a, b) => b.mem - a.mem).slice(0, 6)
	}, [cpu, memory])
	if (!rows.length) return <p className="dash-note">Measuring…</p>
	return (
		<table className="dash-table">
			<thead>
				<tr>
					<th scope="col">Using the server</th>
					<th scope="col">CPU</th>
					<th scope="col">Memory</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr key={r.id}>
						<td>
							<b>{r.name}</b>
							<span>{r.kind}</span>
						</td>
						<td className="num">
							<span className="dash-bar" style={{'--w': `${Math.min(100, r.cpu)}%`, '--c': 'var(--blue)'} as CSSProperties} />
							{pct(r.cpu)}
						</td>
						<td className="num">
							<span className="dash-bar" style={{'--w': `${memory ? Math.min(100, (100 * r.mem) / memory.size) : 0}%`, '--c': 'var(--mauve)'} as CSSProperties} />
							{bytes(r.mem)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

function StorageBar({disk}: {disk?: {size: number; available: number; system: number; files?: number; apps: UsageItem[]; machines: UsageItem[]}}) {
	if (!disk?.size) return <p className="dash-note">Measuring…</p>
	const sum = (l: UsageItem[]) => l.reduce((a, u) => a + u.used, 0)
	const parts = [
		{label: 'System', v: disk.system, c: 'var(--muted)'},
		{label: 'Files', v: disk.files ?? 0, c: 'var(--blue)'},
		{label: 'Apps', v: sum(disk.apps), c: 'var(--mauve)'},
		{label: 'Machines', v: sum(disk.machines), c: 'var(--teal)'},
		{label: 'Free', v: disk.available, c: 'var(--line-2)'},
	].filter((p) => p.v > 0)
	const total = parts.reduce((a, p) => a + p.v, 0) || 1
	return (
		<div className="dash-storage">
			<div className="dash-stack" role="img" aria-label={parts.map((p) => `${p.label} ${bytes(p.v)}`).join(', ')}>
				{parts.map((p) => (
					<span key={p.label} style={{flexGrow: p.v / total, background: p.c}} title={`${p.label}: ${bytes(p.v)}`} />
				))}
			</div>
			<ul className="dash-keys">
				{parts.map((p) => (
					<li key={p.label}>
						<i style={{background: p.c}} />
						{p.label} <b className="num">{bytes(p.v)}</b>
					</li>
				))}
			</ul>
		</div>
	)
}

const RANGE_KEY = 'omarchy-server:dash-range'
const savedRange = (): Range => {
	try {
		const v = localStorage.getItem(RANGE_KEY)
		return RANGES.some((r) => r.id === v) ? (v as Range) : '1h'
	} catch {
		return '1h'
	}
}
/** How often each view asks for new points: every second when live. */
export const REFRESH_MS: Record<Range, number> = {live: 1_000, '1h': 10_000, '24h': 60_000, '7d': 60_000}

export function Dashboard() {
	const [range, setRangeState] = useState<Range>(savedRange)
	const setRange = (r: Range) => {
		setRangeState(r)
		try {
			localStorage.setItem(RANGE_KEY, r)
		} catch {
			/* private mode: remembered for this visit only */
		}
	}
	const [iface, setIface] = useState<string | null>(null)
	const [drive, setDrive] = useState<string | null>(null)
	const hist = useQuery({queryKey: ['system.history', range], queryFn: () => query<History>('system.history', {range}), refetchInterval: REFRESH_MS[range], refetchIntervalInBackground: false})
	const cpu = useCpu().data
	const memory = useMemory().data
	const disk = useDisk().data
	const uptime = useUptime().data

	const points = hist.data?.points ?? []
	const times = points.map((p) => p.t)
	const nets = [...new Set(points.flatMap((p) => Object.keys(p.net)))]
	const drives = [...new Set(points.flatMap((p) => Object.keys(p.disk)))]
	const netName = iface && nets.includes(iface) ? iface : busiest(points, 'net')
	const driveName = drive && drives.includes(drive) ? drive : busiest(points, 'disk')
	const newest = points[points.length - 1]
	const memPct = memory?.size ? (100 * memory.totalUsed) / memory.size : null
	const diskPct = disk?.size ? (100 * disk.totalUsed) / (disk.totalUsed + disk.available) : null
	const netNow = netName && newest?.net[netName] ? newest.net[netName] : null
	const loadPerCore = newest?.load != null && cpu?.threads ? (100 * newest.load) / cpu.threads : null

	const cpuSeries: Series[] = [{label: 'CPU', color: 'var(--blue)', values: points.map((p) => p.cpu), area: true}]
	const memSeries: Series[] = [{label: 'Memory', color: 'var(--mauve)', values: points.map((p) => p.mem), area: true}]
	const netSeries: Series[] = [
		{label: 'In', color: 'var(--teal)', values: points.map((p) => (netName ? (p.net[netName]?.[0] ?? null) : null)), area: true},
		{label: 'Out', color: 'var(--peach)', values: points.map((p) => (netName ? (p.net[netName]?.[1] ?? null) : null))},
	]
	const diskSeries: Series[] = [
		{label: 'Read', color: 'var(--green)', values: points.map((p) => (driveName ? (p.disk[driveName]?.[0] ?? null) : null)), area: true},
		{label: 'Write', color: 'var(--yellow)', values: points.map((p) => (driveName ? (p.disk[driveName]?.[1] ?? null) : null))},
	]

	return (
		<section className="dash" aria-label="Dashboard">
			<div className="dash-head">
				<div>
					<h2>Dashboard</h2>
					<p className="dash-note">
						{range === 'live' && (
							<span className="dash-live" role="status">
								<i aria-hidden="true" />
								Live · every second
							</span>
						)}
						{uptime != null ? `Up ${uptimeText(uptime)}` : ''}{cpu?.threads ? ` · ${cpu.threads} CPU threads` : ''}{memory?.size ? ` · ${bytes(memory.size)} memory` : ''}
					</p>
				</div>
				<Segmented value={range} options={RANGES} onChange={setRange} label="Time range" />
			</div>

			<div className="dash-tiles">
				<Tile icon="cpu" label="CPU" value={cpu ? pct(cpu.totalUsed) : '–'} sub={loadPerCore != null ? `Load ${newest?.load} (${pct(loadPerCore)} of cores)` : 'Load –'} state={level(cpu?.totalUsed)} values={points.map((p) => p.cpu)} color="var(--blue)" />
				<Tile icon="memory" label="Memory" value={memPct != null ? pct(memPct) : '–'} sub={memory ? `${bytes(memory.totalUsed)} of ${bytes(memory.size)}` : ''} state={level(memPct, 85, 95)} values={points.map((p) => p.mem)} color="var(--mauve)" />
				<Tile icon="network" label="Network" value={netNow ? rate(netNow[0]) : '–'} sub={netNow ? `in · ${rate(netNow[1])} out · ${netName}` : 'No interface yet'} state={{kind: 'none', word: ''}} values={points.map((p) => (netName ? (p.net[netName]?.[0] ?? 0) + (p.net[netName]?.[1] ?? 0) : null))} color="var(--teal)" />
				<Tile icon="disk" label="Storage" value={diskPct != null ? pct(diskPct) : '–'} sub={disk ? `${bytes(disk.available)} free` : ''} state={level(diskPct, 80, 90)} values={[]} color="var(--green)" />
			</div>

			<div className="dash-grid">
				<article className="dash-card glass">
					<header>
						<h3>Processor</h3>
					</header>
					<TimeChart label="CPU use" times={times} series={cpuSeries} max={100} format={pct} />
				</article>
				<article className="dash-card glass">
					<header>
						<h3>Memory</h3>
					</header>
					<TimeChart label="Memory use" times={times} series={memSeries} max={100} format={pct} />
				</article>
				<article className="dash-card glass">
					<header>
						<h3>Network traffic</h3>
						<Chooser names={nets} value={netName} onChange={setIface} label="Interface" />
					</header>
					<TimeChart label={`Network traffic on ${netName ?? 'no interface'}`} times={times} series={netSeries} base={1024} format={rate} />
				</article>
				<article className="dash-card glass">
					<header>
						<h3>Disk activity</h3>
						<Chooser names={drives} value={driveName} onChange={setDrive} label="Drive" />
					</header>
					<TimeChart label={`Disk activity on ${driveName ?? 'no drive'}`} times={times} series={diskSeries} base={1024} format={rate} />
				</article>
				<article className="dash-card glass">
					<header>
						<h3>What's using the server</h3>
						<span className="dash-note">now</span>
					</header>
					<Consumers cpu={cpu} memory={memory} />
				</article>
				<article className="dash-card glass">
					<header>
						<h3>Storage</h3>
						<span className="dash-note">main drive</span>
					</header>
					<StorageBar disk={disk} />
				</article>
			</div>
			{hist.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					The graphs couldn’t load. They come back on their own once the server answers.
				</div>
			)}
		</section>
	)
}
