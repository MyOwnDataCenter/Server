// Hermes Agent as the assistant: import an existing Hermes setup, chat through it, and let it look
// after this server through an MCP server of its own.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {parseDocument} from 'yaml'

import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {createHermes, parseEnv, setEnv} from '../omarchyd/hermes.mjs'

async function setup({env = '', config = '', role = 'owner'} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'hermes-'))
	const home = join(root, 'home')
	await mkdir(join(home, '.hermes'), {recursive: true})
	if (env !== null) await writeFile(join(home, '.hermes', '.env'), env)
	if (config !== null) await writeFile(join(home, '.hermes', 'config.yaml'), config)
	const keys = createKeyStore({dataDir: join(root, 'data')})
	const calls = []
	const h = createHermes({
		dataDir: join(root, 'data'),
		home,
		env: {},
		keys,
		accounts: {getUser: (id) => (id === 'owner1' ? {role} : null)},
		fetchImpl: async (url, init) => (String(url).endsWith('/v1/models') && init?.headers?.authorization ? new Response(JSON.stringify({data: [{id: 'hermes-agent'}]})) : new Response('', {status: 401})),
		sh: async (cmd, args) => (cmd === 'sh' ? {ok: true, out: '/usr/bin/hermes\n'} : {ok: true, out: ''}),
		runProcedure: async (name, input) => (calls.push({name, input}), {ok: true, name}),
	})
	const server = http.createServer((req, res) => h.handleMcp(req, res))
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const mcp = async (body, token) => {
		const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)})
		return {status: r.status, body: await r.json().catch(() => null)}
	}
	const auth = {userId: 'owner1', role: 'owner'}
	const run = (name, input) => h.procedures[name].run(input, {auth})
	return {root, home, keys, calls, h, mcp, run, auth, close: async () => (server.close(), rm(root, {recursive: true, force: true}))}
}

test('.env edits keep comments and order, and add only what is missing', () => {
	const before = '# my keys\nOPENROUTER_API_KEY=sk-1\nAPI_SERVER_ENABLED=false\n'
	const after = setEnv(before, {API_SERVER_ENABLED: 'true', MODC_MCP_TOKEN: 'abc'})
	assert.match(after, /^# my keys\nOPENROUTER_API_KEY=sk-1\nAPI_SERVER_ENABLED=true\n/)
	assert.equal(parseEnv(after).MODC_MCP_TOKEN, 'abc')
})

test('connecting imports an existing Hermes: API server on (this machine only), this server added as an MCP server, Hermes chosen', async () => {
	const t = await setup({env: '# mine\nOPENROUTER_API_KEY=sk-or-1\n', config: '# my config\nmodel: anthropic/claude-opus-4.6\nmcp_servers:\n  github:\n    command: npx\n'})
	try {
		const before = await t.run('hermes.status')
		assert.equal(before.found, true)
		assert.equal(before.connected, false)
		const r = await t.run('hermes.connect', {})
		assert.equal(r.connected, true)
		assert.equal(r.engine, 'hermes')
		const env = parseEnv(await readFile(join(t.home, '.hermes', '.env'), 'utf8'))
		assert.equal(env.OPENROUTER_API_KEY, 'sk-or-1', 'their settings stay')
		assert.equal(env.API_SERVER_ENABLED, 'true')
		assert.match(env.API_SERVER_KEY, /^[0-9a-f]{64}$/)
		assert.equal(env.API_SERVER_HOST, undefined, 'never opened to the network')
		const configText = await readFile(join(t.home, '.hermes', 'config.yaml'), 'utf8')
		assert.match(configText, /# my config/, 'comments kept')
		const config = parseDocument(configText).toJSON()
		assert.ok(config.mcp_servers.github, 'their MCP servers stay')
		assert.equal(config.mcp_servers.modc.url, 'http://127.0.0.1:2021/mcp')
		assert.equal(config.mcp_servers.modc.headers.Authorization, 'Bearer ${MODC_MCP_TOKEN}', 'the token stays in .env')
		assert.ok((await readdir(join(t.home, '.hermes'))).some((f) => f.startsWith('config.yaml.modc-backup-')), 'a copy was kept')
		// The chat goes to Hermes for this person, and Hermes can't be shared.
		const key = await t.keys.resolveForUser('owner1')
		assert.equal(key.provider, 'hermes')
		assert.equal(key.baseUrl, 'http://127.0.0.1:8642/v1')
		await assert.rejects(() => t.keys.update(t.auth, {id: key.id, sharedWith: ['member1']}), /can’t be shared/)
		// Back to the built-in assistant.
		assert.equal((await t.run('assistant.setEngine', {engine: 'builtin'})).engine, 'builtin')
		await assert.rejects(() => t.keys.resolveForUser('owner1'), /Add an API key/)

		// The MCP server: its own token, owner's tools.
		const token = env.MODC_MCP_TOKEN
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401)
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'}, 'wrong')).status, 401)
		const init = await t.mcp({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}, token)
		assert.equal(init.body.result.protocolVersion, '2025-06-18')
		assert.equal((await t.mcp({jsonrpc: '2.0', method: 'notifications/initialized'}, token)).status, 202)
		const tools = (await t.mcp({jsonrpc: '2.0', id: 2, method: 'tools/list'}, token)).body.result.tools.map((x) => x.name)
		assert.ok(tools.includes('apps_list') && tools.includes('apps_start'))
		assert.ok(!tools.includes('machines_create'), 'needs a password typed in My Own Data Center')
		const start = await t.mcp({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'apps_start', arguments: {appId: 'jellyfin', grant: ['host-network']}}}, token)
		assert.equal(start.body.result.isError, undefined)
		assert.deepEqual(t.calls.at(-1), {name: 'apps.start', input: {appId: 'jellyfin'}})

		// Read only: looks, never changes.
		await t.run('hermes.setMode', {mode: 'read'})
		const ro = (await t.mcp({jsonrpc: '2.0', id: 4, method: 'tools/list'}, token)).body.result.tools.map((x) => x.name)
		assert.ok(ro.includes('apps_list') && !ro.includes('apps_start'))
		const refused = await t.mcp({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'apps_start', arguments: {appId: 'x'}}}, token)
		assert.equal(refused.body.result.isError, true)
		assert.equal(t.calls.length, 1)

		// Disconnect: its MCP entry removed, the token no longer works, chat back to built-in.
		await t.run('hermes.disconnect')
		const after = parseDocument(await readFile(join(t.home, '.hermes', 'config.yaml'), 'utf8')).toJSON()
		assert.equal(after.mcp_servers.modc, undefined)
		assert.ok(after.mcp_servers.github)
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 6, method: 'tools/list'}, token)).status, 401)
	} finally {
		await t.close()
	}
})

