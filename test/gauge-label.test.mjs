// A Home gauge in warning or danger must still read out its value to a screen reader.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {gaugeButtonLabel} from '../web/src/fleet/gaugeLabel.ts'

test('a normal gauge reads its name and value', () => {
	assert.equal(gaugeButtonLabel('CPU', '12%', 'ok'), 'CPU, 12%')
})

test('a gauge that needs attention keeps its value and says how bad it is', () => {
	assert.equal(gaugeButtonLabel('Memory', '13 GB of 16 GB', 'warning'), 'Memory, 13 GB of 16 GB, needs attention, tap for details')
	assert.equal(gaugeButtonLabel('Storage', '95%', 'danger'), 'Storage, 95%, critical, tap for details')
})

test('the gauge buttons use the label helper', () => {
	const s = readFileSync(new URL('../web/src/fleet/serverGauges.tsx', import.meta.url), 'utf8')
	assert.match(s, /aria-label=\{gaugeButtonLabel\(g\.k, g\.reading\?\.text \?\? g\.sub, level\)\}/)
})
