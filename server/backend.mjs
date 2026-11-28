// Minimal client for omarchyd's tRPC v11 HTTP API (no transformer, plain JSON).
//
// Wire format: plain tRPC v11 over HTTP, as omarchyd speaks it:
//   query    GET  /trpc/<path>?input=<urlencoded JSON>   (omit input when there is none)
//   mutation POST /trpc/<path>  body = JSON input
//   success  {"result":{"data":<value>}}
//   failure  {"error":{"message":"...","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401}}}

export const UNREACHABLE_MESSAGE = 'My Own Data Center is restarting or not answering. Wait a moment and try again.'

export class BackendError extends Error {
	constructor(message, {code = 'INTERNAL_SERVER_ERROR', status = 500, path, detail} = {}) {
		super(message)
		this.name = 'BackendError'
		this.code = code
		this.status = status
		this.path = path
		if (detail) this.detail = detail
	}
}

export function createBackendClient({baseUrl, timeoutMs = 20_000, fetchImpl = fetch}) {
	const base = baseUrl.replace(/\/+$/, '')

	async function call(path, {type, input, token, cookie, userAgent, timeout = timeoutMs, withCookies = false} = {}) {
		let url = `${base}/trpc/${path}`
		const headers = {accept: 'application/json'}
		if (token) headers.authorization = `Bearer ${token}`
		if (userAgent) headers['user-agent'] = userAgent
		if (cookie) headers.cookie = cookie
		const init = {method: type === 'mutation' ? 'POST' : 'GET', headers, redirect: 'follow'}
		if (type === 'mutation') {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input))}`
		}

		// Not answering, or dropping the connection part way through its answer (a restart), are the same to the caller.
		const unreachable = (error) => {
			const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code ?? error?.message ?? 'failed')
			return new BackendError(UNREACHABLE_MESSAGE, {
				code: 'UNREACHABLE',
				status: 502,
				path,
				detail: `Can't reach My Own Data Center at ${base} (${reason})`,
			})
		}
		let response
		let text
		try {
			response = await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeout)})
			text = await response.text()
		} catch (error) {
			throw unreachable(error)
		}
		let body
		try {
			body = text ? JSON.parse(text) : {}
		} catch {
			throw new BackendError(UNREACHABLE_MESSAGE, {
				code: 'BAD_RESPONSE',
				status: 502,
				path,
				detail: `My Own Data Center returned an unexpected response for ${path} (HTTP ${response.status})`,
			})
		}
		if (body?.error) {
			const data = body.error.data ?? {}
			throw new BackendError(body.error.message || 'My Own Data Center error', {
				code: data.code ?? 'INTERNAL_SERVER_ERROR',
				status: data.httpStatus ?? response.status ?? 500,
				path,
			})
		}
		if (!response.ok) {
			throw new BackendError(UNREACHABLE_MESSAGE, {
				code: 'BAD_RESPONSE',
				status: response.status >= 400 ? response.status : 502,
				path,
				detail: `My Own Data Center returned HTTP ${response.status} for ${path}`,
			})
		}
		const data = body?.result?.data
		// Cookies omarchyd set on this response, as `name=value` pairs.
		if (withCookies) return {data, cookies: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])}
		return data
	}

	return {
		baseUrl: base,
		query: (path, input, options = {}) => call(path, {...options, type: 'query', input}),
		mutation: (path, input, options = {}) => call(path, {...options, type: 'mutation', input}),
	}
}
