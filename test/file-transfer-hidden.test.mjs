// Moving a folder to another computer takes everything in it, hidden files included, before the
// original is deleted. The folder listing the transfer walks used to hide dot-files, so a move
// copied only the visible ones and then removed the whole folder.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, realpath, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFileTransfer} from '../omarchyd/file-transfer.mjs'
import {createFiles} from '../omarchyd/files.mjs'

function fakeFleet() {
	const pushed = new Map()
	const dirs = []
	return {
		pushed,
		dirs,
		mkdir: async (_id, rel) => void dirs.push(rel),
		push: async (_id, rel, size, readChunk) => {
			const parts = []
			let got = 0
			while (got < size) {
				const chunk = await readChunk(size - got)
				parts.push(chunk)
				got += chunk.length
			}
			pushed.set(rel, Buffer.concat(parts).toString())
		},
		remove: async () => true,
	}
}

test('moving a folder to a computer carries its hidden files and keeps them until they arrive', async () => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'xfer-hidden-')))
	try {
		const home = join(root, 'home')
		await mkdir(join(home, 'proj', '.git'), {recursive: true})
		await mkdir(join(root, 'data'))
		await writeFile(join(home, 'proj', 'a.txt'), 'visible')
		await writeFile(join(home, 'proj', '.env'), 'secret')
		await writeFile(join(home, 'proj', '.git', 'config'), 'cfg')
		const fleet = fakeFleet()
		const transfer = createFileTransfer({files: createFiles({home, dataDir: join(root, 'data')}), fleet})
		await transfer.transfer({path: '/Home/proj', toDirectory: '::computer/kitchen/Docs', mode: 'move'})
		assert.deepEqual([...fleet.pushed.keys()].sort(), ['Docs/proj/.env', 'Docs/proj/.git/config', 'Docs/proj/a.txt'])
		assert.equal(fleet.pushed.get('Docs/proj/.env'), 'secret')
		assert.equal(await stat(join(home, 'proj')).then(() => false, () => true), true, 'the original goes after the copy')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
