import assert from 'node:assert/strict'
import {test} from 'node:test'

import {nice} from '../web/src/screens/filesRules.ts'

test('a real error text keeps its hyphens, paths and brackets', () => {
	assert.equal(nice("qemu-img: Could not open '/home/me/disk-1.qcow2'"), "qemu-img: Could not open '/home/me/disk-1.qcow2'")
	assert.equal(nice('[disk-1.qcow2] is not readable'), '[disk-1.qcow2] is not readable')
})

test('a bare error code is still turned into words', () => {
	assert.equal(nice('[no-space-left]'), 'no space left')
	assert.equal(nice('[cannot-rename]'), 'That can’t be renamed')
})
