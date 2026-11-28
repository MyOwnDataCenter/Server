import assert from 'node:assert/strict'
import {test} from 'node:test'

import {installTargetId} from '../omarchyd/install-target.mjs'
import {computerInstallInput, confirmInstallTarget, guestInstallInput, installKindLabel, installTargets, installsOf, machineCountLabel, SERVER_INSTALL_ID} from '../web/src/fleet/installTargets.ts'
import {matchThemeName} from '../web/src/swarm/themePicker.ts'
import {themeAction} from '../web/src/theme/themeAction.ts'

test('install targets list only machines that can take an install', () => {
	const targets = installTargets({
		serverName: 'Den',
		computers: [
			computerInstallInput({id: 'kitchen', name: 'Kitchen', online: true}),
			computerInstallInput({id: 'loft', name: 'Loft', online: true}),
			computerInstallInput({id: 'garage', name: 'Garage', online: false}),
		],
		guests: [
			guestInstallInput({id: 'ubuntu', name: 'Ubuntu lab', state: 'running', connector: true}),
			guestInstallInput({id: 'haos', name: 'HA OS', state: 'running'}),
			guestInstallInput({id: 'win', name: 'Windows', state: 'stopped', connector: true}),
		],
	})
	assert.deepEqual(
		targets.map((t) => [t.id, t.ability]),
		[
			[SERVER_INSTALL_ID, 'ready'],
			['kitchen', 'ready'],
			['loft', 'ready'],
			['ubuntu', 'ready'],
		],
	)
	assert.equal(targets[0].name, 'Den')
	assert.ok(targets.every((t) => t.ability === 'ready'), 'offline / non-connector rows must not appear')
	assert.equal(
		targets.some((t) => t.id === 'garage' || t.id === 'haos' || t.id === 'win'),
		false,
		'offline connector, guest without connector, and stopped guest stay out of the list',
	)
	assert.equal(installKindLabel('guest'), 'Virtual machine')
	assert.equal(confirmInstallTarget({id: 'kitchen', ability: 'ready'}), 'kitchen')
	assert.equal(confirmInstallTarget({id: 'kitchen', ability: 'offline'}), null)
	assert.equal(confirmInstallTarget({id: SERVER_INSTALL_ID, ability: 'ready'}), SERVER_INSTALL_ID)
	assert.equal(confirmInstallTarget(null), null)
})

test('a guest without an online connector is never an install target', () => {
	const targets = installTargets({
		serverName: 'Den',
		computers: [computerInstallInput({id: 'kitchen', name: 'Kitchen', online: false})],
		guests: [
			guestInstallInput({id: 'lab', name: 'Lab', state: 'running', connector: false}),
			guestInstallInput({id: 'lab2', name: 'Lab 2', state: 'running'}),
		],
	})
	assert.deepEqual(
		targets.map((t) => t.id),
		[SERVER_INSTALL_ID],
	)
})

test('an app count is shown only when it is on more than one machine', () => {
	assert.equal(machineCountLabel(0), null)
	assert.equal(machineCountLabel(1), null)
	assert.equal(machineCountLabel(2), '2')
	assert.equal(installsOf('jellyfin', [{appIds: ['jellyfin']}, {appIds: ['jellyfin', 'code']}, {appIds: []}]), 2)
	assert.equal(installsOf('code', [{appIds: ['jellyfin']}]), 0)
})

test('an install target id is this server, another machine, or unusable', () => {
	assert.equal(installTargetId(undefined), null)
	assert.equal(installTargetId(''), null)
	assert.equal(installTargetId('server'), null)
	assert.equal(installTargetId('kitchen'), 'kitchen')
	assert.equal(installTargetId('abc123'), 'abc123')
	assert.equal(installTargetId('../secret'), false)
	assert.equal(installTargetId('has space'), false)
})

test('theme changes go through one action', () => {
	assert.deepEqual(themeAction({kind: 'server', slug: 'tokyo-night'}), {path: 'omarchy.setTheme', input: {slug: 'tokyo-night'}})
	assert.deepEqual(themeAction({kind: 'computer', id: 'kitchen', theme: 'osaka-jade'}), {path: 'swarm.action', input: {id: 'kitchen', name: 'theme-set', theme: 'osaka-jade'}})
	assert.match(themeAction({kind: 'guest', name: 'HA OS'}).error ?? '', /connector on HA OS/)
	assert.equal(matchThemeName(['Tokyo Night', 'osaka-jade'], 'tokyo-night'), 'Tokyo Night')
	assert.equal(matchThemeName(['osaka-jade'], 'missing'), 'missing')
})
