import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {uploadDirectory} from '../web/src/uploadDirectory.ts'

async function setup(t, io) {
	const root = await mkdtemp(join(os.tmpdir(), 'modc-upload-folder-'))
	const home = join(root, 'home')
	await mkdir(home)
	const files = createFiles({home, dataDir: join(root, 'data'), io})
	const originalFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (input, init) => {
		const url = new URL(input, 'http://test')
		const name = url.pathname.slice('/api/rpc/'.length)
		const args = init.method === 'POST' ? JSON.parse(init.body).input : JSON.parse(url.searchParams.get('input'))
		calls.push(name)
		try {
			return Response.json({data: await files.procedures[name].run(args)})
		} catch (e) {
			return Response.json({error: {code: e.code, message: e.message}}, {status: {NOT_FOUND: 404, CONFLICT: 409, FORBIDDEN: 403, BAD_REQUEST: 400}[e.code] ?? 500})
		}
	}
	t.after(async () => {
		globalThis.fetch = originalFetch
		await rm(root, {recursive: true, force: true})
	})
	return {root, home, files, calls}
}

async function upload(files, contents, name = 'reefy.raw') {
	let status, body
	const url = new URL('http://test/api/files/upload')
	url.searchParams.set('path', `/Home/Downloads/${name}`)
	url.searchParams.set('collision', 'keep-both')
	await files.upload(Readable.from([Buffer.from(contents)]), {
		writeHead: (value) => {status = value},
		end: (value) => {body = JSON.parse(value)},
	}, url)
	assert.equal(status, 200)
	return body.path
}

test('a fresh server prepares Downloads and accepts disk uploads without overwriting an earlier upload', async (t) => {
	const s = await setup(t)
	assert.deepEqual(await readdir(s.home), [])
	assert.equal(await uploadDirectory(), '/Home/Downloads')
	assert.equal(await upload(s.files, 'original disk'), '/Home/Downloads/reefy.raw')
	assert.equal(await uploadDirectory(), '/Home/Downloads')
	assert.equal(await upload(s.files, 'second disk'), '/Home/Downloads/reefy (2).raw')
	assert.equal(await readFile(join(s.home, 'Downloads/reefy.raw'), 'utf8'), 'original disk')
	assert.equal(await readFile(join(s.home, 'Downloads/reefy (2).raw'), 'utf8'), 'second disk')
	assert.equal(s.calls.filter((name) => name === 'files.createDirectory').length, 1)
})

test('an existing Downloads folder is reused without changing its contents', async (t) => {
	const s = await setup(t)
	await mkdir(join(s.home, 'Downloads'))
	await writeFile(join(s.home, 'Downloads/keep.txt'), 'keep')
	assert.equal(await uploadDirectory(), '/Home/Downloads')
	assert.equal(await readFile(join(s.home, 'Downloads/keep.txt'), 'utf8'), 'keep')
	assert.deepEqual(s.calls, ['files.list'])
})

test('images for different Reefy accounts keep their original filenames and contents', async (t) => {
	const s = await setup(t)
	await uploadDirectory()
	const names = ['reefy-alice_at_example_com-20261128-115822.raw', 'reefy-bob_at_example_com-20261128-115822.raw']
	for (const name of names) {
		assert.equal(await upload(s.files, name, name), `/Home/Downloads/${name}`)
		assert.equal(await readFile(join(s.home, 'Downloads', name), 'utf8'), name)
	}
	assert.deepEqual((await readdir(join(s.home, 'Downloads'))).sort(), names)
})

test('simultaneous first uploads can prepare the same folder', async (t) => {
	await setup(t)
	assert.deepEqual(await Promise.all([uploadDirectory(), uploadDirectory()]), ['/Home/Downloads', '/Home/Downloads'])
})

test('a file named Downloads is refused and preserved', async (t) => {
	const s = await setup(t)
	await writeFile(join(s.home, 'Downloads'), 'keep')
	await assert.rejects(uploadDirectory(), (e) => e.code === 'BAD_REQUEST')
	assert.equal(await readFile(join(s.home, 'Downloads'), 'utf8'), 'keep')
	assert.deepEqual(s.calls, ['files.list'])
})

test('a Downloads link outside Home is refused', async (t) => {
	const s = await setup(t)
	await mkdir(join(s.root, 'outside'))
	await symlink(join(s.root, 'outside'), join(s.home, 'Downloads'))
	await assert.rejects(uploadDirectory(), (e) => e.code === 'FORBIDDEN')
	assert.deepEqual(await readdir(join(s.root, 'outside')), [])
	assert.deepEqual(s.calls, ['files.list'])
})

test('permission errors creating Downloads are preserved', async (t) => {
	const s = await setup(t, {mkdir: async () => {throw Object.assign(new Error('denied'), {code: 'EACCES'})}})
	await assert.rejects(uploadDirectory(), (e) => e.code === 'FORBIDDEN')
	assert.deepEqual(await readdir(s.home), [])
})
