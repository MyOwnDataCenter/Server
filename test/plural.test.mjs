// "1 core", "59 min ago", "1 day ago": counts and ages read as plain English at the edges.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {agoText, plural, poweredOnText} from '../web/src/plural.ts'

test('plural: one is singular, everything else is plural', () => {
	assert.equal(plural(1, 'core'), '1 core')
	assert.equal(plural(0, 'core'), '0 cores')
	assert.equal(plural(4, 'thread'), '4 threads')
	assert.equal(plural(1, 'notification'), '1 notification')
	assert.equal(plural(1500, 'day'), '1,500 days')
})

test('agoText: whole units are rounded down and "1 day" is singular', () => {
	assert.equal(agoText(30), 'just now')
	assert.equal(agoText(120), '2 min ago')
	assert.equal(agoText(3570), '59 min ago')
	assert.equal(agoText(3599), '59 min ago')
	assert.equal(agoText(3600), '1 h ago')
	assert.equal(agoText(86399), '23 h ago')
	assert.equal(agoText(86400), '1 day ago')
	assert.equal(agoText(129599), '1 day ago')
	assert.equal(agoText(2 * 86400), '2 days ago')
})

test('poweredOnText: a drive on for less than a day is not "0 days"', () => {
	assert.equal(poweredOnText(5), '5 hours')
	assert.equal(poweredOnText(1), '1 hour')
	assert.equal(poweredOnText(24), '1 day')
	assert.equal(poweredOnText(24 * 400), '400 days')
})

test('the labels that used a hard-coded plural now go through plural()', async () => {
	const {readFile} = await import('node:fs/promises')
	const read = (p) => readFile(new URL(`../web/src/${p}`, import.meta.url), 'utf8')
	assert.doesNotMatch(await read('App.tsx'), /\$\{notes\.length\} notifications/)
	assert.doesNotMatch(await read('OmarchyThemes.tsx'), /\$\{data\.more\.length\} themes/)
	assert.doesNotMatch(await read('screens/Apps.tsx'), /\$\{list\.length\} apps/)
	assert.doesNotMatch(await read('unraid.tsx'), /\$\{v\.cores\} cores/)
	assert.doesNotMatch(await read('screens/Settings.tsx'), /days ago/)
	assert.doesNotMatch(await read('backups.tsx'), /days ago/)
	assert.doesNotMatch(await read('screens/Store.tsx'), /\$\{all\.length\} apps/)
})
