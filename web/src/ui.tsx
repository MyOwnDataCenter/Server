import {createPortal} from 'react-dom'
import {createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode, type RefObject} from 'react'

import {useQuery} from '@tanstack/react-query'
import type {AppState, Wallpaper} from './api'
import {AssistantAvatar, cleanLook, type AssistantLook} from './character/AssistantCharacter'
import {detectDesktop, LAYOUT_POINTER} from './layout'
export {detectDesktop}
import {fieldAria, useDialogFocus} from './focus'
import {RADIO_SELECTOR, rovingKeyDown, rovingTabIndex, TAB_SELECTOR} from './roving'
import {Icon, type IconName} from './icons'
import {versionTagProps, type VersionInfo} from './runningSince'
import {solidOf, useDeskConfig} from './desktop/config'
import {wallpaperBlocked} from './desktop/wallpaperGate'
import {resolvePrefsUpdate} from './photoPrefs'
import {createPrefsSync, SYNCED_PREF_KEYS} from './prefsSync'
import {cleanTutorials, type TutorialId} from './tutorials'
import {darkenForTextOn, darkenHslForWhite, hslToRgb, legibleMuted, parseRgbColor, pickOnAccent, resolveCssColor} from './theme/contrast'
import {cleanThemeSlots, isLightTheme, type DarkThemeId, type LightThemeId, type PictureThemeId} from './theme/themeMode'
import {reachLabel} from './fleet/machineManagerLogic'
import {cleanStatPicks} from './fleet/statView'
import {cleanTempPicks} from './fleet/temperatures'
import {initials as nameInitials} from './initials'
import {paddingBottomPlus} from './scrollPad'
import {SPARK_HEIGHT, SPARK_WIDTH, sparkPath} from './spark'
import {AccountToastProvider, AccountToastStack, useAccountToasts} from './toasts/account'

// ---- portals --------------------------------------------------------------------------
// Sheets, the terminal and the console portal out of their screen. On the phone that's <body>;
// in a desktop window it's the window itself, so they open inside that window.
export const PortalRoot = createContext<HTMLElement | null>(null)
export const usePortalRoot = () => useContext(PortalRoot) ?? document.body
// True inside a desktop window (screens use it to open things as windows instead of overlays).
export const InWindow = createContext(false)

// ---- formatting -------------------------------------------------------------
// Storage in decimal units (as drives are sold); memory in binary (16 GB RAM reads as 16 GB).
export {bytes} from './formatBytes'
export function duration(seconds: number | undefined) {
	if (!seconds) return '–'
	const d = Math.floor(seconds / 86400)
	const h = Math.floor((seconds % 86400) / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
export const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0)
export const levelColor = (p: number) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--yellow)' : 'var(--green)')
export function initials(name = '') {
	return nameInitials(name)
}
export function greeting() {
	const h = new Date().getHours()
	return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
export const today = () => new Date().toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'})

// A light tap on Android; iOS Safari has no vibration API and ignores it.
export const haptic = (ms: number | number[] = 8) => {
	try {
		navigator.vibrate?.(ms)
	} catch {
		/* unsupported */
	}
}

// ---- status ---------------------------------------------------------------
export type StatusKind = 'running' | 'stopped' | 'busy' | 'update' | 'error'
const BUSY: AppState[] = ['installing', 'starting', 'stopping', 'restarting', 'uninstalling', 'updating']
export function appStatus(state: AppState | undefined, hasUpdate = false): {kind: StatusKind; label: string} {
	if (state && BUSY.includes(state)) return {kind: 'busy', label: state}
	if (state === 'stopped') return {kind: 'stopped', label: 'stopped'}
	if (state === 'unknown' || !state) return {kind: 'error', label: 'unknown'}
	if (hasUpdate) return {kind: 'update', label: 'update'}
	return {kind: 'running', label: 'running'}
}
export const isAppBusy = (state?: AppState) => !!state && BUSY.includes(state)
export function machineStatus(state: string): {kind: StatusKind; label: string} {
	return reachLabel('guest', state === 'running', state)
}
const STATUS_COLOR: Record<StatusKind, string> = {
	running: 'var(--green)',
	stopped: 'var(--muted)',
	busy: 'var(--blue)',
	update: 'var(--yellow)',
	error: 'var(--red)',
}
export const statusColor = (kind: StatusKind) => STATUS_COLOR[kind]

export function StatusPill({kind, label}: {kind: StatusKind; label: string}) {
	return (
		<span className={`pill${kind === 'busy' ? ' busy' : ''}`} style={{'--c': STATUS_COLOR[kind]} as CSSProperties}>
			<i />
			{label}
		</span>
	)
}

// ---- app icon ---------------------------------------------------------------
const TINTS = [
	['#6366f1', '#a855f7'],
	['#0ea5e9', '#6366f1'],
	['#14b8a6', '#0ea5e9'],
	['#f97316', '#ef4444'],
	['#ec4899', '#8b5cf6'],
	['#22c55e', '#14b8a6'],
]
export function AppIcon({
	src,
	name,
	size = 56,
	badge,
	dim,
	progress,
}: {
	src?: string
	name?: string
	size?: number
	badge?: StatusKind
	dim?: boolean
	progress?: number | 'spin'
}) {
	const [failed, setFailed] = useState(false)
	const [a, b] = TINTS[[...(name ?? '')].reduce((t, c) => t + c.charCodeAt(0), 0) % TINTS.length]
	const showImg = src && !failed
	const r = size / 2 + 3
	const c = 2 * Math.PI * r
	return (
		<span
			className={`app-icon${dim ? ' dim' : ''}`}
			style={{width: size, height: size, fontSize: size * 0.36, background: showImg ? 'rgba(255,255,255,.92)' : `linear-gradient(140deg, ${a}, ${b})`}}
		>
			{showImg ? (
				<img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} draggable={false} />
			) : (
				<span className="initials">{initials(name)}</span>
			)}
			{progress !== undefined && (
				<svg className={`busy-ring${progress === 'spin' ? ' spin' : ''}`} viewBox={`0 0 ${size + 10} ${size + 10}`} aria-hidden="true">
					<circle cx={size / 2 + 5} cy={size / 2 + 5} r={r} fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="2.5" />
					<circle
						cx={size / 2 + 5}
						cy={size / 2 + 5}
						r={r}
						fill="none"
						stroke="var(--accent-text)"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeDasharray={c}
						strokeDashoffset={progress === 'spin' ? c * 0.72 : c * (1 - Math.max(0.04, progress / 100))}
					/>
				</svg>
			)}
			{badge && <span className="badge" style={{background: STATUS_COLOR[badge]}} />}
		</span>
	)
}

