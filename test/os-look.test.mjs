import assert from 'node:assert/strict'
import {test} from 'node:test'

import {osLook} from '../web/src/osLook.ts'

test('a machine made from your own ISO is not labelled by its folder names or its file path', () => {
	assert.equal(osLook('local:/Home/Machines/gparted-live.iso').name, 'Custom ISO')
	assert.equal(osLook('local:/Home/Machines/gparted-live.iso').icon, 'server')
	assert.equal(osLook('local:/Home/Archive/rescue.iso').name, 'Custom ISO')
	assert.equal(osLook('local:/Home/Downloads/nixos-24.11.iso').name, 'Custom ISO')
})

test('an ISO whose file name says what it is still gets that system’s look', () => {
	assert.equal(osLook('local:/Home/Machines/ubuntu-24.04-live-server-amd64.iso').name, 'Ubuntu')
	assert.equal(osLook('local:/Home/Downloads/archlinux-2026.11.01-x86_64.iso').name, 'Arch Linux')
	assert.equal(osLook('local:/Home/Downloads/Win11_English_x64.iso').name, 'Windows')
})

test('an imported machine says Imported, and catalog ids look as before', () => {
	assert.equal(osLook('imported').name, 'Imported')
	assert.equal(osLook('ubuntu-26.04-server-amd64').name, 'Ubuntu')
	assert.equal(osLook('windows').name, 'Windows')
	assert.equal(osLook('').name, 'Linux')
})
