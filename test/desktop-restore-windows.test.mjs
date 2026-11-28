// A damaged or out-of-date saved window list must not crash the desktop on every load.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {restoreWindows} from '../web/src/desktop/restoreWindows.ts'

const win = (over = {}) => ({id: 'a1', kind: 'files', key: 'files', x: 80, y: 60, w: 900, h: 600, z: 11, min: false, snap: null, born: 1, ...over})

test('saved windows that can be drawn come back as they were', () => {
	const files = win()
	const app = win({id: 'a2', kind: 'app', key: 'app:immich', payload: {appId: 'immich'}})
	const out = restoreWindows([files, app])
	assert.equal(out.length, 2)
	assert.equal(out[0], files)
	assert.equal(out[1], app)
})

test('a saved value that is not a list restores nothing', () => {
	for (const bad of [null, undefined, {}, 'files', 7, {length: 1}]) assert.deepEqual(restoreWindows(bad), [])
})

test('entries the desktop cannot draw are dropped, the rest stay', () => {
	const good = win()
	const out = restoreWindows([
		null,
		'x',
		win({kind: 'from-a-newer-build'}),
		win({id: 5}),
		win({key: undefined}),
		win({x: NaN}),
		win({z: undefined}),
		win({payload: 'nope'}),
		win({kind: 'terminal', key: 'terminal'}),
		win({kind: 'console', key: 'console:vm1'}),
		win({kind: 'rail', key: 'rail:0x1'}),
		good,
	])
	assert.deepEqual(out, [good])
})

test('the desktop restores its windows through the same check', () => {
	const src = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(src, /restoreWindows<Win>\(load<unknown>\(STORE_KEY, \[\]\)\)/)
})
