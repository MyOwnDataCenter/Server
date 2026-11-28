// A zoomed photo in the file viewer is panned with the arrow keys instead of switching files (#517).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {PAN_STEP, panDeltaForKey} from '../web/src/screens/viewer/panKeys.ts'

test('arrow keys move the picture opposite to the way the view moves', () => {
	assert.deepEqual(panDeltaForKey('ArrowRight'), {x: -PAN_STEP, y: 0})
	assert.deepEqual(panDeltaForKey('ArrowLeft'), {x: PAN_STEP, y: 0})
	assert.deepEqual(panDeltaForKey('ArrowDown'), {x: 0, y: -PAN_STEP})
	assert.deepEqual(panDeltaForKey('ArrowUp'), {x: 0, y: PAN_STEP})
	assert.equal(panDeltaForKey('a'), null)
})

test('the photo view takes over the arrow keys only while zoomed in', () => {
	const src = readFileSync(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
	const image = src.slice(src.indexOf('function ImageView'), src.indexOf('function VideoView'))
	assert.match(image, /ownsArrows: z\.s > 1/)
	assert.match(image, /panDeltaForKey\(e\.key\)/)
})
