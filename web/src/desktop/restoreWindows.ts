// Windows are saved in this browser and read back on the next visit. Whatever is stored there can be
// out of date or damaged (a newer build's window kind, a half-written value, another tool's edit),
// and a window the desktop cannot draw would crash it again on every load. Keep only windows that
// can be drawn. Terminals, machine screens and Linux app windows are never restored.
const RESTORABLE_KINDS = new Set(['home', 'files', 'apps', 'store', 'machines', 'system', 'settings', 'personalize', 'assistant', 'clips', 'app'])

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

export function restoreWindows<T extends {id: string; kind: string}>(saved: unknown): T[] {
	if (!Array.isArray(saved)) return []
	return saved.filter((w): w is T => {
		if (!w || typeof w !== 'object') return false
		const x = w as Record<string, unknown>
		if (typeof x.id !== 'string' || typeof x.key !== 'string' || typeof x.kind !== 'string' || !RESTORABLE_KINDS.has(x.kind)) return false
		if (!finite(x.x) || !finite(x.y) || !finite(x.w) || !finite(x.h) || !finite(x.z)) return false
		return x.payload === undefined || (typeof x.payload === 'object' && x.payload !== null)
	})
}
