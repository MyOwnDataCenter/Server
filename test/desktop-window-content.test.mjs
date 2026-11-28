import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {sameWindowContent} from '../web/src/desktop/windowContent.ts'

const store = (id, kind = 'computer', name = id) => ({id: 's1', kind: 'store', payload: {store: {id, kind, name}}})

test('an App Store window opened again for another machine is not treated as unchanged', () => {
	assert.equal(sameWindowContent(store('a'), store('b')), false)
	assert.equal(sameWindowContent(store('a', 'computer'), store('a', 'guest')), false)
	assert.equal(sameWindowContent(store('a', 'computer', 'Old name'), store('a', 'computer', 'New name')), false)
})

test('a window whose payload did not change is unchanged', () => {
	assert.equal(sameWindowContent(store('a'), store('a')), true)
	assert.equal(sameWindowContent({id: 'x', kind: 'settings', payload: {page: 'main', pageNonce: 1}}, {id: 'x', kind: 'settings', payload: {page: 'main', pageNonce: 1}}), true)
	assert.equal(sameWindowContent({id: 'x', kind: 'settings', payload: {page: 'main', pageNonce: 1}}, {id: 'x', kind: 'settings', payload: {page: 'main', pageNonce: 2}}), false)
})

test('the desktop window content memo uses the shared comparison', async () => {
	const src = await readFile(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(src, /sameWindowContent\(a\.win, b\.win\)/)
})
