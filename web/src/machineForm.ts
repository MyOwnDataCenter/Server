// Pure rules for the new-machine form. They match create() in omarchyd/machines.mjs.

const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/
const WINDOWS_USER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/

export function diskRange(os: {id?: string; familyId: string; platform?: string; manualSetup?: boolean}, profileMin: number): {min: number; max: number} {
	const windows = os.platform === 'windows' || os.familyId.startsWith('windows')
	const catalogInstaller = os.manualSetup === true && !String(os.id ?? '').startsWith('local:')
	const floor = windows ? 64 : os.familyId === 'omarchy' || catalogInstaller ? 20 : 4
	return {min: Math.max(profileMin, floor), max: 4096}
}

// Step 20 only while the move stays at or above 100 GB. Below that the step is 5, which is
// what crosses 100, so Less undoes More (95 ↔ 100, 96 ↔ 101).
export function nextDiskGb(value: number, direction: -1 | 1, bounds: {min: number; max: number}): number {
	const sign = direction < 0 ? -1 : 1
	const coarse = value + sign * 20
	const useCoarse = coarse >= 100 && (sign < 0 || value >= 100)
	const next = useCoarse ? coarse : value + sign * 5
	return Math.min(bounds.max, Math.max(bounds.min, next))
}

export function machineUsernameOk(username: string, windows: boolean): boolean {
	const name = username.trim()
	if (!name) return false
	if (windows) return WINDOWS_USER.test(name) && !/^(administrator|guest)$/i.test(name)
	return LINUX_USER.test(name) && name !== 'root'
}

export function machineUsernameHint(windows: boolean): string {
	return windows
		? 'Letters, numbers, dots, dashes and underscores; up to 20 characters (not Administrator or Guest).'
		: 'Lower-case letters, numbers, - and _ (not root).'
}

export function defaultCores(profile: {cores: number; minCores: number}, threads: number): number {
	return Math.min(Math.max(profile.cores, profile.minCores), Math.max(1, Math.floor(threads / 2)), threads)
}

export function hostMaxMemoryGb(mem: {size: number; totalUsed: number} | null): number {
	const totalGb = mem ? Math.floor(mem.size / 1024 ** 3) : 8
	const room = mem ? mem.size - Math.max(2e9, mem.totalUsed) : 6e9
	return Math.max(1, Math.floor(room / 1024 ** 3)) || totalGb
}

export function defaultMemoryGb(profile: {memoryGb: number; minMemoryGb: number}, mem: {size: number; totalUsed: number} | null): number {
	return Math.min(Math.max(profile.memoryGb, profile.minMemoryGb), hostMaxMemoryGb(mem))
}
