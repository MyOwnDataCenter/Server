// A dock button's open windows, focus and a machine's state must reach a screen reader, not only dots and colour.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {dockLabel} from '../web/src/desktop/dockLabel.ts'

test('the dock label names the open windows and a machine state', () => {
	assert.equal(dockLabel('Files', 0), 'Files')
	assert.equal(dockLabel('Files', 1), 'Files, 1 window open')
	assert.equal(dockLabel('Files', 2), 'Files, 2 windows open')
	assert.equal(dockLabel('Ubuntu', 0, 'stopped', true), 'Ubuntu, stopped')
	assert.equal(dockLabel('Ubuntu', 1, 'running', true), 'Ubuntu, 1 window open, running')
	assert.equal(dockLabel('Ubuntu', 0, 'busy', true), 'Ubuntu, busy')
	assert.equal(dockLabel('Desktop', 0, 'running', false), 'Desktop')
})

test('the dock uses the label, marks the focused item and reports Show Applications as pressed', () => {
	const s = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(s, /aria-label=\{dockLabel\(it\.label, count, it\.status, k\.startsWith\('machine:'\)\)\}/)
	assert.match(s, /aria-current=\{p\.focusedKey === k \? 'true' : undefined\}/)
	assert.match(s, /aria-label="Show Applications"\s+aria-pressed=\{!!p\.showAppsOn\}/)
})
