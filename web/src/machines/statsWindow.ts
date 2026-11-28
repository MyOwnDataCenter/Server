const HOUR_MS = 60 * 60 * 1000

// Chart samples stay in the series after a stop, so the axis is the timestamps, not the sample count.
export function pointsInLastHour<T extends {t: number}>(points: readonly T[], now = Date.now()): T[] {
	const cutoff = now - HOUR_MS
	return points.filter((p) => p.t >= cutoff)
}

// A stopped machine still has its last sample. The status line must not present that as current CPU.
export function cpuStatusText(running: boolean, last: {cpu: number} | null | undefined, cores: number): string {
	if (!running || last == null) return '–'
	return `${last.cpu}% of ${cores} CPU${cores > 1 ? 's' : ''}`
}

// Same rule for memory: a stopped machine holds no memory, so its last sample is not "used" now.
export function memoryStatusText(running: boolean, last: {memMb: number} | null | undefined, totalMb: number, format: (mb: number) => string): string {
	if (!running || last == null) return format(totalMb)
	return `${format(last.memMb)} of ${format(totalMb)}`
}
