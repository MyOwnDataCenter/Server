import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {readNixCache, writeNixCache} from '../omarchyd/nix-cache.mjs'

test('nix cache defaults off and persists', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nix-cache-'))
	assert.deepEqual(await readNixCache(dataDir), {enabled: false, substituter: ''})
	await writeNixCache(dataDir, {enabled: true, substituter: 'http://10.0.0.1:5000'})
	assert.deepEqual(await readNixCache(dataDir), {enabled: true, substituter: 'http://10.0.0.1:5000'})
})