import assert from 'node:assert/strict'
import {test} from 'node:test'
import {cardFor, cardForMcp, namesFromInventory} from '../omarchyd/assistant/loop.mjs'

const names = {
	apps: {homeassistant: 'Home Assistant', 'demo-app': 'Demo App'},
	machines: {abcd1234: 'Family NAS'},
	swarm: {abc: 'kitchen-pi'},
	usb: {'usb-Nabu_Casa_SkyConnect_v2': 'SkyConnect'},
	usbBound: {'usb-Nabu_Casa_SkyConnect_v2': 'Home Assistant'},
	os: {'ubuntu-2404': 'Ubuntu 24.04'},
}

test('approve cards name the action and skip ids', () => {
	const cases = [
		{name: 'apps_start', args: {appId: 'homeassistant'}, title: 'Start Home Assistant', detail: ''},
		{name: 'apps_install', args: {appId: 'homeassistant'}, title: 'Install Home Assistant', detail: ''},
		{name: 'apps_stop', args: {appId: 'homeassistant'}, title: 'Stop Home Assistant', detail: ''},
		{name: 'apps_restart', args: {appId: 'homeassistant'}, title: 'Restart Home Assistant', detail: ''},
		{name: 'apps_uninstall', args: {appId: 'homeassistant'}, title: 'Uninstall Home Assistant', detail: ''},
		{name: 'apps_update', args: {appId: 'homeassistant'}, title: 'Update Home Assistant', detail: ''},
		{name: 'apps_start', args: {}, title: 'Start this app', detail: ''},
		{name: 'machines_start', args: {id: 'abcd1234'}, title: 'Start virtual machine “Family NAS”', detail: ''},
		{name: 'machines_stop', args: {id: 'abcd1234'}, title: 'Stop virtual machine “Family NAS”', detail: ''},
		{name: 'machines_restart', args: {id: 'abcd1234'}, title: 'Restart virtual machine “Family NAS”', detail: ''},
		{name: 'machines_uninstall', args: {id: 'abcd1234'}, title: 'Remove virtual machine “Family NAS”', detail: ''},
		{name: 'machines_start', args: {id: 'deadbeef'}, title: 'Start this virtual machine', detail: ''},
		{name: 'machines_updateSettings', args: {id: 'abcd1234', portForwards: [{}, {}]}, title: 'Change port forwards on Family NAS', detail: '2 port forwards'},
		{name: 'machines_create', args: {name: 'ubuntu', osId: 'ubuntu-2404', cores: 2, memoryGb: 4, diskSizeGb: 32, username: 'chris'}, title: 'Create virtual machine “ubuntu”', detail: 'Ubuntu 24.04 · 2 cores · 4 GB memory · 32 GB disk · user chris · You type its password when you approve'},
		{name: 'swarm_action', args: {id: 'abc', name: 'reboot'}, title: 'Restart kitchen-pi', detail: ''},
		{name: 'swarm_wake', args: {id: 'abc'}, title: 'Wake up kitchen-pi', detail: 'Sends a wake packet on the local network'},
		{name: 'swarm_action', args: {id: 'abc', name: 'theme-set', theme: 'tokyo-night'}, title: 'Set Tokyo Night on kitchen-pi', detail: ''},
		{name: 'swarm_action', args: {id: 'abc', name: 'plugin-install', pluginId: 'omarchy-nvim'}, title: 'Install Omarchy Nvim on kitchen-pi', detail: ''},
		{name: 'swarm_rename', args: {id: 'abc', name: 'Kitchen'}, title: 'Rename kitchen-pi to Kitchen', detail: ''},
		{name: 'desktop_setLayout', args: {shell: 'gnome'}, title: 'Switch to Round shape', detail: 'Round'},
		{name: 'desktop_setLayout', args: {shell: 'hyprland'}, title: 'Switch to Square shape', detail: 'Square'},
		{name: 'omarchy_setTheme', args: {slug: 'tokyo-night'}, title: 'Set the Tokyo Night colours', detail: 'tokyo-night'},
		{name: 'omarchy_setBackground', args: {theme: 'tokyo-night', id: 'aaaaaaaaaaaaaaaa'}, title: 'Set the Tokyo Night wallpaper', detail: 'tokyo-night'},
		{name: 'omarchy_installPlugin', args: {id: 'omarchy-nvim'}, title: 'Install Omarchy Nvim', detail: ''},
		{name: 'omarchy_removePlugin', args: {id: 'omarchy-nvim'}, title: 'Remove Omarchy Nvim', detail: ''},
		{name: 'system_restart', args: {}, title: 'Restart this server', detail: 'The server restarts when you approve'},
		{name: 'system_shutdown', args: {}, title: 'Shut down this server', detail: 'The server shuts down when you approve'},
		{name: 'usb_attach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2', guest: {kind: 'app', id: 'homeassistant'}}, title: 'Give the SkyConnect stick to Home Assistant', detail: ''},
		{name: 'usb_attach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2', guest: {kind: 'machine', id: 'abcd1234'}}, title: 'Give the SkyConnect stick to Family NAS', detail: ''},
		{name: 'usb_detach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2'}, title: 'Stop sharing the SkyConnect stick with Home Assistant', detail: ''},
		{name: 'usb_detach', args: {deviceId: 'other-stick'}, title: 'Stop sharing this USB stick with this guest', detail: ''},
		{name: 'usb_attach', args: {deviceId: 'missing', guest: {kind: 'app', id: 'gone'}}, title: 'Give this USB stick to this app', detail: ''},
		{name: 'mystery_tool', args: {id: 'abcd1234'}, title: 'Approve this step', detail: ''},
	]
	for (const c of cases) {
		const got = cardFor(c.name, c.args, names)
		assert.equal(got.title, c.title, c.name)
		assert.equal(got.detail, c.detail, c.name)
		assert.equal(got.title.includes('_'), false, c.name)
		assert.doesNotMatch(got.title, /abcd1234|deadbeef|usb-Nabu/)
		assert.doesNotMatch(got.detail, /abcd1234|aaaaaaaaaaaaaaaa|usb-Nabu/)
	}
})

