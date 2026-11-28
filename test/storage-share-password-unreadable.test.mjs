import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createStorage} from '../omarchyd/storage.mjs'

test('showing the share password never changes it when the saved file cannot be read', async (t) => {
	const data = await mkdtemp(join(os.tmpdir(), 'omarchy-share-pw-'))
	const file = join(data, 'share-password')
	await mkdir(join(data, 'x'))
	await writeFile(file, 'my own words')
	await chmod(file, 0o000)
	t.after(async () => {
		await chmod(file, 0o600).catch(() => {})
		await rm(data, {recursive: true, force: true})
	})
	if ((await readFile(file).catch(() => null)) !== null) return t.skip('this account can read a file with no permissions')
	const verbs = []
	const s = createStorage({
		dataDir: data,
		home: '/home/chris',
		files: {resolve: async () => ({real: '/x', top: 'Home'})},
		run: async (cmd, args) => {
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			verbs.push(args?.[2])
			return 'ok\n'
		},
		fstabPath: join(data, 'fstab'),
		smbConf: join(data, 'smb.conf'),
	})
	await assert.rejects(s.procedures['files.sharePassword'].run(), /share-password.*left unchanged/i)
	assert.equal(verbs.includes('smb-password'), false, 'the Samba password was replaced')
	await chmod(file, 0o600)
	assert.equal(await readFile(file, 'utf8'), 'my own words')
})
