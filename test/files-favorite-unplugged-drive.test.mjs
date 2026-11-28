// A favorite on a drive stays a favorite while the drive is unplugged. Opening Files used to
// forget every favorite whose path could not be found, and an unplugged drive's folders are not there.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'

test('favorites on an unplugged drive come back when the drive does', async () => {
	const root = await mkdtemp(join(tmpdir(), 'files-fav-drive-'))
	try {
		const home = join(root, 'home')
		const drivesDir = join(root, 'media')
		const dataDir = join(root, 'data')
		await mkdir(home, {recursive: true})
		await mkdir(join(drivesDir, 'Backup', 'photos'), {recursive: true})
		await mkdir(dataDir)
		await writeFile(join(home, 'a.txt'), 'x')
		const files = createFiles({home, dataDir, drivesDir})
		const call = (name, input) => files.procedures[name].run(input)
		await call('files.addFavorite', {path: '/External/Backup/photos'})
		await call('files.addFavorite', {path: '/Home/a.txt'})

		await rename(drivesDir, `${drivesDir}-away`) // unplugged
		assert.deepEqual((await call('files.favorites')).map((f) => f.path), ['/Home/a.txt'])
		assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'favorites.json'), 'utf8')).sort(), ['/External/Backup/photos', '/Home/a.txt'])

		await rename(`${drivesDir}-away`, drivesDir) // plugged back in
		assert.deepEqual((await call('files.favorites')).map((f) => f.path).sort(), ['/External/Backup/photos', '/Home/a.txt'])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
