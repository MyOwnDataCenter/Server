// Full-screen terminal: a shell on the server, or inside one app's container.
// omarchyd streams a PTY over a WebSocket (bridged by the Touch server). The terminal fills its
// window: when the window (or the phone's keyboard) changes its size, the shell is resized to
// match, so programs reflow and full-screen ones redraw, the way a native terminal does.
import {useContext, useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Terminal as XTerm} from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {clipText} from './clips'
import {isClipTarget, markClipTarget, unmarkClipTarget} from './clipPasteTarget'
import {BootstrapContext} from './data'
import {Icon} from './icons'
import {overlayBackUsesHistory, popstateClosesOverlay} from './overlayHistory'
import {terminalCloseOutcome, terminalStatusLabel} from './terminalClose'
import {forwardTerminalInput, ignoreOpeningFocus} from './terminalInput'
import {isTerminalReply, pasteInto, terminalPasteDecision} from './terminalPaste'
import {SEQ, applyTerminalModifiers} from './terminalKeys'
import {AppIcon, haptic, useConfirm, usePortalRoot, useScreenLock, useToast} from './ui'

// closed: the shell ended. lost: the connection dropped (the shell is still running on the server).
type State = 'connecting' | 'connected' | 'closed' | 'lost' | 'error'
const BASE_FONT = 13

// Keep a fixed-position screen inside the area the phone keyboard leaves visible.
export function useVisualViewport(ref: React.RefObject<HTMLElement>, enabled = true) {
	useEffect(() => {
		const vv = window.visualViewport
		const el = ref.current
		if (!vv || !el || !enabled) return
		const apply = () => {
			el.style.top = `${vv.offsetTop}px`
			el.style.height = `${vv.height}px`
			el.style.bottom = 'auto'
			// The on-screen keyboard is up: drop the home-indicator padding under the key row.
			el.classList.toggle('kbd-open', window.innerHeight - vv.height > 120)
			el.dispatchEvent(new Event('viewportchange'))
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
		}
	}, [ref, enabled])
}

