// JSON-RPC MCP (2024-11-05) over POST. Loopback only. An `sse` listing uses this same POST.

const cache = new Map()
let rpcId = 0

function loopback(url) {
	let u
	try {
		u = new URL(url)
	} catch {
		return null
	}
	if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return null
	if (u.username || u.password) return null
	return u
}

function clip(s) {
	const t = String(s ?? '').replace(/\s+/g, ' ').trim()
	return t.length > 500 ? t.slice(0, 500) : t
}

export const TOOL_RESULT_MAX = 20_000

// Stored tool text stays short enough to send again. A second cap leaves an existing note in place.
export function capToolResult(text) {
	const s = typeof text === 'string' ? text : JSON.stringify(text ?? null)
	const mark = s.match(/\[cut: \d+ more characters\]$/)
	if (mark && s.length - mark[0].length <= TOOL_RESULT_MAX) return s
	if (s.length <= TOOL_RESULT_MAX) return s
	const extra = s.length - TOOL_RESULT_MAX
	return s.slice(0, TOOL_RESULT_MAX) + `[cut: ${extra} more characters]`
}

function httpError(raw, status) {
	let json = null
	try {
		json = parseMessage(raw)
	} catch {
		json = null
	}
	const message = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.message : ''
	if (message) return clip(message)
	return clip(raw) || `HTTP ${status}`
}

function schemaOf(schema) {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {type: 'object', properties: {}}
	if (schema.type) return schema
	return {type: 'object', ...schema}
}

function contentText(result) {
	const content = result?.content
	if (Array.isArray(content)) {
		const texts = []
		for (const part of content) {
			if (part && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text)
		}
		if (texts.length) return texts.join('\n')
	}
	return JSON.stringify(result ?? null)
}

function parseMessage(raw) {
	const text = String(raw ?? '').trim()
	if (!text) throw new Error('Empty MCP response')
	try {
		return JSON.parse(text)
	} catch {
		// A streamable HTTP server may answer the POST as one SSE event.
	}
	let last = null
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) continue
		const data = line.slice(5).trim()
		if (!data || data === '[DONE]') continue
		last = JSON.parse(data)
	}
	if (!last) throw new Error('Empty MCP response')
	return last
}

function sessionOf(res) {
	const headers = res?.headers
	if (!headers || typeof headers.get !== 'function') return null
	return headers.get('mcp-session-id') || null
}

function post(url, message, fetchImpl, signal, session) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	}
	if (session) headers['mcp-session-id'] = session
	return fetchImpl(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(message),
		redirect: 'error',
		...(signal ? {signal} : {}),
	})
}

async function rpc(url, method, params, fetchImpl, signal, session) {
	const id = ++rpcId
	const res = await post(url, {jsonrpc: '2.0', id, method, params}, fetchImpl, signal, session)
	let raw = ''
	try {
		raw = typeof res.text === 'function' ? await res.text() : ''
	} catch {
		raw = ''
	}
	if (!res.ok) throw new Error(httpError(raw, res.status))
	const json = parseMessage(raw)
	if (!json || typeof json !== 'object' || json.error) throw new Error(clip(json?.error?.message) || 'MCP call failed')
	if (json.id !== id && String(json.id) !== String(id)) throw new Error('MCP call failed')
	return {result: json.result ?? null, session: sessionOf(res) || session || null}
}

async function notify(url, fetchImpl, signal, session) {
	try {
		const res = await post(url, {jsonrpc: '2.0', method: 'notifications/initialized', params: {}}, fetchImpl, signal, session)
		if (typeof res?.text === 'function') await res.text()
	} catch (e) {
		if (e?.name === 'AbortError') throw e
	}
}

async function handshake(url, fetchImpl, signal) {
	const started = await rpc(url, 'initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: {name: 'MODC', version: '1'},
	}, fetchImpl, signal, null)
	await notify(url, fetchImpl, signal, started.session)
	return started.session
}

function toolOf(tool) {
	if (!tool || typeof tool.name !== 'string' || !tool.name) return null
	return {
		name: tool.name,
		description: typeof tool.description === 'string' && tool.description ? tool.description : tool.name,
		inputSchema: schemaOf(tool.inputSchema),
		readOnly: tool.readOnlyHint === true || tool.annotations?.readOnlyHint === true,
	}
}

const copyTools = (tools) => tools.map((t) => ({...t}))

// Only these URLs. Callers must not clear the map; other turns share it.
export function forgetMcpTools(urls) {
	if (!urls) return
	for (const url of urls) cache.delete(url)
}

// A tool list is a quick question. An app that takes the connection and never answers must not hold up
// every chat message while the turn waits for it.
export const LIST_TIMEOUT_MS = 8000

export async function listMcpTools({url, transport, fetchImpl = fetch, ttlMs = 60_000, now = () => Date.now(), signal: turnSignal, timeoutMs = LIST_TIMEOUT_MS} = {}) {
	if (transport !== 'http' && transport !== 'sse') return []
	if (!loopback(url)) return []
	const at = typeof now === 'function' ? now() : Date.now()
	const ttl = Number(ttlMs)
	const hit = cache.get(url)
	const age = hit ? at - hit.at : 0
	if (hit && Number.isFinite(ttl) && age >= 0 && age < ttl) return copyTools(hit.tools)
	const signal = typeof AbortSignal.any === 'function' && turnSignal ? AbortSignal.any([turnSignal, AbortSignal.timeout(timeoutMs)]) : (turnSignal ?? AbortSignal.timeout(timeoutMs))
	try {
		const session = await handshake(url, fetchImpl, signal)
		const tools = []
		const cursors = new Set()
		let cursor = ''
		for (let page = 0; page < 8; page++) {
			const {result} = await rpc(url, 'tools/list', cursor ? {cursor} : {}, fetchImpl, signal, session)
			if (!result || !Array.isArray(result.tools)) throw new Error('MCP tools list failed')
			for (const tool of result.tools) {
				const row = toolOf(tool)
				if (row) tools.push(row)
			}
			const next = typeof result.nextCursor === 'string' ? result.nextCursor : ''
			if (!next || cursors.has(next)) break
			cursors.add(next)
			cursor = next
		}
		cache.set(url, {at, tools})
		return copyTools(tools)
	} catch (e) {
		// Only the turn being stopped ends the listing; running out of time just means this app has no tools now.
		if (turnSignal?.aborted) throw e
		cache.delete(url)
		return []
	}
}

export async function callMcpTool({url, name, arguments: args, fetchImpl = fetch, signal} = {}) {
	if (!loopback(url)) throw new Error('MCP calls stay on loopback')
	const session = await handshake(url, fetchImpl, signal)
	const {result} = await rpc(url, 'tools/call', {
		name,
		arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
	}, fetchImpl, signal, session)
	const text = contentText(result)
	if (result?.isError) throw new Error(clip(text) || 'MCP tool failed')
	return capToolResult(text)
}
