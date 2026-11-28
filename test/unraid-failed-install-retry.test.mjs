import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

test('a container whose install failed is not "already here", and can be cleared for another try', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'ufi-'))
	try {
		const data = join(root, 'data')
		await mkdir(join(data, 'apps'), {recursive: true})
		await writeFile(join(data, 'apps', 'apps.json'), JSON.stringify({
			defaultsAdded: true,
			umbrelStoreRemoved: true,
			permissionsVersion: 2,
			stores: [],
			apps: [{id: 'unraid-plex', name: 'Plex', state: 'error', error: 'It didn’t install'}, {id: 'unraid-ok', name: 'Fine', state: 'running'}],
			recent: [],
		}))
		const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: []})
		try {
			await apps.ready
			assert.equal(apps.installed('unraid-plex'), false)
			assert.equal(apps.installed('unraid-ok'), true)
			await apps.clearFailed('unraid-ok')
			assert.equal(apps.installed('unraid-ok'), true, 'a working app is never removed')
			await apps.clearFailed('unraid-plex')
			assert.deepEqual((await apps.procedures['apps.list'].run()).map((a) => a.id), ['unraid-ok'])
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
