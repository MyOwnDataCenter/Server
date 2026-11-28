export const OTHER_CATEGORY = 'other'

/** Official / built-in store labels that should read as one product name in the UI. */
const STORE_NAME_ALIASES = new Set(['modc', 'my own data center', 'myowndatacenter'])

/** One human label for store chips and “From …” lines (collapses MODC / Modc / My Own Data Center). */
export function storeDisplayName(name: string | undefined | null) {
	const raw = (name ?? '').trim()
	if (!raw) return 'App store'
	const key = raw.toLowerCase().replace(/[\s_-]+/g, ' ').trim()
	const compact = key.replace(/\s+/g, '')
	if (STORE_NAME_ALIASES.has(key) || STORE_NAME_ALIASES.has(compact)) return 'My Own Data Center'
	return raw
}

/** Browse/detail trust hints from catalog fields available before install. */
export function storeRiskHints(app: {oidc?: {supported?: boolean} | null; caution?: string | null; permissions?: readonly string[] | null}) {
	const hints: string[] = []
	if (app.oidc?.supported) hints.push('Sign-in shared')
	const perms = app.permissions ?? []
	if (perms.length > 0 || (typeof app.caution === 'string' && app.caution.trim())) hints.push('Needs extra access')
	return hints
}

export function searchNeedle(q: string) {
	return q.trim().toLowerCase()
}

export function joinedFields(parts: Array<string | undefined | null>) {
	return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

export function categoryOf(category?: string | null) {
	return category ? category : OTHER_CATEGORY
}

export function rankedCategories(apps: {category?: string | null}[]) {
	const counts = new Map<string, number>()
	for (const a of apps) {
		const c = categoryOf(a.category)
		counts.set(c, (counts.get(c) ?? 0) + 1)
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
}

export function effectiveCategory(selected: string, categories: string[], extras: string[] = []) {
	if (selected === 'all' || extras.includes(selected) || categories.includes(selected)) return selected
	return 'all'
}

export function validCommunityStoreUrl(url: string) {
	return /^https:\/\/[\w.-]+(:\d+)?\/[\w.\-~/]+$/.test(url.trim())
}

export function appVersionLine(app: {version?: string; port?: number}, nextVersion?: string) {
	if (nextVersion) return `${app.version ?? '–'} → ${nextVersion}`
	const version = app.version ? `Version ${app.version}` : '–'
	return `${version}${app.port ? ` · port ${app.port}` : ''}`
}

// lastShown starts at 0 so the first probe (0s) does not toast, and later ones wait a full 10s.
export function nextStartingToast(sec: number, lastShown: number) {
	if (sec === 0 || sec - lastShown < 10) return {show: false, lastShown}
	return {show: true, lastShown: sec}
}
