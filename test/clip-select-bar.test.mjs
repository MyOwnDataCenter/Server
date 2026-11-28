// The clip selection bar sits on the list and can delete the checked clips.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('selected clips stick to the top of the list and delete asks first', () => {
	const book = read('../web/src/clips/ClipBook.tsx')
	const css = read('../web/src/styles.css')
	const pin = book.indexOf('className="clip-select-pin"')
	const rows = book.indexOf('visible.map')
	assert.ok(pin > 0 && pin < rows, 'the bar is above the rows')
	assert.match(book, /Delete 1 selected item\?/)
	assert.match(book, /Delete \$\{n\} selected items\?/)
	assert.match(book, /className="btn danger"/)
	assert.match(book, /className="btn block danger"/)
	assert.match(css, /\.clip-select-pin \{[^}]*position:\s*sticky;/)
	assert.match(css, /\.clip-select-pin \{[^}]*top:\s*0;/)
	assert.match(css, /scroll-padding-top:\s*7\.5rem;/)
	assert.doesNotMatch(css, /\.clip-select \{[^}]*position:\s*fixed/)
	assert.doesNotMatch(css, /\.clip-book\.has-selection/)
})
