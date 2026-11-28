// True when a line-clamped element hides part of its text. The browser knows: count its real
// layout, not its characters (a list of short lines is cut after five lines, long text may fit).
export function isClamped(el: {scrollHeight: number; clientHeight: number}): boolean {
	return el.scrollHeight > el.clientHeight + 1
}
