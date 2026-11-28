export type Axis = 'h' | 'v'
export type Dir = 'left' | 'right' | 'up' | 'down'
export type Rect = {x: number; y: number; w: number; h: number}
export type Node = {kind: 'leaf'; id: string} | {kind: 'split'; axis: Axis; ratio: number; a: Node; b: Node}

export const GAP = 8
export const MIN_PANE = 120
export const DIVIDER_HIT = 16

export type Path = Array<'a' | 'b'>
export type Divider = {
	axis: Axis
	rect: Rect
	hit: Rect
	path: Path
	ratio: number
	minRatio: number
	maxRatio: number
	parent: Rect
}

function hitOf(gap: Rect, axis: Axis, hit = DIVIDER_HIT): Rect {
	const extra = Math.max(0, hit - (axis === 'h' ? gap.w : gap.h))
	if (axis === 'h') return {x: gap.x - extra / 2, y: gap.y, w: gap.w + extra, h: gap.h}
	return {x: gap.x, y: gap.y - extra / 2, w: gap.w, h: gap.h + extra}
}

export function dividers(tree: Node | null, area: Rect, gap = GAP, minPane = MIN_PANE, skip?: Iterable<string>): Divider[] {
	const hidden = skip ? (skip instanceof Set ? skip : new Set(skip)) : new Set<string>()
	const out: Divider[] = []
	const walk = (n: Node, r: Rect, path: Path) => {
		if (n.kind === 'leaf') return
		const shownA = collapse(n.a, hidden)
		const shownB = collapse(n.b, hidden)
		if (shownA && shownB) {
			const avail = Math.max(0, n.axis === 'h' ? r.w - gap : r.h - gap)
			const first = Math.round(avail * n.ratio)
			const tight = avail < minPane * 2
			const minRatio = tight ? n.ratio : minPane / avail
			const maxRatio = tight ? n.ratio : 1 - minPane / avail
			const rect =
				n.axis === 'h' ? {x: r.x + first, y: r.y, w: gap, h: r.h} : {x: r.x, y: r.y + first, w: r.w, h: gap}
			out.push({axis: n.axis, rect, hit: hitOf(rect, n.axis), path, ratio: n.ratio, minRatio, maxRatio, parent: r})
			if (n.axis === 'h') {
				walk(n.a, {x: r.x, y: r.y, w: first, h: r.h}, [...path, 'a'])
				walk(n.b, {x: r.x + first + gap, y: r.y, w: r.w - first - gap, h: r.h}, [...path, 'b'])
			} else {
				walk(n.a, {x: r.x, y: r.y, w: r.w, h: first}, [...path, 'a'])
				walk(n.b, {x: r.x, y: r.y + first + gap, w: r.w, h: r.h - first - gap}, [...path, 'b'])
			}
		} else if (shownA) {
			walk(n.a, r, [...path, 'a'])
		} else if (shownB) {
			walk(n.b, r, [...path, 'b'])
		}
	}
	if (tree) walk(tree, area, [])
	return out
}

export function setRatio(tree: Node | null, path: Path, ratio: number): Node | null {
	if (!tree) return null
	const next = Math.min(1, Math.max(0, ratio))
	const apply = (n: Node, p: Path): Node => {
		if (n.kind === 'leaf') return n
		if (!p.length) return n.ratio === next ? n : {...n, ratio: next}
		const rest = p.slice(1)
		if (p[0] === 'a') {
			const a = apply(n.a, rest)
			return a === n.a ? n : {...n, a}
		}
		const b = apply(n.b, rest)
		return b === n.b ? n : {...n, b}
	}
	return apply(tree, path)
}

export function ratioAt(d: Divider, x: number, y: number): number {
	const avail = Math.max(0, d.axis === 'h' ? d.parent.w - d.rect.w : d.parent.h - d.rect.h)
	if (avail <= 0) return d.ratio
	const along = d.axis === 'h' ? x - d.parent.x : y - d.parent.y
	return Math.min(d.maxRatio, Math.max(d.minRatio, along / avail))
}

export function hitDivider(list: Divider[], x: number, y: number): Divider | null {
	for (let i = list.length - 1; i >= 0; i--) {
		const r = list[i].hit
		if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return list[i]
	}
	return null
}

