import {randomBytes} from 'node:crypto'

import {anthropicHeaders, plainBody} from './anthropic.mjs'

const completeArgs = (s) => {
	if (!s) return false
	try {
		const v = JSON.parse(s)
		return !!v && typeof v === 'object' && !Array.isArray(v)
	} catch {
		return false
	}
}

const callId = () => 'call_' + randomBytes(4).toString('hex')

const TOOL_PREFIXES = ['<tool_call', '<function=']

function incompleteToolStart(rest, final) {
	const unclosedCall = rest.search(/<tool_call>/)
	const unclosedFn = rest.search(/<function=/)
	const hasCall = unclosedCall >= 0 && !rest.includes('</tool_call>', unclosedCall)
	const hasFn = unclosedFn >= 0 && !rest.includes('</function>', unclosedFn)
	if (hasCall && hasFn) return Math.min(unclosedCall, unclosedFn)
	if (hasCall) return unclosedCall
	if (hasFn) return unclosedFn
	if (final) return -1
	const lt = rest.lastIndexOf('<')
	if (lt >= 0) {
		const tail = rest.slice(lt)
		if (TOOL_PREFIXES.some((p) => p.startsWith(tail))) return lt
		if (['</tool_call>', '</function>'].some((p) => p.startsWith(tail))) return lt
	}
	return -1
}

const schemaFor = (tools, name) => {
	for (const t of tools ?? []) {
		const fn = t?.function ?? t
		if (fn?.name === name) return fn.parameters?.properties ?? null
	}
	return null
}

const parseParamValue = (raw, prop) => {
	const types = Array.isArray(prop?.type) ? prop.type : prop?.type ? [prop.type] : null
	if (types) {
		if (types.length === 1 && types[0] === 'string') return raw
		if (types.includes('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true'
		if (types.includes('null') && raw === 'null') return null
		if ((types.includes('integer') || types.includes('number')) && raw !== '') {
			try {
				const v = JSON.parse(raw)
				if (typeof v === 'number' && Number.isFinite(v) && (types.includes('number') || Number.isInteger(v))) return v
			} catch {}
		}
		if (types.includes('object') || types.includes('array')) {
			try {
				const v = JSON.parse(raw)
				if (types.includes('array') && Array.isArray(v)) return v
				if (types.includes('object') && v && typeof v === 'object' && !Array.isArray(v)) return v
			} catch {}
		}
		return raw
	}
	// Without a schema for this field, keep plain text as a string and parse JSON values.
	if (raw === 'true') return true
	if (raw === 'false') return false
	if (raw === 'null') return null
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
		const v = Number(raw)
		if (Number.isFinite(v)) return v
	}
	if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
		try {
			return JSON.parse(raw)
		} catch {}
	}
	return raw
}

