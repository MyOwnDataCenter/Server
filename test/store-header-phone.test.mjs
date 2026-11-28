import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const STORE = readFileSync(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')

test('the App Store header lets its buttons wrap under the title on a phone (#540)', () => {
	assert.match(STORE, /<div className="page-head store-head">/)
	const wrap = CSS.match(/\.page-head\.store-head \{([^}]*)\}/)?.[1] ?? ''
	assert.match(wrap, /flex-wrap:\s*wrap;/)
	// The title block keeps a readable width (it wraps the buttons first) and can still shrink.
	const block = CSS.match(/\.page-head\.store-head > div \{([^}]*)\}/)?.[1] ?? ''
	assert.match(block, /flex:\s*1 1 200px;/)
	assert.match(block, /min-width:\s*0;/)
})
