// Rules for toasts. The screen renders these. It does not decide them.

export type ToastLevel = 'note' | 'problem'

export type ToastRecord = {
	id: string
	text: string
	at: number
	href: string | null
	expireAt: number | null
	level: ToastLevel
}

export function liveToasts(rows: readonly ToastRecord[], now: number): ToastRecord[] {
	return rows
		.filter((row) => row.expireAt == null || row.expireAt > now)
		.slice()
		.sort((a, b) => {
			const level = Number(b.level === 'problem') - Number(a.level === 'problem')
			return level || b.at - a.at
		})
}

export function toastSurface(input: {floating: boolean; covered: boolean}): 'bubble' | 'box' {
	return input.floating && !input.covered ? 'bubble' : 'box'
}

export function toastRemaining(row: {at: number; expireAt: number | null}, now: number): number | null {
	if (row.expireAt == null) return null
	const span = row.expireAt - row.at
	if (!(span > 0)) return null
	const left = row.expireAt - now
	if (left <= 0) return 0
	if (left >= span) return 1
	return left / span
}