const paramsToArgs = (body, props) => {
	const args = {}
	const re = /<parameter=([^\s>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
	let m
	while ((m = re.exec(body))) args[m[1]] = parseParamValue(m[2], props?.[m[1]])
	return Object.keys(args).length ? JSON.stringify(args) : '{}'
}

const toolsFromXmlInner = (block, toolList) => {
	const tools = []
	const json = String(block ?? '').trim()
	if (json.startsWith('{')) {
		try {
			const obj = JSON.parse(json)
			const name = String(obj.name ?? obj.function ?? '').trim()
			if (name) {
				const raw = obj.arguments !== undefined ? obj.arguments : obj.parameters
				const argumentsText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
				tools.push({type: 'tool', id: callId(), name, arguments: argumentsText || '{}'})
			}
		} catch {
			tools.push({type: 'error', message: 'The answer was cut off; try again'})
		}
		return tools
	}
	const fn = /<function=([^\s>]+)>([\s\S]*?)<\/function>/g
	let m
	while ((m = fn.exec(block))) tools.push({type: 'tool', id: callId(), name: m[1], arguments: paramsToArgs(m[2], schemaFor(toolList, m[1]))})
	return tools
}

export function takeXmlTools(buf, final, toolList) {
	let text = ''
	const tools = []
	let rest = String(buf ?? '')
	for (;;) {
		const wrapped = rest.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
		const fn = rest.match(/<function=([^\s>]+)>([\s\S]*?)<\/function>/)
		const wAt = wrapped ? rest.indexOf(wrapped[0]) : -1
		const fAt = fn ? rest.indexOf(fn[0]) : -1
		let at = -1
		let raw = ''
		let inner = ''
		if (wAt >= 0 && (fAt < 0 || wAt <= fAt)) {
			at = wAt
			raw = wrapped[0]
			inner = wrapped[1]
		} else if (fAt >= 0) {
			const openCall = rest.indexOf('<tool_call>')
			if (openCall >= 0 && openCall < fAt) {
				if (!final) break
				if (!rest.slice(openCall + '<tool_call>'.length, fAt).trim()) {
					at = openCall
					raw = rest.slice(openCall, fAt + fn[0].length)
					inner = fn[0]
				} else break
			} else {
				at = fAt
				raw = fn[0]
				inner = fn[0]
			}
		}
		if (at < 0) break
		text += rest.slice(0, at)
		tools.push(...toolsFromXmlInner(inner, toolList))
		rest = rest.slice(at + raw.length).replace(/^\s*<\/(?:tool_call|function)>/, '')
	}
	rest = rest.replace(/^\s*<\/(?:tool_call|function)>/, '')
	const hold = incompleteToolStart(rest, final)
	if (hold >= 0) {
		text += rest.slice(0, hold)
		rest = final ? '' : rest.slice(hold)
		return {text, tools, rest}
	}
	text += rest
	return {text, tools, rest: ''}
}

const errorMessage = (raw, status) => {
	try {
		const json = JSON.parse(raw)
		const m = json.error?.message || json.message
		if (m) return String(m)
	} catch {}
	return plainBody(raw, status)
}

function parseEvent(event, pending) {
	let data = event.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).replace(/^ /, ''))
		.join('\n')
	// A server that ignored stream:true answers with one plain JSON completion instead of events.
	if (!data && event.trimStart().startsWith('{')) data = event.trim()
	const out = {content: '', finishReason: null, done: false, error: null}
	if (data === '[DONE]') out.done = true
	if (!data || data === '[DONE]') return out
	let json
	try {
		json = JSON.parse(data)
	} catch {
		return out
	}
	// Some servers report a failure inside a 200 stream.
	if (json.error && typeof json.error === 'object' && !json.choices) out.error = String(json.error.message || 'The assistant did not answer')
	const choice = json.choices?.[0] ?? {}
	const delta = choice.delta ?? {}
	if (typeof choice.finish_reason === 'string' && choice.finish_reason) out.finishReason = choice.finish_reason
	if (typeof delta.content === 'string' && delta.content) out.content += delta.content
	if (typeof choice.message?.content === 'string' && choice.message.content) out.content += choice.message.content
	const addCall = (tc) => {
		if (!tc || typeof tc !== 'object') return
		const i = tc.index ?? pending.length
		const row = pending[i] ?? (pending[i] = {id: '', name: '', arguments: ''})
		if (tc.id) row.id = tc.id
		if (tc.function?.name) row.name = tc.function.name
		if (typeof tc.function?.arguments === 'string') row.arguments += tc.function.arguments
		else if (tc.function?.arguments && typeof tc.function.arguments === 'object') row.arguments = JSON.stringify(tc.function.arguments)
	}
	for (const tc of delta.tool_calls ?? []) addCall(tc)
	for (const tc of choice.message?.tool_calls ?? []) addCall(tc)
	return out
}



