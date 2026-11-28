// The browser tab and history title for each phone screen (WCAG 2.4.2: a title that names the screen).
export const APP_TITLE = 'My Own Data Center'

const SCREEN_NAMES: Record<string, string> = {
	home: 'Home',
	apps: 'Apps',
	files: 'Files',
	machines: 'Machines',
	terminals: 'Terminals',
	more: 'System',
	settings: 'Settings',
	store: 'App Store',
	clips: 'Clip book',
}

/** "Files - My Own Data Center" for a known screen, and the plain app name for anything else. */
export function pageTitle(screen: string): string {
	const name = SCREEN_NAMES[screen]
	return name ? `${name} - ${APP_TITLE}` : APP_TITLE
}