export function rects(tree: Node | null, area: Rect, gap = GAP): Record<string, Rect> {
	const out: Record<string, Rect> = {}
	if (!tree) return out
	const walk = (n: Node, r: Rect) => {
		if (n.kind === 'leaf') {
			out[n.id] = r
			return
		}
		if (n.axis === 'h') {
			const avail = Math.max(0, r.w - gap)
			const aw = Math.round(avail * n.ratio)
			walk(n.a, {x: r.x, y: r.y, w: aw, h: r.h})
			walk(n.b, {x: r.x + aw + gap, y: r.y, w: r.w - aw - gap, h: r.h})
		} else {
			const avail = Math.max(0, r.h - gap)
			const ah = Math.round(avail * n.ratio)
			walk(n.a, {x: r.x, y: r.y, w: r.w, h: ah})
			walk(n.b, {x: r.x, y: r.y + ah + gap, w: r.w, h: r.h - ah - gap})
		}
	}
	walk(tree, area)
	return out
}

export function firstLeaf(tree: Node | null): string | null {
	if (!tree) return null
	return tree.kind === 'leaf' ? tree.id : firstLeaf(tree.a)
}

export function contains(tree: Node | null, id: string): boolean {
	if (!tree) return false
	return tree.kind === 'leaf' ? tree.id === id : contains(tree.a, id) || contains(tree.b, id)
}

