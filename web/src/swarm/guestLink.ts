import type {SwarmMetrics} from './gauges'

export type ConnectorKind = 'linux' | 'unsupported'

// Same rules as omarchyd/guest-install.mjs connectorKind. The connector runs on Linux with systemd or Alpine OpenRC.
export function connectorKind(osId = ''): ConnectorKind {
	const id = String(osId).toLowerCase()
	if (/win|macos|osx|darwin|haos|home-?assistant/.test(id)) return 'unsupported'
	return 'linux'
}

export function linuxConnectorOs(osId = ''): boolean {
	return connectorKind(osId) === 'linux'
}

export function isGuestAgent(agent: {guestOf?: string}): boolean {
	return typeof agent.guestOf === 'string' && /^[a-f0-9]{8}$/.test(agent.guestOf)
}

const CONTAINER_OF = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

export function isContainerAgent(agent: {containerOf?: string}): boolean {
	return typeof agent.containerOf === 'string' && CONTAINER_OF.test(agent.containerOf)
}

/** The connector installed on this virtual machine. An online one wins over an older install. */
export function guestAgent<T extends {guestOf?: string; online: boolean; enrolledAt: number}>(agents: readonly T[], machineId: string): T | undefined {
	const linked = agents.filter((agent) => agent.guestOf === machineId && isGuestAgent(agent))
	return linked.find((agent) => agent.online) ?? [...linked].sort((a, b) => b.enrolledAt - a.enrolledAt)[0]
}

/** The connector installed inside this system container. */
export function containerAgent<T extends {containerOf?: string; online: boolean; enrolledAt: number}>(agents: readonly T[], name: string): T | undefined {
	const linked = agents.filter((agent) => agent.containerOf === name && isContainerAgent(agent))
	return linked.find((agent) => agent.online) ?? [...linked].sort((a, b) => b.enrolledAt - a.enrolledAt)[0]
}

export type GuestTaskTime = {type: string; status: string; startedAt: number; endedAt?: number}

const GUEST_BOOT = new Set(['start', 'reboot'])
const GUEST_OFF = new Set(['stop', 'shutdown', 'hibernate'])

function latestTaskAt(tasks: readonly GuestTaskTime[] | undefined, types: Set<string>): number | null {
	let best: number | null = null
	for (const task of tasks ?? []) {
		if (task.status !== 'ok' || !types.has(task.type)) continue
		const at = task.endedAt ?? task.startedAt
		if (!Number.isFinite(at) || at <= 0) continue
		if (best == null || at > best) best = at
	}
	return best
}

/** Seconds since the guest was started or rebooted, when nothing has shut it down since. */
export function guestUptimeSeconds(tasks: readonly GuestTaskTime[] | undefined, now: number): number | null {
	const boot = latestTaskAt(tasks, GUEST_BOOT)
	if (boot == null || boot > now) return null
	const off = latestTaskAt(tasks, GUEST_OFF)
	if (off != null && off >= boot) return null
	return Math.max(0, (now - boot) / 1000)
}

/** When a shut-down guest was stopped, if that action was recorded. */
export function guestPoweredOffAt(tasks: readonly GuestTaskTime[] | undefined): number | null {
	return latestTaskAt(tasks, GUEST_OFF)
}

/** Host CPU and memory for a running guest. In-guest disk use is not in this sample. */
export function hostGuestMetrics(last: {cpu: number; memMb: number} | null | undefined, memoryMb: number, vcpus: number): SwarmMetrics | null {
	if (!last || !Number.isFinite(last.cpu)) return null
	const total = memoryMb > 0 ? memoryMb * 1024 * 1024 : 0
	const used = Number.isFinite(last.memMb) ? Math.max(0, last.memMb) * 1024 * 1024 : 0
	return {
		cpu: last.cpu,
		cores: vcpus > 0 ? vcpus : undefined,
		mem: total > 0 ? {total, used} : null,
	}
}
