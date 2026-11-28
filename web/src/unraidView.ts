export type UnraidItemStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export type UnraidItem = {
	kind: 'share' | 'container' | 'vm'
	key: string
	name: string
	size: number | null
	status: UnraidItemStatus
	step?: string
	progress?: number
	error?: string
	note?: string
	path?: string
	machineId?: string
	machineName?: string
}

export type UnraidJob = {
	id: string
	host: string
	startedAt: number
	endedAt: number | null
	destination: string
	items: UnraidItem[]
	cancelled?: boolean
	stopped?: string
}

export function itemStatusForView(item: Pick<UnraidItem, 'status'>, jobRunning: boolean): UnraidItemStatus {
	if (jobRunning) return item.status
	if (item.status === 'running') return 'failed'
	if (item.status === 'waiting') return 'skipped'
	return item.status
}

export function jobSummary(job: Pick<UnraidJob, 'host' | 'endedAt' | 'items' | 'cancelled' | 'stopped'>, connected: boolean) {
	const running = !job.endedAt
	const done = job.items.filter((i) => i.status === 'done').length
	const failed = job.items.filter((i) => itemStatusForView(i, running) === 'failed').length
	const incomplete = !running && (failed > 0 || !!job.stopped || !!job.cancelled || done < job.items.length)
	const heading = running
		? `Moving from ${job.host}… ${done} of ${job.items.length}`
		: incomplete
			? job.items.length
				? `${done} of ${job.items.length} came over`
				: 'Move stopped'
			: 'Everything came over'
	return {
		running,
		done,
		failed,
		incomplete,
		heading,
		canRetry: incomplete && connected,
	}
}

export function isKeyChangedError(message: string | null): boolean {
	return Boolean(message && /key changed/i.test(message))
}

export function retryActionState(scanning: boolean) {
	return {
		disabled: scanning,
		label: scanning ? 'Looking…' : 'Try the rest again',
		showSpinner: scanning,
	}
}

export function defaultSelectedVms(vms: {name: string; state: string; problems: string[]; installed?: boolean}[]): string[] {
	return vms.filter((v) => !v.installed && v.state === 'shut off' && !v.problems.length).map((v) => v.name)
}

export function formatBytes(n: number | null | undefined): string {
	if (n == null) return 'size unknown'
	if (n < 1024) return `${n} B`
	const u = ['KB', 'MB', 'GB', 'TB']
	let i = -1
	let v = n
	do {
		v /= 1024
		i++
	} while (v >= 1024 && i < u.length - 1)
	return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

export function formatTotalSize(sizes: (number | null | undefined)[]): string {
	let sum = 0
	let unknown = false
	for (const s of sizes) {
		if (s == null) unknown = true
		else sum += s
	}
	if (!unknown) return formatBytes(sum)
	return sum > 0 ? `at least ${formatBytes(sum)}` : 'size unknown'
}

/** The SSH port as typed. Blank is the default, 22. Text that is not a number stays NaN so the server refuses it instead of quietly using 22. */
export function typedSshPort(text: string): number {
	return text.trim() === '' ? 22 : Number(text)
}
