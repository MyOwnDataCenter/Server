export const BTN = {left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64}

export type DisconnectAction = 'ignore' | 'superseded' | 'reconnect'

// Decide what the console should do when noVNC fires a disconnect event.
export function consoleDisconnectAction({disposed, superseded}: {disposed: boolean; superseded: boolean; clean?: boolean}): DisconnectAction {
	if (disposed) return 'ignore'
	if (superseded) return 'superseded'
	return 'reconnect'
}

/** Why a screen never appeared: what the server or computer said, or a plain fallback. */
export function consoleFailureMessage(reason: string): string {
	const said = reason.trim()
	return said || 'The screen didn’t come up. The computer may be asleep, signed out of its desktop, or its screen sharing isn’t running.'
}

// Map browser wheel deltas to VNC mouse wheel button masks.
export function wheelButtons(deltaX: number, deltaY: number): number[] {
	const out: number[] = []
	if (deltaY > 0) out.push(BTN.wheelDown)
	else if (deltaY < 0) out.push(BTN.wheelUp)
	if (deltaX > 0) out.push(BTN.wheelRight)
	else if (deltaX < 0) out.push(BTN.wheelLeft)
	return out
}

export type LocalDateLike = Pick<Date, 'getFullYear' | 'getMonth' | 'getDate' | 'getHours' | 'getMinutes' | 'getSeconds'>

// Build a screenshot filename keeping Unicode letters and using local wall-clock time.
export function screenshotFilename(name: string, now: LocalDateLike = new Date()): string {
	const base = name.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'desktop'
	const pad = (n: number) => String(n).padStart(2, '0')
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
	return `${base}-${stamp}.png`
}

export type ConsoleWheelEvent = {
	ctrlKey: boolean
	clientX: number
	clientY: number
	deltaX: number
	deltaY: number
	preventDefault: () => void
}

// Handle wheel zoom and scroll events in the console touch layer.
export function handleConsoleWheel(
	e: ConsoleWheelEvent,
	opts: {
		connected: boolean
		onZoom: (deltaY: number, p: {x: number; y: number}) => void
		onScroll: (buttons: number[], p: {x: number; y: number}) => void
	},
) {
	const p = {x: e.clientX, y: e.clientY}
	if (e.ctrlKey) {
		e.preventDefault()
		if (opts.connected) opts.onZoom(e.deltaY, p)
		return
	}
	if (!opts.connected) return
	const buttons = wheelButtons(e.deltaX, e.deltaY)
	if (!buttons.length) return
	e.preventDefault()
	opts.onScroll(buttons, p)
}

// Register a native wheel listener with passive: false so preventDefault works.
export function bindConsoleWheel(
	el: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
	onWheel: (e: WheelEvent) => void,
) {
	el.addEventListener('wheel', onWheel, {passive: false})
	return () => el.removeEventListener('wheel', onWheel)
}

export type ConsoleScale = 'fit' | 'actual' | 'remote'

// Saved Resize VM stays selected until we know the machine cannot resize. Then the picture is fitted.
export function effectiveConsoleScale(saved: ConsoleScale, canResize: boolean | null): ConsoleScale {
	if (saved === 'remote' && canResize === false) return 'fit'
	return saved
}

// Phone typing: an input event mid-IME is not committed text. compositionend is.
export function shouldSendConsoleInput(event: {type: 'input' | 'compositionend'; isComposing: boolean}): boolean {
	if (event.type === 'compositionend') return true
	return !event.isComposing
}

// Read the current framebuffer size and whether the remote desktop supports resizing.
export function readConsoleMetrics(rfb: {_fbWidth?: number; _fbHeight?: number; _supportsSetDesktopSize?: boolean} | null | undefined) {
	const res = rfb?._fbWidth && rfb?._fbHeight ? {w: rfb._fbWidth, h: rfb._fbHeight} : null
	return {res, canResize: !!rfb?._supportsSetDesktopSize}
}

export type Pt = {x: number; y: number}
export type Rect = {left: number; top: number; right: number; bottom: number; width: number; height: number}
export type Size = {w: number; h: number}

// Convert a screen coordinate to a framebuffer pixel, returning null outside the picture unless clamp is set.
export function pointToFb(p: Pt, rect: Rect | null, fb: Size | null, {clamp = true}: {clamp?: boolean} = {}): Pt | null {
	if (!fb || !rect || !rect.width || !rect.height) return null
	if (!clamp && (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom)) return null
	return {
		x: Math.round(Math.min(fb.w - 1, Math.max(0, ((p.x - rect.left) / rect.width) * fb.w))),
		y: Math.round(Math.min(fb.h - 1, Math.max(0, ((p.y - rect.top) / rect.height) * fb.h))),
	}
}

export type SuperKey = 'meta' | 'altright' | 'ctrlright'

// Resolve the Super key setting without hijacking Right Alt / AltGr by default.
export function resolveSuperKey(stored: string | null | undefined): SuperKey {
	return stored === 'altright' || stored === 'ctrlright' || stored === 'meta' ? stored : 'meta'
}

