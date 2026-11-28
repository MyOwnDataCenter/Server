// Secondary (--muted) text reaches 4.5:1 in Daylight and the Omarchy theme (#498), computed with the WCAG 2 formula.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {contrastRatio, legibleMuted, mixRgb, parseRgbColor} from '../web/src/theme/contrast.ts'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const rgb = (hex) => parseRgbColor(hex)
const ratio = (a, b) => contrastRatio(rgb(a), rgb(b))

function block(selector) {
	const start = CSS.indexOf(`\n${selector} {`)
	assert.ok(start >= 0, `${selector} block not found`)
	return CSS.slice(start, CSS.indexOf('\n}', start))
}
const token = (css, name) => css.match(new RegExp(`${name}: (#[0-9a-f]{6});`))?.[1]

test('Daylight muted text is at least 4.5:1 on the page, the solid page colour and a pressed panel', () => {
	const latte = block("[data-theme='latte']")
	const muted = token(latte, '--muted')
	for (const bg of [token(latte, '--bg'), token(latte, '--bg-solid'), '#dce0e8']) {
		assert.ok(ratio(muted, bg) >= 4.5, `${muted} on ${bg} is ${ratio(muted, bg).toFixed(2)}`)
	}
})

test('Linen and Sky muted text is at least 4.5:1 on the page and the solid page colour', () => {
	for (const id of ['linen', 'sky']) {
		const css = block(`[data-theme='${id}']`)
		const muted = token(css, '--muted')
		for (const bg of [token(css, '--bg'), token(css, '--bg-solid')]) {
			assert.ok(ratio(muted, bg) >= 4.5, `${id} ${muted} on ${bg} is ${ratio(muted, bg).toFixed(2)}`)
		}
	}
})

test('the Omarchy fallback muted text is at least 4.5:1 on the page, the solid page colour and a raised panel', () => {
	const omarchy = block("[data-theme='omarchy']")
	const muted = token(omarchy, '--muted')
	for (const bg of [token(omarchy, '--bg'), token(omarchy, '--bg-solid'), token(omarchy, '--glass-2')]) {
		assert.ok(ratio(muted, bg) >= 4.5, `${muted} on ${bg} is ${ratio(muted, bg).toFixed(2)}`)
	}
})

test('legibleMuted lifts a dim desktop palette to 4.5:1 on the page and on a raised panel', () => {
	const cases = [
		{bg: '#1a1b26', fg: '#a9b1d6', brightBlack: null},
		{bg: '#1a1b26', fg: '#a9b1d6', brightBlack: '#414868'},
		{bg: '#282828', fg: '#ebdbb2', brightBlack: '#928374'},
		{bg: '#fbf1c7', fg: '#3c3836', brightBlack: '#bdae93'},
	]
	for (const {bg, fg, brightBlack} of cases) {
		const muted = legibleMuted(bg, fg, brightBlack)
		assert.ok(muted, 'a colour comes back')
		const panel = mixRgb(rgb(fg), rgb(bg), 8)
		assert.ok(contrastRatio(rgb(muted), rgb(bg)) >= 4.5, `${muted} on ${bg}`)
		assert.ok(contrastRatio(rgb(muted), panel) >= 4.5, `${muted} on the panel over ${bg}`)
	}
})

test('legibleMuted keeps a muted colour that is already legible and gives up on unreadable colours', () => {
	assert.equal(legibleMuted('#000000', '#ffffff', '#ffffff'), '#ffffff')
	assert.equal(legibleMuted('not a colour', '#ffffff'), null)
})

