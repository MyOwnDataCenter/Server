// What to tell someone when a command we ran was stopped because it ran too long or printed too much.
// Node reports both as a killed child; the last lines it printed say nothing about why it stopped.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export function howLong(ms) {
	if (ms < 120_000) return plural(Math.max(1, Math.round(ms / 1000)), 'second')
	if (ms < 2 * 60 * 60_000) return plural(Math.round(ms / 60_000), 'minute')
	return plural(Math.round(ms / (60 * 60_000)), 'hour')
}

// The sentence for a stopped command, or null when the command simply failed (then its own output is the reason).
export function stoppedMessage(label, error, timeoutMs) {
	if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `${label} printed more than can be kept and was stopped`
	if (error?.killed) return `${label} took longer than ${howLong(timeoutMs)} and was stopped`
	return null
}
