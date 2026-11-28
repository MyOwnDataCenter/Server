import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {filePlaces} from '../web/src/fleet/filePlaces.ts'
import {isContainerAgent, isGuestAgent} from '../web/src/swarm/guestLink.ts'
import {sendTargets} from '../web/src/clips/view.ts'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('a connected LXC agent is a Files place, not an App Store target or Machines computer', async () => {
	const agent = {
		id: 'aabbccddeeff',
		name: 'web',
		online: true,
		enrolledAt: 1,
		containerOf: 'web',
		allowed: {files: true},
		on: {files: true},
	}
	assert.equal(isContainerAgent(agent), true)
	assert.equal(isGuestAgent(agent), false)

	const {places} = filePlaces([{id: agent.id, name: agent.name, online: true, filesGranted: true}])
	assert.deepEqual(places, [{id: agent.id, name: 'web', path: `::computer/${agent.id}`, kind: 'computer', browsable: true}])

	const clips = sendTargets({
		serverName: 'Den',
		computers: [{id: agent.id, name: agent.name, online: true, allowed: {files: true}, on: {files: true}}],
		machines: [],
	})
	assert.ok(clips.some((t) => t.id === agent.id && t.files))

	const machines = await read('../web/src/screens/Machines.tsx')
	assert.match(machines, /!isGuestAgent\(a\) && !isContainerAgent\(a\)/)
	const swarm = await read('../web/src/swarm/Swarm.tsx')
	assert.match(swarm, /!isGuestAgent\(a\) && !isContainerAgent\(a\)/)
	const store = await read('../web/src/screens/Store.tsx')
	assert.match(store, /!isContainerAgent\(a\)/)
	const ui = await read('../web/src/containers/Containers.tsx')
	assert.doesNotMatch(ui, /openStore/)
	assert.doesNotMatch(ui, /id: 'apps'/)
	const connector = await read('../omarchyd/connector.mjs')
	assert.match(connector, /System containers don’t run the App Store/)
})
