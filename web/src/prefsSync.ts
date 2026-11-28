export const SYNCED_PREF_KEYS = ['theme', 'darkTheme', 'lightTheme', 'pictureTheme', 'accent', 'customBrandHsl', 'omarchyBackground', 'solidColor', 'assistantLook', 'statView', 'machinesCompact', 'statPicks', 'tempPicks', 'tempUnit', 'dismissedTutorials'] as const
export const PREFS_REV_KEY = 'omarchy-server:prefs:rev'
export const PREFS_DIRTY_KEY = 'omarchy-server:prefs:dirty'

export type PrefsStorage = {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem?(key: string): void
}

export type SavedPrefs<T> = T & {rev?: number}

export function diffPrefsPatch<T extends Record<string, unknown>>(before: T, next: T): Partial<T> {
	const patch: Record<string, unknown> = {}
	for (const k of SYNCED_PREF_KEYS) {
		if (JSON.stringify(next[k] ?? null) !== JSON.stringify(before[k] ?? null)) {
			patch[k] = next[k] ?? null
		}
	}
	return patch as Partial<T>
}

export function createPrefsSync<T extends Record<string, unknown>>({
	storage,
	load,
	save,
	getCurrent,
	onApply,
	clean,
	now = Date.now,
	minPullGapMs = 3000,
}: {
	storage?: PrefsStorage | null
	load: () => Promise<{prefs?: SavedPrefs<T> | null} | null>
	save: (patch: Partial<T>) => Promise<SavedPrefs<T> | null>
	getCurrent: () => T
	onApply: (prefs: T) => void
	clean: (raw: SavedPrefs<T> | Partial<T> | null | undefined) => T
	now?: () => number
	minPullGapMs?: number
}) {
	const pending = new Map<string, {value: unknown; seq: number}>()
	let seq = 0
	let lastAttemptSeq = 0
	let saving = 0
	let lastPull = 0
	let inFlight: Promise<boolean> | null = null

	try {
		const raw = storage?.getItem(PREFS_DIRTY_KEY)
		if (raw) {
			const parsed = JSON.parse(raw) as unknown
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const k of SYNCED_PREF_KEYS) {
					if (Object.hasOwn(parsed, k)) {
						pending.set(k, {value: (parsed as Record<string, unknown>)[k] ?? null, seq: ++seq})
					}
				}
			}
		}
	} catch {
		/* ignore malformed dirty record */
	}

	function persistDirty() {
		if (!storage) return
		try {
			if (pending.size === 0) {
				if (storage.removeItem) storage.removeItem(PREFS_DIRTY_KEY)
				else storage.setItem(PREFS_DIRTY_KEY, '')
				return
			}
			const out: Record<string, unknown> = {}
			for (const [k, entry] of pending) out[k] = entry.value
			storage.setItem(PREFS_DIRTY_KEY, JSON.stringify(out))
		} catch {
			/* private mode */
		}
	}

	function readRev(): number {
		try {
			return Number(storage?.getItem(PREFS_REV_KEY)) || 0
		} catch {
			return 0
		}
	}

	function keepRev(rev: unknown) {
		try {
			if (Number(rev)) storage?.setItem(PREFS_REV_KEY, String(rev))
		} catch {}
	}

	function record(patch: Record<string, unknown>) {
		const nextSeq = ++seq
		for (const k of SYNCED_PREF_KEYS) {
			if (Object.hasOwn(patch, k)) {
				pending.set(k, {value: patch[k] ?? null, seq: nextSeq})
			}
		}
		persistDirty()
	}

	async function runFlushOnce(): Promise<boolean> {
		if (pending.size === 0) return true
		lastAttemptSeq = seq
		const patch: Record<string, unknown> = {}
		const sentSeqs = new Map<string, number>()
		let sentMaxSeq = 0
		for (const [k, entry] of pending) {
			patch[k] = entry.value
			sentSeqs.set(k, entry.seq)
			if (entry.seq > sentMaxSeq) sentMaxSeq = entry.seq
		}
		saving++
		try {
			const saved = await save(patch as Partial<T>)
			if (!saved) return false
			for (const [k, s] of sentSeqs) {
				if (pending.get(k)?.seq === s) pending.delete(k)
			}
			persistDirty()
			if (sentMaxSeq === seq) {
				keepRev(saved.rev)
				if (pending.size === 0) {
					const cleaned = clean(saved)
					if (JSON.stringify(cleaned) !== JSON.stringify(getCurrent())) onApply(cleaned)
				}
			}
			return true
		} finally {
			saving--
		}
	}

	async function flush(): Promise<boolean> {
		if (inFlight) {
			const ok = await inFlight
			if (pending.size === 0) return ok
			if (!ok && seq <= lastAttemptSeq) return false
			return flush()
		}
		let self: Promise<boolean> | null = null
		self = (async () => {
			try {
				while (pending.size > 0) {
					if (!(await runFlushOnce())) return false
				}
				return true
			} finally {
				if (inFlight === self) inFlight = null
			}
		})()
		inFlight = self
		return self
	}

	async function update(before: T, next: T): Promise<boolean> {
		const patch = diffPrefsPatch(before, next)
		if (!Object.keys(patch).length) return true
		record(patch)
		return flush()
	}

	async function pull({force = false}: {force?: boolean} = {}): Promise<void> {
		if (saving > 0) return
		const t = now()
		if (!force && lastPull > 0 && t - lastPull < minPullGapMs) return
		lastPull = t
		if (pending.size > 0) {
			await flush()
			return
		}
		const seqAtStart = seq
		const body = await load()
		if (saving > 0 || pending.size > 0 || seq !== seqAtStart || !body) return
		if (body.prefs) {
			if (Number(body.prefs.rev) !== readRev() || JSON.stringify(clean(body.prefs)) !== JSON.stringify(getCurrent())) {
				onApply(clean(body.prefs))
				keepRev(body.prefs.rev)
			}
		} else {
			const current = getCurrent()
			const initial: Record<string, unknown> = {}
			for (const k of SYNCED_PREF_KEYS) initial[k] = current[k] ?? null
			record(initial)
			await flush()
		}
	}

	return {
		update,
		pull,
		flush,
		hasPending: () => pending.size > 0,
	}
}
