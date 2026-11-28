// The Desktop viewer must listen for the wheel natively. React's onWheel is passive, so its
// preventDefault is ignored: a pinch or Ctrl+scroll then also zooms the whole browser page.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SRC = readFileSync(new URL('../web/src/HyprlandView.tsx', import.meta.url), 'utf8')

test('the direct Desktop canvas does not rely on a React onWheel handler', () => {
	assert.doesNotMatch(SRC, /\bonWheel=/)
})

test('the direct Desktop canvas binds a non-passive wheel listener', () => {
	assert.match(SRC, /bindConsoleWheel\(/)
})