export async function* streamChat({baseUrl, apiKey, model, messages, tools, toolSchemas, effort, fetchImpl = fetch, signal}) {
	const schemas = tools?.length ? tools : toolSchemas
	const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
		},
		// Without tools (the text protocol below), send no tool fields: some servers refuse tool_choice alone.
		body: JSON.stringify({
			model,
			messages,
			stream: true,
			...(effort ? {reasoning_effort: effort} : {}),
			...(tools?.length ? {tools, parallel_tool_calls: false, tool_choice: 'auto'} : {}),
		}),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorMessage(raw, res.status), status: res.status}
		return
	}
	const pending = []
	const xmlTools = []
	const decoder = new TextDecoder()
	let buf = ''
	let contentBuf = ''
	let finishReason = null
	let ended = false
	let streamError = null
	const pump = function* (event, final) {
		const parsed = parseEvent(event, pending)
		if (parsed.finishReason) finishReason = parsed.finishReason
		if (parsed.done || parsed.finishReason) ended = true
		if (parsed.error) streamError = parsed.error
		if (parsed.content) contentBuf += parsed.content
		const next = takeXmlTools(contentBuf, final, schemas)
		contentBuf = next.rest
		if (next.text) yield {type: 'text', text: next.text}
		for (const t of next.tools) xmlTools.push(t)
	}
	const body = res.body
	if (body) {
		for await (const chunk of body) {
			buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})
			buf = buf.replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* pump(event, false)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* pump(buf.replace(/\r\n/g, '\n'), false)
	yield* pump('', true)
	if (signal?.aborted) return
	if (streamError) {
		yield {type: 'error', message: streamError}
		return
	}
	// A stream that closed before [DONE] or a finish reason was interrupted: not a finished answer.
	if (!ended) {
		yield {type: 'error', message: 'The answer was cut off; try again'}
		return
	}
	if (finishReason === 'length' || xmlTools.some((t) => t.type === 'error')) {
		yield {type: 'error', message: 'The answer was cut off; try again'}
		return
	}
	const ready = [...xmlTools]
	for (const row of pending) {
		if (!row) continue
		const raw = String(row.arguments ?? '').trim()
		if (!row.name || (raw && !completeArgs(row.arguments))) {
			yield {type: 'error', message: 'The answer was cut off; try again'}
			return
		}
		ready.push({type: 'tool', id: row.id || callId(), name: row.name, arguments: raw ? row.arguments : '{}'})
	}
	for (const t of ready) yield t
}

// ---- The Responses API ---------------------------------------------------------------------------
// POST {base}/responses with store:false and stream:true. The loop speaks Chat Completions, so its
// messages and tools are converted here and the stream comes back as the same {text | tool | error}
// events. The system message becomes `instructions`; tool calls and results pair up by call_id.
// (Named and shaped like #51's ChatGPT path, which can call this with its access token.)
export function responsesInput(messages) {
	let instructions = ''
	const input = []
	for (const m of messages ?? []) {
		if (!m) continue
		if (m.role === 'system') instructions += (instructions ? '\n\n' : '') + String(m.content ?? '')
		else if (m.role === 'user') input.push({role: 'user', content: String(m.content ?? '')})
		else if (m.role === 'assistant') {
			if (m.content) input.push({role: 'assistant', content: String(m.content)})
			for (const t of m.tool_calls ?? []) input.push({type: 'function_call', call_id: t.id, name: t.function?.name, arguments: t.function?.arguments || '{}'})
		} else if (m.role === 'tool') input.push({type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '')})
	}
	return {instructions, input}
}

export const responsesTools = (tools) =>
	(tools ?? []).map((t) => ({type: 'function', name: t.function?.name, description: t.function?.description ?? '', parameters: t.function?.parameters ?? {type: 'object', properties: {}}}))

