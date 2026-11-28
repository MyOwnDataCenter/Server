// Home rings count online computers only. A guest's or system container's CPU is already inside its host.
// CPU is weighted by cores. GPU is the average of computers that have one.
// Temperature is the hottest computer, never an average.
// Battery is one ring: each laptop is an arc from 12 o'clock, longest drawn first.
// Charges within BAT_NEAR share one arc.

export const BAT_NEAR = 8

const BATTERY_COLORS = ['#38bdf8', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb7185']

export type FleetSample = {
	id: string
	name: string
	online: boolean
	cores: number
	cpu: number | null
	memUsed: number | null
	memTotal: number | null
	diskUsed: number | null
	diskTotal: number | null
	temp: number | null
	gpus: {id: string; used: number | null}[]
	battery: number | null
}

export type BatteryMember = {id: string; name: string; percent: number; color: string}

export type BatteryGroup = {
	id: string
	percent: number
	members: BatteryMember[]
}

export type FleetRings = {
	cpu: {percent: number; ready: boolean; busiest: string | null}
	memory: {percent: number; ready: boolean; busiest: string | null; used: number; total: number}
	storage: {percent: number; ready: boolean; busiest: string | null; used: number; total: number}
	gpu: {percent: number; ready: boolean; busiest: string | null} | null
	battery: {lowest: BatteryMember; groups: BatteryGroup[]} | null
	temp: {celsius: number; name: string} | null
}

const round = (n: number) => Math.round(n)

function pct(used: number, total: number) {
	return total > 0 ? (100 * used) / total : 0
}

export function batteryColorFor(id: string, ids: readonly string[]) {
	const index = [...ids].sort().indexOf(id)
	return BATTERY_COLORS[(index < 0 ? 0 : index) % BATTERY_COLORS.length]
}

/** Longest charge first. A laptop joins the open group when it is within BAT_NEAR of that group's fullest charge. */
export function batteryGroups(laptops: readonly {id: string; name: string; percent: number}[]): BatteryGroup[] {
	const colors = new Map(laptops.map((row) => [row.id, batteryColorFor(row.id, laptops.map((r) => r.id))]))
	const sorted = [...laptops].filter((row) => Number.isFinite(row.percent)).sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name))
	const groups: BatteryMember[][] = []
	for (const row of sorted) {
		const member: BatteryMember = {id: row.id, name: row.name, percent: row.percent, color: colors.get(row.id) ?? BATTERY_COLORS[0]}
		const open = groups[groups.length - 1]
		const fullest = open?.[0]
		if (open && fullest && fullest.percent - row.percent <= BAT_NEAR) open.push(member)
		else groups.push([member])
	}
	return groups.map((members) => ({
		id: members.map((m) => m.id).join('+'),
		percent: round(members.reduce((sum, m) => sum + m.percent, 0) / members.length),
		members,
	}))
}

export function batterySweep(level: number, size = 84, stroke = 8) {
	const r = (size - stroke) / 2
	const cx = size / 2
	const cy = size / 2
	const clamped = Math.max(0, Math.min(100, level))
	const start = -Math.PI / 2
	const sweep = (clamped / 100) * Math.PI * 2
	const end = start + sweep
	const x1 = cx + r * Math.cos(start)
	const y1 = cy + r * Math.sin(start)
	const x2 = cx + r * Math.cos(end)
	const y2 = cy + r * Math.sin(end)
	const large = sweep > Math.PI ? 1 : 0
	return {
		d: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
		endX: x2,
		endY: y2,
		endLeft: x2 < cx,
		full: clamped >= 99.5,
	}
}

function busiest(rows: {name: string; value: number}[]) {
	if (!rows.length) return null
	return [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))[0].name
}

