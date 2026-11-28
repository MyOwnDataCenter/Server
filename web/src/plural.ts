// Counts and ages in plain words: "1 core", "2 cores", "59 min ago", "1 day ago".
export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? word : many}`
}

// How long ago something was, from an age in seconds. Whole units are rounded down, so 59.9 minutes never reads "60 min".
export function agoText(seconds: number): string {
	const s = Math.max(0, seconds)
	if (s < 90) return 'just now'
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`
	return `${plural(Math.floor(s / 86400), 'day')} ago`
}

// A drive's power-on time: hours until it has been on for a day, then days.
export function poweredOnText(hours: number): string {
	return hours < 24 ? plural(Math.round(hours), 'hour') : plural(Math.round(hours / 24), 'day')
}
