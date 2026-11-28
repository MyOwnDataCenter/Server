// Chronara Studio (dark) and Chronara Studio Light: registered everywhere a theme id is checked, and readable (WCAG 2).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {contrastRatio, parseRgbColor} from '../web/src/theme/contrast.ts'
import {DARK_THEME_IDS, LIGHT_THEME_IDS, themeModeOf} from '../web/src/theme/themeMode.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const CSS = read('../web/src/theme-chronara-studio.css')
const ratio = (a, b) => contrastRatio(parseRgbColor(a), parseRgbColor(b))

function tokens(id) {
	const start = CSS.indexOf(`:root[data-theme='${id}'] {`)
	assert.ok(start >= 0, `${id} block not found`)
	const body = CSS.slice(start, CSS.indexOf('\n}', start))
	return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]))
}

test('the dark theme is a Moon choice and the light theme a Sun choice', () => {
	assert.ok(DARK_THEME_IDS.includes('chronara-studio'))
	assert.ok(LIGHT_THEME_IDS.includes('chronara-studio-light'))
	assert.equal(themeModeOf('chronara-studio'), 'moon')
	assert.equal(themeModeOf('chronara-studio-light'), 'sun')
})

test('the server, the theme picker, the assistant and the stylesheet all know both ids', () => {
	const server = read('../server/app.mjs')
	const ui = read('../web/src/ui.tsx')
	const tools = read('../omarchyd/assistant/tools.mjs')
	for (const id of ['chronara-studio', 'chronara-studio-light']) {
		assert.match(server, new RegExp(`const THEME_IDS = \\[[^\\]]*'${id}'`), `server THEME_IDS has ${id}`)
		assert.match(ui, new RegExp(`\\{id: '${id}', name: 'Chronara Studio`), `THEMES has ${id}`)
		assert.match(tools, new RegExp(`\\{id: '${id}', name: 'Chronara Studio`), `assistant catalog has ${id}`)
	}
	assert.match(server, /const DARK_THEME_IDS = \[[^\]]*'chronara-studio'\]/)
	assert.match(server, /const LIGHT_THEME_IDS = \[[^\]]*'chronara-studio-light'\]/)
	assert.match(read('../web/src/main.tsx'), /import '\.\/theme-chronara-studio\.css'/)
})

test('every rule in the stylesheet is scoped to a Chronara Studio theme, so no other theme changes', () => {
	const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{/g) ?? []
	for (const rule of rules) {
		const selector = rule.slice(0, -1).trim()
		if (!selector || selector.startsWith('@') || /^(from|to|\d+%)$/.test(selector)) continue
		assert.match(selector, /data-theme='chronara-studio(-light)?'/, `unscoped rule: ${selector}`)
	}
})

test('text and muted text reach 4.5:1 on the page, the solid page colour and a panel, in both modes', () => {
	for (const id of ['chronara-studio', 'chronara-studio-light']) {
		const t = tokens(id)
		for (const name of ['--fg', '--fg-2', '--muted']) {
			for (const bg of ['--bg', '--bg-solid', '--glass', '--sheet']) {
				const r = ratio(t[name], t[bg])
				assert.ok(r >= 4.5, `${id} ${name} ${t[name]} on ${bg} ${t[bg]} is ${r.toFixed(2)}`)
			}
		}
	}
})

test('white text on the accent fill and the accent text on the page reach 4.5:1 in both modes', () => {
	const ui = read('../web/src/ui.tsx')
	const accent = ui.match(/CHRONARA_STUDIO_ACCENT = \{dark: \{fill: '(#[0-9a-f]{6})', text: '(#[0-9a-f]{6})'\}, light: \{fill: '(#[0-9a-f]{6})', text: '(#[0-9a-f]{6})'\}\}/)
	assert.ok(accent, 'CHRONARA_STUDIO_ACCENT found')
	const [, darkFill, darkText, lightFill, lightText] = accent
	for (const [fill, text, id] of [[darkFill, darkText, 'chronara-studio'], [lightFill, lightText, 'chronara-studio-light']]) {
		assert.ok(ratio('#ffffff', fill) >= 4.5, `white on ${fill} is ${ratio('#ffffff', fill).toFixed(2)}`)
		const bg = tokens(id)['--bg-solid']
		assert.ok(ratio(text, bg) >= 4.5, `${id} accent text ${text} on ${bg} is ${ratio(text, bg).toFixed(2)}`)
	}
})
