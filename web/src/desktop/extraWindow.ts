// A second terminal shares one shell (keyed by user and app, not by window), so it is focused.
// Files has no such share, so New window still opens another Files window.
export function extraWindowAction(kind: string, alreadyOpen: boolean): 'focus' | 'open' {
	if (kind === 'terminal' && alreadyOpen) return 'focus'
	return 'open'
}

type ShellWindow = {kind: string; payload?: {term?: {id: string} | null}}

// A Terminal window shows one shell: the server's own, or the one inside a single app. A window
// can stand in for a new Terminal only when it is on the same shell.
export function sameShellWindows<T extends ShellWindow>(wins: readonly T[], term?: {id: string} | null): T[] {
	return wins.filter((w) => w.kind === 'terminal' && (w.payload?.term?.id ?? '') === (term?.id ?? ''))
}
