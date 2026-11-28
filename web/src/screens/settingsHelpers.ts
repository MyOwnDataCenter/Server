// Pure helpers and constants for Settings sheets.
export const PASSWORD_SHEET_SUBTITLE = 'Used to sign in'

// The server (omarchyd/accounts.mjs setPassword) refuses anything shorter.
export const MIN_PASSWORD_LENGTH = 8

// A refusal from system.update that the server sent back (not a dropped connection): its message to show, or null to keep waiting.
export function updateStartFailure(e: unknown): string | null {
	const err = e as {message?: unknown; status?: unknown; code?: unknown} | null
	if (!err || typeof err.status !== 'number' || err.status <= 0) return null
	// omarchyd restarting mid-update reaches us as UNREACHABLE (or a timeout): that is the update working, not a refusal.
	if (err.code === 'UNREACHABLE' || err.code === 'TIMEOUT') return null
	return typeof err.message === 'string' && err.message ? err.message : 'The update did not start'
}

// The browser a user-agent string names. Edge, Opera and the iPhone browsers also say "Chrome" or "Safari" in
// their string, so they are tested first.
export function browserName(ua: string): string {
	if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
	if (/OPR\/|OPiOS\/|Opera/.test(ua)) return 'Opera'
	if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
	if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
	if (/Safari\//.test(ua)) return 'Safari'
	return 'Browser'
}

// Has the update this page started finished? True once the server has reported it running and then reports it
// stopped without an error (after its restart it answers "Updated to X" at 100%). A status seen before the update
// began, such as the "Updated to X" left by an earlier update, must not count, hence `sawRunning`.
export function updateFinished(sawRunning: boolean, status: {running: boolean; error: boolean | string} | undefined): boolean {
	return sawRunning && !!status && !status.running && !status.error
}
