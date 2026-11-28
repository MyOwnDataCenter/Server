import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {
	filterLabel,
	filterSlot,
	healthPill,
	isOffline,
	isOnline,
	managerAccess,
	managerHealth,
	managerPower,
	managerRows,
	loadManagerDials,
	MANAGER_DIALS_KEY,
	managerStats,
	matchesName,
	saveManagerDials,
	valueDials,
	mergeMotion,
	nextFilter,
	passesFilter,
	reachLabel,
	seenFact,
} from '../web/src/fleet/machineManagerLogic.ts'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Machines uses the manager list on phone and desktop, and Manage opens the split on desktop', async () => {
	const settings = await read('../web/src/screens/Settings.tsx')
	assert.doesNotMatch(settings, /Enable pre-release features/)
	assert.doesNotMatch(settings, /usePreRelease/)
	const machines = await read('../web/src/screens/Machines.tsx')
	assert.doesNotMatch(machines, /usePreRelease/)
	assert.doesNotMatch(machines, /phoneManager/)
	assert.match(machines, /<MachineManager/)
	assert.match(machines, /wide && \(selected \|\| computerId \|\| serverOpen\)/)
	assert.match(machines, /machines-split is-resizable/)
	assert.match(machines, /className="machines-list"/)
	assert.match(machines, /className="machines-detail"/)
	assert.match(machines, /label="Flat"/)
	assert.match(machines, />Flat</)
	assert.doesNotMatch(machines, /label="Compact"/)
	assert.doesNotMatch(machines, />Compact</)
	assert.match(machines, /machines-compact-bar/)
	assert.match(machines, /showCompact && <h1 className="title">Machines<\/h1>/)
	assert.match(machines, /showCompact/)
	assert.match(machines, /root\.startViewTransition/)
	assert.match(machines, /layout="nav"/)
	assert.match(machines, /<ServerSheet/)
	assert.match(machines, /<VmView/)
	assert.doesNotMatch(machines, /<NodeView/)
	const ui = await read('../web/src/fleet/MachineManager.tsx')
	assert.match(ui, /icon="vm"/)
	assert.doesNotMatch(ui, /osLook/)
	assert.match(ui, /filterLabel/)
	assert.match(ui, /nextFilter/)
	assert.match(ui, /MACHINES_FILTER_TIP/)
	assert.match(ui, /Tap again to switch/)
	assert.doesNotMatch(ui, /omarchy-server:mm-filter-tip/)
	const logic = await read('../web/src/fleet/machineManagerLogic.ts')
	for (const word of ['All', 'Physical', 'Virtual', 'Unhealthy', 'Healthy', 'Offline', 'Online']) assert.match(logic, new RegExp(word))
	assert.match(ui, /mergeMotion/)
	assert.match(ui, /prefers-reduced-motion/)
	assert.match(ui, /aria-label="Terminal"/)
	assert.match(ui, /aria-label="Desktop"/)
	assert.match(ui, />\s*Manage\s*</)
	const css = await read('../web/src/styles.css')
	assert.match(css, /\.mm-slot\.is-leave \.mm-slot-in/)
	assert.match(css, /\.mm-slot\.is-enter\.is-in \.mm-slot-in/)
	assert.match(css, /prefers-reduced-motion: reduce/)
	assert.match(ui, /mm-line/)
	assert.match(ui, /is-lines/)
	assert.match(css, /\.mm-line/)
	assert.match(css, /\.pve-nav/)
	assert.match(machines, /omarchy-server:machines-list-width/)
	assert.match(machines, /LIST_WIDTH_MIN = 360/)
	assert.match(machines, /LIST_WIDTH_DEFAULT = 360/)
	assert.match(machines, /role="separator"/)
	assert.match(machines, /onBack=/)
	assert.match(machines, /selectedId=\{computerId\}/)
	assert.doesNotMatch(machines, /computerSheet/)
	const frame = await read('../web/src/machines/detailFrame.tsx')
	assert.match(frame, /aria-label=\{backLabel/)
	assert.match(frame, /name="back"/)
	assert.match(frame, /popover: 'hint'/)
	assert.match(frame, /className="pve-vm"/)
	assert.match(frame, /className="pve-nav"/)
	assert.match(frame, /className="pve-title"/)
	assert.match(frame, /\{store\}/)
	const pve = await read('../web/src/machines/pveDetail.tsx')
	assert.match(pve, /<DetailFrame/)
	assert.match(pve, /store=\{/)
	assert.doesNotMatch(pve, /on node/)
	assert.doesNotMatch(pve, /Node “/)
	assert.match(pve, /Virtual machine ID/)
	assert.match(pve, /Hostname/)
	assert.match(pve, /PinButton/)
	assert.match(pve, /machineStatus/)
	assert.doesNotMatch(pve, /DesktopPanel/)
	const panels = await read('../web/src/machines/panels.tsx')
	assert.doesNotMatch(panels, /label: 'Desktop'/)
	assert.doesNotMatch(pve, /Add to desktop/)
	assert.doesNotMatch(pve, /pve-desktop/)
	assert.doesNotMatch(pve, /\{m\.state\}/)
	const server = await read('../web/src/fleet/ServerSheet.tsx')
	assert.match(server, /<DetailFrame/)
	assert.match(server, /store=\{/)
	assert.match(server, /App Store/)
	assert.doesNotMatch(server, /className="pve-toolbar"/)
	assert.match(server, /current === 'apps' \?/)
	assert.match(server, /<MachineApps computerId=\{SERVER_FLEET_ID\}/)
	assert.match(server, /<MachineSeen/)
	assert.doesNotMatch(server, /title="Now"/)
	assert.doesNotMatch(server, /label="Temperature"/)
	assert.doesNotMatch(server, /id: 'console', label: 'Desktop'/)
	const swarm = await read('../web/src/swarm/Swarm.tsx')
	assert.match(swarm, /<DetailFrame/)
	assert.match(swarm, /store=\{/)
	assert.match(swarm, /current === 'apps' \?/)
	assert.match(swarm, /<MachineApps computerId=\{a\.id\}/)
	assert.match(swarm, /<MachineSeen/)
	assert.doesNotMatch(swarm, /title="Now"/)
	assert.doesNotMatch(swarm, /id: 'console', label: 'Desktop'/)
	const guest = await read('../web/src/fleet/GuestLive.tsx')
	assert.match(guest, /<MachineSeen/)
	assert.match(guest, /const stopped = machine\.state === 'stopped'/)
	assert.match(guest, /offline=\{stopped\}/)
	assert.doesNotMatch(guest, /title="Now"/)
	const machineApps = await read('../web/src/fleet/MachineApps.tsx')
	assert.match(machineApps, /Apps are programs that run on this machine/)
	assert.match(machineApps, /Use the App Store button above to install them on/)
	assert.match(machineApps, /machine-apps-empty/)
	assert.match(css, /\.pve-panel \.machine-apps-empty/)
	assert.match(css, /text-wrap: balance/)
	const seen = await read('../web/src/fleet/MachineSeen.tsx')
	assert.match(seen, /label="Up for"/)
	assert.match(seen, /label="Last seen"/)
	assert.match(seen, /toLocaleString\(\)/)
	assert.match(css, /\.machine-seen/)
	assert.doesNotMatch(css, /\.machine-seen \{[^}]*border-top/)
	assert.match(guest, /guestUptimeSeconds/)
	assert.match(guest, /guestPoweredOffAt/)
	assert.match(swarm, /Suspend/)
	assert.match(swarm, /Shut down/)
	assert.match(ui, /name="chevron"/)
	const buttons = await read('../web/src/fleet/PinButton.tsx')
	assert.match(buttons, /Pinned/)
	assert.match(buttons, /: 'Pin'/)
	const guide = await read('../docs/style-guide.md')
	assert.match(guide, /A machine's status is Online or Offline/)
	assert.match(guide, /The button says Pin/)
	assert.match(guide, /disclosure chevron/)
	assert.match(css, /\.machines-split-bar:focus-visible/)
	assert.match(css, /360px 10px/)
	assert.match(css, /min-width: 360px/)
	assert.match(css, /\.pve-split > \.btn:only-of-type/)
	assert.match(css, /\.pve-title/)
	assert.match(css, /\.pve-panel > \.glass\.group \+ \.mx-panel/)
	assert.match(machines, /machinesCompact: true/)
	const prefsSync = await read('../web/src/prefsSync.ts')
	assert.match(prefsSync, /'machinesCompact'/)
	assert.match(prefsSync, /'statPicks'/)
	assert.match(prefsSync, /'tempPicks'/)
	assert.match(prefsSync, /'tempUnit'/)
	const prefsApi = await read('../server/app.mjs')
	assert.match(prefsApi, /patch\.machinesCompact = machinesCompact/)
	assert.match(prefsApi, /Bad stat choice/)
	assert.match(prefsApi, /Bad temperature choice/)
	assert.match(prefsApi, /Bad temperature unit/)
	const region = await read('../web/src/fleet/StatRegion.tsx')
	assert.match(region, /Choose stats/)
	assert.match(region, /Temperatures/)
	assert.match(region, /Fahrenheit/)
	assert.match(css, /\.temp-dialog:modal/)
	assert.doesNotMatch(css, /\.temp-dialog \{[^}]*display:/)
})

test('filters and search keep the fleet order', () => {
	const rows = [
		{kind: 'server', name: 'Den'},
		{kind: 'computer', name: 'Loft'},
		{kind: 'guest', name: 'V-Machine-001'},
		{kind: 'computer', name: 'Garage'},
	]
	assert.deepEqual(
		managerRows(rows, 'all', '').map((r) => r.name),
		['Den', 'Loft', 'V-Machine-001', 'Garage'],
	)
	assert.deepEqual(
		managerRows(rows, 'physical', '').map((r) => r.name),
		['Den', 'Loft', 'Garage'],
	)
	assert.deepEqual(
		managerRows(rows, 'virtual', 'machine').map((r) => r.name),
		['V-Machine-001'],
	)
	assert.equal(passesFilter('server', 'physical'), true)
	assert.equal(passesFilter('guest', 'physical'), false)
	assert.equal(matchesName('Machine-001', ' 001 '), true)
	assert.equal(matchesName('Machine-001', 'zzz'), false)
})

test('Virtual filter includes containers and guests', () => {
	assert.equal(passesFilter('container', 'virtual'), true)
	assert.equal(passesFilter('container', 'physical'), false)
	assert.equal(passesFilter('guest', 'virtual'), true)
	assert.deepEqual(reachLabel('container', true, 'running'), {kind: 'running', label: 'Online'})
	assert.deepEqual(reachLabel('container', false, 'stopped'), {kind: 'stopped', label: 'Offline'})
	assert.deepEqual(reachLabel('container', false, 'frozen'), {kind: 'stopped', label: 'Paused'})
})

test('unhealthy and offline sit beside the type filters', () => {
	const rows = [
		{kind: 'server', name: 'Den', offline: false, health: 'healthy'},
		{kind: 'computer', name: 'Loft', offline: false, health: 'warning'},
		{kind: 'guest', name: 'Paused', offline: false, health: 'unknown'},
		{kind: 'guest', name: 'Down', offline: true, health: 'unknown'},
		{kind: 'computer', name: 'Garage', offline: true, health: 'danger'},
	]
	assert.deepEqual(
		managerRows(rows, 'unhealthy', '').map((r) => r.name),
		['Loft', 'Garage'],
	)
	assert.deepEqual(
		managerRows(rows, 'offline', '').map((r) => r.name),
		['Down', 'Garage'],
	)
	assert.deepEqual(
		managerRows(rows, 'unhealthy', 'gar').map((r) => r.name),
		['Garage'],
	)
	assert.equal(passesFilter('guest', 'offline', {offline: false, health: 'unknown'}), false)
	assert.equal(passesFilter('guest', 'unhealthy', {offline: true, health: 'unknown'}), false)
	assert.equal(passesFilter('computer', 'unhealthy', {offline: false, health: 'danger'}), true)
	assert.deepEqual(
		managerRows(
			[
				{kind: 'server', name: 'Den', offline: false, online: true, health: 'healthy'},
				{kind: 'computer', name: 'Loft', offline: false, online: true, health: 'warning'},
				{kind: 'guest', name: 'Paused', offline: false, online: false, health: 'unknown'},
			],
			'healthy',
			'',
		).map((r) => r.name),
		['Den'],
	)
	assert.deepEqual(
		managerRows(
			[
				{kind: 'server', name: 'Den', offline: false, online: true, health: 'healthy'},
				{kind: 'guest', name: 'Paused', offline: false, online: false, health: 'unknown'},
				{kind: 'guest', name: 'Down', offline: true, online: false, health: 'unknown'},
			],
			'online',
			'',
		).map((r) => r.name),
		['Den'],
	)
	assert.equal(passesFilter('guest', 'healthy', {health: 'unknown'}), false)
	assert.equal(passesFilter('guest', 'online', {online: false, offline: false}), false)
	assert.equal(nextFilter('all', 'kind'), 'physical')
	assert.equal(nextFilter('physical', 'kind'), 'virtual')
	assert.equal(nextFilter('virtual', 'kind'), 'physical')
	assert.equal(nextFilter('virtual', 'health'), 'unhealthy')
	assert.equal(nextFilter('unhealthy', 'health'), 'healthy')
	assert.equal(nextFilter('healthy', 'health'), 'unhealthy')
	assert.equal(nextFilter('all', 'reach'), 'offline')
	assert.equal(nextFilter('offline', 'reach'), 'online')
	assert.equal(nextFilter('online', 'reach'), 'offline')
	assert.equal(nextFilter('online', 'all'), 'all')
	assert.equal(filterSlot('virtual'), 'kind')
	assert.equal(filterSlot('healthy'), 'health')
	assert.equal(filterSlot('online'), 'reach')
	assert.equal(filterSlot('all'), 'all')
	assert.equal(filterLabel('all', 'kind'), 'Physical')
	assert.equal(filterLabel('virtual', 'kind'), 'Virtual')
	assert.equal(filterLabel('healthy', 'health'), 'Healthy')
	assert.equal(filterLabel('online', 'reach'), 'Online')
	assert.equal(isOnline('guest', true, 'running'), true)
	assert.equal(isOnline('guest', false, 'suspended'), false)
	assert.equal(isOnline('guest', false, 'stopped'), false)
	assert.equal(isOnline('computer', true), true)
	assert.equal(isOnline('server', false), false)
	assert.equal(isOffline('guest', false, 'stopped'), true)
	assert.equal(isOffline('guest', false, 'suspended'), false)
	assert.equal(isOffline('guest', false, 'hibernated'), false)
	assert.equal(isOffline('guest', false, 'error'), false)
	assert.equal(isOffline('guest', false, 'starting'), false)
	assert.equal(isOffline('computer', false), true)
	assert.equal(isOffline('server', true), false)
})

test('filter changes keep leavers in their gap and open a gap for new rows', () => {
	const ids = (rows) => rows.map((r) => `${r.id}:${r.phase}`)
	assert.deepEqual(ids(mergeMotion(['A', 'B', 'C', 'D'], ['A', 'C', 'E'])), ['A:stay', 'B:leave', 'C:stay', 'E:enter', 'D:leave'])
	assert.deepEqual(ids(mergeMotion(['A', 'D'], ['A', 'B', 'C', 'D'])), ['A:stay', 'B:enter', 'C:enter', 'D:stay'])
	assert.deepEqual(ids(mergeMotion(['A', 'B', 'C', 'D'], ['A', 'D'])), ['A:stay', 'B:leave', 'C:leave', 'D:stay'])
	assert.deepEqual(ids(mergeMotion(['A', 'B'], ['C', 'D'])), ['C:enter', 'D:enter', 'A:leave', 'B:leave'])
	assert.deepEqual(ids(mergeMotion(['B', 'A'], ['C', 'A'])), ['C:enter', 'B:leave', 'A:stay'])
	assert.deepEqual(ids(mergeMotion(['A', 'B', 'C', 'E', 'D'], ['A', 'B', 'C'])), ['A:stay', 'B:stay', 'C:stay', 'E:leave', 'D:leave'])
	assert.deepEqual(ids(mergeMotion(['A', 'B'], ['A', 'B'])), ['A:stay', 'B:stay'])
	assert.deepEqual(ids(mergeMotion([], ['A'])), ['A:enter'])
	assert.deepEqual(ids(mergeMotion(['A'], [])), ['A:leave'])
})

test('reachability and health stay inside the readings we have', () => {
	assert.deepEqual(reachLabel('computer', true), {kind: 'running', label: 'Online'})
	assert.deepEqual(reachLabel('guest', false, 'suspended'), {kind: 'stopped', label: 'Paused'})
	assert.deepEqual(reachLabel('guest', false, 'error'), {kind: 'error', label: 'Error'})
	assert.equal(managerHealth({kind: 'guest', online: true, connectorOnline: false, alert: null, gauges: [{name: 'CPU', percent: 10, ready: true}]}), 'unknown')
	assert.equal(managerHealth({kind: 'computer', online: false, connectorOnline: false, alert: 'critical', gauges: []}), 'unknown')
	assert.equal(managerHealth({kind: 'computer', online: true, connectorOnline: true, alert: 'critical', gauges: []}), 'danger')
	assert.equal(managerHealth({kind: 'computer', online: true, connectorOnline: true, alert: 'warning', gauges: [{name: 'CPU', percent: 10, ready: true}]}), 'warning')
	assert.equal(managerHealth({kind: 'server', online: true, connectorOnline: true, alert: null, gauges: [{name: 'CPU', percent: 91, ready: true}]}), 'danger')
	assert.equal(managerHealth({kind: 'server', online: true, connectorOnline: true, alert: null, gauges: [{name: 'Battery', percent: 20, ready: true}]}), 'warning')
	assert.equal(managerHealth({kind: 'server', online: true, connectorOnline: true, alert: null, gauges: [{name: 'CPU', percent: 10, ready: true}]}), 'healthy')
	assert.equal(managerHealth({kind: 'server', online: true, connectorOnline: true, alert: null, gauges: []}), 'unknown')
	assert.equal(healthPill('unknown').label, 'Unknown')
})

test('power, terminal, and desktop follow state and grants', () => {
	assert.deepEqual(managerPower({kind: 'server', online: true, manage: true}), [])
	assert.deepEqual(managerPower({kind: 'computer', online: false, manage: true}), [])
	assert.deepEqual(managerPower({kind: 'computer', online: true, manage: true}), ['suspend', 'reboot', 'shutdown'])
	assert.deepEqual(managerPower({kind: 'computer', online: true, manage: false}), [])
	assert.deepEqual(managerPower({kind: 'guest', online: false, manage: false, state: 'stopped'}), ['start'])
	assert.deepEqual(managerPower({kind: 'guest', online: false, manage: false, state: 'hibernated'}), ['resume'])
	assert.deepEqual(managerPower({kind: 'guest', online: true, manage: false, state: 'running'}), ['shutdown', 'reboot', 'pause'])
	assert.deepEqual(managerPower({kind: 'guest', online: false, manage: false, state: 'suspended'}), ['resume', 'stop'])
	assert.deepEqual(managerPower({kind: 'guest', online: false, manage: false, state: 'starting'}), [])
	const guest = {kind: 'guest', owner: false, serverTerminal: false, desktopGranted: false, desktopOk: false}
	assert.deepEqual(managerAccess({...guest, linkOnline: false, terminalGranted: false, guestRunning: true}), {terminal: false, desktop: true})
	assert.deepEqual(managerAccess({...guest, linkOnline: true, terminalGranted: true, guestRunning: true}), {terminal: true, desktop: true})
	assert.deepEqual(managerAccess({...guest, linkOnline: true, terminalGranted: true, guestRunning: false}), {terminal: false, desktop: false})
	assert.deepEqual(managerAccess({kind: 'computer', linkOnline: true, owner: false, serverTerminal: false, terminalGranted: true, desktopGranted: true, desktopOk: false, guestRunning: false}), {terminal: true, desktop: false})
	assert.deepEqual(managerAccess({kind: 'server', linkOnline: true, owner: true, serverTerminal: true, terminalGranted: false, desktopGranted: false, desktopOk: false, guestRunning: false}), {terminal: true, desktop: true})
	assert.deepEqual(managerAccess({kind: 'server', linkOnline: true, owner: false, serverTerminal: false, terminalGranted: false, desktopGranted: false, desktopOk: false, guestRunning: false}), {terminal: false, desktop: false})
})

test('squares use real readings, and up time replaces last seen', () => {
	const stats = managerStats({
		gauges: [{k: 'CPU', icon: 'cpu', p: 18.2, ready: true}],
		temp: null,
		diskSizeGb: 32,
	})
	assert.deepEqual(
		stats.map((s) => [s.label, s.text, s.dial]),
		[
			['CPU', '18%', true],
			['Storage', '? of 32 GB', true],
		],
	)
	const withTemp = managerStats({gauges: [{k: 'CPU', icon: 'cpu', p: 0, ready: false}], temp: 61.2, diskSizeGb: null})
	assert.equal(withTemp[1].text, '61°')
	assert.equal(withTemp[1].dial, true)
	assert.deepEqual(
		valueDials(managerStats({gauges: [{k: 'CPU', icon: 'cpu', p: 18.2, ready: true}], temp: 61.2, diskSizeGb: 32})).map((d) => [d.label, d.text]),
		[
			['Storage', '? of 32 GB'],
			['Temperature', '61°'],
		],
	)
	const now = Date.parse('2026-11-23T12:00:00Z')
	assert.deepEqual(seenFact(true, 9000, null, now), {label: 'Up time', text: '2h 30m'})
	assert.equal(seenFact(true, undefined, now - 86_400_000, now), null)
	assert.deepEqual(seenFact(false, undefined, now - 3 * 86_400_000, now), {label: 'Last seen', text: '3d 0h ago'})
	assert.equal(seenFact(false, undefined, null, now), null)
})

test('the list uses the account drawing and does not keep a separate dial choice', async () => {
	assert.equal(MANAGER_DIALS_KEY, 'omarchy-server:mm-dials')
	assert.equal(loadManagerDials(null), false)
	assert.equal(loadManagerDials('0'), false)
	assert.equal(loadManagerDials('1'), true)
	assert.equal(saveManagerDials(true), '1')
	assert.equal(saveManagerDials(false), '0')
	const ui = await read('../web/src/fleet/MachineManager.tsx')
	assert.match(ui, /StatRegion/)
	assert.match(ui, /LiveStats/)
	assert.doesNotMatch(ui, /MANAGER_DIALS_KEY/)
	assert.doesNotMatch(ui, /setDials/)
	const openAnother = ui.slice(ui.indexOf('const toggle = (id: string)'), ui.indexOf('return (', ui.indexOf('const toggle = (id: string)')))
	assert.match(openAnother, /setOpenId/)
	assert.doesNotMatch(openAnother, /setDials/)
	const filterCollapse = ui.slice(ui.indexOf('}, [queryText, filter])') - 80, ui.indexOf('}, [queryText, filter])'))
	assert.doesNotMatch(filterCollapse, /setDials/)
	const leaveList = ui.slice(ui.indexOf('if (openId && !matched.includes(openId))'), ui.indexOf('}, [rowKey, openId])'))
	assert.doesNotMatch(leaveList, /setDials/)
})

test('a joined computer’s manage page can create a virtual machine', async () => {
	const swarm = await read('../web/src/swarm/Swarm.tsx')
	assert.match(swarm, /onCreateVm/)
	assert.match(swarm, /Create VM/)
	assert.match(swarm, /Virtual machines/)
	const machines = await read('../web/src/screens/Machines.tsx')
	assert.match(machines, /LocalSwarm[\s\S]*onCreateVm=\{setCreateHost\}/)
})
