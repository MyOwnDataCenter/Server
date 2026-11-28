// On a wide screen a wide window over two narrow ones is still reachable with the arrow keys.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {focusDir, swapDir} from '../web/src/desktop/hyprland/layout.ts'

const leaf = (id) => ({kind: 'leaf', id})
const wide = {x: 0, y: 0, w: 3000, h: 800}
// top over (bl | br)
const tree = {kind: 'split', axis: 'v', ratio: 0.5, a: leaf('top'), b: {kind: 'split', axis: 'h', ratio: 0.5, a: leaf('bl'), b: leaf('br')}}

test('Down from a wide top window reaches a window below it', () => {
	assert.ok(['bl', 'br'].includes(focusDir(tree, 'top', 'down', wide, 8)))
})

test('Up from either lower window reaches the top window', () => {
	assert.equal(focusDir(tree, 'bl', 'up', wide, 8), 'top')
	assert.equal(focusDir(tree, 'br', 'up', wide, 8), 'top')
})

test('Swap uses the same neighbour as focus', () => {
	const swapped = swapDir(tree, 'bl', 'up', wide, 8)
	assert.deepEqual(swapped.a, leaf('bl'))
})

test('directions that already worked do not change', () => {
	assert.equal(focusDir(tree, 'bl', 'right', wide, 8), 'br')
	assert.equal(focusDir(tree, 'br', 'left', wide, 8), 'bl')
	assert.equal(focusDir(tree, 'top', 'up', wide, 8), 'top')
	assert.equal(focusDir(tree, 'bl', 'left', wide, 8), 'bl')
	assert.equal(focusDir(tree, 'top', 'down', {x: 0, y: 0, w: 1200, h: 800}, 8), 'bl')
})

test('the fallback never jumps to a window that is not beside this one', () => {
	// a | (b over c): from c, Right has nothing to the right of it.
	const t = {kind: 'split', axis: 'h', ratio: 0.5, a: leaf('a'), b: {kind: 'split', axis: 'v', ratio: 0.5, a: leaf('b'), b: leaf('c')}}
	assert.equal(focusDir(t, 'c', 'right', wide, 8), 'c')
	assert.equal(focusDir(t, 'a', 'up', wide, 8), 'a')
})