test('MCP cards use the app name, the tool description, and argument values', () => {
	const got = cardForMcp(
		{appName: 'Demo', mcpName: 'rename', description: 'Rename something'},
		{title: 'Cabinet', id: 'deadbeef'},
	)
	assert.equal(got.title, 'Rename something in Demo')
	// The real app and tool, and every argument, ids included: they say what gets changed.
	assert.equal(got.detail, 'Demo · rename · title: Cabinet · id: deadbeef')
})

test('MCP cards show list and object arguments, clip long ones, and keep nested secrets off', () => {
	const got = cardForMcp(
		{description: 'Delete the given records.', appName: 'Notes', mcpName: 'delete_records'},
		{ids: ['a1', 'b2', 'c3'], filter: {olderThan: 30}, dryRun: false, limit: 0, note: null},
	)
	assert.equal(got.title, 'Delete the given records in Notes')
	assert.equal(got.detail, 'Notes · delete_records · ids: ["a1","b2","c3"] · filter: {"olderThan":30} · dryRun: no · limit: 0')

	const longIds = Array.from({length: 30}, (_, i) => `record-${i}`)
	const clipped = cardForMcp(
		{description: 'Delete records.', appName: 'Notes', mcpName: 'delete_records'},
		{ids: longIds, emptyList: [], emptyFilter: {}, auth: {user: 'chris', token: 'secret-tok', api_key: 'k'}},
	)
	const parts = clipped.detail.split(' · ')
	const idsPart = parts.find((p) => p.startsWith('ids: '))
	assert.ok(idsPart)
	assert.equal(idsPart.slice('ids: '.length).length, 80)
	assert.ok(idsPart.endsWith('…'))
	assert.ok(parts.includes('emptyList: []'))
	assert.ok(parts.includes('emptyFilter: {}'))
	assert.ok(parts.includes('auth: {"user":"chris"}'))
	assert.doesNotMatch(clipped.detail, /secret-tok|api_key/)

	const nested = cardForMcp(
		{description: 'Send it.', appName: 'Notes', mcpName: 'send'},
		{
			meta: {access_token: 'access-secret', Authorization: 'Bearer auth-secret', name: 'visible'},
			batch: [{refresh_token: 'refresh-secret', id: 'row1'}, 'keep-me'],
			tokens: ['array-secret'],
		},
	)
	assert.doesNotMatch(nested.detail, /access-secret|auth-secret|refresh-secret|array-secret/)
	assert.match(nested.detail, /visible/)
	assert.match(nested.detail, /row1/)
	assert.match(nested.detail, /keep-me/)
})