// ---- ring gauge -------------------------------------------------------------
export function Ring({value, color, children, size = 84, label, empty = false, now, max = 100}: {value: number; color: string; children: ReactNode; size?: number; label: string; empty?: boolean; now?: number; max?: number}) {
	const stroke = 8
	const r = (size - stroke) / 2
	const c = 2 * Math.PI * r
	const [shown, setShown] = useState(0)
	useEffect(() => {
		const id = requestAnimationFrame(() => setShown(value))
		return () => cancelAnimationFrame(id)
	}, [value])
	return (
		<div
			className={empty ? 'ring is-off' : 'ring'}
			style={{width: size, height: size, color}}
			role={empty ? 'img' : 'meter'}
			aria-label={label}
			aria-valuenow={empty ? undefined : Math.round(now ?? value)}
			aria-valuemin={empty ? undefined : 0}
			aria-valuemax={empty ? undefined : max}
		>
			<svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
				<circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
				{!empty && (
					<circle
						className="value"
						cx={size / 2}
						cy={size / 2}
						r={r}
						fill="none"
						stroke="currentColor"
						strokeWidth={stroke}
						strokeLinecap="round"
						strokeDasharray={c}
						strokeDashoffset={c * (1 - Math.max(0.005, shown / 100))}
					/>
				)}
			</svg>
			<div className="center">{children}</div>
		</div>
	)
}

// Last-N poll points for a sparkline. Keyed on fetch time so a flat value still plots.
export function useHistory(value: number | undefined, stamp: number, size = 40) {
	const [series, setSeries] = useState<number[]>([])
	useEffect(() => {
		if (value === undefined || !stamp) return
		setSeries((s) => [...s.slice(-(size - 1)), value])
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stamp])
	return series
}

export function Spark({series, max = 100, color, label}: {series: number[]; max?: number; color: string; label: string}) {
	const id = `spark${useId().replace(/:/g, '')}`
	const d = sparkPath(series, {max})
	if (!d) return <svg className="spark" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} aria-hidden="true" />
	return (
		<svg className="spark" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
			<defs>
				<linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0" stopColor={color} stopOpacity="0.35" />
					<stop offset="1" stopColor={color} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`${d} L${SPARK_WIDTH},${SPARK_HEIGHT} L0,${SPARK_HEIGHT} Z`} fill={`url(#${id})`} />
			<path d={d} fill="none" stroke={color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	)
}

export function StatCard({
	icon,
	label,
	value,
	unit,
	sub,
	subStyle,
	spark,
	ariaLabel,
}: {
	icon: IconName
	label: string
	value: ReactNode
	unit?: ReactNode
	sub?: ReactNode
	subStyle?: CSSProperties
	spark?: {series: number[]; color: string; label: string; max?: number}
	ariaLabel?: string
}) {
	return (
		<section className="glass stat" aria-label={ariaLabel ?? label}>
			<div className="k">
				<Icon name={icon} size={16} /> {label}
			</div>
			<div className="v">
				{value}
				{unit ? <small>{unit}</small> : null}
			</div>
			{sub !== undefined && (
				<div className="sub" style={subStyle}>
					{sub}
				</div>
			)}
			{spark ? <Spark series={spark.series} color={spark.color} label={spark.label} max={spark.max} /> : null}
		</section>
	)
}

export function Card({
	children,
	className,
	style,
	label,
}: {
	children: ReactNode
	className?: string
	style?: CSSProperties
	label?: string
}) {
	return (
		<section className={['glass', 'card', className].filter(Boolean).join(' ')} style={style} aria-label={label}>
			{children}
		</section>
	)
}

export function CardHead({title, extra, style}: {title: ReactNode; extra?: ReactNode; style?: CSSProperties}) {
	return (
		<div className="card-head" style={style}>
			<strong>{title}</strong>
			{extra ? <span>{extra}</span> : null}
		</div>
	)
}

export function StatChip({
	icon,
	label,
	children,
	className = 'spec',
	size = 14,
}: {
	icon: IconName
	label: string
	children: ReactNode
	className?: string
	size?: number
}) {
	return (
		<span className={className} title={label}>
			<Icon name={icon} size={size} /> {children}
		</span>
	)
}

