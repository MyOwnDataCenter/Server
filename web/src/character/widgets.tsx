// The character in the app: the floating launcher, the picker and live preview in Settings, and the
// small icon used where the assistant appears (Home, the desktop). The launcher opens the assistant.
// Its speech bubble shows toasts, and it does not open the chat.
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties} from 'react'

import {useAssistantActivity, useAssistantAnimationState, type CharacterState} from '../assistantActivity'
import {assistantIconBadge} from '../assistantLive'
import {useAssistantTurn} from '../assistantTurn'
import {Icon} from '../icons'
import {ToastRow, useAccountToasts, useToastClock} from '../toasts/account'
import {toastSurface} from '../toasts/view'
import {Row, Segmented, Switch, haptic} from '../ui'
import {AssistantCharacter, DEFAULT_LOOK, lookName, NAME_MAX, useAssistantLook, type AssistantLook} from './AssistantCharacter'
import {CHARACTERS, characterById} from './registry'

export const SIZES: Record<AssistantLook['size'], number> = {small: 60, medium: 78, large: 100}

// Background tab: hold every character still (no work for an unseen page).
export function usePauseWhenHidden() {
	useEffect(() => {
		const apply = () => document.documentElement.classList.toggle('ac-paused', document.visibilityState === 'hidden')
		apply()
		document.addEventListener('visibilitychange', apply)
		return () => {
			document.removeEventListener('visibilitychange', apply)
			document.documentElement.classList.remove('ac-paused')
		}
	}, [])
}

// ---- where the floating character sits --------------------------------------------------------
type Kind = 'phone' | 'desktop'
const layoutKind = (): Kind => (document.documentElement.classList.contains('desk-mode') ? 'desktop' : 'phone')
const EDGE = 8
// Keep Open/Get and other row trailing actions tappable: the default spot stays clear of that column.
const ACTION_SAFE = 76
// The area it may sit in: the whole screen, minus the phone's dock (and a little room at the edges).
function area(kind: Kind, size: number) {
	const vw = window.innerWidth
	const vh = window.innerHeight
	const dock = kind === 'phone' ? document.querySelector('nav.dock')?.getBoundingClientRect() : null
	const top = kind === 'desktop' ? 40 : EDGE + 4
	const bottom = (dock && dock.top > vh / 2 ? dock.top : vh) - EDGE
	const end = EDGE + (kind === 'phone' ? ACTION_SAFE : 0)
	return {minX: EDGE, maxX: Math.max(EDGE, vw - size - end), minY: top, maxY: Math.max(top, bottom - size), vw, vh}
}
// Its corner when you haven't moved it: bottom right, above the dock (and above a page's own button).
// area() already keeps maxX clear of the Open/Get column on phone.
function homeSpot(kind: Kind, size: number) {
	const a = area(kind, size)
	if (kind === 'desktop') return {x: a.maxX - 14, y: a.maxY - 88}
	const right = Math.max(16, a.vw / 2 - 240 + 6)
	const busy = document.querySelector('.fab, .select-bar, .upload-panel') ? 70 : 0
	return {x: Math.min(a.maxX, a.vw - size - right), y: a.maxY - 14 - busy}
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// A phone sheet sits above the character. On the desktop the character stays in front of a sheet.
function useCharacterCovered() {
	const [covered, setCovered] = useState(false)
	useEffect(() => {
		const read = () => setCovered(!document.documentElement.classList.contains('desk-mode') && Number(document.documentElement.dataset.sheets || 0) > 0)
		read()
		const watch = new MutationObserver(read)
		watch.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'data-sheets']})
		return () => watch.disconnect()
	}, [])
	return covered
}

