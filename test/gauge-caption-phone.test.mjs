import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

test('a gauge caption wraps instead of being cut off on a 360 px phone (#541)', () => {
	const narrow = CSS.match(/@media \(max-width: 400px\) \{\s*\.gauge \.sub \{([^}]*)\}/)?.[1] ?? ''
	assert.match(narrow, /white-space:\s*normal;/)
	assert.match(narrow, /text-wrap:\s*balance;/)
	// Wide screens keep the one-line caption.
	const base = CSS.match(/\n\.gauge \.sub \{([^}]*)\}/)?.[1] ?? ''
	assert.match(base, /white-space:\s*nowrap;/)
})
