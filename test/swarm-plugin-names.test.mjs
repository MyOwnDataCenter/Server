import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {loadPluginNames} from '../web/src/swarm/pluginNames.ts'

const registry = Array.from({length: 130}, (_, i) => ({id: `plugin.${i}`, name: `Plugin ${i}`}))
const pageOf = (offset) => Promise.resolve({total: registry.length, plugins: registry.slice(offset, offset + 60)})

test('plugin names are read from every page of the list, not only the first 60 (#795)', async () => {
	const names = await loadPluginNames(pageOf, 60)
	assert.equal(names.size, 130)
	assert.equal(names.get('plugin.125'), 'Plugin 125')
})

test('reading names stops at the last page and when a page comes back empty', async () => {
	const offsets = []
	await loadPluginNames((offset) => (offsets.push(offset), pageOf(offset)), 60)
	assert.deepEqual(offsets, [0, 60, 120])
	const empty = []
	await loadPluginNames((offset) => (empty.push(offset), Promise.resolve({total: 500, plugins: []})), 60)
	assert.deepEqual(empty, [0])
})

test('the Installed rows take their names from that lookup, not from the search results (#795)', async () => {
	const source = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(source, /names\.data\?\.get\(id\)/)
})
