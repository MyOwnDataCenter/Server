// Shared modal stack, focus management, and accessibility helpers for dialogs, menus, and fields.
import {useEffect, useRef, type RefObject} from 'react'

export interface FocusableLike {
	focus?(options?: FocusOptions): void
	disabled?: boolean
	tabIndex?: number
	isConnected?: boolean
	getAttribute?(name: string): string | null
	closest?(selector: string): unknown
}

export interface ContainerLike extends FocusableLike {
	contains(node: unknown): boolean
	querySelector?(selector: string): FocusableLike | null
	querySelectorAll?(selector: string): ArrayLike<FocusableLike>
}

export const FOCUSABLE_SELECTOR =
	'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'

type DialogEntry = {
	id: symbol
	el: HTMLElement | null
}

const dialogStack: DialogEntry[] = []

// Push a modal dialog onto the stack so only the topmost layer handles Escape and Tab.
export function pushDialog(id: symbol = Symbol('dialog'), el: HTMLElement | null = null): symbol {
	popDialog(id)
	dialogStack.push({id, el})
	return id
}

export function popDialog(id: symbol): void {
	for (let i = dialogStack.length - 1; i >= 0; i--) {
		if (dialogStack[i].id === id) {
			dialogStack.splice(i, 1)
			return
		}
	}
}

export function isTopDialog(id: symbol): boolean {
	return dialogStack.length > 0 && dialogStack[dialogStack.length - 1].id === id
}

export function topDialogElement(): HTMLElement | null {
	return dialogStack.length > 0 ? dialogStack[dialogStack.length - 1].el : null
}

export function hasOpenDialog(): boolean {
	return dialogStack.length > 0
}

export function dialogStackSize(): number {
	return dialogStack.length
}

export function resetDialogStack(): void {
	dialogStack.length = 0
}

export function isElementFocusable(el: FocusableLike | null | undefined): el is FocusableLike {
	if (!el) return false
	if (el.disabled || el.getAttribute?.('disabled') != null) return false
	if (el.getAttribute?.('tabindex') === '-1') return false
	if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false
	if (el.closest?.('[inert], [hidden]')) return false
	if (typeof getComputedStyle === 'function' && typeof Element !== 'undefined' && el instanceof Element) {
		const style = getComputedStyle(el)
		if (style.display === 'none' || style.visibility === 'hidden') return false
	}
	return true
}

export function getFocusable(container: ContainerLike): FocusableLike[] {
	if (!container.querySelectorAll) return []
	return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementFocusable)
}

export function getInitialFocusTarget(
	container: ContainerLike,
	active: FocusableLike | null,
	preferred?: 'auto' | 'container' | FocusableLike | null,
): FocusableLike | null {
	// Respect autoFocus or a child effect that already moved focus into the dialog.
	if (active && active !== container && container.contains(active)) return null
	if (preferred && preferred !== 'auto' && preferred !== 'container' && isElementFocusable(preferred)) return preferred
	if (preferred === 'container') return container
	const auto = container.querySelector?.('[data-autofocus], [autofocus]') ?? null
	if (auto && isElementFocusable(auto)) return auto
	return getFocusable(container)[0] ?? container
}

export function getTabTrapTarget(
	focusables: FocusableLike[],
	active: FocusableLike | null,
	shiftKey: boolean,
	container: ContainerLike,
): FocusableLike | null {
	if (focusables.length === 0) return container
	const first = focusables[0]
	const last = focusables[focusables.length - 1]
	const idx = active ? focusables.indexOf(active) : -1
	const inside = !!active && container.contains(active)
	if (shiftKey) {
		return idx === 0 || active === container || !inside ? last : null
	}
	return idx === focusables.length - 1 || active === container || !inside ? first : null
}

export function canRestoreFocus(el: FocusableLike | null | undefined): el is FocusableLike {
	if (!el) return false
	if (el.isConnected === false) return false
	if (el.disabled || el.getAttribute?.('disabled') != null) return false
	if (el.closest?.('[inert], [hidden], .win.minimized, .win.off-workspace')) return false
	return true
}

