// Shared by the transfer runner and the clip book screen. One copy, so the two cannot drift.

export const TRANSIENT_TRIES = 3
export const TOAST_LIFE_MS = 8_000
export const FOLDER_TO_COMPUTER = 'A folder can be saved on this server. Another computer can’t take a whole folder yet.'
export const FOLDER_FROM_COMPUTER = 'This server can’t take a whole folder from another computer yet.'
export const MISSING_FILE = /does-not-exist|isn’t in your home|isn't in your home|no such file/i

export function transferProgress(items) {
	const list = Array.isArray(items) ? items : []
	return {
		done: list.filter((item) => item.state === 'done').length,
		total: list.length,
		current: list.find((item) => item.state === 'sending')?.name ?? null,
	}
}

export function afterFailure(item, reason, error, max = TRANSIENT_TRIES) {
	const tries = item.tries + 1
	if (reason === 'transient' && tries < max) return {item: {...item, state: 'waiting', reason, tries, error}, pause: false}
	if (reason === 'transient') return {item: {...item, state: 'failed', reason, tries, error}, pause: true}
	return {item: {...item, state: 'failed', reason, tries, error}, pause: false}
}

export function resumeIds(items) {
	const list = Array.isArray(items) ? items : []
	return list
		.filter((item) => item.state === 'waiting' || item.state === 'sending' || (item.state === 'failed' && item.reason === 'transient'))
		.map((item) => item.clipId)
}

export function canResume(state, items) {
	return state === 'paused' && resumeIds(items).length > 0
}

export function jobToast(kind, name) {
	const href = '#/clips'
	if (kind === 'started') return {text: `Sending to ${name}`, level: 'note', untilDismiss: false, href}
	if (kind === 'finished') return {text: `Sent to ${name}`, level: 'note', untilDismiss: false, href}
	return {text: `Something didn’t send to ${name}. It’s in Clip book.`, level: 'problem', untilDismiss: true, href}
}
