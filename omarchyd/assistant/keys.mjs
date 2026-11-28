import {mkdir} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {plainObject, readJsonState, removeAtomic, writeAtomic} from '../atomic.mjs'
import {RpcError} from '../rpc.mjs'
import {ANTHROPIC} from './anthropic.mjs'

const SPACEXAI = 'https://api.x.ai/v1'
const OPENAI = 'https://api.openai.com/v1'
// The one address a person who is not the owner may add. Any other address can reach the network, so it stays with the owner.
const LOCAL_MODEL = 'http://127.0.0.1:11434/v1'
export const customBasePermitted = (role, baseUrl) => role === 'owner' || normalizeBaseUrl(baseUrl) === LOCAL_MODEL
// Fixed addresses of the named providers; a custom endpoint brings its own.
export const presetBaseUrl = (provider) => ({spacexai: SPACEXAI, openai: OPENAI, anthropic: ANTHROPIC})[provider] ?? null
// Which API the assistant streams from. OpenAI recommends Responses; the others default to Chat
// Completions, and a key can switch (most local servers now serve both).
const APIS = ['chat', 'responses']
export const apiOf = (k) => (APIS.includes(k?.api) ? k.api : k?.provider === 'openai' ? 'responses' : 'chat')
// How hard a reasoning model thinks. Empty leaves the model's own default and sends nothing.
const EFFORTS = ['low', 'medium', 'high']
export const effortOf = (k) => (EFFORTS.includes(k?.effort) ? k.effort : '')
const ID = () => 'k_' + randomBytes(6).toString('hex')
const last4 = (s) => String(s).slice(-4)
// A pasted endpoint (…/v1/chat/completions, …/v1/responses, …/v1/models) is trimmed back to its base.
export const normalizeBaseUrl = (raw) => {
	const s = String(raw ?? '').trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|completions|responses|models)$/i, '')
	try {
		const u = new URL(s)
		if (!u.pathname || u.pathname === '/') return `${u.origin}/v1`
	} catch {}
	return s
}
// The last live check of a key, so Settings can show whether it still works.
const publicCheck = (c) => (c && typeof c === 'object' ? {ok: !!c.ok, status: String(c.status ?? ''), message: String(c.message ?? '').slice(0, 300), at: Number(c.at) || 0} : null)
const publicOf = (k, userId) => ({
	id: k.id,
	name: k.name,
	provider: k.provider,
	baseUrl: k.baseUrl,
	model: k.model,
	api: apiOf(k),
	effort: effortOf(k),
	check: publicCheck(k.check),
	last4: k.last4,
	...(k.provider === 'chatgpt' ? {account: k.chatgpt?.email ?? null, signedIn: !!k.chatgpt?.refreshToken} : {}),
	ownerUserId: k.ownerUserId,
	sharedWith: k.sharedWith,
	systemDefault: !!k.systemDefault,
	mine: k.ownerUserId === userId,
	createdAt: k.createdAt,
	updatedAt: k.updatedAt,
})
// A ChatGPT sign-in belongs to the person who signed in: never shared, never the system default.
// So does Hermes: it acts on this server with its owner's rights, so nobody else may chat through it.
const personal = (k) => k.provider === 'chatgpt' || k.provider === 'hermes'
const signedIn = (k) => k.provider !== 'chatgpt' || !!k.chatgpt?.refreshToken
// Ownership, or the one key the owner offered to everyone else. A per-account share is not access.
const canUse = (k, userId, declined = false) => k.ownerUserId === userId || (!personal(k) && !declined && !!k.systemDefault)
// A check that started before an edit must not be written onto the key, model, or address now saved.
const sameCheckedKey = (k, snapshot) => {
	if (snapshot == null) return true
	if (typeof snapshot === 'number') return snapshot === k.updatedAt
	if (typeof snapshot !== 'object') return true
	const fields = ['apiKey', 'model', 'baseUrl'].filter((field) => snapshot[field] !== undefined)
	if (fields.length) return fields.every((field) => snapshot[field] === k[field])
	if (snapshot.updatedAt !== undefined) return snapshot.updatedAt === k.updatedAt
	return true
}

