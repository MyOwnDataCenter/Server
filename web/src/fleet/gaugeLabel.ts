/** The spoken name of a gauge button. A gauge that needs attention still says its reading, not only "tap for details". */
export function gaugeButtonLabel(name: string, reading: string, level: 'ok' | 'warning' | 'danger'): string {
	if (level === 'ok') return `${name}, ${reading}`
	return `${name}, ${reading}, ${level === 'danger' ? 'critical' : 'needs attention'}, tap for details`
}