// The floating character: tap to open the assistant; press and drag to put it anywhere. It follows on
// a spring (leaning and stretching as it moves), settles with a soft bounce, and stays where you put
// it, per layout, on every device. Arrow keys move it too. Hidden: the assistant opens from Home.
export function AssistantCharacterWidget({onOpen}: {onOpen: () => void}) {
	const {look, setLook} = useAssistantLook()
	const activity = useAssistantActivity()
	const unread = useAssistantTurn().unread
	const [hover, setHover] = useState(false)
	const [dragging, setDragging] = useState(false)
	const [sayLeft, setSayLeft] = useState(true)
	const state = useAssistantAnimationState({hover: hover || dragging, reactions: look.reactions})
	usePauseWhenHidden()
	const ref = useRef<HTMLDivElement>(null)
	const size = SIZES[look.size]
	const sim = useRef({x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, ready: false, drag: false})
	const press = useRef<{px: number; py: number; x: number; y: number; moved: boolean} | null>(null)
	const swallowClick = useRef(false)
	const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

	const paint = useCallback(() => {
		const s = sim.current
		const el = ref.current
		if (!el) return
		const lean = clamp(s.vx * 0.9, -16, 16)
		const speed = Math.min(Math.hypot(s.vx, s.vy) / 45, 0.1)
		el.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0) rotate(${lean.toFixed(2)}deg) scale(${(1 - speed * 0.35).toFixed(3)}, ${(1 + speed * 0.5).toFixed(3)})`
	}, [])
	const run = useCallback(() => {
		const s = sim.current
		if (s.raf) return
		const step = () => {
			const k = s.drag ? 0.32 : 0.12
			const d = s.drag ? 0.6 : 0.74
			s.vx = (s.vx + (s.tx - s.x) * k) * d
			s.vy = (s.vy + (s.ty - s.y) * k) * d
			s.x += s.vx
			s.y += s.vy
			const busy = s.drag || Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y) > 0.08
			if (!busy) Object.assign(s, {x: s.tx, y: s.ty, vx: 0, vy: 0})
			paint()
			s.raf = busy ? requestAnimationFrame(step) : 0
		}
		s.raf = requestAnimationFrame(step)
	}, [paint])
	useEffect(() => () => cancelAnimationFrame(sim.current.raf), [])

	// Where it should be: your spot, or its home corner. Jump there at first; glide after that.
	const place = useCallback(
		(glide: boolean) => {
			const s = sim.current
			if (s.drag || !ref.current) return
			const kind = layoutKind()
			const a = area(kind, size)
			const spot = look.position[kind]
			const target = spot ? {x: a.minX + spot.x * (a.maxX - a.minX), y: a.minY + spot.y * (a.maxY - a.minY)} : homeSpot(kind, size)
			s.tx = clamp(target.x, a.minX, a.maxX)
			s.ty = clamp(target.y, a.minY, a.maxY)
			setSayLeft(s.tx > window.innerWidth / 2)
			if (!glide || !s.ready || reduce) {
				Object.assign(s, {x: s.tx, y: s.ty, vx: 0, vy: 0, ready: true})
				paint()
			} else run()
		},
		[look.position, size, paint, run, reduce],
	)
	useLayoutEffect(() => place(true), [place, look.floating])
	useEffect(() => {
		const again = () => place(true)
		window.addEventListener('resize', again)
		window.addEventListener('hashchange', again)
		const t = window.setTimeout(again, 400) // after the page's own buttons have appeared
		return () => {
			window.removeEventListener('resize', again)
			window.removeEventListener('hashchange', again)
			window.clearTimeout(t)
		}
	}, [place])

	const save = (x: number, y: number) => {
		const kind = layoutKind()
		const a = area(kind, size)
		const fx = a.maxX > a.minX ? (x - a.minX) / (a.maxX - a.minX) : 0
		const fy = a.maxY > a.minY ? (y - a.minY) / (a.maxY - a.minY) : 0
		setLook({...look, position: {...look.position, [kind]: {x: clamp(fx, 0, 1), y: clamp(fy, 0, 1)}}})
	}
	const keySave = useRef(0)
	const {rows, claimBubble, dismiss, open} = useAccountToasts()
	const now = useToastClock(rows)
	const covered = useCharacterCovered()
	const showBubble = look.floating && rows.length > 0 && toastSurface({floating: true, covered}) === 'bubble'
	useLayoutEffect(() => {
		claimBubble(showBubble)
		return () => claimBubble(false)
	}, [showBubble, claimBubble])

	if (!look.floating) return null
	const name = lookName(look)
	const waiting = activity.pending
	const badge = assistantIconBadge({unread, pending: waiting, phase: activity.phase})
	const extra = unread > 0
		? `, ${unread} unread`
		: waiting
			? `, ${waiting} step${waiting === 1 ? '' : 's'} waiting for you`
			: activity.phase === 'error'
				? ', something went wrong'
				: ''
	const label = `${name}${extra}. Opens the assistant; drag or use the arrow keys to move it.`
	return (
		<div ref={ref} className={`ac-widget${dragging ? ' dragging' : ''}`} style={{width: size, height: size} as CSSProperties}>
		<button
			type="button"
			className="ac-hit"
			aria-label={label}
			title={name}
			onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
			onPointerLeave={() => setHover(false)}
			onFocus={() => setHover(true)}
			onBlur={() => setHover(false)}
			onPointerDown={(e) => {
				if (e.button !== 0) return
				const s = sim.current
				press.current = {px: e.clientX, py: e.clientY, x: s.tx, y: s.ty, moved: false}
				e.currentTarget.setPointerCapture(e.pointerId)
			}}
			onPointerMove={(e) => {
				const p = press.current
				if (!p) return
				const dx = e.clientX - p.px
				const dy = e.clientY - p.py
				if (!p.moved && Math.hypot(dx, dy) < 7) return
				const s = sim.current
				if (!p.moved) {
					p.moved = true
					s.drag = true
					setDragging(true)
					haptic(6)
				}
				const a = area(layoutKind(), size)
				s.tx = clamp(p.x + dx, a.minX, a.maxX)
				s.ty = clamp(p.y + dy, a.minY, a.maxY)
				if (reduce) Object.assign(s, {x: s.tx, y: s.ty}), paint()
				else run()
			}}
			onPointerUp={(e) => {
				const p = press.current
				press.current = null
				if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
				if (!p?.moved) return
				const s = sim.current
				s.drag = false
				setDragging(false)
				swallowClick.current = true
				save(s.tx, s.ty)
				run()
			}}
			onPointerCancel={() => {
				press.current = null
				sim.current.drag = false
				setDragging(false)
				place(true)
			}}
			onKeyDown={(e) => {
				const step = e.shiftKey ? 64 : 16
				const d = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[e.key]
				if (!d) return
				e.preventDefault()
				const s = sim.current
				const a = area(layoutKind(), size)
				s.tx = clamp(s.tx + d[0], a.minX, a.maxX)
				s.ty = clamp(s.ty + d[1], a.minY, a.maxY)
				run()
				window.clearTimeout(keySave.current)
				keySave.current = window.setTimeout(() => save(s.tx, s.ty), 500)
			}}
			onClick={() => {
				if (swallowClick.current) {
					swallowClick.current = false
					return
				}
				haptic(8)
				onOpen()
			}}
		>
			<AssistantCharacter id={look.character} state={state} size={size} animate={look.animate} intensity={look.intensity} shadow />
			{badge && 'count' in badge ? (
				<span className="ac-dot" aria-hidden="true">
					{badge.count}
				</span>
			) : badge && 'warn' in badge ? (
				<span className="ac-dot warn" aria-hidden="true">
					!
				</span>
			) : null}
		</button>
		{showBubble && (
			<div className={`ac-say${sayLeft ? '' : ' on-right'}`}>
				<div className="ac-say-list">
					{rows.map((row) => (
						<ToastRow key={row.id} row={row} now={now} onOpen={open} onDismiss={dismiss} variant="bubble" />
					))}
				</div>
			</div>
		)}
		</div>
	)
}

// Pick a character: a grid of them (hover says hello). `value` is the one in use (checked); `focus`
// is the one shown in the panel beside the grid.
export function AssistantCharacterPicker({value, focus, onFocus, animate, intensity}: {value: string; focus: string; onFocus: (id: string) => void; animate: boolean; intensity: AssistantLook['intensity']}) {
	const [hover, setHover] = useState<string | null>(null)
	return (
		<div className="ac-picker" role="radiogroup" aria-label="Characters">
			{CHARACTERS.map((c) => (
				<button
					key={c.id}
					type="button"
					role="radio"
					aria-checked={c.id === focus}
					className={`ac-pick${c.id === value ? ' in-use' : ''}`}
					style={{'--ac-1': c.accent} as CSSProperties}
					onPointerEnter={() => setHover(c.id)}
					onPointerLeave={() => setHover(null)}
					onClick={() => {
						haptic(6)
						onFocus(c.id)
					}}
				>
					{c.id === value && (
						<span className="ac-check" aria-label="Selected">
							<Icon name="check" size={14} stroke={3} />
						</span>
					)}
					<AssistantCharacter id={c.id} state={hover === c.id ? 'hover' : 'idle'} size={88} animate={animate} intensity={intensity} />
					<b>{c.name}</b>
					<span>{c.tagline}</span>
				</button>
			))}
		</div>
	)
}

const PREVIEW_STATES: {id: CharacterState; label: string}[] = [
	{id: 'idle', label: 'Idle'},
	{id: 'hover', label: 'Hover'},
	{id: 'listening', label: 'Listening'},
	{id: 'thinking', label: 'Thinking'},
	{id: 'responding', label: 'Responding'},
	{id: 'working', label: 'Working'},
	{id: 'success', label: 'Success'},
	{id: 'error', label: 'Error'},
	{id: 'sleeping', label: 'Sleeping'},
]

// The panel beside the grid: the character, large, and how to use it.
export function AssistantCharacterPreview({id, look, inUse, onUse, onCustomize}: {id: string; look: AssistantLook; inUse: boolean; onUse: () => void; onCustomize: () => void}) {
	const [state, setState] = useState<CharacterState>('idle')
	useEffect(() => setState('idle'), [id])
	const c = characterById(id)
	const name = inUse ? lookName(look) : c.name
	return (
		<div className="glass ac-panel" style={{'--ac-1': c.accent} as CSSProperties}>
			<AssistantCharacter id={c.id} state={state} size={180} animate={look.animate} intensity={look.intensity} label={`${name}, ${state}`} />
			<div className="ac-panel-head">
				<b>{name}</b>
				{inUse && (
					<span className="ac-pill">
						<Icon name="check" size={13} stroke={3} /> Selected
					</span>
				)}
			</div>
			<p>{c.description}</p>
			<div className="ac-chips" aria-label="What it does">
				<span>
					<Icon name="terminal" size={15} /> Chat &amp; Commands
				</span>
				<span>
					<Icon name="server" size={15} /> Manage Systems
				</span>
				<span>
					<Icon name="bolt" size={15} /> Run Automations
				</span>
			</div>
			<div className="states" role="group" aria-label="Preview a state">
				{PREVIEW_STATES.map((s) => (
					<button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>
						{s.label}
					</button>
				))}
			</div>
			<div className="ac-panel-actions">
				<button type="button" className="btn primary ac-use" disabled={inUse} onClick={() => (haptic(8), onUse())}>
					<Icon name="check" size={17} stroke={2.6} /> {inUse ? `Using ${c.name}` : `Use ${c.name}`}
				</button>
				<button type="button" className="btn" onClick={() => (haptic(6), onCustomize())}>
					<Icon name="settings" size={17} /> Customize
				</button>
			</div>
		</div>
	)
}

// Settings → Assistant → Assistant Appearance ("Choose Your AI Assistant"). Saved per account.
export function AssistantAppearanceSettings() {
	const {look, setLook} = useAssistantLook()
	const [focus, setFocus] = useState(look.character)
	const [name, setName] = useState(look.name)
	const [custom, setCustom] = useState(false)
	useEffect(() => setName(look.name), [look.name])
	const set = (patch: Partial<AssistantLook>) => setLook({...look, ...patch})
	const isDefault = JSON.stringify(look) === JSON.stringify(DEFAULT_LOOK)
	const customize = () => {
		setCustom(true)
		requestAnimationFrame(() => document.getElementById('ac-customize')?.scrollIntoView({behavior: 'smooth', block: 'start'}))
	}
	return (
		<section className="ac-settings" aria-labelledby="ac-settings-title">
			<div className="section-head" style={{marginTop: 22}}>
				<h2 id="ac-settings-label">Assistant Appearance</h2>
			</div>
			<h2 className="ac-title" id="ac-settings-title">
				Choose Your <em>AI Assistant</em>
			</h2>
			<p className="ac-lead">Pick a mascot for your MODC widget. Your assistant lives in the UI, helps you manage your home lab, and keeps everything running smoothly.</p>
			<div className="ac-choose">
				<AssistantCharacterPicker value={look.character} focus={focus} onFocus={setFocus} animate={look.animate} intensity={look.intensity} />
				<AssistantCharacterPreview id={focus} look={look} inUse={focus === look.character} onUse={() => set({character: focus})} onCustomize={customize} />
			</div>
			{custom && (
				<div id="ac-customize">
					<div className="glass group" style={{marginTop: 14, padding: '12px 14px'}}>
						<div className="field">
							<label htmlFor="ac-name">Name</label>
							<input
								id="ac-name"
								value={name}
								maxLength={NAME_MAX}
								placeholder={characterById(look.character).name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => name !== look.name && set({name})}
								onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
							/>
						</div>
						<div className="field">
							<label>Size</label>
							<Segmented label="Size" value={look.size} onChange={(size) => set({size})} options={[{id: 'small', label: 'Small'}, {id: 'medium', label: 'Medium'}, {id: 'large', label: 'Large'}]} />
						</div>
						<div className="field">
							<label>Animation</label>
							<Segmented label="Animation" value={look.intensity} onChange={(intensity) => set({intensity})} options={[{id: 'minimal', label: 'Minimal'}, {id: 'normal', label: 'Normal'}, {id: 'playful', label: 'Playful'}]} />
						</div>
					</div>
					<div className="glass group" style={{marginTop: 12, '--inset': '62px'} as CSSProperties}>
						<Row icon="sparkle" color="var(--green)" label="Animate" sub="Off: the character stays still" trailing={<Switch on={look.animate} label="Animate" onChange={(animate) => set({animate})} />} />
						<Row icon="bolt" color="var(--peach)" label="Reactions" sub="Thinking, working, done and problems" trailing={<Switch on={look.reactions} label="Reactions" onChange={(reactions) => set({reactions})} />} />
						<Row icon="eye" color="var(--blue)" label="Floating character" sub="Off: open it from Home or the desktop" trailing={<Switch on={look.floating} label="Floating character" onChange={(floating) => set({floating})} />} />
					</div>
					<button type="button" className="btn block" style={{marginTop: 12}} disabled={!Object.keys(look.position).length} onClick={() => (haptic(6), set({position: {}}))}>
						Put it back in its corner
					</button>
					<p className="footer-note" style={{textAlign: 'left', margin: '8px 6px 0'}}>
						Drag the floating character anywhere on the screen; it stays there on this account, separately for phone and desktop.
					</p>
					<button type="button" className="btn block" style={{marginTop: 12}} disabled={isDefault} onClick={() => (haptic(6), setLook(DEFAULT_LOOK), setFocus(DEFAULT_LOOK.character))}>
						Restore default appearance
					</button>
				</div>
			)}
		</section>
	)
}
