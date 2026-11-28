// Desktop customization: wallpaper, desktop theme (chrome style + accent), dock layout and the
// icons on the desktop. Saved on the server for your account, so every browser shows the same desktop.
import {useCallback, useEffect, useState} from 'react'

// 'server' = your My Own Data Center wallpaper (what the phone shows); 'photo' = the photo you uploaded;
// 'omarchy' = an Omarchy desktop background (which one: prefs.omarchyBackground, or the desktop's own).
// 'color:#rrggbb' = a plain colour instead of a picture.
export type WallpaperId = 'server' | 'photo' | 'omarchy' | `color:#${string}`
export const solidOf = (w: string) => (/^color:#[0-9a-f]{6}$/i.test(w) ? w.slice(6).toLowerCase() : null)

export type DeskStyle = 'yaru' | 'glass' | 'graphite' | 'daylight'
export const STYLES: {id: DeskStyle; name: string; note: string}[] = [
	{id: 'yaru', name: 'Yaru', note: 'Ubuntu’s look: solid dark panels'},
	{id: 'glass', name: 'Glass', note: 'Frosted, see-through panels'},
	{id: 'graphite', name: 'Graphite', note: 'Flat and crisp, no blur'},
	{id: 'daylight', name: 'Daylight', note: 'Light top bar, dock and menus'},
]
export type DeskAccent = 'app' | 'wallpaper' | 'blue' | 'mauve' | 'teal' | 'peach' | 'green' | 'pink'
export type DockPos = 'left' | 'bottom' | 'right' | 'top'
export type DockHover = 'none' | 'lift' | 'magnify'
export const DOCK_ICON_MIN = 28
export const DOCK_ICON_MAX = 80
const LEGACY_SIZE: Record<string, number> = {small: 38, medium: 46, large: 56}
export type DeskIcon = {key: string; col: number; row: number}

export type DeskShell = 'gnome' | 'hyprland'
export type DeskConfig = {
	v: 1
	preset: string | null
	wallpaper: WallpaperId
	style: DeskStyle
	accent: DeskAccent
	shell: DeskShell
	// Omarchy Super shortcuts, key capture, and the snippet. Square tiles without this.
	omarchySuperKeys: boolean
	dock: {position: DockPos; iconSize: number; hover: DockHover; magnify: number; bounce: boolean; floating: boolean; autohide: boolean; showRunning: boolean; items: string[]; homeAdded?: boolean}
	icons: DeskIcon[]
	/** Once true, a Home folder shortcut on the desktop stays a folder. The first load turns the old Home folder icon into the Home page. */
	homePageIcon?: boolean
	showIcons: boolean
	// 'auto': a window when the app allows being shown inside one, otherwise a browser tab
	appsOpenIn: 'auto' | 'tab'
}

/** The dock before Home was a window. A saved dock that still matches this, item for item, gains Home once. */
const PREVIOUS_SYSTEM_DOCK = ['files', 'apps', 'store', 'terminal', 'machines', 'system', 'settings'] as const
export const SYSTEM_DOCK = ['home', ...PREVIOUS_SYSTEM_DOCK] as const

/** Terminals can be pinned on the desktop dock/rail. On the phone it opens from System, not the dock. */
export function withTerminals(keys: readonly string[], show: boolean): string[] {
	if (!show || keys.includes('terminals')) return [...keys]
	const next = [...keys]
	const at = next.indexOf('machines')
	next.splice(at < 0 ? next.length : at + 1, 0, 'terminals')
	return next
}

const KEY = 'omarchy-server:desktop-config'

function isDeskIcon(i: unknown): i is DeskIcon {
	return !!i && typeof i === 'object' && typeof (i as DeskIcon).key === 'string' && Number.isInteger((i as DeskIcon).col) && Number.isInteger((i as DeskIcon).row)
}

/** The old desktop Home icon was the home folder, so a double-click opened Files. It becomes the Home page once. */
function desktopIcons(raw: unknown, homePageIcon: boolean): DeskIcon[] {
	const icons = Array.isArray(raw) ? raw.filter(isDeskIcon) : DEFAULT_CONFIG.icons.map((i) => ({...i}))
	if (homePageIcon) return icons
	let seenHome = icons.some((i) => i.key === 'home')
	return icons.flatMap((i) => {
		if (i.key !== 'folder:/Home') return [i]
		if (seenHome) return []
		seenHome = true
		return [{...i, key: 'home'}]
	})
}

export const DEFAULT_CONFIG: DeskConfig = {
	v: 1,
	preset: null,
	wallpaper: 'omarchy',
	style: 'glass',
	accent: 'wallpaper',
	shell: 'gnome',
	omarchySuperKeys: false,
	dock: {position: 'left', iconSize: 46, hover: 'lift', magnify: 1.6, bounce: true, floating: false, autohide: false, showRunning: true, items: [...SYSTEM_DOCK]},
	icons: [
		{key: 'home', col: 0, row: 0},
		{key: 'folder:/Trash', col: 0, row: 1},
	],
	homePageIcon: true,
	showIcons: true,
	appsOpenIn: 'auto',
}

function clean(raw: unknown): DeskConfig {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeskConfig>
	const d = DEFAULT_CONFIG
	const dock = {...d.dock, ...(c.dock ?? {})} as DeskConfig['dock'] & {size?: string}
	const okWall = (w: unknown): w is WallpaperId => w === 'server' || w === 'photo' || w === 'omarchy' || (typeof w === 'string' && !!solidOf(w))
	// Pins from the first desktop release move into the dock.
	let legacyPins: string[] = []
	try {
		legacyPins = JSON.parse(localStorage.getItem('omarchy-server:desktop-pins') ?? '[]').map((id: string) => `app:${id}`)
	} catch {
		/* none */
	}
	const items = Array.isArray(dock.items) ? dock.items.filter((k) => typeof k === 'string') : d.dock.items
	// Only a dock saved before Home existed gets it, and only once: clean() runs on every change, so without
	// the homeAdded mark a dock the owner trimmed back to these seven would get Home again each time.
	const previousDefault = c.dock?.homeAdded !== true && items.length === PREVIOUS_SYSTEM_DOCK.length && PREVIOUS_SYSTEM_DOCK.every((key, index) => items[index] === key)
	const dockItems = previousDefault ? ['home', ...items] : items
	return {
		v: 1,
		preset: typeof c.preset === 'string' ? c.preset : null,
		wallpaper: okWall(c.wallpaper) ? c.wallpaper : d.wallpaper,
		style: STYLES.some((s) => s.id === c.style) ? (c.style as DeskStyle) : d.style,
		shell: c.shell === 'hyprland' ? 'hyprland' : 'gnome',
		omarchySuperKeys: c.omarchySuperKeys === true,
		accent: (['app', 'wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink'] as const).includes(c.accent as DeskAccent) ? (c.accent as DeskAccent) : d.accent,
		dock: {
			position: (['left', 'bottom', 'right', 'top'] as const).includes(dock.position) ? dock.position : 'left',
			// Earlier versions had three sizes; they carry over.
			iconSize: Math.round(Math.min(DOCK_ICON_MAX, Math.max(DOCK_ICON_MIN, Number.isFinite(c.dock?.iconSize) ? Number(c.dock!.iconSize) : (LEGACY_SIZE[dock.size ?? ''] ?? 46)))),
			hover: (['none', 'lift', 'magnify'] as const).includes(dock.hover) ? dock.hover : 'lift',
			magnify: Math.min(2.2, Math.max(1.2, Number.isFinite(dock.magnify) ? Number(dock.magnify) : 1.6)),
			bounce: dock.bounce !== false,
			floating: !!dock.floating,
			autohide: !!dock.autohide,
			showRunning: dock.showRunning !== false,
			items: [...new Set([...dockItems, ...(c.dock ? [] : legacyPins)])],
			homeAdded: true,
		},
		icons: desktopIcons(c.icons, c.homePageIcon === true),
		homePageIcon: true,
		showIcons: c.showIcons !== false,
		appsOpenIn: c.appsOpenIn === 'tab' ? 'tab' : 'auto',
	}
}

export function loadConfig(): DeskConfig {
	try {
		const raw = localStorage.getItem(KEY)
		return clean(raw ? JSON.parse(raw) : null)
	} catch {
		return DEFAULT_CONFIG
	}
}

// One shared, live config for the whole desktop (dock, icons and the settings window). It's kept
// in this browser for an instant start and saved on the server for your account, so every browser
// you sign in on gets the same desktop. The server counts each save (rev), so a browser knows it
// has the latest without trusting its own clock: it takes the server's copy unless it has changes
// of its own not saved yet, and checks again when it comes back to the front (and every 20 s).
let current: DeskConfig | null = null
const listeners = new Set<(c: DeskConfig) => void>()
const REV_KEY = `${KEY}:rev`
const DIRTY_KEY = `${KEY}:dirty`
const stored = (k: string) => {
	try {
		return localStorage.getItem(k)
	} catch {
		return null
	}
}
const store = (k: string, v: string | null) => {
	try {
		if (v === null) localStorage.removeItem(k)
		else localStorage.setItem(k, v)
	} catch {
		/* private mode: this visit only */
	}
}
const knownRev = () => Number(stored(REV_KEY)) || 0
const keepLocal = (c: DeskConfig) => store(KEY, JSON.stringify(c))
// The revision this tab itself last loaded or saved; shared localStorage rev moves when another tab writes.
let appliedRev = stored(KEY) !== null ? knownRev() : 0
// Changes made here that the server doesn't have yet (counted, so a save that was already on its way
// doesn't clear a change made after it left).
let edits = stored(DIRTY_KEY) ? 1 : 0
let pushTimer: number | undefined
// Sign-out bumps this. A save or load already in flight captured the old value and must not
// write this browser once the next account is in the same tab.
let epoch = 0
function push() {
	window.clearTimeout(pushTimer)
	pushTimer = window.setTimeout(async () => {
		const mine = epoch
		if (!current || mine !== epoch) return
		const sent = edits
		const config = current
		try {
			const r = await fetch('/api/desktop', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
				body: JSON.stringify({config}),
			})
			if (mine !== epoch || !r.ok) return
			const saved = (await r.json())?.desktop as {rev?: number} | null
			if (mine !== epoch) return
			if (saved?.rev) {
				appliedRev = Number(saved.rev) || appliedRev
				store(REV_KEY, String(saved.rev))
			}
			if (edits === sent) (edits = 0), store(DIRTY_KEY, null)
		} catch {
			/* offline: saved next time */
		}
	}, 600)
}
let lastPull = 0
let syncing = false
// A pull asked for while one is already running. Sign-out must not start a pull of its
// own: that request is signed out, and stamping lastPull there blocks the next account.
let pullAgain = false
async function pull() {
	if (syncing) {
		pullAgain = true
		return
	}
	if (Date.now() - lastPull < 3000) return
	const mine = epoch
	syncing = true
	try {
		const r = await fetch('/api/desktop', {credentials: 'same-origin'})
		// A 401, or a pull sign-out invalidated, must leave lastPull unset. resetDeskConfig
		// already zeroes it; setting it here makes the next account's sync wait 3 seconds.
		if (mine !== epoch || !r.ok) return
		const saved = (await r.json())?.desktop as {config: unknown; rev?: number; updatedAt?: number} | null
		if (mine !== epoch) return
		lastPull = Date.now()
		const rev = saved ? Number(saved.rev) || 1 : 0
		if (edits) {
			// This browser has the newest changes: save them for the others.
			current ??= loadConfig()
			push()
		} else if (saved && rev !== appliedRev) {
			current = clean(saved.config)
			appliedRev = rev
			keepLocal(current)
			store(REV_KEY, String(rev))
			listeners.forEach((l) => l(current!))
		} else if (!saved) {
			// Nothing saved for this account yet: this browser's desktop becomes the saved one.
			current ??= loadConfig()
			push()
		}
	} catch {
		/* offline: this browser's copy stays */
	} finally {
		syncing = false
		// One follow-up for a pull that arrived while this one was running. Not because
		// the epoch changed: that started a signed-out pull which stamped lastPull.
		if (pullAgain) {
			pullAgain = false
			void pull()
		}
	}
}
function clearTabState() {
	epoch++
	window.clearTimeout(pushTimer)
	pushTimer = undefined
	current = null
	appliedRev = 0
	edits = 0
	lastPull = 0
	pullAgain = false
	listeners.forEach((l) => l(DEFAULT_CONFIG))
}
function onStorage(e: StorageEvent) {
	try {
		if (e.storageArea && e.storageArea !== localStorage) return
	} catch {
		return
	}
	if (e.key !== KEY && e.key !== REV_KEY && e.key !== null) return
	if (e.key === null || (e.key === KEY && e.newValue === null)) {
		clearTabState()
		return
	}
	if (edits) return
	const raw = stored(KEY)
	if (raw === null) return
	try {
		current = clean(JSON.parse(raw))
	} catch {
		return
	}
	appliedRev = knownRev()
	listeners.forEach((l) => l(current!))
}
let started = false
export function syncDeskConfig() {
	if (!started) {
		started = true
		// Saved by an earlier version, which went by each browser's clock: take the server's copy.
		store(`${KEY}:at`, null)
		window.addEventListener('focus', () => pull())
		window.addEventListener('storage', onStorage)
		document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pull())
		window.setInterval(() => document.visibilityState === 'visible' && pull(), 20_000)
	}
	pull()
}
export function resetDeskConfig() {
	store(KEY, null)
	store(REV_KEY, null)
	store(DIRTY_KEY, null)
	clearTabState()
}
export function patchDeskConfig(patch: Partial<DeskConfig>) {
	current = clean({...(current ?? loadConfig()), ...patch})
	keepLocal(current)
	edits++
	store(DIRTY_KEY, '1')
	listeners.forEach((l) => l(current!))
	push()
}

export function useDeskConfig() {
	const [cfg, setCfg] = useState<DeskConfig>(() => (current ??= loadConfig()))
	if (typeof document !== 'undefined') document.documentElement.dataset.shape = cfg.shell === 'hyprland' ? 'square' : 'round'
	useEffect(() => {
		listeners.add(setCfg)
		syncDeskConfig()
		return () => void listeners.delete(setCfg)
	}, [])
	const update = useCallback((fn: (c: DeskConfig) => DeskConfig) => {
		patchDeskConfig(fn(current ?? loadConfig()))
	}, [])
	return [cfg, update] as const
}
