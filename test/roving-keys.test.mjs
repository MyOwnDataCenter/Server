// Tabs, segmented controls and radio groups move with the arrow keys and have one Tab stop (#513).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {nextRovingIndex, rovingKeyDown, rovingTabIndex} from '../web/src/roving.ts'

const read = (path) => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8')

test('nextRovingIndex wraps and supports Home and End', () => {
	assert.equal(nextRovingIndex(3, 2, 'ArrowRight'), 0)
	assert.equal(nextRovingIndex(3, 0, 'ArrowLeft'), 2)
	assert.equal(nextRovingIndex(3, 1, 'Home'), 0)
	assert.equal(nextRovingIndex(3, 1, 'End'), 2)
	assert.equal(nextRovingIndex(3, 1, 'Enter'), null)
	assert.equal(nextRovingIndex(0, 0, 'ArrowRight'), null)
	assert.equal(nextRovingIndex(3, -1, 'ArrowRight'), null)
})

test('up and down move a radio group but leave a horizontal tab strip alone', () => {
	assert.equal(nextRovingIndex(3, 0, 'ArrowDown', 'both'), 1)
	assert.equal(nextRovingIndex(3, 1, 'ArrowUp', 'both'), 0)
	assert.equal(nextRovingIndex(3, 0, 'ArrowDown', 'horizontal'), null)
	assert.equal(nextRovingIndex(3, 0, 'ArrowRight', 'horizontal'), 1)
})

test('only the selected item is a tab stop, or the first one when nothing is selected', () => {
	assert.equal(rovingTabIndex(true, 2, true), 0)
	assert.equal(rovingTabIndex(false, 0, true), -1)
	assert.equal(rovingTabIndex(false, 0, false), 0)
	assert.equal(rovingTabIndex(false, 1, false), -1)
})

test('rovingKeyDown focuses the next item, prevents the page scroll, and ignores modified keys', () => {
	const focused = []
	const item = (name) => ({focus: () => focused.push(name), contains: (n) => n === name})
	const items = [item('a'), item('b'), item('c')]
	let prevented = 0
	const ev = (key, target, extra = {}) => ({key, target, currentTarget: {querySelectorAll: () => items}, preventDefault: () => prevented++, ...extra})
	assert.equal(rovingKeyDown(ev('ArrowRight', 'c'), '[role="tab"]'), true)
	assert.deepEqual(focused, ['a'])
	assert.equal(prevented, 1)
	assert.equal(rovingKeyDown(ev('ArrowRight', 'a', {altKey: true}), '[role="tab"]'), false)
	assert.equal(rovingKeyDown(ev('x', 'a'), '[role="tab"]'), false)
	assert.equal(prevented, 1)
})

test('Segmented puts the selected option alone in the Tab order and handles the arrow keys', () => {
	const ui = read('src/ui.tsx')
	const seg = ui.slice(ui.indexOf('export function Segmented'), ui.indexOf('export function Switch'))
	assert.match(seg, /tabIndex=\{rovingTabIndex\(/)
	assert.match(seg, /onKeyDown=\{\(e\) => rovingKeyDown\(e, TAB_SELECTOR, 'horizontal'\)\}/)
})

test('the app sheet and store tabs and the theme and accent radios use the same helper', () => {
	assert.match(read('src/AppSheet.tsx'), /rovingKeyDown\(e, TAB_SELECTOR, 'horizontal'\)/)
	assert.match(read('src/screens/Store.tsx'), /rovingKeyDown\(e, TAB_SELECTOR, 'horizontal'\)/)
	assert.match(read('src/screens/Plugins.tsx'), /role="tab" aria-selected=\{category === c\} tabIndex=\{category === c \? 0 : -1\}/)
	assert.match(read('src/CategoryChips.tsx'), /rovingKeyDown\(e, TAB_SELECTOR, 'horizontal'\)/)
	const more = read('src/screens/More.tsx')
	assert.equal(more.match(/rovingKeyDown\(e, RADIO_SELECTOR\)/g)?.length, 1)
	const chooser = read('src/ThemeChooser.tsx')
	assert.equal(chooser.match(/rovingKeyDown\(e, RADIO_SELECTOR\)/g)?.length, 2)
	assert.match(read('src/OmarchyBackgrounds.tsx'), /rovingKeyDown\(e, RADIO_SELECTOR\)/)
	assert.match(read('src/ui.tsx'), /rovingKeyDown\(e, RADIO_SELECTOR\)/)
	assert.match(read('src/OmarchyThemes.tsx'), /rovingKeyDown\(e, RADIO_SELECTOR\)/)
})