const validKeysState = (value) => plainObject(value) && Array.isArray(value.keys)

export function createKeyStore({dataDir, now = () => Date.now()}) {
	const file = join(dataDir, 'assistant', 'keys.json')
	let state = {keys: [], engine: {}, order: {}, declineServerDefault: {}}
	// Factory reset bumps this before it deletes. A write records the generation when it is queued
	// and writes nothing if a reset has moved on, so the queued write cannot recreate the file.
	let epoch = 0
	let damaged = false
	const damagedError = () => new RpcError('PRECONDITION_FAILED', 'keys.json is damaged and was left unchanged. Repair or remove it before saving.')
	const assertWritable = () => {
		if (damaged) throw damagedError()
	}
	const loaded = (async () => {
		await mkdir(join(dataDir, 'assistant'), {recursive: true, mode: 0o700}).catch(() => {})
		const res = await readJsonState(file, {validate: validKeysState})
		if (res.damaged) {
			damaged = true
			return
		}
		if (res.status !== 'ok') return
		state = {
			keys: res.value.keys.filter(plainObject),
			engine: plainObject(res.value.engine) ? res.value.engine : {},
			order: plainObject(res.value.order) ? res.value.order : {},
			declineServerDefault: plainObject(res.value.declineServerDefault) ? res.value.declineServerDefault : {},
		}
		for (const k of state.keys) {
			if (!Array.isArray(k.sharedWith)) k.sharedWith = []
			// Custom endpoints saved with a pasted endpoint path (…/v1/responses) work without re-adding them.
			if (k.provider === 'openai-compatible' && k.baseUrl) k.baseUrl = normalizeBaseUrl(k.baseUrl)
		}
	})()
	const save = () => {
		if (damaged) return Promise.reject(damagedError())
		const seen = epoch
		return writeAtomic(file, () => (seen !== epoch ? null : JSON.stringify(state, null, '\t')), {mode: 0o600})
	}
	const find = (id) => state.keys.find((k) => k.id === id)
	const declined = (userId) => !!state.declineServerDefault?.[userId]
	const ownKeys = (userId) => state.keys.filter((k) => k.ownerUserId === userId)
	// No saved order yet: the key that would answer today stays first, and a Hermes engine stays first.
	const derivedIds = (userId) => {
		const own = ownKeys(userId)
		const ranked = [...own].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0))
		let ids = ranked.map((k) => k.id)
		if (state.engine?.[userId] === 'hermes') {
			const hermes = own.find((k) => k.provider === 'hermes')
			if (hermes) ids = [hermes.id, ...ids.filter((id) => id !== hermes.id)]
		}
		return ids
	}
	const tryOrder = (userId) => {
		const own = ownKeys(userId)
		const byId = new Map(own.map((k) => [k.id, k]))
		const saved = Array.isArray(state.order?.[userId]) ? state.order[userId] : null
		const ids = (saved ?? derivedIds(userId)).filter((id) => byId.has(id))
		const ranked = ids.map((id) => byId.get(id))
		const rest = own.filter((k) => !ids.includes(k.id)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
		return saved ? [...ranked, ...rest] : ranked
	}
	// A new row joins the bottom of this person's list. It does not take the place of the one that answers now.
	const placeNew = (userId, id) => {
		const current = (Array.isArray(state.order?.[userId]) ? state.order[userId] : derivedIds(userId)).filter((x) => x !== id)
		state.order = {...(state.order ?? {}), [userId]: [...current, id]}
	}
	const dropFromOrder = (id) => {
		if (!state.order) return
		for (const [userId, ids] of Object.entries(state.order)) state.order[userId] = (Array.isArray(ids) ? ids : []).filter((x) => x !== id)
	}
	// The chain chat walks. Hermes is the whole chain when its row is first, and it is skipped otherwise.
	const candidateKeys = (userId) => {
		const rows = tryOrder(userId)
		// `builtin` is the old switch: Hermes is installed but this account turned it off, even if its row is first.
		if (rows[0]?.provider === 'hermes' && state.engine?.[userId] !== 'builtin') return [rows[0]]
		const chain = rows.filter((k) => signedIn(k) && k.provider !== 'hermes')
		if (!declined(userId)) {
			const offer = state.keys.find((k) => k.systemDefault && !personal(k))
			if (offer && offer.ownerUserId !== userId && !chain.some((k) => k.id === offer.id)) chain.push(offer)
		}
		return chain
	}
	// Another account sees the service and the model. The owner's name, address, and key stay off this row.
	const offerRow = (userId) => {
		const offer = state.keys.find((k) => k.systemDefault && !personal(k))
		if (!offer || offer.ownerUserId === userId) return null
		return {
			declined: declined(userId),
			id: offer.id,
			name: '',
			provider: offer.provider,
			baseUrl: '',
			model: offer.model,
			api: 'chat',
			effort: '',
			check: null,
			last4: '',
			ownerUserId: offer.ownerUserId,
			sharedWith: [],
			systemDefault: true,
			mine: false,
			offered: true,
			createdAt: offer.createdAt,
			updatedAt: offer.updatedAt,
		}
	}

	return {
		async listPublic(userId) {
			await loaded
			const rows = tryOrder(userId).map((k) => publicOf(k, userId))
			const offer = offerRow(userId)
			return offer ? [...rows, offer] : rows
		},
		async candidatesForUser(userId, preferId) {
			await loaded
			const chain = candidateKeys(userId)
			if (!preferId) return chain
			const preferred = find(String(preferId))
			if (!preferred || !canUse(preferred, userId, declined(userId))) return chain
			// A chat that started on Hermes stays on Hermes. Chat does not fall out of it.
			if (preferred.provider === 'hermes') return [preferred]
			const rest = chain.filter((k) => k.id !== preferred.id)
			if (chain.some((k) => k.id === preferred.id) || preferred.ownerUserId === userId) return [preferred, ...rest]
			return chain
		},
		async reorder(actor, ids) {
			await loaded
			assertWritable()
			const own = ownKeys(actor.userId).map((k) => k.id)
			const next = Array.isArray(ids) ? ids.map((id) => String(id)) : []
			const same = next.length === own.length && new Set(next).size === next.length && own.every((id) => next.includes(id))
			if (!same) throw new RpcError('BAD_REQUEST', 'That order doesn’t match your providers')
			state.order = {...(state.order ?? {}), [actor.userId]: next}
			state.engine = {...(state.engine ?? {})}
			if (find(next[0])?.provider === 'hermes') state.engine[actor.userId] = 'hermes'
			else delete state.engine[actor.userId]
			await save()
			return tryOrder(actor.userId).map((k) => publicOf(k, actor.userId))
		},
		async useServerDefault(actor, use) {
			await loaded
			assertWritable()
			const userId = actor.userId
			state.declineServerDefault = {...(state.declineServerDefault ?? {})}
			if (use) delete state.declineServerDefault[userId]
			else state.declineServerDefault[userId] = true
			await save()
			return {use: !state.declineServerDefault[userId]}
		},
		async clearDefault(actor) {
			await loaded
			assertWritable()
			if (actor.role === 'member') throw new RpcError('FORBIDDEN', 'Only the server’s owner can set the default key')
			for (const k of state.keys) if (k.ownerUserId === actor.userId) k.systemDefault = false
			await save()
			return true
		},
		async add(actor, input) {
			await loaded
			assertWritable()
			const ownerUserId = actor.userId
			const provider = ['openai-compatible', 'spacexai', 'openai', 'anthropic'].includes(input?.provider) ? input.provider : null
			if (!provider) throw new RpcError('BAD_REQUEST', 'Choose Grok, OpenAI, Anthropic or an OpenAI-compatible endpoint')
			// A custom endpoint makes omarchyd send requests to any address it can reach (your network
			// included), so only the server's owner can add one. The loopback model address is the exception.
			if (provider === 'openai-compatible' && !customBasePermitted(actor.role, input?.baseUrl)) {
				throw new RpcError('FORBIDDEN', 'Only the server’s owner can add a custom endpoint')
			}
			const apiKey = String(input?.apiKey ?? '').trim()
			if (apiKey.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			if (provider !== 'openai-compatible' && apiKey.length < 4) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			const model = String(input?.model ?? '').trim()
			if (!model || model.length > 80) throw new RpcError('BAD_REQUEST', 'Enter a model id')
			const name = [...String(input?.name ?? '').trim()].slice(0, 48).join('') || ({spacexai: 'Grok', openai: 'OpenAI', anthropic: 'Anthropic'}[provider] ?? 'API')
			let baseUrl = presetBaseUrl(provider) ?? normalizeBaseUrl(input?.baseUrl)
			if (provider === 'openai-compatible') {
				if (!/^https?:\/\/[^\s]+/i.test(baseUrl) || baseUrl.length > 200) throw new RpcError('BAD_REQUEST', 'Enter the API base URL')
			}
			const t = now()
			const row = {id: ID(), ownerUserId, name, provider, baseUrl, api: apiOf({provider, api: input?.api}), effort: effortOf(input), model, apiKey, last4: last4(apiKey), sharedWith: [], systemDefault: false, createdAt: t, updatedAt: t}
			state.keys.push(row)
			placeNew(ownerUserId, row.id)
			await save()
			return publicOf(row, ownerUserId)
		},
		async update(actor, input) {
			await loaded
			assertWritable()
			const k = find(String(input?.id ?? ''))
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (Array.isArray(input?.sharedWith) && input.sharedWith.map((id) => String(id)).some((id) => id && id !== k.ownerUserId)) {
				if (personal(k)) throw new RpcError('BAD_REQUEST', k.provider === 'hermes' ? 'Hermes acts with your rights, so it can’t be shared' : 'A ChatGPT sign-in can’t be shared')
				throw new RpcError('BAD_REQUEST', 'A provider stays with the person who added it. Offer one to everyone else instead.')
			}
			if (personal(k) && input?.systemDefault === true) {
				if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
				throw new RpcError('BAD_REQUEST', k.provider === 'hermes' ? 'Hermes acts with your rights, so it can’t be the system default' : 'A ChatGPT sign-in can’t be the system default')
			}
			if (personal(k) && Array.isArray(input?.sharedWith) && input.sharedWith.some((id) => String(id) && String(id) !== k.ownerUserId)) {
				if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
				throw new RpcError('BAD_REQUEST', k.provider === 'hermes' ? 'Hermes acts with your rights, so it can’t be shared' : 'A ChatGPT sign-in can’t be shared')
			}
			let makeDefault = false
			let clearDefault = false
			if (input?.systemDefault === true) {
				if (actor.role === 'member') throw new RpcError('FORBIDDEN', 'Only the server’s owner can set the default key')
				if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'You can only make a key you own the default')
				makeDefault = true
			} else if (input?.systemDefault === false && k.ownerUserId === actor.userId && actor.role !== 'member') {
				clearDefault = true
			}
			if (k.ownerUserId !== actor.userId && input?.sharedWith === undefined && input?.name === undefined && input?.model === undefined && input?.apiKey === undefined && input?.baseUrl === undefined && input?.api === undefined && input?.effort === undefined && input?.systemDefault === undefined) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			if (k.ownerUserId !== actor.userId && (input?.sharedWith || input?.name || input?.model || input?.apiKey || input?.baseUrl || input?.api || input?.effort !== undefined)) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			// Work on a copy so a refused update never leaves partial changes behind in memory.
			const next = {...k}
			if (clearDefault) next.systemDefault = false
			if (k.ownerUserId === actor.userId) {
				if (typeof input?.name === 'string') next.name = [...input.name.trim()].slice(0, 48).join('') || next.name
				if (typeof input?.model === 'string' && input.model.trim() && input.model.trim() !== next.model) {
					next.model = input.model.trim().slice(0, 80)
					delete next.check
				}
				if (input?.effort === '' || EFFORTS.includes(input?.effort)) next.effort = input.effort
				// ChatGPT has no API key and no address. Sharing and the system default stay off.
				if (personal(next)) {
					next.api = 'responses'
					next.baseUrl = OPENAI
					next.sharedWith = []
					next.systemDefault = false
					makeDefault = false
				} else if (APIS.includes(input?.api)) next.api = input.api
				if (!personal(next) && typeof input?.apiKey === 'string') {
					const secret = input.apiKey.trim()
					if (secret.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
					if (next.provider !== 'openai-compatible' && secret.length < 4) throw new RpcError('BAD_REQUEST', 'Enter an API key')
					if (next.provider === 'openai-compatible' || secret.length >= 4) {
						next.apiKey = secret
						next.last4 = last4(next.apiKey)
						delete next.check
					}
				}
				if (!personal(next) && next.provider === 'openai-compatible' && typeof input?.baseUrl === 'string') {
					if (actor.role !== 'owner') throw new RpcError('FORBIDDEN', 'Only the server’s owner can change a custom endpoint')
					next.baseUrl = normalizeBaseUrl(input.baseUrl)
					delete next.check
				}
				if (!personal(next) && Array.isArray(input?.sharedWith)) next.sharedWith = [...new Set(input.sharedWith.map((id) => String(id)).filter((id) => id && id !== next.ownerUserId))].slice(0, 32)
			}
			next.updatedAt = now()
			if (makeDefault) next.systemDefault = true
			const id = k.id
			// Swap in before the write so a key added or removed meanwhile is not lost; every check is done.
			// Return this key, not whatever later sits at the old index.
			state = {
				...state,
				keys: state.keys.map((x) => {
					if (x.id === id) return next
					return makeDefault ? {...x, systemDefault: false} : x
				}),
			}
			await save()
			return publicOf(state.keys.find((x) => x.id === id) ?? next, actor.userId)
		},
		async remove(actor, id) {
			await loaded
			assertWritable()
			const k = find(id)
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can delete it')
			state.keys = state.keys.filter((x) => x.id !== id)
			dropFromOrder(id)
			await save()
			return true
		},
		async recordCheck(id, check, snapshot) {
			await loaded
			assertWritable()
			const k = find(id)
			if (!k || !sameCheckedKey(k, snapshot)) return null
			k.check = {...publicCheck(check), at: now()}
			await save()
			return publicCheck(k.check)
		},
		// Sign in with ChatGPT: one row per person and ChatGPT account (signing in again updates it).
		async saveChatGpt(userId, {sub, email, clientId, accessToken, refreshToken, idToken, expiresAt, scope, model}) {
			await loaded
			assertWritable()
			if (!sub || !clientId || !accessToken || !refreshToken) throw new RpcError('BAD_GATEWAY', 'ChatGPT didn’t finish the sign-in')
			const t = now()
			let k = state.keys.find((x) => x.provider === 'chatgpt' && x.ownerUserId === userId && x.chatgpt?.sub === sub)
			const picked = String(model ?? '').trim().slice(0, 80)
			if (!k) {
				k = {
					id: ID(),
					ownerUserId: userId,
					name: 'ChatGPT',
					provider: 'chatgpt',
					baseUrl: OPENAI,
					api: 'responses',
					effort: '',
					model: picked,
					apiKey: '',
					last4: '',
					sharedWith: [],
					systemDefault: false,
					createdAt: t,
				}
				state.keys.push(k)
				placeNew(userId, k.id)
			}
			if (picked && !k.model) k.model = picked
			k.api = 'responses'
			k.baseUrl = OPENAI
			k.sharedWith = []
			k.systemDefault = false
			k.chatgpt = {sub, email: email ?? null, clientId, accessToken, refreshToken, idToken, expiresAt, scope}
			delete k.check
			k.updatedAt = t
			await save()
			return publicOf(k, userId)
		},
		async updateChatGptTokens(id, tokens) {
			await loaded
			assertWritable()
			const k = find(id)
			if (!k || k.provider !== 'chatgpt') return null
			k.chatgpt = {...k.chatgpt, ...tokens}
			await save()
			return k
		},
		// Hermes (an agent already set up on this server) as this person's assistant.
		async upsertHermes(actor, {baseUrl, apiKey, model}) {
			await loaded
			assertWritable()
			const t = now()
			let k = state.keys.find((x) => x.provider === 'hermes' && x.ownerUserId === actor.userId)
			if (!k) {
				k = {id: ID(), ownerUserId: actor.userId, name: 'Hermes', provider: 'hermes', sharedWith: [], systemDefault: false, createdAt: t}
				state.keys.push(k)
				placeNew(actor.userId, k.id)
			}
			Object.assign(k, {baseUrl, apiKey, model: model || 'hermes-agent', api: 'chat', last4: last4(apiKey), updatedAt: t})
			delete k.check
			await save()
			return publicOf(k, actor.userId)
		},
		async removeHermes(userId) {
			await loaded
			assertWritable()
			const gone = state.keys.filter((k) => k.provider === 'hermes' && k.ownerUserId === userId).map((k) => k.id)
			state.keys = state.keys.filter((k) => !gone.includes(k.id))
			for (const id of gone) dropFromOrder(id)
			if (state.engine?.[userId] === 'hermes') delete state.engine[userId]
			await save()
		},
		async engineOf(userId) {
			await loaded
			if (state.engine?.[userId] === 'builtin') return 'builtin'
			return tryOrder(userId)[0]?.provider === 'hermes' ? 'hermes' : 'builtin'
		},
		async setEngine(userId, engine) {
			await loaded
			assertWritable()
			const hermes = ownKeys(userId).find((k) => k.provider === 'hermes')
			if (engine === 'hermes' && !hermes) throw new RpcError('PRECONDITION_FAILED', 'Connect Hermes first')
			const ids = tryOrder(userId).map((k) => k.id)
			state.order = {...(state.order ?? {})}
			state.engine = {...(state.engine ?? {})}
			if (engine === 'hermes') {
				state.order[userId] = [hermes.id, ...ids.filter((id) => id !== hermes.id)]
				state.engine[userId] = 'hermes'
			} else {
				state.engine[userId] = 'builtin'
				state.order[userId] = hermes ? [...ids.filter((id) => id !== hermes.id), hermes.id] : ids
			}
			await save()
			return engine === 'hermes' ? 'hermes' : 'builtin'
		},
		async getSecret(id) {
			await loaded
			return find(id) ?? null
		},
		// Factory reset: the key list is empty in memory and the file is gone, so the next owner
		// does not inherit these keys. A write queued before this bump does not put the file back.
		async reset() {
			await loaded
			epoch++
			damaged = false
			state = {keys: [], engine: {}, order: {}, declineServerDefault: {}}
			await removeAtomic(file)
		},
		async resolveForUser(userId, keyId) {
			await loaded
			if (keyId) {
				const k = find(keyId)
				if (!k || !canUse(k, userId, declined(userId))) throw new RpcError('NOT_FOUND', 'That key isn’t available')
				return k
			}
			const chain = candidateKeys(userId)
			if (chain.length) return chain[0]
			throw new RpcError('PRECONDITION_FAILED', 'Add an API key in Settings → Assistant')
		},
	}
}