function cssVar(name: string, fallback: string) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function TerminalScreen({
	app,
	agent,
	container,
	overSheet = false,
	onClose,
	embedded,
	inline,
	input,
	machine,
}: {
	app?: {id: string; name?: string; icon?: string}
	// A computer in the local swarm (through its connector), instead of this server.
	agent?: {id: string; name: string}
	// One of this server's containers (Incus): its console (login prompt) or a root shell in it.
	container?: {name: string; mode?: 'console' | 'shell'}
	// Opened from a sheet (a container's page): sit above the sheet instead of behind it.
	overSheet?: boolean
	onClose: () => void
	embedded?: boolean
	/** Draw inside the open row. No full-screen portal, history entry, or screen lock. */
	inline?: boolean
	input?: string
	/** The computer this shell is on. Defaults to this server, or the swarm computer when `agent` is set. */
	machine?: string
}) {
	const boot = useContext(BootstrapContext)
	const serverName = boot?.server?.device || 'This server'
	const machineName = machine ?? agent?.name ?? container?.name ?? serverName
	const portalRoot = usePortalRoot()
	const root = useRef<HTMLDivElement>(null)
	const host = useRef<HTMLDivElement>(null)
	const termRef = useRef<XTerm>()
	const wsRef = useRef<WebSocket>()
	// This window's own size in characters (what it asks the shell for); ready once measured.
	const size = useRef({cols: 80, rows: 24, ready: false})
	const [state, setState] = useState<State>('connecting')
	const [message, setMessage] = useState('')
	const [attempt, setAttempt] = useState(0)
	const [ctrl, setCtrl] = useState(false)
	const [alt, setAlt] = useState(false)
	const [kbd, setKbd] = useState(false)
	const [pasteBox, setPasteBox] = useState(false)
	// Long-press on a phone: a small Paste button where the finger was.
	const [pressPaste, setPressPaste] = useState<{x: number; y: number} | null>(null)
	const pasteRef = useRef<() => void>(() => {})
	const [pasteText, setPasteText] = useState('')
	const pasteField = useRef<HTMLTextAreaElement>(null)
	const pasteCaret = useRef<number | null>(null)
	useEffect(() => {
		const el = pasteField.current
		const caret = pasteCaret.current
		if (!el || caret == null) return
		pasteCaret.current = null
		el.selectionStart = el.selectionEnd = caret
	}, [pasteText])
	const mods = useRef({ctrl: false, alt: false})
	// Your shell keeps running when you close this; reopening resumes it. `fresh` asks for a new one.
	const [resumed, setResumed] = useState(false)
	const fresh = useRef(false)
	const confirm = useConfirm()
	// A command to have ready at the prompt (typed, never run: you press Enter). Only once.
	const pending = useRef(input)
	// When this screen appeared. The tap that opened it is still in progress then.
	const openedAt = useRef(performance.now())
	mods.current = {ctrl, alt}
	const toast = useToast()
	useVisualViewport(root, !embedded && !inline)
	useScreenLock(root, true, !embedded && !inline)
	// Phone layout only. An embedded desktop window, or a row on the Terminals page, must not push its own history entry.
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	const overlayClosed = useRef(false)
	useEffect(() => {
		if (embedded || inline) return
		overlayClosed.current = false
		const id = 'terminal'
		history.pushState({omarchyOverlay: id}, '', location.href)
		const onPop = (e: PopStateEvent) => {
			if (!popstateClosesOverlay(e.state, id)) return
			overlayClosed.current = true
			onCloseRef.current()
		}
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
	}, [embedded, inline])
	const back = () => {
		if (embedded || inline) {
			onClose()
			return
		}
		haptic(6)
		if (overlayBackUsesHistory(overlayClosed.current, history.state, 'terminal')) history.back()
		else onClose()
	}

	useEffect(() => {
		const el = host.current
		if (!el) return
		let disposed = false
		const term = new XTerm({
			fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
			fontSize: BASE_FONT,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: false,
			macOptionIsMeta: false,
			theme: {
				background: '#0b0b0e',
				foreground: '#e6e6ea',
				cursor: cssVar('--accent-text', '#fb923c'),
				cursorAccent: '#0b0b0e',
				selectionBackground: 'rgba(255,255,255,.25)',
				black: '#1c1c22', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#2dd4bf', white: '#d4d4d8',
				brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#5eead4', brightWhite: '#ffffff',
			},
		})
		termRef.current = term
		term.open(el)

		// Right-click, as in most terminals: with text selected it copies it; otherwise it pastes.
		// Reading the clipboard needs https://; on http:// the browser's own menu opens instead,
		// and its Paste works (the terminal puts its input under the pointer for that).
		const copyText = (text: string) => {
			if (window.isSecureContext && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
			const t = document.createElement('textarea')
			t.value = text
			t.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
			document.body.appendChild(t)
			t.select()
			document.execCommand('copy')
			t.remove()
			return Promise.resolve()
		}
		const onContextMenu = (e: MouseEvent) => {
			// A long-press on a phone keeps its own behaviour.
			if ((e as PointerEvent).pointerType === 'touch' || !matchMedia('(any-pointer: fine)').matches) return
			const selected = term.getSelection()
			if (selected) {
				e.preventDefault()
				copyText(selected).then(
					() => {
						toast('Copied')
						clipText(selected, 'terminal').catch((err: Error) => toast(err.message, true))
					},
					() => toast('Couldn’t copy', true),
				)
				term.clearSelection()
				term.focus()
				return
			}
			// Paste, like a terminal on the machine: straight from the clipboard where the browser
			// allows reading it (https://). On http:// browsers never let a page read the clipboard, so
			// their own menu opens with Paste (xterm puts its input under the pointer for that).
			if (!window.isSecureContext || !navigator.clipboard?.readText) return
			e.preventDefault()
			navigator.clipboard.readText().then(
				(text) => {
					if (text) term.paste(text)
					term.focus()
				},
				() => pasteRef.current(),
			)
		}
		el.addEventListener('contextmenu', onContextMenu)
		// Take a clipboard paste once. Otherwise the browser also drops it into xterm's hidden
		// field and keeps sending the last character.
		const onPaste = (e: ClipboardEvent) => {
			const decision = terminalPasteDecision(e.clipboardData ? e.clipboardData.getData('text/plain') : null)
			if (!decision.prevent) return
			e.preventDefault()
			e.stopPropagation()
			if (decision.text) term.paste(decision.text)
		}
		el.addEventListener('paste', onPaste, true)
		// Keyboard copy and paste as on a desktop: Ctrl+V and Ctrl+Shift+V paste (the browser's own
		// paste, which works on http:// too), Ctrl+Shift+C copies, and Ctrl+C copies when text is
		// selected (otherwise it interrupts, as always). Without this Ctrl+V sent ^V to the shell.
		term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown' || !matchMedia('(any-pointer: fine)').matches || e.altKey || e.metaKey) return true
			const k = e.key.toLowerCase()
			if (e.ctrlKey && k === 'v') return false
			if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
				const selected = term.getSelection()
				if (!selected) return false
				e.preventDefault()
				copyText(selected).then(
					() => {
						toast('Copied')
						clipText(selected, 'terminal').catch((err: Error) => toast(err.message, true))
					},
					() => toast('Couldn’t copy', true),
				)
				term.clearSelection()
				return false
			}
			return true
		})
		const onClip = (e: ClipboardEvent) => {
			const selected = term.getSelection()
			const target = e.target
			if (!selected || !(target instanceof Node) || !el.contains(target)) return
			clipText(selected, 'terminal', e.type === 'cut').catch((err: Error) => toast(err.message, true))
		}
		document.addEventListener('copy', onClip)
		document.addEventListener('cut', onClip)

		// -- Size: fill the window at the normal text size --------------------------------------
		// A character cell at the normal text size (measured at whatever size is showing now).
		const cell = () => {
			const dims = (term as any)._core?._renderService?.dimensions?.css?.cell
			const font = term.options.fontSize ?? BASE_FONT
			const k = BASE_FONT / font
			return {w: (dims?.width || font * 0.6) * k, h: (dims?.height || font * 1.15 * 1.2) * k}
		}
		// The room the text has: the window, less padding and (on a computer) the scrollbar.
		const room = () => {
			const cs = getComputedStyle(el)
			const vp = el.querySelector<HTMLElement>('.xterm-viewport')
			const bar = vp ? vp.offsetWidth - vp.clientWidth : 0
			return {
				w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - bar,
				h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
			}
		}
		// How many columns and rows fit this window.
		const fitSize = () => {
			const {w, h} = room()
			const c = cell()
			return {cols: Math.max(20, Math.min(500, Math.floor(w / c.w))), rows: Math.max(4, Math.min(300, Math.floor(h / c.h)))}
		}
		// Draw the terminal at the shell's size. At this window's own size that's the normal text
		// size; if another device viewing the same shell set its size, scale the text to fit here.
		const show = (cols: number, rows: number) => {
			const buf = term.buffer.active
			const atBottom = buf.viewportY >= buf.baseY
			if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
			const mine = size.current
			let font = BASE_FONT
			if (cols !== mine.cols || rows !== mine.rows) {
				const {w, h} = room()
				const c = cell()
				font = Math.max(7, Math.min(BASE_FONT * 1.5, BASE_FONT * Math.min(w / (cols * c.w), h / (rows * c.h))))
			}
			// Round down to a half point, so the scaled text always fits inside the window.
			if (Math.abs(font - (term.options.fontSize ?? BASE_FONT)) > 0.2) term.options.fontSize = Math.floor(font * 2) / 2
			// Reading back through history stays put; at the bottom it stays at the bottom.
			if (atBottom) term.scrollToBottom()
		}
		// Tell the shell this window's size (a binary frame; what's typed is text). A window being
		// dragged changes size many times: send the last one.
		let sizeTimer = 0
		const sendSize = (now = false) => {
			window.clearTimeout(sizeTimer)
			const go = () => {
				const ws = wsRef.current
				if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(JSON.stringify({type: 'resize', cols: size.current.cols, rows: size.current.rows})))
			}
			if (now) go()
			else sizeTimer = window.setTimeout(go, 90)
		}
		// The window changed size (or the phone's keyboard came or went): fit it, and resize the shell.
		const refit = () => {
			if (!size.current.ready || !el.clientWidth || !el.clientHeight) return // hidden (another workspace)
			const next = fitSize()
			const changed = next.cols !== size.current.cols || next.rows !== size.current.rows
			size.current = {...size.current, ...next}
			if (changed || next.cols !== term.cols || next.rows !== term.rows) {
				show(next.cols, next.rows)
				if (changed || wsRef.current?.readyState === WebSocket.OPEN) sendSize()
			}
		}

		let replaying = 0
		let replayNext = false
		const send = (data: string) => {
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) ws.send(data)
		}
		term.onData((data) => {
			if (!forwardTerminalInput(data, focusReportFromUser)) return
			// The terminal's own answers to questions found in a replayed screen (what kind of terminal,
			// its colours, where the cursor is) would reach the shell as stray text: the extra
			// characters that appeared when a terminal was opened again.
			if (replaying > 0 && isTerminalReply(data)) return
			if (data === '\x1b[I' || data === '\x1b[O') focusReportFromUser = false
			// Drop the composition the opening tap just dumped. The on-screen keys send on their own.
			if (ignoreOpeningFocus(coarsePointer(), performance.now() - openedAt.current)) return
			// Typing here after another device resized this shell: take it back to this window's size.
			// (Sent now, ahead of what's typed: the server holds the typing until the shell has resized.)
			if (term.cols !== size.current.cols || term.rows !== size.current.rows) {
				show(size.current.cols, size.current.rows)
				sendSize(true)
			}
			const m = mods.current
			const res = applyTerminalModifiers(data, m, {appCursor: term.modes.applicationCursorKeysMode, applyAppCursor: false})
			mods.current = {ctrl: res.ctrl, alt: res.alt}
			if (res.ctrl !== m.ctrl) setCtrl(res.ctrl)
			if (res.alt !== m.alt) setAlt(res.alt)
			send(res.data)
		})
		const ta = term.textarea
		ta?.setAttribute('autocomplete', 'off')
		ta?.setAttribute('autocapitalize', 'off')
		ta?.setAttribute('autocorrect', 'off')
		ta?.setAttribute('spellcheck', 'false')
		const coarsePointer = () => matchMedia('(pointer: coarse)').matches
		// Set in the capture phase, before xterm turns the focus or blur into a report.
		// A report that arrives without this flag was produced by replaying the session.
		let focusReportFromUser = false
		const markFocusReport = () => {
			if (ignoreOpeningFocus(coarsePointer(), performance.now() - openedAt.current)) return
			focusReportFromUser = true
			// xterm emits the report synchronously, before this microtask. If focus reporting
			// is off, nothing is emitted and the flag must not stay set for the replay.
			queueMicrotask(() => {
				focusReportFromUser = false
			})
		}
		ta?.addEventListener('focus', markFocusReport, true)
		ta?.addEventListener('blur', markFocusReport, true)
		// (Typing scrolls to the prompt by itself; tapping in to type doesn't throw away your place.)
		// The tap that opened this screen focuses the phone's stretched field and dumps a composition.
		const onFocus = () => {
			if (ignoreOpeningFocus(coarsePointer(), performance.now() - openedAt.current)) {
				if (ta) ta.value = ''
				term.blur()
				return
			}
			setKbd(true)
		}
		const onBlur = () => setKbd(false)
		ta?.addEventListener('focus', onFocus)
		ta?.addEventListener('blur', onBlur)

		const connect = async () => {
			setState('connecting')
			const check = await fetch('/api/console/check?target=terminal', {credentials: 'same-origin'}).catch(() => null)
			if (disposed) return
			if (!check?.ok) {
				const body = await check?.json().catch(() => null)
				setMessage(body?.error?.message ?? 'Can’t reach your server right now.')
				setState('error')
				return
			}
			term.options.fontSize = BASE_FONT
			await new Promise((r) => requestAnimationFrame(() => r(null)))
			if (disposed) return
			const s = {...fitSize(), ready: true}
			size.current = s
			term.resize(s.cols, s.rows)
			term.reset()
			const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
			const qs = new URLSearchParams({...(app ? {appId: app.id} : {}), ...(agent ? {agentId: agent.id} : {}), ...(container ? {containerId: container.name, containerMode: container.mode ?? 'shell'} : {}), cols: String(s.cols), rows: String(s.rows), ...(fresh.current ? {fresh: '1'} : {})})
			fresh.current = false
			const ws = new WebSocket(`${scheme}//${location.host}/api/terminal?${qs}`)
			ws.binaryType = 'arraybuffer'
			wsRef.current = ws
			let opened = false
			ws.onopen = () => {
				opened = true
				setState('connected')
				haptic(8)
				if (pending.current) {
					const text = pending.current
					pending.current = undefined
					setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(text), 400)
				}
				// A hardware keyboard can type immediately. A phone waits: focusing now would
				// catch the tap that opened this screen and insert whatever the keyboard was composing.
				if (!coarsePointer()) {
					if (ta) ta.value = ''
					term.focus()
				}
			}
			ws.onmessage = (e) => {
				if (typeof e.data !== 'string') {
					if (!replayNext) return term.write(new Uint8Array(e.data))
					replayNext = false
					replaying++
					return term.write(new Uint8Array(e.data), () => {
						// Answers are emitted while parsing; give a late one a moment too.
						setTimeout(() => (replaying = Math.max(0, replaying - 1)), 250)
					})
				}
				// Text frames are about the session: resumed (what was on screen follows, drawn at the
				// size it was), and the size it's now at. Resize in order with the output around it.
				let m: {type?: string; resumed?: boolean; cols?: number; rows?: number}
				try {
					m = JSON.parse(e.data)
				} catch {
					return
				}
				if (m.type === 'session') {
					setResumed(!!m.resumed)
					replayNext = !!m.resumed
				}
				if ((m.type === 'session' || m.type === 'size') && m.cols && m.rows) {
					// In order with the output around it: a resumed screen replays at the size it was
					// drawn, then the shell takes this window's size.
					const {cols, rows} = m
					term.write('', () => show(cols, rows))
				}
			}
			ws.onclose = (e) => {
				if (disposed || wsRef.current !== ws) return
				const out = terminalCloseOutcome({opened, shellEnded: e.code === 1000 && e.reason === 'Shell ended', onComputer: !!agent})
				setState(out.state)
				setMessage(out.message)
			}
		}
		connect()

		// Fill the window, now and whenever it changes size. (Phones: the keyboard shrinks the
		// window, so the shell gets fewer rows and the prompt stays in view above it.)
		let raf = 0
		const onResize = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(() => {
				refit()
				el.style.setProperty('--term-frame', `${el.clientHeight}px`)
			})
		}
		const ro = new ResizeObserver(onResize)
		ro.observe(el)
		const rootEl = root.current
		rootEl?.addEventListener('viewportchange', onResize)

		// -- Touch: scroll like a phone app ---------------------------------------------------
		// A drag moves the text with your finger and keeps going when you let go (momentum). In
		// full-screen programs (less, man, vim) there's no history to scroll, so a drag sends the
		// arrow keys instead, as a mouse wheel would. A tap still opens the keyboard, and a long
		// press still offers Paste.
		const viewport = () => el.querySelector<HTMLElement>('.xterm-viewport')
		let touch: {startY: number; y: number; t: number; v: number; moved: boolean; carry: number} | null = null
		let fling = 0
		const stopFling = () => cancelAnimationFrame(fling)
		// dy > 0: the text moves up (towards newer lines).
		const scrollBy = (dy: number) => {
			if (term.buffer.active.type === 'alternate') {
				if (!touch) return false
				touch.carry += dy
				const rowH = cell().h * ((term.options.fontSize ?? BASE_FONT) / BASE_FONT)
				let out = ''
				while (Math.abs(touch.carry) >= rowH) {
					out += applyTerminalModifiers(touch.carry > 0 ? SEQ.down : SEQ.up, {ctrl: false, alt: false}, {appCursor: term.modes.applicationCursorKeysMode, applyAppCursor: true}).data
					touch.carry -= Math.sign(touch.carry) * rowH
				}
				if (out) send(out)
				return true
			}
			const vp = viewport()
			if (!vp) return false
			const before = vp.scrollTop
			vp.scrollTop = before + dy
			return vp.scrollTop !== before
		}
		// Press and hold (without moving) offers Paste; a reading of the clipboard needs a tap of its own.
		let holdTimer = 0
		const cancelHold = () => window.clearTimeout(holdTimer)
		const onTouchStart = (e: TouchEvent) => {
			stopFling()
			cancelHold()
			if (e.touches.length !== 1) return void (touch = null)
			const y = e.touches[0].clientY
			const x = e.touches[0].clientX
			touch = {startY: y, y, t: performance.now(), v: 0, moved: false, carry: 0}
			holdTimer = window.setTimeout(() => {
				if (touch && !touch.moved) (haptic(10), setPressPaste({x, y}))
			}, 500)
		}
		const onTouchMove = (e: TouchEvent) => {
			if (!touch || e.touches.length !== 1) return
			const y = e.touches[0].clientY
			if (!touch.moved && Math.abs(y - touch.startY) < 6) return // not a drag yet: maybe a tap or a long press
			touch.moved = true
			cancelHold()
			e.preventDefault() // ours, not the page's (or xterm's own, slower) scrolling
			e.stopPropagation()
			const now = performance.now()
			const dy = touch.y - y
			const dt = Math.max(1, now - touch.t)
			touch.v = 0.75 * (dy / dt) + 0.25 * touch.v
			touch.y = y
			touch.t = now
			scrollBy(dy)
		}
		const onTouchEnd = (e: TouchEvent) => {
			cancelHold()
			const t = touch
			touch = null
			if (!t?.moved) return
			e.stopPropagation()
			// Let go mid-swipe: keep going and slow down, as a phone does (not in full-screen programs).
			let v = performance.now() - t.t > 80 ? 0 : t.v
			if (term.buffer.active.type === 'alternate' || Math.abs(v) < 0.05) return
			let last = performance.now()
			const step = (now: number) => {
				const dt = now - last
				last = now
				v *= Math.pow(0.9965, dt)
				if (Math.abs(v) < 0.02 || !scrollBy(v * dt)) return
				fling = requestAnimationFrame(step)
			}
			fling = requestAnimationFrame(step)
		}
		// Until this settles, the phone's stretched typing field ignores the tap that opened the screen.
		const readyTimer = window.setTimeout(() => root.current?.classList.add('term-ready'), 500)
		el.addEventListener('touchstart', onTouchStart, {capture: true, passive: true})
		el.addEventListener('touchmove', onTouchMove, {capture: true, passive: false})
		el.addEventListener('touchend', onTouchEnd, {capture: true})
		el.addEventListener('touchcancel', onTouchEnd, {capture: true})

		return () => {
			disposed = true
			ro.disconnect()
			cancelAnimationFrame(raf)
			stopFling()
			window.clearTimeout(readyTimer)
			window.clearTimeout(sizeTimer)
			rootEl?.removeEventListener('viewportchange', onResize)
			cancelHold()
			el.removeEventListener('touchstart', onTouchStart, {capture: true})
			el.removeEventListener('touchmove', onTouchMove, {capture: true})
			el.removeEventListener('touchend', onTouchEnd, {capture: true})
			el.removeEventListener('touchcancel', onTouchEnd, {capture: true})
			ta?.removeEventListener('focus', markFocusReport, true)
			ta?.removeEventListener('blur', markFocusReport, true)
			ta?.removeEventListener('focus', onFocus)
			ta?.removeEventListener('blur', onBlur)
			wsRef.current?.close()
			el.removeEventListener('contextmenu', onContextMenu)
			el.removeEventListener('paste', onPaste, true)
			document.removeEventListener('copy', onClip)
			document.removeEventListener('cut', onClip)
			term.dispose()
		}
	}, [app, agent?.id, container?.name, container?.mode, attempt])

	// A clip pasted as text goes into the terminal used last, not into every open one.
	const clipTarget = useRef({})
	useEffect(() => {
		const me = clipTarget.current
		markClipTarget(me)
		// Listening on the document, because the screen's own element can be swapped out.
		const mark = (e: Event) => {
			if (e.target instanceof Node && root.current?.contains(e.target)) markClipTarget(me)
		}
		document.addEventListener('focusin', mark)
		document.addEventListener('pointerdown', mark, true)
		const onClipPaste = (e: Event) => {
			const text = (e as CustomEvent<{text?: string}>).detail?.text
			if (text && isClipTarget(me)) termRef.current?.paste(text)
		}
		window.addEventListener('omarchy-clip-paste', onClipPaste)
		return () => {
			window.removeEventListener('omarchy-clip-paste', onClipPaste)
			document.removeEventListener('focusin', mark)
			document.removeEventListener('pointerdown', mark, true)
			unmarkClipTarget(me)
		}
	}, [])

	const sendSeq = (seq: string) => {
		haptic(5)
		const ws = wsRef.current
		if (ws?.readyState !== WebSocket.OPEN) return
		const m = mods.current
		const res = applyTerminalModifiers(seq, m, {appCursor: termRef.current?.modes.applicationCursorKeysMode, applyAppCursor: true})
		mods.current = {ctrl: res.ctrl, alt: res.alt}
		if (res.ctrl !== m.ctrl) setCtrl(res.ctrl)
		if (res.alt !== m.alt) setAlt(res.alt)
		ws.send(res.data)
	}
	const toggleKeyboard = () => {
		haptic(8)
		const term = termRef.current
		if (!term) return
		if (document.activeElement === term.textarea) term.blur()
		else term.focus()
	}
	// Reading the clipboard directly only works on HTTPS (and iPhone asks first). Otherwise,
	// open a small box the phone's own long-press → Paste works in, then send that.
	const paste = async () => {
		haptic(6)
		if (window.isSecureContext && navigator.clipboard?.readText) {
			try {
				const text = await navigator.clipboard.readText()
				if (text) {
					termRef.current?.paste(text)
					termRef.current?.focus()
				}
				return
			} catch {
				/* denied or unsupported: fall back to the paste box */
			}
		}
		setPasteText('')
		setPasteBox(true)
	}
	pasteRef.current = () => void paste()
	useEffect(() => {
		if (!pressPaste) return
		const t = window.setTimeout(() => setPressPaste(null), 4000)
		return () => window.clearTimeout(t)
	}, [pressPaste])
	const sendPaste = () => {
		if (pasteText) {
			haptic(8)
			termRef.current?.paste(pasteText.replace(/\r?\n$/, ''))
			toast('Pasted')
		}
		setPasteBox(false)
		window.setTimeout(() => termRef.current?.focus(), 50)
	}
	const live = state === 'connected'
	const status = terminalStatusLabel(state, {attempt})
	const where =
		app ? ' · App shell' : agent ? ' · Shell through its connector' : container ? (container.mode === 'console' ? ' · Container login' : ' · Root shell') : ''
	// End the shell that's running (and whatever is running in it) and start a new one.
	const newSession = async () => {
		haptic(6)
		const ok = await confirm({
			title: 'Start a new session?',
			body: agent
				? 'The shell that’s running now ends, along with anything still running in it. This computer’s connector does not keep the shell after it closes.'
				: 'The shell that’s running now ends, along with anything still running in it. (Closing the terminal doesn’t do this: your shell keeps running until you exit it.)',
			confirm: 'New session',
			icon: 'reset',
		})
		if (!ok) return
		fresh.current = true
		setResumed(false)
		setAttempt((a) => a + 1)
	}
	const title = app ? (app.name ?? app.id) : machineName

	const keys: {label: string; onClick: () => void; on?: boolean}[] = [
		{label: 'esc', onClick: () => sendSeq(SEQ.esc)},
		{label: 'tab', onClick: () => sendSeq(SEQ.tab)},
		{label: 'ctrl', on: ctrl, onClick: () => (haptic(5), setCtrl((v) => !v))},
		{label: 'alt', on: alt, onClick: () => (haptic(5), setAlt((v) => !v))},
		{label: '^C', onClick: () => sendSeq(SEQ.ctrlC)},
		{label: '←', onClick: () => sendSeq(SEQ.left)},
		{label: '↑', onClick: () => sendSeq(SEQ.up)},
		{label: '↓', onClick: () => sendSeq(SEQ.down)},
		{label: '→', onClick: () => sendSeq(SEQ.right)},
		{label: '|', onClick: () => sendSeq('|')},
		{label: '~', onClick: () => sendSeq('~')},
		{label: '/', onClick: () => sendSeq('/')},
		{label: '-', onClick: () => sendSeq('-')},
		{label: 'home', onClick: () => sendSeq(SEQ.home)},
		{label: 'end', onClick: () => sendSeq(SEQ.end)},
	]

	const screen = (
		<div ref={root} className={`console terminal${inline ? ' inline' : embedded ? ' embedded' : ''}${overSheet ? ' over-sheet' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : !embedded} aria-label={`${title} terminal, on ${machineName}`}>
			<header className="console-bar">
				<button className="round-btn" aria-label="Close terminal" onClick={back}>
					<Icon name="back" size={20} />
				</button>
				{app ? (
					<AppIcon src={app.icon} name={title} size={34} />
				) : (
					<span className="term-badge">
						<Icon name="logs" size={19} />
					</span>
				)}
				<div className="console-title">
					<b>{title}</b>
					<span>
						<i className={`dot ${live ? 'live' : state === 'connecting' ? '' : 'down'}`} />
						{live ? `${status}${where}${resumed ? ' · resumed' : ''} · ${machineName}` : `${status} · ${machineName}`}
					</span>
				</div>
				<button className="round-btn" aria-label="New session" title="New session" onClick={newSession} disabled={!live}>
					<Icon name="reset" size={19} />
				</button>
				<button className="round-btn" aria-label="Paste" onClick={paste} disabled={!live}>
					<Icon name="clipboard" size={19} />
				</button>
			</header>
			<div
				className="term-screen"
				onClick={() => {
					if (!live || kbd) return
					if (ignoreOpeningFocus(matchMedia('(pointer: coarse)').matches, performance.now() - openedAt.current)) return
					const term = termRef.current
					if (!term) return
					if (term.textarea) term.textarea.value = ''
					term.focus()
				}}
			>
				<div ref={host} className="term-host" />
				{state !== 'connected' && (
					<div className="console-overlay">
						{state === 'connecting' ? (
							<>
								<span className="spinner" />
								<b>{status}</b>
								<span>Opening a shell on {machineName}…</span>
							</>
						) : (
							<>
								<Icon name={state === 'closed' ? 'logs' : state === 'lost' ? 'wifi' : 'alert'} size={34} />
								<b>{status}</b>
								<span>{message}</span>
								<button className="btn primary small" onClick={() => setAttempt((a) => a + 1)}>
									{state === 'closed' ? 'New session' : state === 'lost' ? 'Reconnect' : 'Try again'}
								</button>
							</>
						)}
					</div>
				)}
			</div>
			{pressPaste && (
				<>
					<div className="term-press-scrim" onPointerDown={() => setPressPaste(null)} />
					<button
						className="term-press-paste"
						style={{left: Math.min(Math.max(12, pressPaste.x - 40), window.innerWidth - 92), top: Math.max(12, pressPaste.y - 56)}}
						onClick={() => (setPressPaste(null), void paste())}
					>
						Paste
					</button>
				</>
			)}
			{pasteBox && (
				<div className="term-paste" role="dialog" aria-label="Paste into terminal">
					<div className="term-paste-card">
						<div className="term-paste-head">
							<b>Paste</b>
							<span>{matchMedia('(any-pointer: fine)').matches ? 'Press Ctrl+V (or right-click → Paste) in the box, then Send.' : 'Long-press in the box, tap Paste, then Send.'}</span>
						</div>
						<textarea
							ref={pasteField}
							autoFocus
							value={pasteText}
							onChange={(e) => setPasteText(e.target.value)}
							onPaste={(e) => {
								const t = e.clipboardData.getData('text')
								if (!t) return
								e.preventDefault()
								const el = e.currentTarget
								const start = el.selectionStart ?? el.value.length
								const end = el.selectionEnd ?? el.value.length
								pasteCaret.current = Math.min(start, end) + t.length
								setPasteText(pasteInto(el.value, start, end, t))
							}}
							placeholder="Paste here"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							rows={4}
						/>
						<div className="term-paste-actions">
							<button className="btn ghost" onClick={() => (setPasteBox(false), termRef.current?.focus())}>
								Cancel
							</button>
							<button className="btn primary" disabled={!pasteText} onClick={sendPaste}>
								Send to terminal
							</button>
						</div>
					</div>
				</div>
			)}
			<div className="console-dock">
				<button className={`kbd-btn${kbd ? ' on' : ''}`} aria-label={kbd ? 'Hide keyboard' : 'Show keyboard'} aria-pressed={kbd} disabled={!live} onClick={toggleKeyboard}>
					<Icon name={kbd ? 'keyboard-hide' : 'keyboard'} size={22} />
				</button>
				<div className="console-keys">
					{keys.map((k) => (
						<button key={k.label} className={k.on ? 'on' : ''} aria-pressed={k.on} disabled={!live} onPointerDown={(e) => e.preventDefault()} onClick={k.onClick}>
							{k.label}
						</button>
					))}
				</div>
			</div>
		</div>
	)
	return inline ? screen : createPortal(screen, portalRoot)
}
