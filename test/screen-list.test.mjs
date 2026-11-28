// A list that is the body of a screen is a card on the phone and flat in a desktop window.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

test('desktop windows strip the screen-list card', () => {
	const start = CSS.indexOf('html.desk-mode .screen-list.glass {')
	assert.ok(start >= 0, 'screen-list rule missing')
	const rule = CSS.slice(start, CSS.indexOf('\n}', start))
	assert.match(rule, /background:\s*none/)
	assert.match(rule, /backdrop-filter:\s*none/)
})

test('a selection border is not clipped by the card or crossed by the row above', () => {
	assert.match(CSS, /html:not\(\.desk-mode\) \.screen-list\.glass \{\s*padding: 12px;/)
	assert.match(CSS, /html\.desk-mode \.group\.screen-list \{\s*overflow: visible;/)
	assert.match(CSS, /\.mm-line\.on \{[^}]*border: 1px solid var\(--accent-text\);/)
	assert.match(CSS, /\.mm-slot:last-child \.mm-row:not\(\.is-open\)/)
	assert.match(CSS, /\.mm-slot:last-child \.mm-line:not\(\.on\)/)
	assert.match(CSS, /\.mm-slot:has\(\+ \.mm-slot :is\(\.mm-line\.on, \.mm-row\.is-open\)\)/)
	assert.doesNotMatch(CSS, /\.mm-row\.is-open \{[^}]*translateY/)
})

test('the screen body lists use screen-list', () => {
	const files = [
		'../web/src/fleet/MachineManager.tsx',
		'../web/src/fleet/Terminals.tsx',
		'../web/src/fleet/NuEntries.tsx',
		'../web/src/screens/Apps.tsx',
		'../web/src/screens/Files.tsx',
		'../web/src/screens/Store.tsx',
	]
	for (const file of files) {
		const src = readFileSync(new URL(file, import.meta.url), 'utf8')
		assert.match(src, /screen-list/, file)
	}
})
