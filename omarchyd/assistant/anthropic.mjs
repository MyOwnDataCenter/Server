// Anthropic's own Messages API (POST /v1/messages). The loop speaks Chat Completions, so its messages
// and tools are converted here and the stream comes back as the same {text | tool | error} events.
//
// Thinking. Current Claude models think by default, and inside a tool loop the assistant turn with the
// tool call must be sent back with its thinking blocks, unchanged (signature included). A replayed
// block is also bound to the conversation before it, and this loop rebuilds the system prompt between
// turns (live facts, pending Approve notes) and swaps a waiting tool result for the real one after
// Approve. So the loop replays thinking only within the run that produced it (append-only, so valid)
// and drops it from earlier turns (dropping the oldest blocks is accepted). If the API still objects,
// for instance when a turn resumes after Approve, the request is retried once with that history's tool
// calls written as plain text, which has no thinking requirement.
export const ANTHROPIC = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192
// Room for thinking as well as the answer when an effort is chosen.
const MAX_TOKENS_THINKING = 32_000
const EPHEMERAL = Object.freeze({type: 'ephemeral'})

export const anthropicHeaders = (apiKey) => ({'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION})

// Tool ids must match ^[a-zA-Z0-9_-]+$; ids from another provider are mapped the same way on both sides.
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'toolu_missing'

const parseInput = (raw) => {
	try {
		const v = JSON.parse(raw || '{}')
		return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
	} catch {
		return {}
	}
}

export function anthropicMessages(messages) {
	const system = []
	const out = []
	const push = (role, blocks) => {
		if (!blocks.length) return
		const last = out.at(-1)
		// Roles alternate: tool results after a tool call, or two user turns in a row, share one message.
		if (last?.role === role) last.content.push(...blocks)
		else out.push({role, content: blocks})
	}
	for (const m of messages ?? []) {
		if (!m) continue
		if (m.role === 'system') {
			if (m.content) system.push(String(m.content))
		} else if (m.role === 'user') {
			push('user', [{type: 'text', text: String(m.content ?? '').trim() ? String(m.content) : '(empty message)'}])
		} else if (m.role === 'assistant') {
			// Thinking from this run of the tool loop goes first, exactly as it came.
			const blocks = Array.isArray(m.thinking) ? m.thinking.map((b) => ({...b})) : []
			// The API refuses a text block that is only whitespace, and a saved chat replays every message.
			if (String(m.content ?? '').trim()) blocks.push({type: 'text', text: String(m.content)})
			for (const t of m.tool_calls ?? []) blocks.push({type: 'tool_use', id: safeId(t.id), name: t.function?.name, input: parseInput(t.function?.arguments)})
			push('assistant', blocks)
		} else if (m.role === 'tool') {
			push('user', [{type: 'tool_result', tool_use_id: safeId(m.tool_call_id), content: String(m.content ?? '')}])
		}
	}
	return {system: system.join('\n\n'), messages: out}
}

// The same history with tool calls and results as plain text, and no thinking: the fallback when the
// API refuses how earlier tool turns or thinking were sent back.
export function flattenToolTurns(messages) {
	const names = new Map()
	return (messages ?? []).map((m) => {
		if (m?.role === 'assistant' && m.tool_calls?.length) {
			const calls = m.tool_calls.map((t) => {
				names.set(t.id, t.function?.name)
				return `[Called ${t.function?.name} with ${t.function?.arguments || '{}'}]`
			})
			return {role: 'assistant', content: [m.content, ...calls].filter(Boolean).join('\n')}
		}
		if (m?.role === 'tool') return {role: 'user', content: `[Result of ${names.get(m.tool_call_id) ?? 'the tool'}]\n${m.content ?? ''}`}
		if (m?.role === 'assistant') return {role: 'assistant', content: m.content}
		return m
	})
}

export const anthropicTools = (tools) =>
	(tools ?? []).map((t) => ({name: t.function?.name, description: t.function?.description ?? '', input_schema: t.function?.parameters ?? {type: 'object', properties: {}}}))

// An error body that isn't JSON is shown only when it is short plain text. A proxy's or gateway's HTML page,
// or a long dump, becomes one plain sentence instead.
export const plainBody = (raw, status) => {
	const text = raw ? String(raw).trim() : ''
	if (!text) return `HTTP ${status}`
	if (/^</.test(text) || /<\/?(?:html|head|body)\b/i.test(text) || text.length > 300) return `The AI service answered with an error page (HTTP ${status}). Check the endpoint address or try again.`
	return text
}

const errorText = (raw, status) => {
	try {
		const m = JSON.parse(raw)?.error?.message
		if (m) return String(m)
	} catch {}
	return plainBody(raw, status)
}

export async function* streamAnthropic({baseUrl = ANTHROPIC, apiKey, model, messages, tools, effort, fetchImpl = fetch, signal, retried = false}) {
	const converted = anthropicMessages(messages)
	const body = {model, max_tokens: effort ? MAX_TOKENS_THINKING : MAX_TOKENS, messages: converted.messages, stream: true}
	// Adaptive thinking with an effort level, on the current Claude models. Without one the model's own
	// default applies (most current models already think).
	if (effort) Object.assign(body, {thinking: {type: 'adaptive'}, output_config: {effort}})
	// Prompt caching. Every request re-sends the tools and system prompt, and each step of a tool loop
	// re-sends the whole chat, so: one breakpoint after the tools (they rarely change), one after the
	// system prompt, and top-level caching for the conversation so far. Short prompts just don't cache.
	if (converted.system) body.system = [{type: 'text', text: converted.system, cache_control: EPHEMERAL}]
	const fnTools = anthropicTools(tools)
	if (fnTools.length) {
		fnTools[fnTools.length - 1].cache_control = EPHEMERAL
		Object.assign(body, {tools: fnTools, tool_choice: {type: 'auto', disable_parallel_tool_use: true}})
	}
	if (converted.messages.length) body.cache_control = EPHEMERAL
	const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/messages`, {
		method: 'POST',
		headers: {'content-type': 'application/json', accept: 'text/event-stream', ...anthropicHeaders(apiKey)},
		body: JSON.stringify(body),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		const message = errorText(raw, res.status)
		if (res.status === 400 && !retried && /thinking|signature/i.test(message)) {
			yield* streamAnthropic({baseUrl, apiKey, model, messages: flattenToolTurns(messages), tools, effort, fetchImpl, signal, retried: true})
			return
		}
		yield {type: 'error', message, status: res.status}
		return
	}
	const blocks = new Map() // content blocks by index
	const toolEvents = [] // held until the stop reason says the turn finished cleanly
	let stopReason = null
	let finished = false
	const handle = function* (event) {
		const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
		if (!data) return
		let ev
		try {
			ev = JSON.parse(data)
		} catch {
			return
		}
		if (ev.type === 'content_block_start') {
			const cb = ev.content_block ?? {}
			blocks.set(ev.index, {type: cb.type, id: cb.id, name: cb.name, json: '', thinking: cb.thinking ?? '', signature: cb.signature ?? '', data: cb.data})
			if (cb.type === 'text' && cb.text) yield {type: 'text', text: cb.text}
		} else if (ev.type === 'content_block_delta') {
			const b = blocks.get(ev.index)
			if (ev.delta?.type === 'text_delta' && ev.delta.text) yield {type: 'text', text: ev.delta.text}
			else if (ev.delta?.type === 'input_json_delta' && b) b.json += ev.delta.partial_json ?? ''
			else if (ev.delta?.type === 'thinking_delta' && b) b.thinking += ev.delta.thinking ?? ''
			else if (ev.delta?.type === 'signature_delta' && b) b.signature = ev.delta.signature ?? ''
		} else if (ev.type === 'content_block_stop') {
			const b = blocks.get(ev.index)
			if (b?.type === 'tool_use' && b.name) toolEvents.push({type: 'tool', id: b.id || safeId(''), name: b.name, arguments: JSON.stringify(parseInput(b.json))})
			// Not shown; kept by the loop only to send back within this tool loop.
			else if (b?.type === 'thinking') yield {type: 'thinking', block: {type: 'thinking', thinking: b.thinking, signature: b.signature}}
			else if (b?.type === 'redacted_thinking') yield {type: 'thinking', block: {type: 'redacted_thinking', data: b.data}}
			blocks.delete(ev.index)
		} else if (ev.type === 'message_delta') {
			if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
		} else if (ev.type === 'message_stop') {
			finished = true
			// A reply cut off by its length limit may hold a half-written tool call: run none of it.
			if (stopReason === 'max_tokens') yield {type: 'error', message: 'The answer ran out of room and was cut off; try again or ask for less'}
			else if (stopReason === 'model_context_window_exceeded') yield {type: 'error', message: 'This chat is too long for the model to answer; start a new chat'}
			else if (stopReason === 'refusal') yield {type: 'error', message: 'The model declined to answer this'}
			else yield* toolEvents
		}
		else if (ev.type === 'error') {
			finished = true
			const kind = ev.error?.type
			const error = {type: 'error', message: String(ev.error?.message || 'The assistant did not answer'), status: kind === 'authentication_error' ? 401 : kind === 'overloaded_error' ? 529 : 0}
			// Overloaded or a server error after a 200: a fresh request may well work.
			if (kind === 'overloaded_error' || kind === 'api_error') error.retryable = true
			yield error
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
				yield* handle(event)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* handle(buf.replace(/\r\n/g, '\n'))
	if (!finished && !signal?.aborted) yield {type: 'error', message: 'The answer was cut off; try again'}
}