export function pickFocusTarget(candidates: (FocusableLike | null | undefined)[]): FocusableLike | null {
	for (const candidate of candidates) {
		if (canRestoreFocus(candidate)) return candidate
	}
	return null
}

export function restoreFocus(
	opener: FocusableLike | null | undefined,
	...fallbacks: (FocusableLike | null | undefined)[]
): boolean {
	const target = pickFocusTarget([opener, ...fallbacks])
	if (!target?.focus) return false
	target.focus({preventScroll: true})
	return true
}

export type DialogFocusOptions = {
	initialFocus?: 'auto' | 'container' | RefObject<HTMLElement | null>
	canEscape?: (e: KeyboardEvent) => boolean
	restoreFocus?: boolean
}

export function useDialogFocus(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	onClose?: () => void,
	opts?: DialogFocusOptions,
): () => boolean {
	// Keep callbacks and options in refs so parent re-renders never re-run the focus effect.
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	const canEscapeRef = useRef(opts?.canEscape)
	canEscapeRef.current = opts?.canEscape
	const initialFocusRef = useRef(opts?.initialFocus)
	initialFocusRef.current = opts?.initialFocus
	const restoreFocusRef = useRef(opts?.restoreFocus)
	restoreFocusRef.current = opts?.restoreFocus
	const dialogIdRef = useRef<symbol | null>(null)
	const openerRef = useRef<HTMLElement | null>(null)
	const wasOpenRef = useRef(false)

	// Capture the opener before React runs commit-time autoFocus inside the dialog.
	if (open && !wasOpenRef.current && !openerRef.current && typeof document !== 'undefined') {
		const active = document.activeElement
		if (active instanceof HTMLElement && active !== document.body && !(ref.current && ref.current.contains(active))) {
			openerRef.current = active
		}
	}

	useEffect(() => {
		if (!open) return
		const el = ref.current
		if (!el) return
		wasOpenRef.current = true
		if (!openerRef.current) {
			const active = document.activeElement
			if (active instanceof HTMLElement && active !== document.body && !el.contains(active)) {
				openerRef.current = active
			}
		}
		const id = pushDialog(undefined, el)
		dialogIdRef.current = id

		const pref = initialFocusRef.current
		const preferred = pref && typeof pref === 'object' ? pref.current : pref
		const active = document.activeElement as FocusableLike | null
		const target = getInitialFocusTarget(el, active, preferred)
		target?.focus?.({preventScroll: true})

		const onKey = (e: KeyboardEvent) => {
			if (!isTopDialog(id) || e.defaultPrevented) return
			if (e.key === 'Escape') {
				if (canEscapeRef.current && !canEscapeRef.current(e)) return
				e.preventDefault()
				e.stopPropagation()
				onCloseRef.current?.()
				return
			}
			if (e.key === 'Tab') {
				const next = getTabTrapTarget(getFocusable(el), document.activeElement as FocusableLike | null, e.shiftKey, el)
				if (next) {
					e.preventDefault()
					next.focus?.({preventScroll: true})
				}
			}
		}
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('keydown', onKey)
			popDialog(id)
			if (dialogIdRef.current === id) dialogIdRef.current = null
			wasOpenRef.current = false
			const opener = openerRef.current
			openerRef.current = null
			if (restoreFocusRef.current !== false) {
				restoreFocus(opener, topDialogElement())
			}
		}
	}, [open, ref])

	return () => dialogIdRef.current !== null && isTopDialog(dialogIdRef.current)
}

export function nextMenuIndex(count: number, current: number, key: string): number | null {
	if (count <= 0) return null
	if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
	if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
	if (key === 'Home') return 0
	if (key === 'End') return count - 1
	return null
}

