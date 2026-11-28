// The Console "Keys" menu follows the menu keyboard pattern like the desktop menus (#499).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CONSOLE = readFileSync(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
const FOCUS = readFileSync(new URL('../web/src/focus.ts', import.meta.url), 'utf8')

test('the Keys menu hands its keyboard handling to useMenuFocus', () => {
	assert.match(CONSOLE, /useMenuFocus\(keysOpen, keysMenuRef, \(\) => setKeysOpen\(false\)\)/)
	assert.match(CONSOLE, /<div ref=\{keysMenuRef\} className="ct-menu" role="menu"/)
})

test('the Keys button announces that it opens a menu', () => {
	assert.match(CONSOLE, /aria-haspopup="menu" aria-expanded=\{keysOpen\}/)
})

test('arrow keys also reach the radio items at the bottom of a menu', () => {
	const selector = FOCUS.match(/querySelectorAll\('(\[role="menuitem"\][^']*)'\)/)?.[1]
	assert.ok(selector, 'menu item selector not found')
	assert.match(selector, /\[role="menuitemradio"\]:not\(\[disabled\]\)/)
})
