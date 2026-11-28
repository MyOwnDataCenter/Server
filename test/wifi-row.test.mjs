// The Wi-Fi row says "Not connected" for an unjoined interface and nothing while it is still loading (#175).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {wifiRowValue} from '../web/src/screens/wifiRow.ts'

test('wifiRowValue: the network name, "Not connected", or nothing yet', () => {
	assert.equal(wifiRowValue({status: 'connected', ssid: 'Home'}), 'Home')
	assert.equal(wifiRowValue({status: 'disconnected'}), 'Not connected')
	assert.equal(wifiRowValue(undefined), '')
})

test('the server page uses it instead of the old "Off" fallback', () => {
	const src = readFileSync(new URL('../web/src/screens/machineHost.tsx', import.meta.url), 'utf8')
	assert.match(src, /wifiRowValue\(wifi\.data\)/)
	assert.doesNotMatch(src, /wifi\.data\.ssid : 'Off'/)
})
