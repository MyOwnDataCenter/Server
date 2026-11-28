import assert from 'node:assert/strict'
import {test} from 'node:test'

import {installLxcConnector, lxcConnectorAbilities, lxcConnectorAllowList} from '../omarchyd/lxc-install.mjs'
import {createContainers} from '../omarchyd/containers.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

test('lxc abilities omit desktop, storage, and vms', () => {
	const abilities = lxcConnectorAbilities()
	assert.equal(abilities.terminal, true)
	assert.equal(abilities.files, true)
	assert.equal(abilities.backup, true)
	assert.equal(abilities.manage, true)
	assert.equal(abilities.services, true)
	assert.equal(abilities.desktop, undefined)
	assert.equal(lxcConnectorAllowList(abilities), 'terminal,files,manage,backup,services')
	assert.equal(lxcConnectorAllowList({...abilities, desktop: true, storage: true, vms: true}), 'terminal,files,manage,backup,services')
})

test('lxc install pairs with containerOf and runs exec', async () => {
	const calls = []
	const pair = async (input) => {
		calls.push(['pair', input])
		return {token: 't', ca: 'a'.repeat(64), source: 'https://example.test', port: 7780, addresses: [{address: '10.0.0.1'}]}
	}
	const run = async (args, opts = {}) => {
		calls.push(['incus', args, opts.input ? 'with-input' : ''])
		return ''
	}
	await installLxcConnector({
		name: 'web',
		username: 'joseph',
		osId: 'debian',
		run,
		pair,
		listAgents: async () => [{containerOf: 'web'}],
		caCertificate: async () => '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
		sleep: async () => {},
		enrollTimeoutMs: 100,
	})
	assert.equal(calls[0][0], 'pair')
	assert.equal(calls[0][1].containerOf, 'web')
	assert.equal(calls[0][1].desktop, undefined)
	assert.equal(calls[0][1].storage, undefined)
	assert.equal(calls[0][1].vms, undefined)
	assert.equal(calls[0][1].terminal, true)
	assert.equal(calls[0][1].files, true)
	assert.ok(calls.some((c) => c[0] === 'incus'))
})

test('the container page offers Install connector for the owner', async () => {
	const {readFile} = await import('node:fs/promises')
	const ui = await readFile(new URL('../web/src/containers/Containers.tsx', import.meta.url), 'utf8')
	assert.match(ui, /containers\.installConnector/)
	assert.match(ui, /Install connector/)
	assert.match(ui, /containerAgent/)
	assert.match(ui, /linuxConnectorOs/)
})

test('containers.installConnector requires a running container and a username', async () => {
	const rows = [{name: 'web', type: 'container', status: 'Stopped', config: {'image.os': 'Debian'}, devices: {}, expanded_devices: {}, state: {}}]
	const run = async (args) => {
		if (args[0] === 'list') return JSON.stringify(rows)
		if (args[0] === 'query') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		return ''
	}
	const pairCalls = []
	const ct = createContainers({
		run,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return {token: 't', ca: 'a'.repeat(64), source: 'https://example.test', port: 7780, addresses: [{address: '10.0.0.1'}]}
			},
			list: async () => [],
			caCertificate: async () => '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
		},
	})
	await assert.rejects(() => ct.procedures['containers.installConnector'].run({name: 'web'}), (e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED')
	rows[0].status = 'Running'
	await assert.rejects(() => ct.procedures['containers.installConnector'].run({name: 'web'}), (e) => e instanceof RpcError && /account|username/i.test(e.message))
	assert.deepEqual(pairCalls, [])
})
