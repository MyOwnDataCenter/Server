// A 401 on a resumable-upload chunk means the access token is no longer good. The chunk request
// makes no retries of its own, so the token refresh must not use up a retry: it is tried once
// more with a fresh token. It used to give up with a bare {status: 401} object, which is not an
// Error and says nothing, and the backup failed.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {GDRIVE_SCOPE, createGdriveClient} from '../omarchyd/gdrive.mjs'

test('a 401 on an upload chunk refreshes the token and sends the chunk again', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'gdrive-401-'))
	try {
		let refreshes = 0
		let chunkTries = 0
		const tokens = []
		const fetchImpl = async (url, opts = {}) => {
			const u = String(url)
			if (u.endsWith('/token')) {
				refreshes++
				return new Response(JSON.stringify({access_token: `tok${refreshes}`, expires_in: 3600, scope: GDRIVE_SCOPE}), {status: 200})
			}
			if (u.includes('uploadType=resumable')) return new Response('{}', {status: 200, headers: {location: 'https://upload.test/session/1'}})
			if (u.startsWith('https://upload.test/session/1')) {
				chunkTries++
				tokens.push(opts.headers.authorization)
				if (chunkTries === 1) return new Response(JSON.stringify({error: {code: 401, message: 'Invalid Credentials'}}), {status: 401})
				return new Response(JSON.stringify({id: 'file1', size: '16'}), {status: 200})
			}
			throw new Error(`unexpected ${u}`)
		}
		const client = createGdriveClient({
			indexFile: join(dir, 'index.json'),
			getCredentials: async () => ({clientId: 'c', refreshToken: 'r'}),
			fetchImpl,
			tokenUrl: 'https://auth.test/token',
			uploadBase: 'https://upload.test/upload',
			apiBase: 'https://api.test/drive',
			multipartThreshold: 4,
			chunkSize: 262144,
		})
		const rec = await client.putObject('root1', 'data.bin', Buffer.alloc(16, 1), {size: 16})
		assert.equal(rec.id, 'file1')
		assert.equal(chunkTries, 2)
		assert.deepEqual(tokens, ['Bearer tok1', 'Bearer tok2'])
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
