// Where an account toast opens. The phone follows the hash. The desktop opens a window.

export const OPEN_TOAST_PLACE = 'omarchy:open-toast-place'

const DESK: Record<string, string> = {
	home: 'home',
	apps: 'apps',
	files: 'files',
	machines: 'machines',
	more: 'system',
	system: 'system',
	settings: 'settings',
	store: 'store',
	clips: 'clips',
	personalize: 'personalize',
	assistant: 'assistant',
	terminal: 'terminal',
}

export function toastDeskKind(href: string): string | null {
	if (!href.startsWith('#/')) return null
	const id = href.slice(2).split(/[?#]/)[0]
	return DESK[id] ?? null
}

export function openToastPlace(href: string) {
	if (!toastDeskKind(href)) return
	if (typeof document !== 'undefined' && document.documentElement.classList.contains('desk-mode')) {
		window.dispatchEvent(new CustomEvent(OPEN_TOAST_PLACE, {detail: href}))
		return
	}
	if (location.hash !== href) location.hash = href
}