export type TouchReleaseInput = {
	cancelled: boolean
	mode: 'touch' | 'mouse'
	kind: 'none' | 'one' | 'two' | 'mouse'
	wasCount: number
	remaining: number
	moved: boolean
	held: boolean
	dragging: boolean
	quick: boolean
	maxPointers: number
}

export type TouchReleaseOutcome =
	| {action: 'none'}
	| {action: 'release-drag'}
	| {action: 'click'; target: 'start' | 'cursor' | 'mid'; button: number; haptic: number; updateLastTap: boolean}

// Decide what a touch release or pointercancel should do at the end of a gesture.
export function touchReleaseAction(input: TouchReleaseInput): TouchReleaseOutcome {
	if (input.kind === 'one' && input.wasCount === 1) {
		if (input.dragging) return {action: 'release-drag'}
		if (!input.cancelled && !input.moved) {
			if (input.mode === 'touch') return {action: 'click', target: 'start', button: input.held ? BTN.right : BTN.left, haptic: 5, updateLastTap: false}
			if (input.quick) return {action: 'click', target: 'cursor', button: BTN.left, haptic: 5, updateLastTap: true}
		}
		return {action: 'none'}
	}
	if (input.kind === 'two' && input.remaining === 0 && !input.cancelled && !input.moved && input.quick) {
		return {action: 'click', target: 'mid', button: input.maxPointers >= 3 ? BTN.middle : BTN.right, haptic: 10, updateLastTap: false}
	}
	return {action: 'none'}
}

export type PasteKeyStep = {keysym: number; code: string; down: boolean}

// Build the V keystroke sequence for delayed clipboard paste, ensuring Ctrl/Shift are held if already released.
export function pasteKeySequence({
	meta,
	shift = false,
	ctrlHeld,
	shiftHeld = false,
}: {
	meta: boolean
	shift?: boolean
	ctrlHeld: boolean
	shiftHeld?: boolean
}): {releaseSuper: boolean; keys: PasteKeyStep[]} {
	const needCtrl = meta || !ctrlHeld
	const needShift = shift && !shiftHeld
	const keys: PasteKeyStep[] = []
	if (needCtrl) keys.push({keysym: 0xffe3, code: 'ControlLeft', down: true})
	if (needShift) keys.push({keysym: 0xffe1, code: 'ShiftLeft', down: true})
	const vSym = shift ? 0x56 : 0x76
	keys.push({keysym: vSym, code: 'KeyV', down: true})
	keys.push({keysym: vSym, code: 'KeyV', down: false})
	if (needShift) keys.push({keysym: 0xffe1, code: 'ShiftLeft', down: false})
	if (needCtrl) keys.push({keysym: 0xffe3, code: 'ControlLeft', down: false})
	return {releaseSuper: meta, keys}
}

// Characters a US keyboard types with Shift. The keysym is the character itself; Shift is
// what makes QEMU's keyboard produce it instead of the unshifted key.
const NEEDS_SHIFT = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/
export const PASTE_SHIFT = 0xffe1
export const PASTE_ENTER = 0xff0d
export const PASTE_TAB = 0xff09

export function keysymOfChar(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0
	return cp < 0x100 ? cp : (0x01000000 | cp)
}

// One typed character as key down then key up, with Shift around it when the character needs it.
export function charKeySteps(ch: string, shiftHeld = false): {keysym: number; down: boolean}[] {
	const keysym = ch === '\n' ? PASTE_ENTER : ch === '\t' ? PASTE_TAB : keysymOfChar(ch)
	const shift = !shiftHeld && ch !== '\n' && ch !== '\t' && NEEDS_SHIFT.test(ch)
	const steps: {keysym: number; down: boolean}[] = []
	if (shift) steps.push({keysym: PASTE_SHIFT, down: true})
	steps.push({keysym, down: true}, {keysym, down: false})
	if (shift) steps.push({keysym: PASTE_SHIFT, down: false})
	return steps
}

// Gap between key events of a paste. QEMU's keyboard queue is 16 bytes and it does not
// let the guest run while it drains one burst. The guest terminal pauses when the cursor
// reaches the right edge, the queue drops the next key-up, and that character repeats.
export const PASTE_STEP_MS = 20

// Every key-down and key-up of a paste, in order. The sender must wait PASTE_STEP_MS
// between steps so each key-up lands before the next character.
export function pasteKeySteps(text: string): {keysym: number; down: boolean}[] {
	const steps: {keysym: number; down: boolean}[] = []
	for (const ch of text.replace(/\r\n?/g, '\n')) steps.push(...charKeySteps(ch))
	return steps
}

// Map DOM mouse button numbers (0..2) to VNC button masks; ignore extra buttons like Back/Forward.
export function mouseButtonFromEvent(button: number): number | null {
	if (button === 0) return BTN.left
	if (button === 1) return BTN.middle
	if (button === 2) return BTN.right
	return null
}
