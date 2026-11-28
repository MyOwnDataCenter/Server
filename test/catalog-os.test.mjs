import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines, findChecksum} from '../omarchyd/machines.mjs'
import {statReadings} from '../web/src/fleet/statView.ts'
import {swarmGaugeItems} from '../web/src/swarm/gauges.ts'
import {memoryUsage} from '../omarchyd/system.mjs'

test('publisher checksum lines match the catalog filenames', () => {
	assert.equal(
		findChecksum('563932158571f5e7cd42834aa54f8027be198653844125b7467756a5ec5aa651  Leap-16.1-Minimal-VM.x86_64-Cloud.qcow2\n', 'Leap-16.1-Minimal-VM.x86_64-Cloud.qcow2', 'sha256'),
		'563932158571f5e7cd42834aa54f8027be198653844125b7467756a5ec5aa651',
	)
	assert.equal(
		findChecksum('SHA256 (Rocky-10-GenericCloud-Base-10.3-20261112.0.x86_64.qcow2) = 68eae06d402c8b19e7dca06e85bdc43a3476089afa3ee20d93d0d43cf9871e9e\n', 'Rocky-10-GenericCloud-Base-10.3-20261112.0.x86_64.qcow2', 'sha256'),
		'68eae06d402c8b19e7dca06e85bdc43a3476089afa3ee20d93d0d43cf9871e9e',
	)
})

test('the catalog offers the agreed systems and keeps installer ISOs manual', async () => {
	const root = await mkdtemp(join(tmpdir(), 'catalog-os-'))
	try {
		const machines = createMachines({
			dataDir: root,
			run: async () => '',
			kvmDevice: join(root, 'kvm'),
			catalogUrl: 'https://example.invalid/catalog.json',
			fetchImpl: async () => ({ok: false}),
		})
		const images = await machines.procedures['machines.osImages'].run()
		const byId = Object.fromEntries(images.map((image) => [image.id, image]))
		assert.equal(byId['omarchy-4.0.4-amd64'], undefined)
		assert.equal(byId['omarchy-4.5.0-amd64'].requiresCredentials, true)
		assert.equal(byId['omarchy-4.5.0-amd64'].manualSetup, false)
		for (const id of ['cachyos-desktop-amd64', 'linuxmint-22.3-cinnamon-amd64']) {
			assert.equal(byId[id].requiresCredentials, false, id)
			assert.equal(byId[id].manualSetup, true, id)
		}
		for (const id of ['opensuse-leap-16.1-amd64', 'rocky-10-server-amd64', 'debian-12-server-amd64', 'ubuntu-22.04-server-amd64']) {
			assert.equal(byId[id].requiresCredentials, true, id)
			assert.equal(byId[id].manualSetup, undefined, id)
			assert.equal(byId[id].platform, 'linux', id)
		}
		const catalog = JSON.parse(await readFile(new URL('../omarchyd/machine-catalog.json', import.meta.url), 'utf8'))
		const omarchy = catalog.images.find((image) => image.id === 'omarchy-4.5.0-amd64')
		assert.equal(omarchy.install, 'omarchy')
		assert.equal(omarchy.url, 'https://iso.omarchy.org/omarchy-4.5.0-x86.iso')
		for (const id of ['cachyos-desktop-amd64', 'linuxmint-22.3-cinnamon-amd64']) assert.equal(catalog.images.find((image) => image.id === id).install, 'manual')
		for (const id of ['opensuse-leap-16.1-amd64', 'rocky-10-server-amd64', 'debian-12-server-amd64', 'ubuntu-22.04-server-amd64']) assert.equal(catalog.images.find((image) => image.id === id).kind, 'cloud')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a swap reading is the same stat on every view, and a machine without swap omits it', async () => {
	const withSwap = swarmGaugeItems({cpu: 10, mem: {total: 100, used: 40}, swap: {total: 50, used: 10}, disks: []})
	const readings = statReadings({gauges: withSwap, temp: null, diskSizeGb: null})
	assert.deepEqual(
		readings.map((reading) => reading.label),
		['CPU', 'Memory', 'Swap'],
	)
	assert.equal(readings.find((reading) => reading.label === 'Swap').icon, 'swap')
	assert.equal(readings.find((reading) => reading.label === 'Swap').text, '20%')
	const text = await readFile('/proc/meminfo', 'utf8')
	const total = Number(/^SwapTotal:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024
	const mem = await memoryUsage()
	assert.ok(mem.size > 0)
	if (total > 0) {
		assert.equal(mem.swap.total, total)
		assert.ok(mem.swap.used >= 0 && mem.swap.used <= total)
	} else assert.equal(mem.swap, undefined)
})
