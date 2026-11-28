// A saved state file must be on disk before it takes the old file's name. Without a flush, a power
// cut right after the rename can leave an empty accounts.json, and the server then refuses to start.
import assert from 'node:assert/strict'
import {mkdtemp, open, readFile, readdir, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {mock, test} from 'node:test'

import {writeAtomic} from '../omarchyd/atomic.mjs'

test('writeAtomic flushes the new contents to disk before renaming them into place', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-fsync-'))
	const probe = await open(join(dir, 'probe'), 'w')
	const proto = Object.getPrototypeOf(probe)
	await probe.close()
	const sync = mock.method(proto, 'sync')
	try {
		const file = join(dir, 'state.json')
		await writeAtomic(file, '{"a":1}', {mode: 0o600})
		assert.equal(await readFile(file, 'utf8'), '{"a":1}')
		assert.equal(sync.mock.callCount(), 1, 'the temporary file was flushed')
		await writeAtomic(file, Buffer.from('{"a":2}'))
		assert.equal(await readFile(file, 'utf8'), '{"a":2}')
		assert.equal(sync.mock.callCount(), 2)
		assert.deepEqual((await readdir(dir)).sort(), ['probe', 'state.json'])
	} finally {
		sync.mock.restore()
		await rm(dir, {recursive: true, force: true})
	}
})