// ---- segmented control ------------------------------------------------------
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T
	options: {id: T; label: string; count?: number}[]
	onChange: (v: T) => void
	label: string
}) {
	const index = Math.max(0, options.findIndex((o) => o.id === value))
	return (
		<div className="segmented glass" role="tablist" aria-label={label} onKeyDown={(e) => rovingKeyDown(e, TAB_SELECTOR, 'horizontal')}>
			<span className="thumb" style={{width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)`}} />
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					role="tab"
					aria-selected={o.id === value}
					tabIndex={rovingTabIndex(o.id === value, options.indexOf(o), options.some((x) => x.id === value))}
					onClick={() => {
						haptic(5)
						onChange(o.id)
					}}
				>
					{o.label}
					{o.count !== undefined && <span className="n">{o.count}</span>}
				</button>
			))}
		</div>
	)
}

export function Switch({on, onChange, label, disabled}: {on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean}) {
	return (
		<button
			className="switch"
			role="switch"
			aria-checked={on}
			aria-label={label}
			disabled={disabled}
			onClick={() => {
				haptic(6)
				onChange(!on)
			}}
		/>
	)
}

// ---- page scroll lock -------------------------------------------------------
// Sheets and full-screen views stop the page behind them from scrolling. Several can be open at
// once (a sheet over a sheet, a confirm over a sheet), so it's counted: the page scrolls again only
// when the last one closes, whatever order they close in. (Saving and restoring the old style
// instead left the page stuck when two closed out of order, until a reload.)
let pageLocks = 0
export function lockPageScroll() {
	pageLocks++
	document.documentElement.classList.add('page-locked')
	let released = false
	return () => {
		if (released) return
		released = true
		pageLocks = Math.max(0, pageLocks - 1)
		if (pageLocks === 0) {
			document.documentElement.classList.remove('page-locked')
			// Clear anything an older version (or an interrupted lock) left behind.
			document.body.style.overflow = ''
		}
	}
}

// Make a full-screen overlay behave like its own window on iPhone: freeze the page underneath
// (iOS ignores overflow:hidden on body and will scroll it to "reveal" a focused input), and
// stop drags outside the real scroll areas from panning the page while the keyboard is up.
export function useScreenLock(ref: RefObject<HTMLElement>, guardTouch = true, enabled = true) {
	useEffect(() => {
		if (!enabled) return
		const html = document.documentElement
		const b = document.body.style
		const y = window.scrollY
		Object.assign(b, {position: 'fixed', top: `-${y}px`, left: '0', right: '0', width: '100%'})
		const release = lockPageScroll()
		html.classList.add('screen-locked')
		const el = ref.current
		const scrollers = '.xterm-viewport, .console-keys, .term-paste textarea'
		const onMove = (e: TouchEvent) => {
			if (e.touches.length > 1) return void e.preventDefault() // no pinch-zoom of the page
			const t = e.target as Element | null
			if (t?.closest?.(scrollers)) return
			e.preventDefault()
		}
		if (guardTouch) el?.addEventListener('touchmove', onMove, {passive: false})
		// iOS can still pan the page after the keyboard opens; pull it back.
		const onScroll = () => window.scrollY && window.scrollTo(0, 0)
		window.addEventListener('scroll', onScroll)
		return () => {
			if (guardTouch) el?.removeEventListener('touchmove', onMove)
			window.removeEventListener('scroll', onScroll)
			// Back to the page's normal layout (not a saved copy, which another overlay may have changed).
			Object.assign(b, {position: '', top: '', left: '', right: '', width: ''})
			release()
			html.classList.remove('screen-locked')
			window.scrollTo(0, y)
		}
	}, [ref, guardTouch, enabled])
}

// ---- bottom sheet -----------------------------------------------------------
export function Sheet({open, onClose, label, children, tall}: {open: boolean; onClose: () => void; label: string; children: ReactNode; tall?: boolean}) {
	const ref = useRef<HTMLDivElement>(null)
	const scrollRef = useRef<HTMLDivElement>(null)
	const portalRoot = usePortalRoot()
	const start = useRef<{y: number; t: number} | null>(null)
	const [drag, setDrag] = useState(0)
	useDialogFocus(open, ref, onClose)
	useEffect(() => {
		if (!open) return
		return lockPageScroll()
	}, [open])
	useEffect(() => {
		if (!open) return
		const root = document.documentElement
		root.dataset.sheets = String(Number(root.dataset.sheets || 0) + 1)
		return () => {
			const left = Number(root.dataset.sheets || 1) - 1
			if (left <= 0) delete root.dataset.sheets
			else root.dataset.sheets = String(left)
		}
	}, [open])
	if (!open) return null
	// Drag the handle or the header down to dismiss, and only when the page is already at the top.
	// A drag that starts on the page itself scrolls that page. The close button is the accessible path.
	// Disabled on centered desktop dialogs so a touch drag cannot drop the centering transform.
	const onTouchStart = (e: React.TouchEvent) => {
		if (document.documentElement.classList.contains('desk-mode')) return
		if ((scrollRef.current?.scrollTop ?? 0) > 0) return
		const target = e.target as HTMLElement
		if (target.closest('.logs, .gallery, input, textarea')) return
		if (!target.closest('.sheet-chrome, .sheet-head')) return
		start.current = {y: e.touches[0].clientY, t: Date.now()}
	}
	const onTouchMove = (e: React.TouchEvent) => {
		if (!start.current) return
		const dy = e.touches[0].clientY - start.current.y
		setDrag(dy > 0 ? dy : dy / 6)
	}
	const onTouchEnd = () => {
		if (!start.current) return
		const velocity = drag / Math.max(1, Date.now() - start.current.t)
		if (drag > 120 || (drag > 40 && velocity > 0.6)) {
			haptic(6)
			onClose()
		}
		start.current = null
		setDrag(0)
	}
	// Portalled to <body> so a transformed/animated ancestor can't re-anchor position: fixed.
	return createPortal(
		<>
			<button className="scrim" aria-label="Close" onClick={onClose} tabIndex={-1} style={drag > 0 ? {opacity: Math.max(0.2, 1 - drag / 400)} : undefined} />
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				className={`sheet${tall ? ' tall' : ''}`}
				style={drag ? {transform: `translate(-50%, ${drag}px)`, transition: 'none'} : undefined}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
			>
				<div className="sheet-chrome">
					<span className="grabber" />
				</div>
				<div className="sheet-scroll" ref={scrollRef}>
					{children}
				</div>
			</div>
		</>,
		portalRoot,
	)
}

export function SheetHeader({icon, title, subtitle, onClose}: {icon?: ReactNode; title: string; subtitle?: ReactNode; onClose: () => void}) {
	return (
		<div className="sheet-head">
			{icon}
			<div className="main">
				<h3>{title}</h3>
				{subtitle && <p>{subtitle}</p>}
			</div>
			<button className="icon-btn" aria-label="Close" onClick={onClose}>
				<Icon name="close" size={18} stroke={2.2} />
			</button>
		</div>
	)
}

export function KV({rows}: {rows: [string, ReactNode][]}) {
	return (
		<div className="kv glass group" style={{borderRadius: 18}}>
			{rows.map(([k, v]) => (
				<div className="row static" key={k}>
					<span className="k">{k}</span>
					<span className="v">{v}</span>
				</div>
			))}
		</div>
	)
}

// Version, settings rows, and grouped lists. Copied screens used to drift (the version tooltip
// only appeared where someone remembered to wire it).
export function VersionTag({version, info, prefix}: {version?: string; info?: VersionInfo | null; prefix?: string}) {
	const {text, title} = versionTagProps(version, info, {prefix})
	return (
		<span title={title}>
			{text}
			{title ? <span className="sr-only"> {title}</span> : null}
		</span>
	)
}

export function Row({
	icon,
	color = 'var(--accent)',
	label,
	value,
	sub,
	onClick,
	href,
	trailing,
	title,
	disabled,
	expanded,
}: {
	icon: IconName
	color?: string
	label: string
	value?: ReactNode
	sub?: ReactNode
	onClick?: () => void
	href?: string
	trailing?: ReactNode
	title?: string
	disabled?: boolean
	/** For a row that opens or closes more rows under it: whether they are showing. */
	expanded?: boolean
}) {
	const inner = (
		<>
			<span className="row-ico" style={{'--c': color} as CSSProperties}>
				<Icon name={icon} size={19} />
			</span>
			<span className="main">
				<b style={{fontWeight: 550}}>{label}</b>
				{sub ? <span>{sub}</span> : null}
			</span>
			{value !== undefined && <span className="trail">{value}</span>}
			{trailing ?? (onClick || href ? <Icon name="chevron" size={18} className="chev" /> : null)}
		</>
	)
	if (href)
		return (
			<a className="row" href={href} target="_blank" rel="noopener noreferrer" title={title} style={{minHeight: 56}}>
				{inner}
			</a>
		)
	if (onClick)
		return (
			<button className="row" onClick={onClick} title={title} disabled={disabled} aria-expanded={expanded} style={{minHeight: 56}}>
				{inner}
			</button>
		)
	return (
		<div className="row static" title={title} style={{minHeight: 56}}>
			{inner}
		</div>
	)
}

export function Group({title, children, footer}: {title: string; children: ReactNode; footer?: ReactNode}) {
	return (
		<section>
			<div className="section-head">
				<h2>{title}</h2>
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{children}
			</div>
			{footer && (
				<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
					{footer}
				</p>
			)}
		</section>
	)
}

export type FieldProps = {
	id?: string
	label: string
	labelHidden?: boolean
	hint?: ReactNode
	error?: ReactNode
	invalid?: boolean
	wrapperClassName?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>

export function Field({
	id,
	label,
	labelHidden,
	hint,
	error,
	invalid,
	wrapperClassName,
	'aria-describedby': describedByProp,
	'aria-invalid': ariaInvalidProp,
	...input
}: FieldProps) {
	const autoId = useId()
	const fieldId = id ?? autoId
	const a11y = fieldAria(autoId, {
		hasHint: Boolean(hint),
		hasError: Boolean(error),
		invalid,
		describedBy: describedByProp,
	})
	return (
		<div className={wrapperClassName ? `field ${wrapperClassName}` : 'field'}>
			<label htmlFor={fieldId} className={labelHidden ? 'sr-only' : undefined}>
				{label}
			</label>
			<input
				id={fieldId}
				aria-describedby={a11y.describedBy}
				aria-invalid={ariaInvalidProp ?? a11y.invalid}
				{...input}
			/>
			{hint && (
				<span id={a11y.hintId} className="hint">
					{hint}
				</span>
			)}
			<span id={a11y.errorId} className={error ? 'hint field-error' : 'sr-only'} aria-live="polite" aria-atomic="true">
				{error || ''}
			</span>
		</div>
	)
}

// ---- confirmation & toasts ----------------------------------------------------
type ConfirmOptions = {title: string; body: ReactNode; confirm: string; danger?: boolean; icon?: Parameters<typeof Icon>[0]['name']}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastContext)

export function Providers({children}: {children: ReactNode}) {
	return (
		<AccountToastProvider>
			<ProvidersInner>{children}</ProvidersInner>
		</AccountToastProvider>
	)
}

function ProvidersInner({children}: {children: ReactNode}) {
	const account = useAccountToasts()
	const show = useCallback((text: string, error = false) => {
		haptic(error ? [20, 40, 20] : 10)
		account.push(text, error)
	}, [account])

	const [pending, setPending] = useState<(ConfirmOptions & {resolve: (v: boolean) => void}) | null>(null)
	const confirm = useCallback((o: ConfirmOptions) => {
		haptic(10)
		return new Promise<boolean>((resolve) => setPending({...o, resolve}))
	}, [])
	const finish = (v: boolean) => {
		pending?.resolve(v)
		setPending(null)
	}

	return (
		<ToastContext.Provider value={show}>
			<ConfirmContext.Provider value={confirm}>
				{children}
				<Sheet open={!!pending} onClose={() => finish(false)} label={pending?.title ?? 'Confirm'}>
					{pending && (
						<div style={{textAlign: 'center', padding: '6px 4px 0'}}>
							<span
								className="row-ico"
								style={{width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px', '--c': pending.danger ? 'var(--red)' : 'var(--accent)'} as CSSProperties}
							>
								<Icon name={pending.icon ?? (pending.danger ? 'alert' : 'info')} size={28} />
							</span>
							<h3 style={{margin: '0 0 8px', fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em'}}>{pending.title}</h3>
							<div className="prose" style={{marginBottom: 24}}>
								{pending.body}
							</div>
							<div className="stack confirm-actions">
								<button className={`btn block ${pending.danger ? 'danger solid' : 'primary'}`} onClick={() => finish(true)}>
									{pending.confirm}
								</button>
								{/* Destructive confirms start on Cancel, so a stray Enter can't delete or uninstall. */}
								<button className="btn block ghost" data-autofocus={pending.danger || undefined} onClick={() => finish(false)}>
									Cancel
								</button>
							</div>
						</div>
					)}
				</Sheet>
				<AccountToastStack />
			</ConfirmContext.Provider>
		</ToastContext.Provider>
	)
}

// ---- appearance ---------------------------------------------------------------
// ids stay stable (they're saved); only the names are shown.
export const THEMES = [
	{id: 'horizon', name: 'Horizon', bg: '#111', fg: '#fff', dots: [] as string[]},
	{id: 'custom', name: 'Your photo', bg: '#111', fg: '#fff', dots: [] as string[]},
	{id: 'mocha', name: 'Midnight', bg: '#282238', fg: '#ddd4f6', dots: ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8']},
	{id: 'tokyo', name: 'Neon', bg: '#101820', fg: '#c8e7f8', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e']},
	{id: 'gruvbox', name: 'Ember', bg: '#282828', fg: '#ebdbb2', dots: ['#83a598', '#b8bb26', '#fabd2f', '#fb4934']},
	{id: 'latte', name: 'Daylight', bg: '#f2f2ef', fg: '#4c4f69', dots: ['#1e66f5', '#40a02b', '#df8e1d', '#d20f39']},
	{id: 'linen', name: 'Linen', bg: '#f6f1e7', fg: '#4a4338', dots: ['#3d6fbf', '#3d8c3a', '#b8860b', '#c44536']},
	{id: 'sky', name: 'Sky', bg: '#d5e3f6', fg: '#2c3d52', dots: ['#3a6fbf', '#2f8f6b', '#c4922a', '#d04555']},
	{id: 'chronara-studio', name: 'Chronara Studio', bg: '#14181d', fg: '#e7eaee', dots: ['#6ea0ff', '#4cc38a', '#e5b454', '#f2716b']},
	{id: 'chronara-studio-light', name: 'Chronara Studio Light', bg: '#f7f8fa', fg: '#161a20', dots: ['#2f62d0', '#1f8a5b', '#a86b00', '#c8362f']},
	{id: 'omarchy', name: 'Omarchy', bg: '#1a1b26', fg: '#a9b1d6', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e']},
] as const
export const ACCENTS = ['wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink'] as const
export type ThemeId = (typeof THEMES)[number]['id']
export type Prefs = {
	theme: ThemeId
	/** Palette Moon returns to. */
	darkTheme: DarkThemeId
	/** Palette Sun returns to. */
	lightTheme: LightThemeId
	/** Horizon, Your photo, or Omarchy. Off returns to this. */
	pictureTheme: PictureThemeId
	accent: (typeof ACCENTS)[number]
	customBrandHsl?: string | null
	backgroundVersion?: number | null
	/** Omarchy theme: which Omarchy background (null: whatever the desktop shows right now). */
	omarchyBackground?: string | null
	/** A plain colour behind everything instead of a picture (#rrggbb), or null for the picture. */
	solidColor?: string | null
	/** How the assistant looks (character, name, motion); see character/AssistantCharacter. */
	assistantLook?: AssistantLook | null
	/** How machine stats are drawn. Null means the one-line default. Saved per account. */
	statView?: 'line' | 'blocks' | 'gauges' | null
	/** Desktop Machines compact list. Null means off. Saved per account. */
	machinesCompact?: boolean | null
	/** Which readings this account shows, apart from temperatures. Null means all of them stay shown. */
	statPicks?: {on: string[]; off: string[]} | null
	/** Which temperature sensors this account shows. Null means each sensor's own default. */
	tempPicks?: {on: string[]; off: string[]} | null
	/** Fahrenheit when `f`. Null means Celsius. */
	tempUnit?: 'f' | null
	/** Notes this account has dismissed. The same id stays dismissed on every device. */
	dismissedTutorials?: TutorialId[]
}
// New installs start on the Omarchy theme (the Omarchy desktop's own colours and background). Anyone
// who already chose a theme keeps it: their choice is saved on the server and wins over this default.
const DEFAULT_PREFS: Prefs = {theme: 'omarchy', darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'omarchy', accent: 'wallpaper'}
// Plain colours to choose instead of a picture (the phone's background and the desktop's wallpaper).
export const SOLID_COLORS = ['#1a1b26', '#11111b', '#000000', '#2e3440', '#1f2335', '#283618', '#3b2f2f', '#4a1942', '#0f3b57', '#7aa2f7', '#9ece6a', '#e0af68'] as const
export const isSolidColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

// Plain colours instead of a picture: a few to tap, any other with the colour picker, or the picture.
export function SolidColors({value, onChange}: {value: string | null; onChange: (c: string | null) => void}) {
	return (
		<div className="solid-colors" role="radiogroup" aria-label="Solid colour" onKeyDown={(e) => rovingKeyDown(e, RADIO_SELECTOR)}>
			<button role="radio" aria-checked={!value} tabIndex={!value || !SOLID_COLORS.includes(value as (typeof SOLID_COLORS)[number]) ? 0 : -1} className={`solid-swatch picture${!value ? ' on' : ''}`} onClick={() => onChange(null)} title="A picture (no solid colour)">
				<Icon name="wallpaper" size={16} />
			</button>
			{SOLID_COLORS.map((c) => (
				<button key={c} role="radio" aria-checked={value === c} tabIndex={value === c ? 0 : -1} aria-label={c} className={`solid-swatch${value === c ? ' on' : ''}`} style={{background: c}} onClick={() => onChange(c)} />
			))}
			<label className={`solid-swatch custom${value && !(SOLID_COLORS as readonly string[]).includes(value) ? ' on' : ''}`} title="Any colour" style={value && !(SOLID_COLORS as readonly string[]).includes(value) ? {background: value} : undefined}>
				<Icon name="palette" size={16} />
				<input type="color" value={value ?? '#1a1b26'} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label="Pick any colour" />
			</label>
		</div>
	)
}
const LOCAL_KEY = 'omarchy-server:prefs'

function clean(p: Partial<Prefs> | null | undefined): Prefs {
	const theme = THEMES.some((t) => t.id === p?.theme) ? p!.theme! : DEFAULT_PREFS.theme
	const slots = cleanThemeSlots(theme, p)
	const accent = (ACCENTS as readonly string[]).includes(p?.accent as string) ? p!.accent! : DEFAULT_PREFS.accent
	const omarchyBackground = typeof p?.omarchyBackground === 'string' && /^[0-9a-f]{16}$/.test(p.omarchyBackground) ? p.omarchyBackground : null
	const statView = p?.statView === 'line' || p?.statView === 'blocks' || p?.statView === 'gauges' ? p.statView : null
	const machinesCompact = typeof p?.machinesCompact === 'boolean' ? p.machinesCompact : null
	const statPicks = cleanStatPicks(p?.statPicks)
	const tempPicks = cleanTempPicks(p?.tempPicks)
	const tempUnit = p?.tempUnit === 'f' ? 'f' : null
	const dismissedTutorials = cleanTutorials(p?.dismissedTutorials)
	return {theme, ...slots, accent, customBrandHsl: p?.customBrandHsl ?? null, backgroundVersion: p?.backgroundVersion ?? null, omarchyBackground, solidColor: isSolidColor(p?.solidColor) ? p.solidColor.toLowerCase() : null, assistantLook: p?.assistantLook ? cleanLook(p.assistantLook) : null, statView, machinesCompact, statPicks, tempPicks, tempUnit, dismissedTutorials}
}
export function readPrefs(): Prefs {
	try {
		return clean(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}'))
	} catch {
		return DEFAULT_PREFS
	}
}

// ---- the Omarchy desktop's themes ------------------------------------------------------------
export type OmarchyColors = {background?: string | null; foreground?: string | null; accent?: string | null; dots?: string[]; palette?: Partial<Record<'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'black' | 'brightBlack', string>>}
export type OmarchyThemes = {theme: string | null; label: string | null; current: string | null; colors: OmarchyColors | null; groups: {theme: string; label: string; items: {id: string; name: string}[]}[]}
let omarchyColors: OmarchyColors | null = null
try {
	omarchyColors = JSON.parse(localStorage.getItem('omarchy-server:omarchy-colors') ?? 'null')
} catch {}
// `current`: the desktop's background right now. Pass the current background's id as `key` so the
// picture reloads when the desktop changes it.
export const omarchyBackgroundUrl = (id?: string | null, key?: string | null) => `/api/omarchy/background/${id ?? 'current'}${!id && key ? `?v=${key}` : ''}`
export function useOmarchyThemes(enabled = true) {
	const q = useQuery({
		queryKey: ['omarchy-themes'],
		queryFn: () => fetch('/api/omarchy/themes', {credentials: 'same-origin'}).then((r) => (r.ok ? (r.json() as Promise<OmarchyThemes>) : null)),
		enabled,
		// Nothing yet (e.g. before signing in): ask again next time something needs it.
		staleTime: (query) => (query.state.data ? 60_000 : 0),
	})
	useEffect(() => {
		const c = q.data?.colors
		if (!c || JSON.stringify(c) === JSON.stringify(omarchyColors)) return
		omarchyColors = c
		try {
			localStorage.setItem('omarchy-server:omarchy-colors', JSON.stringify(c))
		} catch {}
		if (document.documentElement.dataset.theme === 'omarchy') applyPrefs(readPrefs())
	}, [q.data])
	return q
}

const FALLBACK_BRAND = '24 90% 50%' // My Own Data Center's default wallpaper colour
// The Omarchy theme takes every colour from the theme the Omarchy desktop uses right now: panels,
// text and the palette that system icons are tinted with (see .sys-ico in styles.css).
const OMARCHY_VARS = ['--bg', '--bg-solid', '--fg', '--fg-2', '--muted', '--faint', '--glass', '--glass-2', '--glass-press', '--line', '--line-2', '--sheet', '--dock', '--red', '--green', '--yellow', '--blue', '--mauve', '--teal', '--peach', '--pink']
function applyOmarchyPalette(root: HTMLElement, on: boolean) {
	for (const v of OMARCHY_VARS) root.style.removeProperty(v)
	const c = omarchyColors
	if (!on || !c?.background || !c.foreground) return
	const bg = c.background
	const fg = c.foreground
	const mix = (a: string, b: string, pctA: number) => `color-mix(in srgb, ${a} ${pctA}%, ${b})`
	const set = (k: string, v: string | null | undefined) => v && root.style.setProperty(k, v)
	set('--bg', bg)
	set('--bg-solid', mix(bg, '#000', 88))
	set('--fg', fg)
	set('--fg-2', mix(fg, bg, 88))
	set('--muted', legibleMuted(bg, fg, c.palette?.brightBlack) ?? (c.palette?.brightBlack && c.palette.brightBlack !== bg ? mix(c.palette.brightBlack, fg, 55) : mix(fg, bg, 62)))
	set('--faint', mix(fg, 'transparent', 8))
	set('--glass', mix(bg, 'transparent', 94))
	set('--glass-2', mix(fg, bg, 8))
	set('--glass-press', mix(fg, bg, 14))
	set('--line', mix(fg, bg, 16))
	set('--line-2', mix(fg, bg, 26))
	set('--sheet', bg)
	set('--dock', mix(bg, 'transparent', 96))
	const p = c.palette ?? {}
	set('--red', p.red)
	set('--green', p.green)
	set('--yellow', p.yellow)
	set('--blue', p.blue)
	set('--mauve', p.magenta)
	set('--pink', p.magenta)
	set('--teal', p.cyan)
	set('--peach', p.yellow && p.red ? mix(p.yellow, p.red, 55) : p.yellow)
}
// Chronara Studio's own accent, per mode (white text on the fill passes WCAG AA in both).
const CHRONARA_STUDIO_ACCENT = {dark: {fill: '#3d70db', text: '#8db3ff'}, light: {fill: '#2f62d0', text: '#2a58c2'}}
const isChronaraStudio = (theme: string): theme is 'chronara-studio' | 'chronara-studio-light' => theme === 'chronara-studio' || theme === 'chronara-studio-light'
export function applyPrefs(p: Prefs, brandHsl?: string | null) {
	const root = document.documentElement
	root.dataset.theme = p.theme
	applyOmarchyPalette(root, p.theme === 'omarchy')
	const light = isLightTheme(p.theme)
	const lightBg = light ? (parseRgbColor(THEMES.find((t) => t.id === p.theme)?.bg) ?? undefined) : undefined
	if (p.accent === 'wallpaper' && p.theme === 'omarchy') {
		// The Omarchy desktop's own theme colours, once known (see useOmarchyThemes).
		const c = omarchyColors
		const fill = c?.accent ?? '#7aa2f7'
		root.style.setProperty('--accent', fill)
		root.style.setProperty('--accent-text', fill)
		root.style.setProperty('--on-accent', pickOnAccent(fill, '#111', c?.background ?? '#1a1b26'))
	} else if (p.accent === 'wallpaper' && isChronaraStudio(p.theme)) {
		const a = CHRONARA_STUDIO_ACCENT[p.theme === 'chronara-studio-light' ? 'light' : 'dark']
		root.style.setProperty('--accent', a.fill)
		root.style.setProperty('--accent-text', a.text)
		root.style.setProperty('--on-accent', '#fff')
	} else if (p.accent === 'wallpaper') {
		const source = p.theme === 'custom' ? (p.customBrandHsl ?? brandHsl) : brandHsl
		const [h, s, l] = (source ?? FALLBACK_BRAND).split(' ').map((v) => parseFloat(v))
		root.style.setProperty('--accent', darkenHslForWhite(h, s, l))
		const [r, g, b] = hslToRgb(h, Math.min(s, 95), Math.min(l, 42))
		root.style.setProperty('--accent-text', (light && darkenForTextOn(`rgb(${r}, ${g}, ${b})`, lightBg)) || `hsl(${h} ${Math.min(s, 95)}% ${light ? Math.min(l, 42) : Math.max(l, 66)}%)`)
		root.style.setProperty('--on-accent', '#fff')
	} else {
		const token = `var(--${p.accent})`
		root.style.setProperty('--accent', token)
		const resolved = resolveCssColor(root, token)
		root.style.setProperty('--accent-text', (light && darkenForTextOn(resolved, lightBg)) || token)
		root.style.setProperty('--on-accent', pickOnAccent(resolved, light ? '#fff' : '#111'))
	}
	const meta = document.querySelector('meta[name="theme-color"]')
	meta?.setAttribute('content', THEMES.find((t) => t.id === p.theme)?.bg ?? '#111')
}

// Appearance is cached in the browser for an instant first paint, and saved on the server per
// My Own Data Center account so every device you sign in on gets it. The server counts each save (rev):
// a device takes the server's copy whenever it changed, checking again when it comes back to the
// front (and every 20 s), and unsaved local edits stay pending until a save succeeds so offline
// changes are never reverted by a poll.
export function usePrefs(brandHsl: string | null | undefined, signedIn: boolean) {
	const [prefs, setLocal] = useState<Prefs>(readPrefs)
	const now = useRef(prefs)
	now.current = prefs
	const syncRef = useRef<ReturnType<typeof createPrefsSync<Prefs>> | null>(null)
	if (!syncRef.current) {
		syncRef.current = createPrefsSync<Prefs>({
			storage: typeof localStorage !== 'undefined' ? localStorage : undefined,
			load: loadPrefs,
			save: savePrefs,
			getCurrent: () => now.current,
			onApply: (next) => setLocal(next),
			clean,
		})
	}
	useLayoutEffect(() => {
		applyPrefs(prefs, brandHsl)
		try {
			localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs))
		} catch {
			/* private mode: keep in memory */
		}
	}, [prefs, brandHsl])
	useEffect(() => {
		if (!signedIn) return
		const sync = syncRef.current!
		void sync.pull()
		const onVisible = () => document.visibilityState === 'visible' && void sync.pull()
		const onFocus = () => void sync.pull()
		const onOnline = () => void sync.pull({force: true})
		window.addEventListener('focus', onFocus)
		window.addEventListener('online', onOnline)
		document.addEventListener('visibilitychange', onVisible)
		const timer = window.setInterval(onVisible, 20_000)
		return () => {
			window.removeEventListener('focus', onFocus)
			window.removeEventListener('online', onOnline)
			document.removeEventListener('visibilitychange', onVisible)
			window.clearInterval(timer)
		}
	}, [signedIn])
	const setPrefs = useCallback(
		(next: Prefs | ((current: Prefs) => Prefs)) => {
			const before = now.current
			const resolved = resolvePrefsUpdate(before, next)
			now.current = resolved
			setLocal(resolved)
			if (!signedIn) return
			void syncRef.current?.update(before, resolved)
		},
		[signedIn],
	)
	return [prefs, setPrefs, setLocal] as const
}
function prefsTimeout(ms = 20_000) {
	if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
		return {signal: AbortSignal.timeout(ms), cleanup: () => {}}
	}
	const ac = new AbortController()
	const timer = window.setTimeout(() => ac.abort(), ms)
	return {signal: ac.signal, cleanup: () => window.clearTimeout(timer)}
}
function loadPrefs(): Promise<{prefs?: (Prefs & {rev?: number}) | null} | null> {
	const {signal, cleanup} = prefsTimeout()
	return fetch('/api/prefs', {credentials: 'same-origin', signal})
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null)
		.finally(cleanup)
}
function savePrefs(p: Partial<Prefs>): Promise<(Prefs & {rev?: number}) | null> {
	const body: Record<string, unknown> = {}
	for (const k of SYNCED_PREF_KEYS) if (k in p) body[k] = p[k] ?? null
	const {signal, cleanup} = prefsTimeout()
	return fetch('/api/prefs', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
		body: JSON.stringify(body),
		signal,
	})
		.then((r) => (r.ok ? r.json() : null))
		.then((b) => b?.prefs ?? null)
		.catch(() => null)
		.finally(cleanup)
}

// Resize a photo on the phone (keeps upload small, fixes rotation) and find its dominant colour.
export async function preparePhoto(file: File): Promise<{blob: Blob; hsl: string}> {
	const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'} as ImageBitmapOptions).catch(() => {
		throw new Error('That photo couldn’t be opened. Try a JPEG or PNG.')
	})
	const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height))
	const w = Math.round(bitmap.width * scale)
	const h = Math.round(bitmap.height * scale)
	const canvas = document.createElement('canvas')
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d')!
	ctx.drawImage(bitmap, 0, 0, w, h)
	bitmap.close?.()
	// Average of a small copy, pushed to a usable saturation/lightness for an accent.
	const tiny = document.createElement('canvas')
	tiny.width = tiny.height = 24
	const t = tiny.getContext('2d')!
	t.drawImage(canvas, 0, 0, 24, 24)
	const px = t.getImageData(0, 0, 24, 24).data
	let r = 0, g = 0, b = 0, n = 0
	for (let i = 0; i < px.length; i += 4) {
		const max = Math.max(px[i], px[i + 1], px[i + 2])
		const min = Math.min(px[i], px[i + 1], px[i + 2])
		const weight = 1 + (max - min) / 32 // favour colourful pixels over grey ones
		r += px[i] * weight
		g += px[i + 1] * weight
		b += px[i + 2] * weight
		n += weight
	}
	const [hue, sat] = rgbToHsl(r / n, g / n, b / n)
	const hsl = `${Math.round(hue)} ${Math.round(Math.max(55, sat))}% 52%`
	const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((bl) => (bl ? resolve(bl) : reject(new Error('Couldn’t process the photo'))), 'image/jpeg', 0.86))
	return {blob, hsl}
}
function rgbToHsl(r: number, g: number, b: number) {
	r /= 255
	g /= 255
	b /= 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const l = (max + min) / 2
	if (max === min) return [0, 0, l * 100]
	const d = max - min
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
	return [h * 60, s * 100, l * 100]
}

// ---- backdrop -----------------------------------------------------------------
export const wallpaperUrl = (w?: Wallpaper | null) => (w?.id ? `/api/wallpaper/${w.id}` : null)

export const customBackgroundUrl = (version?: number | null) => (version ? `/api/background?v=${version}` : null)

export function Backdrop({wallpaper, prefs, signedIn = false}: {wallpaper?: Wallpaper | null; prefs: Prefs; signedIn?: boolean}) {
	const [desk] = useDeskConfig()
	const solid = prefs.solidColor || solidOf(desk.wallpaper)
	const wantsOmarchy = desk.wallpaper === 'omarchy' || prefs.theme === 'omarchy' || prefs.theme === 'horizon'
	const desktopBg = useOmarchyThemes(wantsOmarchy).data?.current
	const url =
		desk.wallpaper === 'photo'
			? (customBackgroundUrl(prefs.backgroundVersion) ?? wallpaperUrl(wallpaper))
			: desk.wallpaper === 'server'
				? wallpaperUrl(wallpaper)
				: desk.wallpaper === 'omarchy' || prefs.theme === 'horizon' || prefs.theme === 'omarchy'
					? omarchyBackgroundUrl(prefs.omarchyBackground, desktopBg)
					: prefs.theme === 'custom'
						? (customBackgroundUrl(prefs.backgroundVersion) ?? wallpaperUrl(wallpaper))
						: null
	const [ready, setReady] = useState<string | null>(null)
	const [failed, setFailed] = useState<{url: string; session: boolean} | null>(null)
	useEffect(() => {
		setFailed(null)
		if (!url) return
		let cancel = false
		const img = new Image()
		img.onload = () => {
			if (!cancel) setReady(url)
		}
		img.onerror = () => {
			if (!cancel) setFailed({url, session: signedIn})
		}
		img.src = url
		return () => {
			cancel = true
		}
	}, [url, signedIn])
	const blocked = wallpaperBlocked(failed?.url ?? null, failed?.session ?? false, url, signedIn)
	if (solid) return <div className="backdrop" aria-hidden="true" style={{background: solid}} />
	return (
		<div className="backdrop" aria-hidden="true">
			{url && !blocked ? (
				<>
					<div className={`wall${ready === url ? ' ready' : ''}`} style={{backgroundImage: `url(${url})`}} />
					<div className="shade" />
				</>
			) : (
				<div className="aurora" />
			)}
		</div>
	)
}

export function TerminalIcon({size = 56}: {size?: number}) {
	return (
		<span className="app-icon terminal-icon sys-ico" style={{width: size, height: size, '--tone': 'var(--green)'} as CSSProperties}>
			<svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M5 7l5 5-5 5M12 18h7" />
			</svg>
		</span>
	)
}

// The assistant's icon is its character (Settings → Assistant → Assistant Appearance).
export function AssistantIcon({size = 56}: {size?: number}) {
	return (
		<span className="app-icon assistant-icon sys-ico ac-icon" style={{width: size, height: size} as CSSProperties}>
			<AssistantAvatar size={size} />
		</span>
	)
}

export function StoreIcon({size = 56}: {size?: number}) {
	return (
		<span className="app-icon store-icon sys-ico" style={{width: size, height: size, '--tone': 'var(--blue)'} as CSSProperties}>
			<svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M6.3 8h11.4a1 1 0 0 1 1 1.1l-.9 9.1A2 2 0 0 1 15.8 20H8.2a2 2 0 0 1-2-1.8l-.9-9.1A1 1 0 0 1 6.3 8z" />
				<path d="M9 11V7a3 3 0 0 1 6 0v4" />
			</svg>
		</span>
	)
}

// ---- layout: phone or desktop (detection in layout.ts) ---------------------------------------
// Stored per device (a phone and a PC signed into the same account want different layouts). Each
// device is asked once, at its first sign-in (the welcome setup); Automatic is still there.
//
// Automatic: the desktop on a big enough screen that has a mouse or trackpad anywhere (a touchscreen
// PC or a touch laptop still counts), never on a phone. It changes only on a clear change of size
// (above 1000 px wide to switch to the desktop, below 860 px to switch back), so snapping a window to
// half the screen or a scrollbar appearing doesn't flip it.
export type LayoutPref = 'auto' | 'desktop' | 'phone'
const LAYOUT_KEY = 'omarchy-server:layout'
const ASKED_KEY = 'omarchy-server:layout-asked'
function readLayoutPref(): LayoutPref {
	try {
		const v = localStorage.getItem(LAYOUT_KEY)
		return v === 'desktop' || v === 'phone' ? v : 'auto'
	} catch {
		return 'auto'
	}
}
export function setLayoutPref(p: LayoutPref) {
	try {
		if (p === 'auto') localStorage.removeItem(LAYOUT_KEY)
		else localStorage.setItem(LAYOUT_KEY, p)
		localStorage.setItem(ASKED_KEY, '1')
	} catch {
		/* private mode: applies for this visit only */
	}
	window.dispatchEvent(new CustomEvent('touch:layout', {detail: p}))
}
// Has this device chosen (or been asked) yet? A device that already picked Desktop or Phone counts.
export function layoutAsked(): boolean {
	try {
		return localStorage.getItem(ASKED_KEY) === '1' || localStorage.getItem(LAYOUT_KEY) !== null
	} catch {
		return true
	}
}
export function useLayout(): {desktop: boolean; pref: LayoutPref; detected: boolean} {
	const [pref, setPref] = useState<LayoutPref>(readLayoutPref)
	const [wide, setWide] = useState(() => detectDesktop())
	useEffect(() => {
		const mq = matchMedia(LAYOUT_POINTER)
		const check = () => setWide((was) => detectDesktop(was))
		const onPref = (e: Event) => setPref((e as CustomEvent<LayoutPref>).detail ?? readLayoutPref())
		mq.addEventListener('change', check)
		window.addEventListener('resize', check)
		window.addEventListener('touch:layout', onPref)
		return () => {
			mq.removeEventListener('change', check)
			window.removeEventListener('resize', check)
			window.removeEventListener('touch:layout', onPref)
		}
	}, [])
	return {desktop: pref === 'desktop' || (pref === 'auto' && wide), pref, detected: wide}
}

// The phone page scroller is .shell (or .auth before sign-in). The document itself does not scroll.
function phoneScroller(): HTMLElement | null {
	return document.querySelector<HTMLElement>('.shell, .auth')
}
export function scrollPhoneToTop(behavior: ScrollBehavior = 'auto') {
	phoneScroller()?.scrollTo({top: 0, behavior})
	window.scrollTo({top: 0, behavior})
}

// ---- iOS keyboard viewport repair -------------------------------------------------------------
// After the on-screen keyboard closes, iOS Safari can keep the shrunken viewport, so fixed
// elements (the dock, the backdrop) sit too high and leave a strip at the bottom until the page
// scrolls. A one-pixel scroll and back makes it measure again, even on screens that don't scroll.
// A home-screen web app on iOS has no browser bars to put back. Opening the page's own scrolling and
// scrolling it by a pixel there is what leaves iOS laying the app out short, with an undrawn strip
// under the bottom bar that only reinstalling cleared. So it only runs in the browser.
export const iosHomeScreenApp = () =>
	(/iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
	((navigator as Navigator & {standalone?: boolean}).standalone === true || matchMedia('(display-mode: standalone)').matches)
export function nudgeViewport() {
	if (document.documentElement.classList.contains('desk-mode') || iosHomeScreenApp()) return
	const root = document.documentElement
	const scroller = phoneScroller()
	const yWin = window.scrollY
	const y = scroller?.scrollTop ?? yWin
	const prevMin = root.style.minHeight
	const prevOverflow = root.style.overflow
	const prevPad = scroller?.style.paddingBottom ?? ''
	// html/body overflow:hidden clips a 1px document scroll; open it for one frame so iOS remeasures.
	root.style.minHeight = 'calc(100% + 2px)'
	root.style.overflow = 'auto'
	// Add to the used padding. Replacing it with 2px drops the dock padding and jumps the page.
	if (scroller) scroller.style.paddingBottom = paddingBottomPlus(getComputedStyle(scroller).paddingBottom)
	if (scroller) scroller.scrollTop = y + 1
	window.scrollTo(0, yWin + 1)
	requestAnimationFrame(() => {
		if (scroller) {
			scroller.style.paddingBottom = prevPad
			scroller.scrollTop = y
		}
		window.scrollTo(0, yWin)
		root.style.minHeight = prevMin
		root.style.overflow = prevOverflow
	})
}
// If the page was zoomed in anyway (a pinch, or a field from an older build), put it back at 1×
// when a full-screen view like the assistant closes. Capping the scale for a moment and then
// lifting the cap resets it; pinch-to-zoom works again straight after.
export function resetZoom() {
	const vv = window.visualViewport
	if (!vv || vv.scale <= 1.01) return
	const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
	if (!meta) return
	const content = meta.content
	meta.content = `${content.replace(/,\s*maximum-scale=[^,]*/g, '')}, maximum-scale=1`
	window.setTimeout(() => {
		meta.content = content
	}, 300)
}
let viewportTimers: number[] = []
export function settleViewport() {
	viewportTimers.forEach(window.clearTimeout)
	viewportTimers = [80, 350, 800].map((ms) => window.setTimeout(nudgeViewport, ms))
}
export function watchKeyboardViewport() {
	const vv = window.visualViewport
	if (!vv || !matchMedia('(pointer: coarse)').matches) return
	let wasOpen = false
	vv.addEventListener('resize', () => {
		const open = window.innerHeight - vv.height > 80
		if (wasOpen && !open) settleViewport()
		wasOpen = open
	})
	// Leaving a text field (or closing a screen that had the keyboard up) may not resize at all.
	document.addEventListener('focusout', (e) => {
		const t = e.target as HTMLElement | null
		if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) settleViewport()
	})
}