test('only the owner connects; a Hermes API server open to the network without a key is refused; no Hermes is said plainly', async () => {
	const t = await setup({env: 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=0.0.0.0\n'})
	try {
		await assert.rejects(() => t.run('hermes.connect', {}), /open to the network without a key/)
	} finally {
		await t.close()
	}
	const m = await setup({role: 'member'})
	try {
		await assert.rejects(() => m.run('hermes.status'), /Only the server’s owner/)
	} finally {
		await m.close()
	}
	const none = await setup({env: null, config: null})
	try {
		await rm(join(none.home, '.hermes'), {recursive: true, force: true})
		const st = await none.h.procedures['hermes.status'].run({}, {auth: none.auth})
		assert.equal(typeof st.found, 'boolean')
	} finally {
		await none.close()
	}
})

test('Hermes on another computer or in the cloud: connect by address and key, then give it the snippet and token', async () => {
	const t = await setup({env: null, config: null})
	try {
		await assert.rejects(() => t.run('hermes.connectRemote', {baseUrl: 'ftp://x', apiKey: 'k'.repeat(20)}), /http/)
		await assert.rejects(() => t.run('hermes.connectRemote', {baseUrl: 'http://10.0.0.5:8642', apiKey: 'short'}), /API_SERVER_KEY/)
		const st = await t.run('hermes.connectRemote', {baseUrl: 'http://10.0.0.5:8642', apiKey: 'k'.repeat(32)})
		assert.equal(st.where, 'remote')
		assert.equal(st.connected, true)
		assert.equal(st.engine, 'hermes')
		const key = await t.keys.resolveForUser('owner1')
		assert.equal(key.baseUrl, 'http://10.0.0.5:8642/v1')
		const s1 = await t.run('hermes.remoteSetup')
		assert.match(s1.token, /^[0-9a-f]{64}$/)
		assert.equal(s1.path, '/mcp')
		// The token works for MCP; a new one replaces it.
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'}, s1.token)).status, 200)
		const s2 = await t.run('hermes.rotateToken')
		assert.notEqual(s2.token, s1.token)
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'}, s1.token)).status, 401)
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'}, s2.token)).status, 200)
		await t.run('hermes.disconnect')
		assert.equal((await t.mcp({jsonrpc: '2.0', id: 1, method: 'tools/list'}, s2.token)).status, 401)
		await assert.rejects(() => t.keys.resolveForUser('owner1'), /Add an API key/)
	} finally {
		await t.close()
	}
})
