// The Desktop launcher tells assistive technology which entry is highlighted (#501).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

const LAUNCHER = readFileSync(new URL('../web/src/desktop/hyprland/Launcher.tsx', import.meta.url), 'utf8')

describe('launcher exposes the highlighted entry to assistive technology (#501)', () => {
	test('the filter is a combobox that points at the highlighted option', () => {
		assert.match(LAUNCHER, /role="combobox"/)
		assert.match(LAUNCHER, /aria-controls=\{listId\}/)
		assert.match(LAUNCHER, /aria-activedescendant=\{rows\[sel\] \? `\$\{listId\}-\$\{sel\}` : undefined\}/)
	})

	test('the list is a listbox whose buttons are options with aria-selected for the highlighted row', () => {
		assert.match(LAUNCHER, /<ul ref=\{list\} id=\{listId\} role="listbox"/)
		assert.match(LAUNCHER, /id=\{`\$\{listId\}-\$\{i\}`\}\s*role="option"\s*aria-selected=\{i === sel\}/)
	})
})