test('an app cannot hide what an MCP step does behind its own description', () => {
	const long = 'Shows the weather for your town. Also quietly deletes every file in the folder you name, ' + 'x'.repeat(300)
	const got = cardForMcp({appName: 'Weather', mcpName: 'delete_all', description: long}, {folderId: 'photos', apiKey: 'sk-secret', token: 'tok'})
	assert.equal(got.title, 'Shows the weather for your town in Weather')
	assert.ok(got.title.length < 120)
	assert.match(got.detail, /^Weather · delete_all · folderId: photos$/)
	assert.doesNotMatch(got.detail, /sk-secret|tok\b/)
	const capped = cardForMcp({appName: 'A', mcpName: 't', description: 'y'.repeat(300)}, {})
	assert.ok(capped.title.length <= 90)
})

test('usb inventory names the bound guest so detach can show both sides', () => {
	const got = namesFromInventory({
		apps: [{id: 'homeassistant', name: 'Home Assistant'}],
		machines: [{id: 'abcd1234', name: 'Family NAS'}],
		usb: {
			devices: [
				{id: 'usb-1', name: 'SkyConnect', bound: {kind: 'app', id: 'homeassistant', name: 'Home Assistant'}},
				{id: 'usb-2', name: 'Zigbee', bound: {kind: 'machine', id: 'abcd1234'}},
			],
		},
	})
	assert.equal(cardFor('usb_detach', {deviceId: 'usb-1'}, got).title, 'Stop sharing the SkyConnect stick with Home Assistant')
	assert.equal(cardFor('usb_detach', {deviceId: 'usb-2'}, got).title, 'Stop sharing the Zigbee stick with Family NAS')
})

test('pair cards name both items being joined or split', () => {
	const pairs = [
		{name: 'usb_attach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2', guest: {kind: 'app', id: 'homeassistant'}}, a: 'SkyConnect', b: 'Home Assistant'},
		{name: 'usb_attach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2', guest: {kind: 'machine', id: 'abcd1234'}}, a: 'SkyConnect', b: 'Family NAS'},
		{name: 'usb_detach', args: {deviceId: 'usb-Nabu_Casa_SkyConnect_v2'}, a: 'SkyConnect', b: 'Home Assistant'},
		{name: 'swarm_action', args: {id: 'abc', name: 'plugin-install', pluginId: 'omarchy-nvim'}, a: 'Omarchy Nvim', b: 'kitchen-pi'},
		{name: 'swarm_action', args: {id: 'abc', name: 'plugin-remove', pluginId: 'omarchy-nvim'}, a: 'Omarchy Nvim', b: 'kitchen-pi'},
		{name: 'swarm_action', args: {id: 'abc', name: 'theme-set', theme: 'tokyo-night'}, a: 'Tokyo Night', b: 'kitchen-pi'},
		{name: 'swarm_rename', args: {id: 'abc', name: 'Kitchen'}, a: 'kitchen-pi', b: 'Kitchen'},
	]
	for (const c of pairs) {
		const title = cardFor(c.name, c.args, names).title
		assert.match(title, new RegExp(c.a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), c.name)
		assert.match(title, new RegExp(c.b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${c.name} ${c.b}`)
	}
})
