// WCAG contrast helpers for choosing a legible foreground (--on-accent) over resolved accent fills.
export type Rgb = [number, number, number]

export function parseRgbColor(css: string | null | undefined): Rgb | null {
	if (!css) return null
	const s = css.trim().toLowerCase()
	const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
	if (hex) {
		const h = hex[1]
		if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
	}
	if (s.startsWith('color(')) {
		const clean = s.replace(/color\([^)\s]+/, '')
		const m = clean.match(/[\d.]+/g)
		if (!m || m.length < 3) return null
		return [Math.round(parseFloat(m[0]) * 255), Math.round(parseFloat(m[1]) * 255), Math.round(parseFloat(m[2]) * 255)]
	}
	if (s.startsWith('rgb')) {
		const m = s.match(/[\d.]+/g)
		if (!m || m.length < 3) return null
		return [Math.round(parseFloat(m[0])), Math.round(parseFloat(m[1])), Math.round(parseFloat(m[2]))]
	}
	return null
}

function relativeLuminance([r, g, b]: Rgb): number {
	const lin = (c: number) => {
		const v = Math.max(0, Math.min(255, c)) / 255
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a)
	const lb = relativeLuminance(b)
	const hi = Math.max(la, lb)
	const lo = Math.min(la, lb)
	return (hi + 0.05) / (lo + 0.05)
}

// color-mix(in srgb, a pctA%, b) for opaque colours.
export function mixRgb(a: Rgb, b: Rgb, pctA: number): Rgb {
	const t = Math.max(0, Math.min(100, pctA)) / 100
	return [0, 1, 2].map((i) => Math.round(a[i] * t + b[i] * (1 - t))) as Rgb
}

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/**
 * The Omarchy theme's secondary text colour, nudged toward the foreground only as far as needed so hints and
 * timestamps reach 4.5:1 on the page and on a raised panel (the foreground at 8% over the page).
 * Returns null when a colour cannot be read, so the caller keeps its own mix.
 */
export function legibleMuted(bg: string, fg: string, brightBlack?: string | null, minRatio = 4.5): string | null {
	const bgc = parseRgbColor(bg)
	const fgc = parseRgbColor(fg)
	if (!bgc || !fgc) return null
	const dim = brightBlack && brightBlack !== bg ? parseRgbColor(brightBlack) : null
	const base = dim ? mixRgb(dim, fgc, 55) : mixRgb(fgc, bgc, 62)
	const panel = mixRgb(fgc, bgc, 8)
	for (let towardFg = 0; towardFg <= 100; towardFg += 2) {
		const cand = mixRgb(fgc, base, towardFg)
		if (contrastRatio(cand, bgc) >= minRatio && contrastRatio(cand, panel) >= minRatio) return hex(cand)
	}
	return hex(fgc)
}

const WHITE: Rgb = [255, 255, 255]
const DARK: Rgb = [17, 17, 17]
const BLACK: Rgb = [0, 0, 0]

export function hslToRgb(h: number, sPct: number, lPct: number): Rgb {
	const hNorm = (((h % 360) + 360) % 360) / 360
	const s = Math.max(0, Math.min(100, sPct)) / 100
	const l = Math.max(0, Math.min(100, lPct)) / 100
	if (s === 0) {
		const v = Math.round(l * 255)
		return [v, v, v]
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s
	const p = 2 * l - q
	const hue = (t: number) => {
		const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
		if (u < 1 / 6) return p + (q - p) * 6 * u
		if (u < 1 / 2) return q
		if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
		return p
	}
	return [Math.round(hue(hNorm + 1 / 3) * 255), Math.round(hue(hNorm) * 255), Math.round(hue(hNorm - 1 / 3) * 255)]
}

// Darken an HSL fill only as much as needed so white text reaches WCAG AA (>= 4.5:1) while preserving hue.
export function darkenHslForWhite(h: number, s: number, l: number, minRatio = 4.5): string {
	let cur = Math.max(0, Math.min(100, l))
	while (cur > 8 && contrastRatio(hslToRgb(h, s, cur), WHITE) < minRatio) {
		cur = Math.max(8, cur - 1)
	}
	return `hsl(${h} ${s}% ${cur}%)`
}

/** The Daylight page colour (--bg of the latte theme in styles.css); a test keeps the two in step. */
export const DAYLIGHT_BG: Rgb = [242, 242, 239]

/** An accent as text on a light page: mixed toward black only as far as needed to reach 4.5:1 on `bg`. */
export function darkenForTextOn(fillCss: string | null | undefined, bg: Rgb = DAYLIGHT_BG, minRatio = 4.5): string | null {
	const fill = parseRgbColor(fillCss)
	if (!fill) return null
	for (let keep = 100; keep >= 0; keep -= 2) {
		const cand = mixRgb(fill, BLACK, keep)
		if (contrastRatio(cand, bg) >= minRatio) return hex(cand)
	}
	return hex(BLACK)
}

export function pickOnAccent(fillCss: string | null | undefined, fallback: '#fff' | '#111' = '#fff', preferred?: string | null): string {
	const fill = parseRgbColor(fillCss)
	if (!fill) return fallback
	if (preferred) {
		const pref = parseRgbColor(preferred)
		if (pref && contrastRatio(fill, pref) >= 4.5) return preferred
	}
	const w = contrastRatio(fill, WHITE)
	const d = contrastRatio(fill, DARK)
	if (Math.max(w, d) >= 4.5) return w >= d ? '#fff' : '#111'
	const b = contrastRatio(fill, BLACK)
	return b >= w ? '#000' : '#fff'
}

export function resolveCssColor(root: HTMLElement, cssValue: string): string | null {
	const direct = parseRgbColor(cssValue)
	if (direct) return cssValue
	if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null
	const probe = document.createElement('span')
	probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;background-color:${cssValue}`
	root.appendChild(probe)
	const resolved = getComputedStyle(probe).backgroundColor
	probe.remove()
	return resolved || null
}
