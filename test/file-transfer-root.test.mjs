// A move to another computer deletes the original once it is copied. Home, Trash, Drives and a
// drive itself are not movable (Files refuses them); the computer transfer must refuse them too.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, realpath, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFileTransfer} from '../omarchyd/file-transfer.mjs'
import {createFiles} from '../omarchyd/files.mjs'

test('moving Home, Trash or a drive to another computer is refused and deletes nothing', async () => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'xfer-root-')))
	try {
		const home = join(root, 'home')
		const drives = join(root, 'drives')
		await mkdir(home)
		await mkdir(join(drives, 'usb'), {recursive: true})
		await mkdir(join(root, 'data'))
		await writeFile(join(home, 'a.txt'), 'keep me')
		await writeFile(join(drives, 'usb', 'b.txt'), 'keep me too')
		const fleet = {mkdir: async () => {}, push: async () => {}, remove: async () => true}
		const transfer = createFileTransfer({files: createFiles({home, dataDir: join(root, 'data'), drivesDir: drives}), fleet})
		for (const path of ['/Home', '/Trash', '/External', '/External/usb']) {
			await assert.rejects(transfer.transfer({path, toDirectory: '::computer/kitchen/Docs', mode: 'move'}), (e) => e.code === 'BAD_REQUEST', path)
		}
		assert.equal((await stat(join(home, 'a.txt'))).isFile(), true)
		assert.equal((await stat(join(drives, 'usb', 'b.txt'))).isFile(), true)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
