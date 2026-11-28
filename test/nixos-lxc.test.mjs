import assert from 'node:assert/strict'
import {test} from 'node:test'

import {applyNixosConfig, isNixosOs, NIXOS_EXAMPLE, readNixosConfig, validateNixosConfig} from '../omarchyd/nixos-lxc.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {createContainers} from '../omarchyd/containers.mjs'

test('nixos config validation and os detect', () => {
	assert.equal(isNixosOs('nixos'), true)
	assert.equal(isNixosOs('debian'), false)
	assert.equal(validateNixosConfig('').ok, true)
	assert.equal(validateNixosConfig(NIXOS_EXAMPLE).ok, true)
	assert.equal(validateNixosConfig('not nix').ok, false)
	assert.equal(validateNixosConfig(`x${'\0'}`).ok, false)
})

test('apply writes configuration.nix then rebuilds', async () => {
	const calls = []
	const run = async (args, opts = {}) => {
		calls.push({args, input: opts.input === undefined ? undefined : String(opts.input).slice(0, 40)})
		return ''
	}
	await applyNixosConfig({name: 'box', config: NIXOS_EXAMPLE, run, sleep: async () => {}})
	assert.ok(calls.some((c) => c.args[0] === 'file' && c.args[1] === 'push' && String(c.args[2] ?? '').includes('-')))
	assert.ok(calls.some((c) => c.args.includes('nixos-rebuild') && c.args.includes('switch')))
	assert.equal(calls[0].args[0], 'exec')
})

test('read returns empty when the file is missing', async () => {
	const run = async () => {
		throw Object.assign(new Error('missing'), {code: 1})
	}
	assert.deepEqual(await readNixosConfig({name: 'box', run}), {path: '/etc/nixos/configuration.nix', config: '', present: false})
})

test('create refuses nixosConfig on a non-NixOS image', async () => {
	const list = []
	const images = [
		{
			type: 'container',
			architecture: 'x86_64',
			size: 1e8,
			aliases: [{name: 'debian/12'}],
			properties: {os: 'Debian', release: '12', architecture: 'amd64', variant: 'default', description: 'Debian 12'},
		},
	]
	const run = async (args) => {
		if (args[0] === 'list') return JSON.stringify(list)
		if (args[0] === 'image') return JSON.stringify(images)
		if (args[0] === 'query') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		return ''
	}
	const p = createContainers({run}).procedures
	await assert.rejects(
		() => p['containers.create'].run({name: 'web', image: 'debian/12', nixosConfig: NIXOS_EXAMPLE}),
		(e) => e instanceof RpcError && /NixOS/i.test(e.message),
	)
})

test('create NixOS with config enables nesting and schedules apply', async () => {
	const list = []
	const images = [
		{
			type: 'container',
			architecture: 'x86_64',
			size: 1e8,
			aliases: [{name: 'nixos/24.11'}],
			properties: {os: 'NixOS', release: '24.11', architecture: 'amd64', variant: 'default', description: 'NixOS 24.11'},
		},
	]
	const calls = []
	const run = async (args, opts = {}) => {
		calls.push(args)
		if (args[0] === 'list') return JSON.stringify(list)
		if (args[0] === 'image') return JSON.stringify(images)
		if (args[0] === 'query') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		if (args[0] === 'launch') {
			list.push({
				name: 'nix1',
				status: 'Running',
				config: {'image.os': 'nixos', 'image.release': '24.11', 'user.modc.nixos': 'true', 'security.nesting': 'true'},
				expanded_devices: {root: {size: '8GiB'}},
				state: {network: {}},
				snapshots: [],
			})
			return ''
		}
		return ''
	}
	const tmp = await import('node:fs/promises').then(async (fs) => {
		const os = await import('node:os')
		const path = await import('node:path')
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nixos-lxc-'))
		return dir
	})
	const p = createContainers({run, dataDir: tmp}).procedures
	await p['containers.create'].run({name: 'nix1', image: 'nixos/24.11', nixosConfig: NIXOS_EXAMPLE})
	const launch = calls.find((a) => a[0] === 'launch')
	assert.ok(launch)
	assert.ok(launch.includes('security.nesting=true') || launch.some((x, i) => x === '--config' && String(launch[i + 1]).includes('security.nesting=true')))
	// Wait for background apply job to start writing.
	for (let i = 0; i < 40 && !calls.some((a) => a.includes('nixos-rebuild')); i++) await new Promise((r) => setTimeout(r, 25))
	assert.ok(calls.some((a) => a.includes('nixos-rebuild') && a.includes('switch')))
})

test('nix cache settings persist', async () => {
	const fs = await import('node:fs/promises')
	const os = await import('node:os')
	const path = await import('node:path')
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nix-cache-'))
	const run = async (args) => {
		if (args[0] === 'list') return '[]'
		if (args[0] === 'image') return '[]'
		if (args[0] === 'query') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		return ''
	}
	const p = createContainers({run, dataDir: dir}).procedures
	assert.deepEqual(await p['containers.nixCache'].run(), {enabled: false, substituter: ''})
	await p['containers.setNixCache'].run({enabled: true, substituter: 'http://10.0.0.1:5000'})
	assert.deepEqual(await p['containers.nixCache'].run(), {enabled: true, substituter: 'http://10.0.0.1:5000'})
})
