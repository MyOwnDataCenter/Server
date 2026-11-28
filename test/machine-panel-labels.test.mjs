// Boot order checkboxes, the QEMU monitor command box and the Notes box need accessible names.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const s = readFileSync(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')

test('each boot order checkbox is named after its device', () => {
	assert.match(s, /role="checkbox" aria-checked=\{x\.on\} aria-label=\{bootName\(d, x\.id\)\}/)
})

test('the QEMU monitor command box has a label', () => {
	assert.match(s, /<input className="field mono" aria-label="QEMU monitor command"/)
})

test('the machine notes box has a label', () => {
	assert.match(s, /<textarea className="field mx-textarea" aria-label="Notes"/)
})
