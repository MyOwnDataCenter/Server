// Settings > Device name: the hint gives an address that works, with the port the app listens on (#563).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {hostnameAddress} from '../web/src/screens/hostnameHint.ts'

test('hostnameAddress keeps the port the page was opened on', () => {
	assert.equal(hostnameAddress('myserver', {protocol: 'http:', port: '7780'}), 'http://myserver.local:7780')
	assert.equal(hostnameAddress('myserver', {protocol: 'https:', port: ''}), 'https://myserver.local')
	assert.equal(hostnameAddress('box', {protocol: 'http:', port: '8080'}), 'http://box.local:8080')
})

test('the Device name sheet builds its hint from the page address, not a fixed port-less one', () => {
	const src = readFileSync(new URL('../web/src/screens/machineHost.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(src, /Reachable at http:\/\/\$\{name/)
	assert.match(src, /hostnameAddress\(/)
})
