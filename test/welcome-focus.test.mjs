// The first-run setup is a modal dialog: focus must move into it and Tab must stay inside.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SRC = readFileSync(new URL('../web/src/Welcome.tsx', import.meta.url), 'utf8')

test('the welcome setup takes keyboard focus like every other modal dialog', () => {
	assert.match(SRC, /import \{useDialogFocus\} from '\.\/focus'/)
	assert.match(SRC, /useDialogFocus\(true, dialogRef\)/)
	const dialog = SRC.match(/<div ref=\{dialogRef\}[^>]*role="dialog"[^>]*>/)
	assert.ok(dialog, 'the dialog element does not carry the focus ref')
	assert.match(dialog[0], /tabIndex=\{-1\}/)
})

test('the welcome setup opens with focus on the main button, not on Skip', () => {
	const primary = SRC.match(/<button type="button" className="btn primary"[^>]*>/)
	assert.ok(primary, 'primary button not found')
	assert.match(primary[0], /data-autofocus/)
})
