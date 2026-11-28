// A clipboard paste must be taken once. xterm clears its hidden field but does not cancel the
// paste, so the browser inserts the text there anyway and then keeps delivering the last character.
// An empty or missing clipboard is cancelled too: some phones fire paste on focus with no text,
// and leaving that event alone still inserts a character and then repeats it.
// Insert clipboard text in place of the selection, keeping whatever sits after the caret.
export function pasteInto(value: string, start: number, end: number, text: string): string {
	const len = value.length
	const bound = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(len, n)) : len)
	const from = Math.min(bound(start), bound(end))
	const to = Math.max(bound(start), bound(end))
	return value.slice(0, from) + text + value.slice(to)
}

export function terminalPasteDecision(clipboardText: string | null): {prevent: boolean; text: string} {
	if (clipboardText == null || clipboardText === '') return {prevent: true, text: ''}
	return {prevent: true, text: clipboardText}
}

// What a terminal sends back on its own when the screen asks: device attributes (ESC[?…c, ESC[>…c),
// cursor position and status (ESC[…R, ESC[0n), mode reports (ESC[?…$y), its name (DCS >|…), and
// colour answers (OSC 4/10/11/12 …rgb:…). Never something a person types.
const REPLY = [
	/^\x1b\[\??[\d;]*c$/,
	/^\x1b\[>[\d;]*c$/,
	/^\x1b\[\d+;\d+R$/,
	/^\x1b\[\d*n$/,
	/^\x1b\[\?[\d;]*\$y$/,
	/^\x1bP[!>]\|[^\x1b]*\x1b\\$/,
	/^\x1b\](?:4;\d+|1[0-2]);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)$/,
]
const ANY_REPLY = new RegExp(`(?:${REPLY.map((r) => r.source.replace(/^\^|\$$/g, '')).join('|')})`, 'g')
// One answer, or several arriving together (the terminal can answer a burst of questions at once).
export function isTerminalReply(data: string): boolean {
	if (!data || data[0] !== '\x1b') return false
	if (REPLY.some((r) => r.test(data))) return true
	return data.replace(ANY_REPLY, '') === ''
}
