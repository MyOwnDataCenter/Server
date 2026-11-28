// Arrow-key movement for groups that announce role="tablist" or role="radiogroup" (WAI-ARIA roving focus).
// Only the selected item sits in the Tab order; the arrow keys, Home and End move focus between items.
// Moving focus does not select: Enter or Space still chooses, so arrowing never fires a choice that has a cost.

export type RovingAxis = 'horizontal' | 'both'

export const TAB_SELECTOR = '[role="tab"]:not([disabled])'
export const RADIO_SELECTOR = '[role="radio"]:not([disabled])'

/** Index to move to for a key, wrapping at the ends, or null when the key is not a movement key here. */
export function nextRovingIndex(count: number, current: number, key: string, axis: RovingAxis = 'both'): number | null {
	if (count <= 0 || current < 0) return null
	if (key === 'ArrowRight' || (axis === 'both' && key === 'ArrowDown')) return (current + 1) % count
	if (key === 'ArrowLeft' || (axis === 'both' && key === 'ArrowUp')) return (current - 1 + count) % count
	if (key === 'Home') return 0
	if (key === 'End') return count - 1
	return null
}

/** Tab order for one item: the selected one, or the first one when nothing in the group is selected. */
export function rovingTabIndex(selected: boolean, index: number, anySelected: boolean): 0 | -1 {
	return selected || (!anySelected && index === 0) ? 0 : -1
}

type RovingItem = {focus?: (options?: FocusOptions) => void; contains?: (node: unknown) => boolean}
type RovingEvent = {
	key: string
	target: unknown
	currentTarget: {querySelectorAll?: (selector: string) => ArrayLike<unknown>}
	altKey?: boolean
	ctrlKey?: boolean
	metaKey?: boolean
	preventDefault: () => void
}

/** onKeyDown for the group element. Returns true when it moved focus. */
export function rovingKeyDown(e: RovingEvent, selector: string, axis: RovingAxis = 'both'): boolean {
	if (e.altKey || e.ctrlKey || e.metaKey) return false
	const items = Array.from(e.currentTarget.querySelectorAll?.(selector) ?? []) as RovingItem[]
	const current = items.findIndex((el) => el === e.target || el.contains?.(e.target))
	const next = nextRovingIndex(items.length, current, e.key, axis)
	if (next === null) return false
	e.preventDefault()
	items[next]?.focus?.()
	return true
}
