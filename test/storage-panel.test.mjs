import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('storage opens in its own panel and closes back to the machine', async () => {
	const storage = await read('../web/src/screens/Storage.tsx')
	assert.match(storage, /export function StoragePanel/)
	assert.match(storage, /<MachineShell bare=\{bare\} label=\{label\} onClose=\{onClose\}>/)
	assert.match(storage, /<StoragePage onBack=\{onClose\}/)
	assert.match(storage, /\{onBack && \(/)

	const server = await read('../web/src/fleet/ServerSheet.tsx')
	assert.match(server, /if \(more === 'storage'\) return <StoragePanel bare=\{bare\} target="host" onClose=\{\(\) => setMore\(null\)\} \/>/)
	assert.match(server, /<StoragePage target="host" \/>/)
	assert.match(server, /<BackupsPage \/>/)
	assert.doesNotMatch(server, /return <StoragePage/)

	const guest = await read('../web/src/fleet/GuestLive.tsx')
	assert.match(guest, /onOpenStorage\(\{agentId: agent\.id, name: machine\.name\}\)/)
	assert.doesNotMatch(guest, /StoragePage/)

	const machines = await read('../web/src/screens/Machines.tsx')
	assert.match(machines, /if \(storage\) return <StoragePanel bare=\{bare\} target=\{storage\} onClose=\{\(\) => setStorage\(null\)\} \/>/)
	assert.match(machines, /onOpenStorage=\{setStorage\}/)

	const swarm = await read('../web/src/swarm/Swarm.tsx')
	assert.match(swarm, /if \(storage\) return <StoragePanel bare=\{bare\} target=\{\{agentId: a\.id, name: a\.name\}\} onClose=\{\(\) => setStorage\(false\)\} \/>/)
	assert.match(swarm, /<StoragePage target=\{\{agentId: a\.id, name: a\.name\}\} \/>/)
	assert.doesNotMatch(swarm, /return <StoragePage/)

	const backups = await read('../web/src/backups.tsx')
	assert.match(backups, /\{onBack && \(/)

	const vm = await read('../web/src/machines/pveDetail.tsx')
	assert.match(vm, /<StoragePage target=\{storage\} \/>/)
	assert.match(vm, /setStorage\(null\)/)
})
