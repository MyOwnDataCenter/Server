// Glance rings for a swarm computer: same set as Home, from connector metrics.

export type SwarmGpu = {
	id: string
	index: number
	name: string
	used: number | null
	vramUsed?: number | null
	vramTotal?: number | null
	temp?: number | null
	power?: number | null
}
export type SwarmBattery = {
	id: string
	index: number
	name: string
	percent: number | null
	status: 'charging' | 'discharging' | 'full' | 'not-charging' | 'unknown'
	secondsRemaining: number | null
	power: number | null
	energyNow: number | null
	energyFull: number | null
}
export type SwarmDisk = {mount: string; total: number; used: number}
export type SwarmMetrics = {
	cpu?: number | null
	cores?: number | null
	mem?: {total: number; used: number} | null
	swap?: {total: number; used: number} | null
	disks?: SwarmDisk[]
	gpus?: SwarmGpu[]
	batteries?: SwarmBattery[]
}

export function batteryColor(p: number) {
	return p <= 15 ? 'var(--red)' : p <= 25 ? 'var(--yellow)' : 'var(--green)'
}

function bytes(n: number | undefined, digits = 1, base: 1000 | 1024 = 1000) {
	if (n === undefined || !Number.isFinite(n)) return '–'
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
	let i = 0
	while (n >= base && i < units.length - 1) {
		n /= base
		i++
	}
	return `${n.toFixed(n >= 100 || i === 0 ? 0 : digits)} ${units[i]}`
}

const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (100 * used) / total)) : 0)

export function rootDisk(disks: SwarmDisk[] = []) {
	return disks.find((d) => d.mount === '/') ?? disks[0]
}

export function extraDisks(disks: SwarmDisk[] = []) {
	const root = rootDisk(disks)
	return root ? disks.filter((d) => d !== root) : []
}

function sumKnown(xs: Array<number | null>) {
	const known = xs.filter((n): n is number => n != null)
	return known.length ? known.reduce((a, b) => a + b, 0) : null
}

function combineBatteries(batteries: SwarmBattery[]): {percent: number | null; status: SwarmBattery['status']; secondsRemaining: number | null} | null {
	if (!batteries.length) return null
	if (batteries.length === 1) {
		const b = batteries[0]
		return {percent: b.percent, status: b.status, secondsRemaining: b.secondsRemaining}
	}
	const energyNow = batteries.every((b) => b.energyNow != null) ? sumKnown(batteries.map((b) => b.energyNow)) : null
	const energyFull = batteries.every((b) => b.energyFull != null) ? sumKnown(batteries.map((b) => b.energyFull)) : null
	const power = sumKnown(batteries.map((b) => b.power))
	const percents = batteries.map((b) => b.percent).filter((n): n is number => n != null)
	const percent =
		energyNow != null && energyFull != null && energyFull > 0
			? Math.round((100 * energyNow) / energyFull)
			: percents.length
				? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
				: null
	const status = batteries.some((b) => b.status === 'charging')
		? 'charging'
		: batteries.every((b) => b.status === 'full')
			? 'full'
			: batteries.some((b) => b.status === 'discharging')
				? 'discharging'
				: batteries.some((b) => b.status === 'not-charging')
					? 'not-charging'
					: 'unknown'
	let secondsRemaining: number | null = null
	if (power != null && power > 0 && energyNow != null) {
		if (status === 'discharging') secondsRemaining = Math.round((energyNow / (power * 1e6)) * 3600)
		else if (status === 'charging' && energyFull != null && energyFull > energyNow) secondsRemaining = Math.round(((energyFull - energyNow) / (power * 1e6)) * 3600)
	}
	return {percent, status, secondsRemaining}
}

function shortGpuName(name: string) {
	return name.replace(/^NVIDIA GeForce /, '').replace(/^NVIDIA /, '').replace(/^AMD Radeon /, '').replace(/^Intel\(R\) /, '').replace(/^Intel /, '')
}

function gpuSub(gpu: SwarmGpu) {
	const name = shortGpuName(gpu.name)
	if (gpu.vramTotal && gpu.vramTotal > 0 && gpu.vramUsed != null) {
		const vram = `${bytes(gpu.vramUsed, 1, 1024)}/${bytes(gpu.vramTotal, 0, 1024)}`
		return name ? `${name} · ${vram}` : vram
	}
	return name || ' '
}

function gpuItems(gpus: SwarmGpu[]) {
	const many = gpus.length > 1
	return gpus.map((gpu) => ({
		k: many ? `GPU ${gpu.index}` : 'GPU',
		key: gpu.id,
		icon: 'gpu' as const,
		p: gpu.used ?? 0,
		sub: gpu.used == null ? '–' : gpuSub(gpu),
		ready: gpu.used != null,
	}))
}

function batteryItem(batteries: SwarmBattery[]) {
	const combined = combineBatteries(batteries)
	if (!combined) return []
	return [
		{
			k: 'Battery',
			icon: 'battery' as const,
			p: combined.percent ?? 0,
			sub: combined.percent != null ? `${Math.round(combined.percent)}%` : '–',
			ready: combined.percent != null,
			color: batteryColor(combined.percent ?? 0),
		},
	]
}

export function swarmGaugeItems(m: SwarmMetrics | null | undefined) {
	if (!m || (m.cpu == null && !m.mem?.total && !(m.disks ?? []).length && !(m.gpus ?? []).length && !(m.batteries ?? []).length)) return []
	const disk = rootDisk(m.disks)
	const mem = m.mem
	const swap = m.swap && m.swap.total > 0 ? m.swap : null
	return [
		{
			k: 'CPU',
			icon: 'cpu' as const,
			p: m.cpu ?? 0,
			sub: m.cpu != null ? `${Math.round(m.cpu)}%` : '–',
			ready: m.cpu != null,
		},
		{
			k: 'Memory',
			icon: 'memory' as const,
			p: mem ? pct(mem.used, mem.total) : 0,
			sub: mem ? `${bytes(mem.used, 1, 1024)} of ${bytes(mem.total, 0, 1024)}` : '–',
			ready: !!mem?.total,
		},
		...(swap
			? [
					{
						k: 'Swap',
						icon: 'swap' as const,
						p: pct(swap.used ?? 0, swap.total),
						sub: `${bytes(swap.used ?? 0, 1, 1024)} of ${bytes(swap.total, 0, 1024)}`,
						ready: true,
					},
				]
			: []),
		...(disk
			? [
					{
						k: 'Storage',
						icon: 'disk' as const,
						p: pct(disk.used, disk.total),
						sub: `${bytes(disk.used, 1)} of ${bytes(disk.total, 0)}`,
						ready: true,
					},
				]
			: []),
		...gpuItems(m.gpus ?? []),
		...batteryItem(m.batteries ?? []),
	]
}
