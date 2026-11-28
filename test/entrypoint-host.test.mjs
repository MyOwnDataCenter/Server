import assert from 'node:assert/strict'
import {test} from 'node:test'

import {entrypointHost, isLoopbackHost} from '../web/src/entrypointHost.ts'

test('loopback hosts are detected', () => {
	assert.equal(isLoopbackHost('127.0.0.1'), true)
	assert.equal(isLoopbackHost('localhost'), true)
	assert.equal(isLoopbackHost('::1'), true)
	assert.equal(isLoopbackHost('[::1]'), true)
	assert.equal(isLoopbackHost('192.168.1.50'), false)
	assert.equal(isLoopbackHost('omarchy.local'), false)
})

test('prefers a LAN or hostname over loopback', () => {
	assert.equal(entrypointHost({host: '192.168.1.50'}, '127.0.0.1'), '192.168.1.50')
	assert.equal(entrypointHost({host: '127.0.0.1'}, 'omarchy.local'), 'omarchy.local')
	assert.equal(entrypointHost({host: 'omarchy.local'}, '127.0.0.1'), 'omarchy.local')
})

test('labels loopback when that is all that is known', () => {
	assert.equal(entrypointHost({host: '127.0.0.1'}, '127.0.0.1'), 'local')
	assert.equal(entrypointHost({host: 'localhost', local: true}, 'localhost'), 'local')
})