export function getMenuItems(container: ContainerLike): FocusableLike[] {
	if (!container.querySelectorAll) return []
	return Array.from(container.querySelectorAll('[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])')).filter(
		(el) => el.getAttribute?.('aria-disabled') !== 'true' && isElementFocusable(el),
	)
}

export function useMenuFocus(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	onClose: () => void,
	explicitOpener?: HTMLElement | null,
): (fn: () => void) => void {
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	const openerRef = useRef<HTMLElement | null>(null)
	const wasOpenRef = useRef(false)
	const skipRestoreRef = useRef(false)

	if (open && !wasOpenRef.current && !openerRef.current && typeof document !== 'undefined') {
		skipRestoreRef.current = false
		const active = explicitOpener ?? document.activeElement
		if (active instanceof HTMLElement && active !== document.body && !(ref.current && ref.current.contains(active))) {
			openerRef.current = active
		}
	}

	useEffect(() => {
		if (!open) return
		const el = ref.current
		if (!el) return
		wasOpenRef.current = true
		skipRestoreRef.current = false
		if (!openerRef.current) {
			const active = explicitOpener ?? document.activeElement
			if (active instanceof HTMLElement && active !== document.body && !el.contains(active)) {
				openerRef.current = active
			}
		}
		const id = pushDialog(undefined, el)
		const items = getMenuItems(el)
		;(items[0] ?? el).focus?.({preventScroll: true})

		const onKey = (e: KeyboardEvent) => {
			if (!isTopDialog(id) || e.defaultPrevented) return
			if (e.key === 'Escape' || e.key === 'Tab') {
				e.preventDefault()
				e.stopPropagation()
				onCloseRef.current()
				return
			}
			const currentItems = getMenuItems(el)
			const active = document.activeElement as FocusableLike | null
			const idx = active ? currentItems.indexOf(active) : -1
			const next = nextMenuIndex(currentItems.length, idx, e.key)
			if (next !== null) {
				e.preventDefault()
				currentItems[next]?.focus?.({preventScroll: true})
			}
		}
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('keydown', onKey)
			popDialog(id)
			wasOpenRef.current = false
			const opener = openerRef.current
			openerRef.current = null
			if (!skipRestoreRef.current) {
				restoreFocus(opener, topDialogElement())
			}
			skipRestoreRef.current = false
		}
	}, [open, ref])

	return (fn: () => void) => {
		skipRestoreRef.current = true
		restoreFocus(openerRef.current)
		onCloseRef.current()
		fn()
	}
}

export function useInert(ref: RefObject<HTMLElement | null>, active: boolean): void {
	useEffect(() => {
		const el = ref.current
		if (!el) return
		el.inert = active
		return () => {
			el.inert = false
		}
	}, [ref, active])
}

export function liveRegionText(toast: {text: string; error?: boolean} | null): {status: string; alert: string} {
	if (!toast) return {status: '', alert: ''}
	return toast.error ? {status: '', alert: toast.text} : {status: toast.text, alert: ''}
}

export function checkLiveText(check: {ok: boolean; message: string} | null | undefined, busy?: boolean): {status: string; alert: string} {
	if (busy) return {status: 'Checking…', alert: ''}
	if (!check) return {status: '', alert: ''}
	return check.ok ? {status: check.message, alert: ''} : {status: '', alert: check.message}
}

export function fieldAria(
	baseId: string,
	opts: {hasHint?: boolean; hasError?: boolean; invalid?: boolean; describedBy?: string},
): {hintId: string; errorId: string; describedBy?: string; invalid?: true} {
	const hintId = `${baseId}-hint`
	const errorId = `${baseId}-error`
	const ids: string[] = []
	if (opts.hasError) ids.push(errorId)
	if (opts.hasHint) ids.push(hintId)
	if (opts.describedBy) ids.push(opts.describedBy)
	return {
		hintId,
		errorId,
		...(ids.length ? {describedBy: ids.join(' ')} : {}),
		...(opts.invalid || opts.hasError ? {invalid: true as const} : {}),
	}
}