export async function* streamResponses({baseUrl = 'https://api.openai.com/v1', apiKey, accessToken, model, messages, tools, toolSchemas, effort, fetchImpl = fetch, signal}) {
	const schemas = tools?.length ? tools : toolSchemas
	const {instructions, input} = responsesInput(messages)
	const token = accessToken ?? apiKey
	const body = {model, input, store: false, stream: true}
	if (effort) body.reasoning = {effort}
	if (instructions) body.instructions = instructions
	const fnTools = responsesTools(tools)
	if (fnTools.length) Object.assign(body, {tools: fnTools, tool_choice: 'auto', parallel_tool_calls: false})
	const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/responses`, {
		method: 'POST',
		headers: {'content-type': 'application/json', accept: 'text/event-stream', ...(token ? {authorization: `Bearer ${token}`} : {})},
		body: JSON.stringify(body),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorMessage(raw, res.status), status: res.status}
		return
	}
	const calls = new Map() // function_call items by item id, arguments filled in from deltas
	const emitted = new Set()
	const toolEvents = [] // held until response.completed says the turn finished cleanly
	let badToolArgs = false
	let errored = false
	let contentBuf = ''
	let finished = false
	const handle = function* (event, final) {
		const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
		let ev = null
		if (data && data !== '[DONE]') {
			try {
				ev = JSON.parse(data)
			} catch {}
		}
		if (ev?.type === 'response.output_text.delta' && typeof ev.delta === 'string') contentBuf += ev.delta
		// Some local servers put Qwen-style XML tool calls in the text, as with Chat Completions.
		const next = takeXmlTools(contentBuf, final, schemas)
		contentBuf = next.rest
		if (next.text) yield {type: 'text', text: next.text}
		for (const t of next.tools) toolEvents.push(t)
		if (!ev) return
		const item = ev.item
		if (ev.type === 'response.output_item.added' && item?.type === 'function_call') {
			calls.set(item.id ?? item.call_id, {id: item.call_id || callId(), name: item.name ?? '', arguments: item.arguments ?? ''})
		} else if (ev.type === 'response.function_call_arguments.delta') {
			const row = calls.get(ev.item_id)
			if (row && typeof ev.delta === 'string') row.arguments += ev.delta
		} else if (ev.type === 'response.output_item.done' && item?.type === 'function_call') {
			const row = calls.get(item.id ?? item.call_id) ?? {id: item.call_id || callId(), name: '', arguments: ''}
			calls.delete(item.id ?? item.call_id)
			const id = item.call_id || row.id
			const name = item.name || row.name
			if (name && !emitted.has(id)) {
				const args = typeof item.arguments === 'string' && item.arguments ? item.arguments : row.arguments
				const raw = String(args ?? '').trim()
				if (raw && !completeArgs(args)) badToolArgs = true
				else {
					emitted.add(id)
					toolEvents.push({type: 'tool', id, name, arguments: raw ? args : '{}'})
				}
			}
		} else if (ev.type === 'response.completed') finished = true
		else if (ev.type === 'response.failed' || ev.type === 'response.incomplete' || ev.type === 'error') {
			finished = true
			errored = true
			const err = ev.response?.error ?? ev.error ?? ev
			const why = ev.response?.incomplete_details?.reason
			yield {type: 'error', message: String(err?.message || (why ? `The answer stopped early (${why})` : 'The assistant did not answer')), status: Number(err?.status) || 0}
		}
	}
	const decoder = new TextDecoder()
	let buf = ''
	if (res.body) {
		for await (const chunk of res.body) {
			// A chunk can end between the \r and the \n, so the whole buffer is normalized, not just the new piece.
			buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})
			buf = buf.replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* handle(event, false)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* handle(buf.replace(/\r\n/g, '\n'), false)
	yield* handle('', true)
	if (signal?.aborted) return
	// An interrupted stream is a failure, not an answer.
	if (!finished) {
		yield {type: 'error', message: 'The answer was cut off; try again'}
		return
	}
	if (errored) return
	if (badToolArgs || calls.size > 0 || toolEvents.some((t) => t.type === 'error')) {
		yield {type: 'error', message: 'The answer was cut off; try again'}
		return
	}
	for (const t of toolEvents) yield t
}

// ---- Tools as text, for models that can't take them natively ----------------------------------
// Some backends refuse native tools for some models (Ollama with Gemma: "does not support tools";
// OpenRouter: "No endpoints found that support tool use"). Then the tools go in the system prompt,
// the model writes <tool_call>{"name","arguments"}</tool_call>, and takeXmlTools above reads it back
// as an ordinary tool call. Approve cards and lookups work the same. (Ported from Wardyx, where
// this measured 100% valid calls on gemma3:12b.)
const TOOLS_UNSUPPORTED = /does not support tool|tools? (?:are|is) not supported|function calling is not supported|tool use is not supported|no endpoints found that support tool use|tool_choice.*not supported/i
export const toolsUnsupported = (ev) => ev?.type === 'error' && (ev.status === 400 || ev.status === 404 || ev.status === 422) && TOOLS_UNSUPPORTED.test(String(ev.message ?? ''))

export function toolProtocolPrompt(tools) {
	const lines = (tools ?? []).map((t) => JSON.stringify({name: t.function?.name, description: t.function?.description ?? '', parameters: t.function?.parameters ?? {}}))
	return [
		'# Tool calling',
		'You can call tools to look things up or take actions. Your tools are listed below, one JSON signature per line:',
		'<tools>',
		...lines,
		'</tools>',
		'To call a tool, output exactly:',
		'<tool_call>{"name": "<tool name>", "arguments": {<arguments as JSON>}}</tool_call>',
		'Rules:',
		'- One <tool_call> block per call. Use only the tool names listed above.',
		'- A tool’s result comes back in a <tool_response> block; continue from there.',
		'- When you have the answer, reply normally with no <tool_call> block.',
	].join('\n')
}

// The same conversation with tool calls and results written as text, for a backend without tools.
export function toolProtocolMessages(messages, tools) {
	const out = []
	const nameById = new Map()
	const push = (role, content) => {
		const last = out.at(-1)
		if (role === 'user' && last?.role === 'user') last.content += `\n\n${content}`
		else out.push({role, content})
	}
	const protocol = toolProtocolPrompt(tools)
	let sawSystem = false
	for (const m of messages ?? []) {
		if (!m) continue
		if (m.role === 'system') {
			sawSystem = true
			out.push({role: 'system', content: `${m.content ?? ''}\n\n${protocol}`})
		} else if (m.role === 'assistant') {
			const calls = (m.tool_calls ?? []).map((t) => {
				nameById.set(t.id, t.function?.name)
				let args = {}
				try {
					args = JSON.parse(t.function?.arguments || '{}')
				} catch {}
				return `<tool_call>${JSON.stringify({name: t.function?.name, arguments: args})}</tool_call>`
			})
			push('assistant', [m.content, ...calls].filter(Boolean).join('\n') || ' ')
		} else if (m.role === 'tool') {
			const name = nameById.get(m.tool_call_id)
			push('user', `<tool_response${name ? ` name="${name}"` : ''}>\n${m.content ?? ''}\n</tool_response>`)
		} else push('user', String(m.content ?? ''))
	}
	if (!sawSystem) out.unshift({role: 'system', content: protocol})
	return out
}

// Backends (address + model) that refused native tools, so later turns skip the failed request.
// ---- Chat Completions that send you to the Responses API ------------------------------------------
// Some models refuse tools on /chat/completions and say so ("…not supported for gpt-6.2-sol in
// /v1/chat/completions. To use function tools, use /v1/responses…"). Then the request goes to
// /responses at the same address instead, and that is remembered for this address and model.
const RESPONSES_ONLY = /\buse \/?(?:v1\/)?responses\b|(?:only|is) (?:supported|available) (?:in|on|by|via|through) (?:the )?(?:\/?v1\/)?responses\b/i
export const wantsResponses = (ev) => ev?.type === 'error' && (ev.status === 400 || ev.status === 404) && RESPONSES_ONLY.test(String(ev.message ?? ''))
const responsesModels = new Set()
export const forgetResponsesModels = () => responsesModels.clear()

export async function* chatOrResponses(opts) {
	const id = `${String(opts.baseUrl ?? '').replace(/\/+$/, '')}|${opts.model}`
	if (responsesModels.has(id)) return yield* streamResponses(opts)
	let first = true
	for await (const ev of streamChat(opts)) {
		if (first && wantsResponses(ev)) {
			responsesModels.add(id)
			return yield* streamResponses(opts)
		}
		first = false
		yield ev
	}
}

const textToolModels = new Set()
export const forgetTextToolModels = () => textToolModels.clear()

// Runs a stream (Chat Completions or Responses); if the backend refuses native tools, runs it again
// with the tools as text, and remembers that for this address and model.
export async function* withToolFallback(stream, opts) {
	const id = `${String(opts.baseUrl ?? '').replace(/\/+$/, '')}|${opts.model}`
	const asText = () => stream({...opts, messages: toolProtocolMessages(opts.messages, opts.tools), tools: [], toolSchemas: opts.tools})
	if (!opts.tools?.length) return yield* stream(opts)
	if (textToolModels.has(id)) return yield* asText()
	let first = true
	for await (const ev of stream(opts)) {
		if (first && toolsUnsupported(ev)) {
			textToolModels.add(id)
			return yield* asText()
		}
		first = false
		yield ev
	}
}

// ---- Live checks and model lists ----------------------------------------------------------------
// GET {base}/models is cheap: it proves the address is right and the key is accepted, and it says
// which models the endpoint serves.

// OpenAI's /models also lists embeddings, speech, images and moderation. Keep what can chat.
export function isChatModel(id) {
	// A fine-tune is a chat model when the model it was tuned from is (ft:gpt-4o-mini:org::id).
	const s = String(id).toLowerCase().replace(/^ft:([^:]+):.*$/, '$1')
	if (/^(text-embedding|tts-|whisper|dall-e|davinci|babbage|sora|computer-use|gpt-live)/.test(s)) return false
	if (/(realtime|-audio|^gpt-audio|transcribe|diarize|-tts|-search-api|embedding|moderation|image)/.test(s)) return false
	return true
}

// OpenAI's list, whichever way it was added (preset or a custom endpoint pointed at it).
const isOpenAiList = (provider, baseUrl) => {
	if (provider === 'openai') return true
	try {
		return new URL(String(baseUrl)).hostname === 'api.openai.com'
	} catch {
		return false
	}
}

const trimBase = (baseUrl) => String(baseUrl ?? '').replace(/\/+$/, '')

// Same sentence for a key check and a chat when the endpoint cannot be reached.
export function describeReachFailure(baseUrl, error) {
	const why = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'it didn’t answer in time' : error?.cause?.code || error?.message || 'the connection failed'
	return `Couldn’t reach ${trimBase(baseUrl)}: ${why}`
}
const bearer = (apiKey) => (apiKey ? {authorization: `Bearer ${apiKey}`} : {})
const listRequest = (provider, baseUrl, apiKey) =>
	provider === 'anthropic'
		? {url: `${trimBase(baseUrl)}/models?limit=1000`, headers: apiKey ? anthropicHeaders(apiKey) : {}}
		: {url: `${trimBase(baseUrl)}/models`, headers: bearer(apiKey)}

const withTimeout = (signal, ms) => {
	const t = AbortSignal.timeout(ms)
	return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : t
}

export class ProviderCheckError extends Error {
	constructor(status, message, httpStatus) {
		super(message)
		this.status = status
		this.httpStatus = httpStatus
	}
}

export async function listModels({provider, baseUrl, apiKey, fetchImpl = fetch, signal, timeoutMs = 10_000}) {
	const {url, headers} = listRequest(provider, baseUrl, apiKey)
	let res
	try {
		res = await fetchImpl(url, {headers: {accept: 'application/json', ...headers}, signal: withTimeout(signal, timeoutMs)})
	} catch (e) {
		if (signal?.aborted) throw e
		throw new ProviderCheckError('unreachable', describeReachFailure(baseUrl, e))
	}
	if (res.status === 401 || res.status === 403) {
		throw new ProviderCheckError('rejected', apiKey ? 'The endpoint rejected this API key' : 'The endpoint needs an API key', res.status)
	}
	if (res.status === 404) throw new ProviderCheckError('no-list', `Nothing at ${url.split('?')[0]}. Check the base URL ends in /v1.`, 404)
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		throw new ProviderCheckError('error', errorMessage(raw, res.status), res.status)
	}
	let payload
	try {
		payload = await res.json()
	} catch {
		throw new ProviderCheckError('error', 'The endpoint answered, but not with a model list')
	}
	if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
		const message = payload.error.message || payload.message
		throw new ProviderCheckError('error', message ? String(message) : 'The endpoint reported an error')
	}
	const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null
	if (!rows) throw new ProviderCheckError('error', 'The endpoint answered, but not with a model list')
	const openAi = isOpenAiList(provider, baseUrl)
	const seen = new Set()
	const models = []
	for (const r of rows) {
		const id = String((typeof r === 'string' ? r : r?.id ?? r?.name ?? r?.model) ?? '').trim()
		if (!id || id.length > 200 || seen.has(id)) continue
		if (openAi && !isChatModel(id)) continue
		seen.add(id)
		const name = typeof r === 'object' && r?.display_name ? String(r.display_name) : undefined
		models.push(name && name !== id ? {id, name} : {id})
	}
	models.sort((a, b) => a.id.localeCompare(b.id))
	return models
}

// Reachable, key accepted, and (when a model is set) whether the endpoint serves it.
export async function verifyKey({provider, baseUrl, apiKey, model, fetchImpl = fetch, signal, timeoutMs}) {
	try {
		const models = await listModels({provider, baseUrl, apiKey, fetchImpl, signal, timeoutMs})
		const wanted = String(model ?? '').trim()
		const found = !wanted || !models.length ? null : models.some((m) => m.id === wanted || m.id === `${wanted}:latest`)
		const count = models.length
		if (found === false) {
			return {ok: false, status: 'no-model', message: `Key works, but ${wanted} isn’t one of the ${count} models this endpoint serves`, models, modelFound: false}
		}
		return {ok: true, status: 'ok', message: count ? `Connected · ${count} model${count === 1 ? '' : 's'} available` : 'Connected', models, modelFound: found}
	} catch (e) {
		if (!(e instanceof ProviderCheckError)) throw e
		return {ok: false, status: e.status, message: e.message, models: [], modelFound: null}
	}
}
