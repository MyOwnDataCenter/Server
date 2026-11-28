// Pick-lists made of plain buttons must tell a screen reader which rows are chosen (checkbox/radio + aria-checked).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const src = (p) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8')

test('Move from Unraid share, container and VM rows are checkboxes with aria-checked', () => {
	const s = src('unraid.tsx')
	assert.match(s, /role=\{choosable \? 'checkbox' : undefined\} aria-checked=\{choosable \? shares\.has\(x\.name\) : undefined\}/)
	assert.match(s, /role="checkbox" aria-checked=\{containers\.has\(c\.id\)\}/)
	assert.match(s, /role="checkbox" aria-checked=\{vms\.has\(v\.name\)\}/)
})

test('New pool drive rows are checkboxes with aria-checked', () => {
	const s = src('screens/Storage.tsx')
	assert.match(s, /role=\{checked === undefined \? undefined : 'checkbox'\} aria-checked=\{checked\}/)
	assert.match(s, /checked=\{picked\.includes\(d\.path\)\}/)
})

test('backup folder rows are checkboxes and the NAS share list is a radio group', () => {
	const s = src('backups.tsx')
	assert.match(s, /role="checkbox" aria-checked=\{picked\.includes\(name\)\}/)
	assert.match(s, /role="radiogroup" aria-label="Share"/)
	assert.match(s, /role="radio" aria-checked=\{share === x\.name\}/)
})