export function collapse(tree: Node | null, skip: Iterable<string>): Node | null {
	const hidden = skip instanceof Set ? skip : new Set(skip)
	if (!tree || !hidden.size) return tree
	if (tree.kind === 'leaf') return hidden.has(tree.id) ? null : tree
	const a = collapse(tree.a, hidden)
	const b = collapse(tree.b, hidden)
	if (!a) return b
	if (!b) return a
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function insert(tree: Node | null, focusedId: string | null, newId: string, area: Rect, gap = GAP, skip?: Iterable<string>): Node {
	if (!tree) return {kind: 'leaf', id: newId}
	const hidden = skip ? (skip instanceof Set ? skip : new Set(skip)) : new Set<string>()
	const shown = collapse(tree, hidden)
	if (!shown) {
		const axis: Axis = area.w >= area.h ? 'h' : 'v'
		return {kind: 'split', axis, ratio: 0.5, a: tree, b: {kind: 'leaf', id: newId}}
	}
	const target = focusedId && contains(shown, focusedId) ? focusedId : firstLeaf(shown)!
	const r = rects(shown, area, gap)[target]
	const axis: Axis = !r || r.w >= r.h ? 'h' : 'v'
	return replaceLeaf(tree, target, {
		kind: 'split',
		axis,
		ratio: 0.5,
		a: {kind: 'leaf', id: target},
		b: {kind: 'leaf', id: newId},
	})
}

export function remove(tree: Node | null, id: string): Node | null {
	if (!tree) return null
	if (tree.kind === 'leaf') return tree.id === id ? null : tree
	const a = remove(tree.a, id)
	const b = remove(tree.b, id)
	if (a === null) return b
	if (b === null) return a
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function flipSplit(tree: Node | null, focusedId: string): Node | null {
	if (!tree) return null
	if (tree.kind === 'leaf') return tree
	if ((tree.a.kind === 'leaf' && tree.a.id === focusedId) || (tree.b.kind === 'leaf' && tree.b.id === focusedId)) {
		return {...tree, axis: tree.axis === 'h' ? 'v' : 'h'}
	}
	const a = flipSplit(tree.a, focusedId)!
	const b = flipSplit(tree.b, focusedId)!
	if (a === tree.a && b === tree.b) return tree
	return {...tree, a, b}
}

export function focusDir(tree: Node | null, focusedId: string, dir: Dir, area: Rect, gap = GAP, skip?: Iterable<string>): string {
	tree = skip ? collapse(tree, skip) : tree
	if (!tree) return focusedId
	const all = rects(tree, area, gap)
	const src = all[focusedId]
	if (!src) return focusedId
	const scx = src.x + src.w / 2
	const scy = src.y + src.h / 2
	const sideways = dir === 'left' || dir === 'right'
	const positive = dir === 'right' || dir === 'down'
	const pick = (accept: (r: Rect, along: number, across: number) => boolean): string | null => {
		let best: string | null = null
		let bestD = Infinity
		for (const [id, r] of Object.entries(all)) {
			if (id === focusedId) continue
			const dx = r.x + r.w / 2 - scx
			const dy = r.y + r.h / 2 - scy
			const along = sideways ? dx : dy
			const across = sideways ? dy : dx
			if (positive ? along <= 0 : along >= 0) continue
			if (!accept(r, along, across)) continue
			const d = dx * dx + dy * dy
			if (d < bestD) {
				bestD = d
				best = id
			}
		}
		return best
	}
	// A window that sits that way and shares a stretch of this window's edge is the neighbour. Judging by
	// centres alone sent Right from a lower window to the wide one above it on a wide screen, and gave no
	// neighbour at all for Up and Down between a wide window and two narrow ones.
	const beside = pick((r) => (sideways ? Math.min(src.y + src.h, r.y + r.h) - Math.max(src.y, r.y) : Math.min(src.x + src.w, r.x + r.w) - Math.max(src.x, r.x)) > 0)
	return beside ?? pick((_r, along, across) => Math.abs(along) >= Math.abs(across)) ?? focusedId
}

export function swapIds(tree: Node | null, a: string, b: string): Node | null {
	if (!tree || a === b) return tree
	if (tree.kind === 'leaf') {
		if (tree.id === a) return {kind: 'leaf', id: b}
		if (tree.id === b) return {kind: 'leaf', id: a}
		return tree
	}
	return {...tree, a: swapIds(tree.a, a, b)!, b: swapIds(tree.b, a, b)!}
}

export function swapDir(tree: Node | null, focusedId: string, dir: Dir, area: Rect, gap = GAP, skip?: Iterable<string>): Node | null {
	const other = focusDir(tree, focusedId, dir, area, gap, skip)
	return swapIds(tree, focusedId, other)
}

export function rebuild(ids: string[], area: Rect, gap = GAP): Node | null {
	let tree: Node | null = null
	let last: string | null = null
	for (const id of ids) {
		tree = insert(tree, last, id, area, gap)
		last = id
	}
	return tree
}

export function isNode(n: unknown): n is Node {
	if (!n || typeof n !== 'object') return false
	const x = n as Record<string, unknown>
	if (x.kind === 'leaf') return typeof x.id === 'string'
	if (x.kind === 'split') return (x.axis === 'h' || x.axis === 'v') && typeof x.ratio === 'number' && isNode(x.a) && isNode(x.b)
	return false
}

export function leafIds(tree: Node | null): string[] {
	if (!tree) return []
	return tree.kind === 'leaf' ? [tree.id] : [...leafIds(tree.a), ...leafIds(tree.b)]
}

export function reconcile(tree: unknown, ids: string[], area: Rect, gap = GAP): Node | null {
	if (!ids.length) return null
	const valid = isNode(tree) ? tree : null
	if (!valid) return rebuild(ids, area, gap)
	const have = new Set(leafIds(valid))
	if (have.size === ids.length && ids.every((id) => have.has(id))) return valid
	let next: Node | null = valid
	for (const id of have) {
		if (!ids.includes(id)) next = remove(next, id)
	}
	let last = firstLeaf(next)
	for (const id of ids) {
		if (!contains(next, id)) {
			next = insert(next, last, id, area, gap)
			last = id
		}
	}
	return next
}

export function moveWorkspace(
	trees: Record<number, Node | null>,
	id: string,
	fromWs: number,
	toWs: number,
	opts: {floating?: boolean; targetFocusId?: string | null; area: Rect; gap?: number; hidden?: Iterable<string>},
): Record<number, Node | null> {
	if (fromWs === toWs) return trees
	const next: Record<number, Node | null> = {...trees}
	for (const k of Object.keys(next)) {
		const n = Number(k)
		next[n] = remove(next[n] ?? null, id)
	}
	if (!opts.floating) {
		const targetTree = next[toWs] ?? null
		next[toWs] = insert(targetTree, opts.targetFocusId ?? firstLeaf(targetTree), id, opts.area, opts.gap ?? GAP, opts.hidden)
	}
	return next
}

function replaceLeaf(tree: Node, id: string, next: Node): Node {
	if (tree.kind === 'leaf') return tree.id === id ? next : tree
	return {...tree, a: replaceLeaf(tree.a, id, next), b: replaceLeaf(tree.b, id, next)}
}