test('the Omarchy palette uses legibleMuted for --muted', () => {
	assert.match(readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8'), /set\('--muted', legibleMuted\(bg, fg, c\.palette\?\.brightBlack\)/)
})

test('Daylight accent text is at least 4.5:1 on the Daylight page for any hue (#498)', async () => {
	const {DAYLIGHT_BG, darkenForTextOn, hslToRgb} = await import('../web/src/theme/contrast.ts')
	const latteBg = parseRgbColor(token(block("[data-theme='latte']"), '--bg'))
	assert.deepEqual(DAYLIGHT_BG, latteBg, 'DAYLIGHT_BG must match the latte --bg in styles.css')
	for (const hue of [0, 24, 50, 60, 90, 120, 150, 180, 210, 270, 330]) {
		const [r, g, b] = hslToRgb(hue, 90, 42)
		const text = darkenForTextOn(`rgb(${r}, ${g}, ${b})`)
		assert.ok(contrastRatio(parseRgbColor(text), DAYLIGHT_BG) >= 4.5, `hue ${hue}: ${text} is ${contrastRatio(parseRgbColor(text), DAYLIGHT_BG).toFixed(2)}`)
	}
	for (const named of ['#40a02b', '#df8e1d', '#fe640b', '#179299', '#ea76cb', '#1e66f5']) {
		const text = darkenForTextOn(named)
		assert.ok(contrastRatio(parseRgbColor(text), DAYLIGHT_BG) >= 4.5, `${named} -> ${text}`)
	}
	assert.equal(darkenForTextOn('#000000'), '#000000')
	assert.equal(darkenForTextOn('nope'), null)
})

test('applyPrefs uses the darkened accent text in Daylight', () => {
	const ui = readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8')
	assert.equal(ui.match(/light && darkenForTextOn\(/g)?.length, 2)
})

function rgbaToken(css, name) {
	const m = css.match(new RegExp(`${name}: rgba\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\)`))
	assert.ok(m, `${name} rgba not found`)
	return {rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4])}
}

function over(fg, bg, alpha) {
	return mixRgb(fg, bg, alpha * 100)
}

test('Midnight, Neon, and Ember muted text is at least 4.5:1 on the page and the card', () => {
	for (const id of ['mocha', 'tokyo', 'gruvbox']) {
		const css = block(`[data-theme='${id}']`)
		const muted = token(css, '--muted')
		for (const bg of [token(css, '--bg'), token(css, '--card')]) {
			assert.ok(ratio(muted, bg) >= 4.5, `${id} ${muted} on ${bg} is ${ratio(muted, bg).toFixed(2)}`)
		}
	}
})

test('Horizon secondary text is at least 4.5:1 on the frost card over a white picture', () => {
	const start = CSS.indexOf("[data-theme='horizon']")
	const css = CSS.slice(CSS.indexOf('{', start), CSS.indexOf('\n}', CSS.indexOf('{', start)))
	const card = rgbaToken(css, '--card')
	const muted = rgbaToken(css, '--muted')
	const onWhite = over(card.rgb, [255, 255, 255], card.a)
	const text = over(muted.rgb, onWhite, muted.a)
	const got = contrastRatio(text, onWhite)
	assert.ok(got >= 4.5, `horizon muted on the card over white is ${got.toFixed(2)}`)
})

test('Linen and Sky muted text is at least 4.5:1 on the card over the page', () => {
	for (const id of ['latte', 'linen', 'sky']) {
		const css = block(`[data-theme='${id}']`)
		const glass = rgbaToken(css, '--glass')
		const page = rgb(token(css, '--bg'))
		const card = over(glass.rgb, page, glass.a)
		const got = contrastRatio(rgb(token(css, '--muted')), card)
		assert.ok(got >= 4.5, `${id} muted on the card is ${got.toFixed(2)}`)
	}
})

test('a danger button is white text on a deep red, at least 4.5:1 in every theme', () => {
	const start = CSS.indexOf('.btn.danger {')
	const rule = CSS.slice(start, CSS.indexOf('\n}', start))
	assert.match(rule, /color:\s*#fff/)
	const mix = rule.match(/color-mix\(in srgb, var\(--red\)\s+([\d.]+)%,\s*(#[0-9a-fA-F]{6})\)/)
	assert.ok(mix, 'danger fill is a mix of --red')
	const pct = Number(mix[1])
	const anchor = rgb(mix[2])
	const ids = ['horizon', 'mocha', 'tokyo', 'gruvbox', 'latte', 'linen', 'sky', 'omarchy']
	for (const id of ids) {
		const css = id === 'horizon' ? CSS.slice(CSS.indexOf('{', CSS.indexOf("[data-theme='horizon']")), CSS.indexOf('\n}', CSS.indexOf("[data-theme='horizon']"))) : block(`[data-theme='${id}']`)
		const red = rgb(token(css, '--red'))
		const fill = mixRgb(red, anchor, pct)
		const got = contrastRatio([255, 255, 255], fill)
		assert.ok(got >= 4.5, `${id} white on danger is ${got.toFixed(2)}`)
	}
})
