// A virtual machine's connector is the same Linux connector, remembered against that guest.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConnector} from '../omarchyd/connector.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {connectorKind, containerAgent, guestAgent, guestPoweredOffAt, guestUptimeSeconds, hostGuestMetrics, isContainerAgent, isGuestAgent, linuxConnectorOs} from '../web/src/swarm/guestLink.ts'

test('the connector installs on Linux guests, and host stats omit disk use', () => {
	assert.equal(connectorKind('ubuntu'), 'linux')
	assert.equal(connectorKind('omarchy'), 'linux')
	assert.equal(connectorKind(''), 'linux')
	assert.equal(connectorKind('windows-11'), 'unsupported')
	assert.equal(connectorKind('macos'), 'unsupported')
	assert.equal(connectorKind('haos'), 'unsupported')
	assert.equal(connectorKind('alpine'), 'linux')
	assert.equal(linuxConnectorOs('ubuntu'), true)
	assert.equal(linuxConnectorOs(''), true)
	assert.equal(linuxConnectorOs('omarchy'), true)
	assert.equal(linuxConnectorOs('windows-11'), false)
	assert.equal(linuxConnectorOs('macos'), false)
	assert.equal(linuxConnectorOs('haos'), false)
	assert.equal(linuxConnectorOs('home-assistant'), false)
	assert.equal(linuxConnectorOs('alpine'), true)
	const metrics = hostGuestMetrics({cpu: 12, memMb: 512}, 1024, 2)
	assert.equal(metrics.cpu, 12)
	assert.equal(metrics.cores, 2)
	assert.equal(metrics.mem.used, 512 * 1024 * 1024)
	assert.equal(metrics.mem.total, 1024 * 1024 * 1024)
	assert.equal(metrics.disks, undefined)
	assert.equal(hostGuestMetrics(null, 1024, 2), null)
	const online = {guestOf: 'abcd1234', online: true, enrolledAt: 1, id: 'new'}
	const older = {guestOf: 'abcd1234', online: false, enrolledAt: 9, id: 'old'}
	assert.equal(guestAgent([older, online], 'abcd1234').id, 'new')
	assert.equal(guestAgent([older], 'abcd1234').id, 'old')
	assert.equal(guestAgent([online], 'ffffffff'), undefined)
	assert.equal(isGuestAgent({guestOf: 'abcd1234'}), true)
	assert.equal(isGuestAgent({guestOf: ''}), false)
	assert.equal(isGuestAgent({}), false)
	const now = 10_000_000
	const start = {type: 'start', status: 'ok', startedAt: now - 3_600_000, endedAt: now - 3_598_000}
	assert.equal(guestUptimeSeconds([start], now), 3598)
	assert.equal(guestUptimeSeconds([{type: 'stop', status: 'ok', startedAt: now - 1000, endedAt: now - 500}, start], now), null)
	assert.equal(guestUptimeSeconds([{type: 'reboot', status: 'ok', startedAt: now - 120_000, endedAt: now - 60_000}, start], now), 60)
	assert.equal(guestPoweredOffAt([{type: 'shutdown', status: 'ok', startedAt: now - 50_000, endedAt: now - 40_000}, start]), now - 40_000)
	assert.equal(guestPoweredOffAt([start]), null)
	assert.equal(guestUptimeSeconds([{type: 'start', status: 'error', startedAt: now - 1000, endedAt: now - 500}], now), null)
})

