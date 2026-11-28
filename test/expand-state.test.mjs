// Buttons that open or close more content must report it with aria-expanded.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const src = (p) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8')

test('Row takes an expanded flag and puts it on the button', () => {
	const s = src('ui.tsx')
	assert.match(s, /expanded\?: boolean/)
	assert.match(s, /<button className="row" onClick=\{onClick\} title=\{title\} disabled=\{disabled\} aria-expanded=\{expanded\}/)
})

test('a backup history row reports whether its results are showing', () => {
	assert.match(src('backups.tsx'), /expanded=\{r\.items\.length \? open : undefined\}/)
})

test('Take snapshot and Back up now report whether their form is open', () => {
	const s = src('machines/panels.tsx')
	assert.match(s, /onClick=\{\(\) => setTaking\(!taking\)\}[^>]*aria-expanded=\{taking\}/)
	assert.match(s, /onClick=\{\(\) => setAsking\(!asking\)\}[^>]*aria-expanded=\{asking\}/)
})
