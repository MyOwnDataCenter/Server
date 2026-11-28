export type BackupSchedule = {frequency: 'off' | 'daily' | 'weekly'; hour: number; weekday: number}

export function sameFolders(a: readonly string[], b: readonly string[]): boolean {
	const setA = new Set(a)
	const setB = new Set(b)
	if (setA.size !== setB.size) return false
	for (const item of setA) if (!setB.has(item)) return false
	return true
}

export function computerSheetChanged(
	picked: readonly string[],
	savedFolders: readonly string[],
	schedule: BackupSchedule,
	savedSchedule: BackupSchedule,
): boolean {
	return (
		!sameFolders(picked, savedFolders) ||
		schedule.frequency !== savedSchedule.frequency ||
		schedule.hour !== savedSchedule.hour ||
		schedule.weekday !== savedSchedule.weekday
	)
}

export function safeTimeZone(tz?: string): string | undefined {
	if (!tz) return undefined
	try {
		Intl.DateTimeFormat(undefined, {timeZone: tz})
		return tz
	} catch {
		return undefined
	}
}

export function formatBackupHour(h: number): string {
	return new Date(Date.UTC(2026, 0, 1, h)).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', timeZone: 'UTC'})
}

function dayKeyInZone(ms: number, timeZone?: string): [number, number, number] {
	const parts = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		...(timeZone ? {timeZone} : {}),
	}).formatToParts(ms)
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
	return [get('year'), get('month'), get('day')]
}

export function formatBackupWhen(
	t: number,
	timeZone?: string,
	nowMs = Date.now(),
	browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const tz = safeTimeZone(timeZone)
	const [ty, tm, td] = dayKeyInZone(t, tz)
	const [ny, nm, nd] = dayKeyInZone(nowMs, tz)
	const tomorrow = new Date(Date.UTC(ny, nm - 1, nd + 1))
	const time = new Date(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', ...(tz ? {timeZone: tz} : {})})
	const suffix = tz && tz !== browserTimeZone ? ` (${tz})` : ''
	if (ty === ny && tm === nm && td === nd) return `today at ${time}${suffix}`
	if (ty === tomorrow.getUTCFullYear() && tm === tomorrow.getUTCMonth() + 1 && td === tomorrow.getUTCDate()) {
		return `tomorrow at ${time}${suffix}`
	}
	const weekday = new Date(t).toLocaleDateString([], {weekday: 'long', ...(tz ? {timeZone: tz} : {})})
	return `${weekday} at ${time}${suffix}`
}

export function formatBackupStamp(t: number, timeZone?: string): string {
	const tz = safeTimeZone(timeZone)
	return new Date(t).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? {timeZone: tz} : {})})
}

export function serverLastRun<T extends {endedAt: number | null; computer?: string}>(s: {last?: T | null; history: readonly T[]}): T | null {
	return s.last !== undefined ? s.last : (s.history.find((r) => r.endedAt && !r.computer) ?? null)
}

export type BackupGap = {skipped?: readonly string[]; unreadable?: boolean; files?: number}

export function backupGapText(info: BackupGap | null | undefined): string {
	if (!info) return ''
	const skipped = (info.skipped ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
	const parts: string[] = []
	if (skipped.length === 1) parts.push(`${skipped[0]} wasn’t found on this computer`)
	else if (skipped.length > 1) parts.push(`${skipped.join(', ')} weren’t found on this computer`)
	if (info.unreadable) {
		const n = Number(info.files)
		parts.push(Number.isFinite(n) && n > 0 ? `${n} file${n === 1 ? '' : 's'} couldn’t be read` : 'Some files couldn’t be read')
	}
	return parts.join(' · ')
}

export function historyRowTone(r: {endedAt: number | null; ok: boolean; items?: readonly BackupGap[]}): 'running' | 'ok' | 'warn' | 'bad' {
	if (!r.endedAt) return 'running'
	if (!r.ok) return 'bad'
	if ((r.items ?? []).some((item) => backupGapText(item))) return 'warn'
	return 'ok'
}

export function folderListError(error: unknown): string | null {
	if (!error || typeof error !== 'object' || !('message' in error)) return null
	const message = (error as {message?: unknown}).message
	return typeof message === 'string' && message ? message : null
}

export function computerSnapshotRows<T>(rows: readonly T[] | null | undefined): readonly T[] {
	return rows ? [...rows] : []
}

/**
 * Has the Google sign-in that this sheet started finished? When the server was already signed in
 * (the person chose "Switch Google account"), the old sign-in still reports connected, so only a
 * different account counts. Signing in as the same account again is finished by pasting the code.
 */
export function gdriveSignInFinished(status: {connected: boolean; email?: string}, before: {connected: boolean; email?: string}): boolean {
	if (!status.connected) return false
	return !before.connected || (status.email ?? '') !== (before.email ?? '')
}
