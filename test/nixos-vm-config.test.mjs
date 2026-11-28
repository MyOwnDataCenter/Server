import assert from 'node:assert/strict'
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {readNixCache, writeNixCache} from '../omarchyd/nix-cache.mjs'
import {configDir, validateNixosConfig} from '../omarchyd/nixos-config.mjs'
import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const EXAMPLE = `{ config, pkgs, ... }:
{
  system.stateVersion = "24.11";
}
`

const DEBIAN = {
	id: 'testos-amd64',
	familyId: 'debian',
	name: 'TestOS',
	version: '1',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/os.qcow2',
	checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'},
	sizeMb: 1,
	adminGroup: 'sudo',
}

const NIXOS = {
	id: 'modc-nixos-test-amd64',
	familyId: 'nixos',
	nixos: true,
	name: 'NixOS',
	version: '24.11',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/nixos.qcow2',
	sha256: '0'.repeat(64),
	sizeMb: 1,
	adminGroup: 'wheel',
}

async function openMachines(dataDir, catalogUrl) {
	await mkdir(dataDir, {recursive: true})
	const kvm = join(dataDir, 'kvm')
	await writeFile(kvm, '')
	const m = createMachines({
		dataDir,
		catalogUrl,
		arch: 'amd64',
		fetchImpl: async () => new Response('image', {status: 200}),
		run: async (cmd, args) => {
			if (cmd === 'virsh' && (args.at(-1) === '--version' || args[0] === '--version')) return '10.0.0\n'
			if (cmd === 'qemu-img' && args[0] === '--version') return '9.0.0\n'
			if (cmd === 'openssl') return '$6$rounds=5000$saltsalt$hash\n'
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
				return ''
			}
			return ''
		},
		kvmDevice: kvm,
		watchIdleMs: 1,
		statsIntervalMs: 60_000,
	})
	await m.ready
	return m
}

test('bundled catalog includes NixOS stub', async () => {
	const bundled = fileURLToPath(new URL('../omarchyd/machine-catalog.json', import.meta.url))
	const {images} = JSON.parse(await readFile(bundled, 'utf8'))
	const img = images.find((i) => i.id === 'modc-nixos-24.11-amd64')
	assert.ok(img)
	assert.equal(img.familyId, 'nixos')
	assert.equal(img.nixos, true)
})

test('create refuses nixosConfig on non-NixOS image', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-refuse-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [DEBIAN]}))
		const m = await openMachines(dataDir, catalogUrl)
		await assert.rejects(
			() =>
				m.procedures['machines.create'].run({
					name: 'Ubuntu-ish',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					username: 'chris',
					password: 'hunter2',
					nixosConfig: EXAMPLE,
				}),
			(e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && /only for NixOS/i.test(e.message),
		)
	} finally {
		await mkdir(root, {recursive: true}).catch(() => {})
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true})
	}
})

test('create writes config share and records nixos flag', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-create-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [NIXOS]}))
		await mkdir(dataDir, {recursive: true})
		await writeNixCache(dataDir, {enabled: true, substituter: 'https://cache.example.test'})
		const m = await openMachines(dataDir, catalogUrl)
		const {id} = await m.procedures['machines.create'].run({
			name: 'NixBox',
			osId: NIXOS.id,
			cores: 1,
			memoryGb: 1,
			diskSizeGb: 10,
			username: 'chris',
			password: 'hunter2',
			nixosConfig: EXAMPLE,
		})
		const saved = JSON.parse(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8'))
		const rec = saved.machines.find((x) => x.id === id)
		assert.equal(rec?.nixos, true)
		const cfg = await readFile(join(configDir(dataDir, id), 'configuration.nix'), 'utf8')
		assert.equal(validateNixosConfig(cfg).ok, true)
		const cache = await readNixCache(dataDir)
		const fragment = await readFile(join(configDir(dataDir, id), 'nix-cache.conf'), 'utf8')
		assert.match(fragment, new RegExp(cache.substituter.replaceAll('/', '\\/')))
		await access(join(dataDir, 'nixos-configs', id, 'configuration.nix'))
		await new Promise((r) => setTimeout(r, 50))
	} finally {
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}).catch(() => {})
	}
})