export function fleetRings(samples: readonly FleetSample[]): FleetRings {
	const online = samples.filter((s) => s.online)
	const cpuRows = online.filter((s) => s.cpu != null && s.cores > 0)
	const cpuWeight = cpuRows.reduce((sum, s) => sum + s.cores, 0)
	const cpu = cpuWeight > 0 ? cpuRows.reduce((sum, s) => sum + (s.cpu ?? 0) * s.cores, 0) / cpuWeight : 0
	const memRows = online.filter((s) => s.memUsed != null && s.memTotal != null && s.memTotal > 0)
	const memUsed = memRows.reduce((sum, s) => sum + (s.memUsed ?? 0), 0)
	const memTotal = memRows.reduce((sum, s) => sum + (s.memTotal ?? 0), 0)
	const diskRows = online.filter((s) => s.diskUsed != null && s.diskTotal != null && s.diskTotal > 0)
	const diskUsed = diskRows.reduce((sum, s) => sum + (s.diskUsed ?? 0), 0)
	const diskTotal = diskRows.reduce((sum, s) => sum + (s.diskTotal ?? 0), 0)
	const gpuRows = online
		.map((s) => {
			const known = s.gpus.map((g) => g.used).filter((n): n is number => n != null)
			if (!known.length) return null
			return {name: s.name, value: known.reduce((a, b) => a + b, 0) / known.length}
		})
		.filter((row): row is {name: string; value: number} => row != null)
	const temps = online.filter((s) => s.temp != null && Number.isFinite(s.temp))
	const hottest = [...temps].sort((a, b) => (b.temp ?? 0) - (a.temp ?? 0) || a.name.localeCompare(b.name))[0]
	const laptops = online
		.filter((s) => s.battery != null && Number.isFinite(s.battery))
		.map((s) => ({id: s.id, name: s.name, percent: s.battery ?? 0}))
	const groups = batteryGroups(laptops)
	const lowest = [...laptops].sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name))[0]
	const lowestMember = lowest ? groups.flatMap((g) => g.members).find((m) => m.id === lowest.id) : undefined
	return {
		cpu: {percent: round(cpu), ready: cpuRows.length > 0, busiest: busiest(cpuRows.map((s) => ({name: s.name, value: s.cpu ?? 0})))},
		memory: {percent: round(pct(memUsed, memTotal)), ready: memRows.length > 0, busiest: busiest(memRows.map((s) => ({name: s.name, value: pct(s.memUsed ?? 0, s.memTotal ?? 0)}))), used: memUsed, total: memTotal},
		storage: {percent: round(pct(diskUsed, diskTotal)), ready: diskRows.length > 0, busiest: busiest(diskRows.map((s) => ({name: s.name, value: pct(s.diskUsed ?? 0, s.diskTotal ?? 0)}))), used: diskUsed, total: diskTotal},
		gpu: gpuRows.length ? {percent: round(gpuRows.reduce((sum, row) => sum + row.value, 0) / gpuRows.length), ready: true, busiest: busiest(gpuRows)} : null,
		battery: lowestMember ? {lowest: lowestMember, groups} : null,
		temp: hottest?.temp != null ? {celsius: hottest.temp, name: hottest.name} : null,
	}
}

type Metrics = {
	cpu?: number | null
	cores?: number | null
	mem?: {total: number; used: number} | null
	disks?: {mount: string; total: number; used: number}[]
	gpus?: {id: string; used: number | null}[]
	batteries?: {percent: number | null}[]
	temp?: number | null
}

function batteryPercent(batteries: {percent: number | null}[] | null | undefined) {
	const known = (batteries ?? []).map((b) => b.percent).filter((n): n is number => n != null)
	if (!known.length) return null
	return known.reduce((sum, n) => sum + n, 0) / known.length
}

export function computerSample(row: {id: string; name: string; online: boolean; metrics?: Metrics | null}): FleetSample {
	const m = row.metrics
	const disk = m?.disks?.find((d) => d.mount === '/') ?? m?.disks?.[0]
	const battery = batteryPercent(m?.batteries)
	return {
		id: row.id,
		name: row.name,
		online: row.online,
		cores: m?.cores && m.cores > 0 ? m.cores : m?.cpu != null ? 1 : 0,
		cpu: m?.cpu ?? null,
		memUsed: m?.mem?.used ?? null,
		memTotal: m?.mem?.total ?? null,
		diskUsed: disk?.used ?? null,
		diskTotal: disk?.total ?? null,
		temp: m?.temp ?? null,
		gpus: m?.gpus ?? [],
		battery,
	}
}

export type GaugeKind = 'CPU' | 'Memory' | 'Storage' | 'GPU' | 'Battery'

/** One machine's share of the gauge that was opened. Null means that machine has no reading. */
export function samplePercent(sample: FleetSample, kind: GaugeKind, gpuId?: string): number | null {
	if (kind === 'CPU') return sample.cpu
	if (kind === 'Memory') return sample.memUsed != null && sample.memTotal ? pct(sample.memUsed, sample.memTotal) : null
	if (kind === 'Storage') return sample.diskUsed != null && sample.diskTotal ? pct(sample.diskUsed, sample.diskTotal) : null
	if (kind === 'Battery') return sample.battery
	if (gpuId) {
		const one = sample.gpus.find((g) => g.id === gpuId)
		if (one) return one.used
	}
	const known = sample.gpus.map((g) => g.used).filter((n): n is number => n != null)
	if (!known.length) return null
	return known.reduce((sum, n) => sum + n, 0) / known.length
}

export function serverSample(row: {
	id?: string
	name: string
	cores: number
	cpu: number | null
	memUsed: number | null
	memTotal: number | null
	diskUsed: number | null
	diskTotal: number | null
	temp: number | null
	gpus: {id: string; used: number | null}[]
	battery: number | null
}): FleetSample {
	return {
		id: row.id ?? 'server',
		name: row.name,
		online: true,
		cores: row.cores,
		cpu: row.cpu,
		memUsed: row.memUsed,
		memTotal: row.memTotal,
		diskUsed: row.diskUsed,
		diskTotal: row.diskTotal,
		temp: row.temp,
		gpus: row.gpus,
		battery: row.battery,
	}
}