test('pairing a virtual machine keeps the connector off the physical computer list', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-connector-'))
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=t'], {cwd: root, stdio: 'ignore'})
		const swarm = createConnector({dataDir: root, tlsDir: root, source: async () => 'https://example.test'})
		try {
			await assert.rejects(() => swarm.procedures['swarm.pair'].run({machineId: 'not-a-vm', terminal: true}), (e) => e instanceof RpcError && e.code === 'BAD_REQUEST')
			const {token} = await swarm.procedures['swarm.pair'].run({machineId: 'abcd1234', terminal: true, desktop: true, files: true})
			const joined = await swarm.enroll({token, info: {hostname: 'guest'}, abilities: {terminal: true, desktop: true, files: true, manage: false, storage: false, backup: false}})
			assert.equal(joined.status, 200)
			const [guest] = await swarm.procedures['swarm.list'].run()
			assert.equal(guest.guestOf, 'abcd1234')
			assert.equal(guest.allowed.terminal, true)
			assert.equal(guest.allowed.files, true)
			const physical = await swarm.procedures['swarm.pair'].run({terminal: true})
			const pc = await swarm.enroll({token: physical.token, info: {hostname: 'pc'}, abilities: {terminal: true}})
			assert.equal(pc.status, 200)
			const list = await swarm.procedures['swarm.list'].run()
			assert.equal(list.find((a) => a.id === pc.body.id).guestOf, '')
			const saved = JSON.parse(await readFile(join(root, 'swarm.json'), 'utf8'))
			assert.equal(saved.agents.find((a) => a.id === pc.body.id).guestOf, undefined)
			assert.equal(saved.agents.find((a) => a.guestOf === 'abcd1234').id, guest.id)
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a guest pairing code lasts six hours; a computer pairing code lasts fifteen minutes', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-pair-ttl-'))
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=t'], {cwd: root, stdio: 'ignore'})
		const now = 1_700_000_000_000
		const swarm = createConnector({dataDir: root, tlsDir: root, source: async () => 'https://example.test', now: () => now})
		try {
			const guest = await swarm.procedures['swarm.pair'].run({machineId: 'abcd1234', terminal: true})
			assert.equal(guest.expiresAt, now + 6 * 60 * 60_000)
			const computer = await swarm.procedures['swarm.pair'].run({terminal: true})
			assert.equal(computer.expiresAt, now + 15 * 60_000)
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('pairing a system container keeps the connector linked with containerOf', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'lxc-connector-'))
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=t'], {cwd: root, stdio: 'ignore'})
		const now = 1_700_000_000_000
		const swarm = createConnector({dataDir: root, tlsDir: root, source: async () => 'https://example.test', now: () => now})
		try {
			await assert.rejects(() => swarm.procedures['swarm.pair'].run({containerOf: 'Bad_Name', terminal: true}), (e) => e instanceof RpcError && e.code === 'BAD_REQUEST')
			await assert.rejects(
				() => swarm.procedures['swarm.pair'].run({machineId: 'abcd1234', containerOf: 'web', terminal: true}),
				(e) => e instanceof RpcError && e.code === 'BAD_REQUEST',
			)
			const {token, expiresAt} = await swarm.procedures['swarm.pair'].run({containerOf: 'web', terminal: true, files: true, backup: true, manage: true})
			assert.equal(expiresAt, now + 6 * 60 * 60_000)
			const joined = await swarm.enroll({token, info: {hostname: 'web', environment: 'lxc'}, abilities: {terminal: true, files: true, backup: true, manage: true, desktop: false, storage: false, vms: false, containers: false}})
			assert.equal(joined.status, 200)
			const [agent] = await swarm.procedures['swarm.list'].run()
			assert.equal(agent.containerOf, 'web')
			assert.equal(agent.guestOf, '')
			assert.equal(agent.allowed.terminal, true)
			assert.equal(agent.allowed.files, true)
			assert.equal(agent.allowed.desktop, false)
			const saved = JSON.parse(await readFile(join(root, 'swarm.json'), 'utf8'))
			assert.equal(saved.agents.find((a) => a.id === agent.id).containerOf, 'web')
			assert.equal(isContainerAgent({containerOf: 'web'}), true)
			assert.equal(isContainerAgent({containerOf: 'Bad'}), false)
			assert.equal(containerAgent([{...agent, online: true}], 'web').id, agent.id)
			assert.equal(containerAgent([{...agent, online: true}], 'other'), undefined)
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an older connector file still loads, and a bad guest id does not hide the computer', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-connector-old-'))
	try {
		const saved = JSON.stringify({
			agents: [
				{id: 'aabbccddeeff', name: 'Study PC', keyHash: 'ab', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 1},
				{id: 'bbccddeeff00', name: 'Odd', keyHash: 'cd', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 2, guestOf: 'not-hex'},
				{id: 'ccddeeff0011', name: 'Odd LXC', keyHash: 'ef', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 3, containerOf: 'Not Valid'},
			],
		})
		await writeFile(join(root, 'swarm.json'), saved)
		const swarm = createConnector({dataDir: root, tlsDir: root})
		try {
			const listed = await swarm.procedures['swarm.list'].run()
			assert.deepEqual(
				listed.map((a) => [a.id, a.guestOf, a.containerOf]),
				[
					['aabbccddeeff', '', ''],
					['bbccddeeff00', '', ''],
					['ccddeeff0011', '', ''],
				],
			)
			assert.equal(await readFile(join(root, 'swarm.json'), 'utf8'), saved)
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('the machine page runs machines.installConnector and asks for a password', async () => {
	const guest = await readFile(new URL('../web/src/fleet/GuestLive.tsx', import.meta.url), 'utf8')
	assert.match(guest, /machines\.installConnector/)
	assert.match(guest, /useMachineDetails/)
	assert.match(guest, /taskId/)
	assert.match(guest, /type === 'connector'/)
	assert.match(guest, /status === 'running'/)
	assert.match(guest, /status === 'error'/)
	assert.match(guest, /message \?\? 'Install failed'/)
	assert.match(guest, /className="primary-row"/)
	assert.match(guest, /primary-row-spacer/)
	assert.match(guest, /primary-row-pin-slot/)
	assert.doesNotMatch(guest, /className="actions"/)
	assert.match(guest, /useMachineDetails\(!agent && canInstall/)
	const started = /if \(out\.status === 'started'\) \{[\s\S]*?\n\t{4}\}/.exec(guest)
	assert.ok(started, 'started branch is its own block')
	assert.doesNotMatch(started[0], /setBusy\(false\)/)
	assert.match(started[0], /taskId/)
	assert.match(guest, /type="password"/)
	assert.match(guest, /autoComplete="off"|autocomplete="off"/)
	assert.match(guest, /onOpenStorage\(\{agentId: agent\.id, name: machine\.name\}\)/)
	assert.doesNotMatch(guest, /swarm\.isFetched && !agent && linux &&/)
	assert.match(guest, /This operating system can’t run the connector\. It runs on Linux with systemd or Alpine OpenRC\./)
	assert.match(guest, /The connector runs on Linux with systemd or Alpine OpenRC/)
	const swarm = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(swarm, /linuxConnectorOs\(guest\.osId/)
	assert.match(swarm, /can’t run the connector/)
	assert.match(swarm, /Linux with systemd or Alpine OpenRC/)
	assert.match(swarm, /osId\?/)
	const vision = await readFile(new URL('../docs/vision.md', import.meta.url), 'utf8')
	assert.match(vision, /It runs on Linux with systemd or Alpine OpenRC/)
	const style = await readFile(new URL('../docs/style-guide.md', import.meta.url), 'utf8')
	assert.match(style, /Offer Install connector when the guest can run Linux with systemd or Alpine OpenRC/)
	const api = await readFile(new URL('../web/src/api.ts', import.meta.url), 'utf8')
	assert.match(api, /['"]machines\.installConnector['"]/)
})
