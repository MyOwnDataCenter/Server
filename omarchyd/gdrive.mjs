// Zero-dependency Google Drive v3 client + loopback restic REST v2 bridge for encrypted backups.
//
// Security & scale design:
// - Uses OAuth 2.0 + PKCE (S256) with strict `https://www.googleapis.com/auth/drive.file` scope:
//   My Own Data Center can ONLY read/write the backup folder and encrypted objects it created itself,
//   never the user's personal Google Drive files.
// - All backup data is encrypted locally by restic (AES-256-CTR + Poly1305) BEFORE reaching this
//   module. Google Drive only ever sees opaque content-addressed encrypted blobs.
// - Supports both 3-2-1 Mirror mode (sync local encrypted repo to Drive) and Direct-to-Drive mode
//   (ephemeral loopback restic REST v2 bridge: zero duplicate local disk needed for multi-TB pools).
// - Engineered for 30 TB Google Drive accounts: resumable 8 MiB chunked uploads, exponential backoff
//   on 429/5xx, graceful pause on Google's 750 GB/24h upload quota, and a local path->fileId index.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {createReadStream, createWriteStream} from 'node:fs'
import {mkdir, open, readFile, readdir, rm, stat} from 'node:fs/promises'
import http from 'node:http'
import {dirname, join} from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {removeAtomic, writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DEFAULT_API_BASE = 'https://www.googleapis.com/drive/v3'
const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MULTIPART_THRESHOLD = 4 * 1024 * 1024 // < 4 MiB -> single multipart request
const RESUMABLE_CHUNK = 8 * 1024 * 1024 // 8 MiB (multiple of 256 KiB per Drive resumable spec)
const MAX_RESTIC_OBJECT = 512 * 1024 * 1024 // 512 MiB safety cap per restic pack
const RESTIC_TYPES = new Set(['data', 'keys', 'locks', 'snapshots', 'index'])
const RESTIC_OBJECT_RE = /^[0-9a-f]{64}$/
const SAFE_FOLDER_NAME_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/

export class GdriveQuotaError extends Error {
	constructor(message, {reason = 'dailyLimitExceeded', retryAfterMs = 60 * 60_000} = {}) {
		super(message)
		this.name = 'GdriveQuotaError'
		this.code = 'QUOTA_PAUSED'
		this.reason = reason
		this.retryAfterMs = retryAfterMs
	}
}

export function pkceChallenge(verifier) {
	return createHash('sha256').update(String(verifier)).digest('base64url')
}

export function cleanFolderName(name) {
	const clean = String(name ?? '').trim() || 'My Own Data Center Backups'
	if (!SAFE_FOLDER_NAME_RE.test(clean) || clean === '.' || clean === '..') {
		throw new RpcError('BAD_REQUEST', 'Enter a valid Google Drive folder name')
	}
	return clean
}

export function cleanClientId(id) {
	const clean = String(id ?? '').trim()
	if (!clean || clean.length > 200 || /[\s\x00-\x1f]/.test(clean)) {
		throw new RpcError('BAD_REQUEST', 'Enter your Google OAuth Client ID')
	}
	return clean
}

export function buildGdriveAuthUrl({clientId, redirectUri, state, codeChallenge, authUrl = DEFAULT_AUTH_URL}) {
	const u = new URL(authUrl)
	u.searchParams.set('client_id', clientId)
	u.searchParams.set('redirect_uri', redirectUri)
	u.searchParams.set('response_type', 'code')
	u.searchParams.set('scope', GDRIVE_SCOPE)
	u.searchParams.set('access_type', 'offline')
	u.searchParams.set('prompt', 'consent')
	u.searchParams.set('state', state)
	u.searchParams.set('code_challenge', codeChallenge)
	u.searchParams.set('code_challenge_method', 'S256')
	return u.toString()
}

function assertStrictDriveFileScope(scopeStr, {required = true} = {}) {
	const scopes = String(scopeStr ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
	if (!scopes.length) {
		if (required) throw new RpcError('PRECONDITION_FAILED', 'Google returned a token without the required drive.file scope')
		return
	}
	if (scopes.length !== 1 || scopes[0] !== GDRIVE_SCOPE) {
		throw new RpcError('PRECONDITION_FAILED', `Refusing Google token with scope wider than drive.file (${scopes.join(' ')})`)
	}
}

// Accepts either a raw authorization code or the entire callback URL pasted from the browser bar.
export function parseAuthCodeInput(rawCode, explicitState = '') {
	const trimmed = String(rawCode ?? '').trim()
	if (!trimmed) throw new RpcError('BAD_REQUEST', 'Paste the authorization code or callback URL from Google')
	if (/^https?:\/\//i.test(trimmed)) {
		let u
		try {
			u = new URL(trimmed)
		} catch {
			throw new RpcError('BAD_REQUEST', 'That doesn’t look like a valid Google redirect URL')
		}
		if (u.searchParams.get('error')) {
			throw new RpcError('BAD_REQUEST', `Google sign-in was cancelled or denied (${u.searchParams.get('error')})`)
		}
		const code = u.searchParams.get('code')?.trim() ?? ''
		const state = u.searchParams.get('state')?.trim() || String(explicitState ?? '').trim()
		if (!code) throw new RpcError('BAD_REQUEST', 'That URL didn’t contain a Google authorization code')
		return {code, state}
	}
	return {code: trimmed, state: String(explicitState ?? '').trim()}
}

function escapeDriveQuery(val) {
	return String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function classifyDriveError(status, bodyText) {
	let parsed = null
	try {
		parsed = JSON.parse(bodyText)
	} catch {}
	const errObj = parsed?.error
	const firstReason = errObj?.errors?.[0]?.reason || parsed?.error || ''
	const message = errObj?.message || parsed?.error_description || bodyText.slice(0, 240) || `HTTP ${status}`
	const combined = `${firstReason} ${message}`
	if (status === 403 && /dailyLimitExceeded|uploadRateLimitExceeded|exceeded your daily/i.test(combined)) {
		return new GdriveQuotaError('Paused at Google Drive’s 750 GB daily upload limit. Already-uploaded encrypted data is safe; backups will resume automatically.', {
			reason: String(firstReason || 'dailyLimitExceeded'),
			retryAfterMs: 6 * 60 * 60_000,
		})
	}
	if (status === 403 && /storageQuotaExceeded/i.test(combined)) {
		return new GdriveQuotaError('Your Google Drive storage quota is full.', {
			reason: 'storageQuotaExceeded',
			retryAfterMs: 60 * 60_000,
		})
	}
	const err = new Error(`Google Drive error (${status}): ${message}`)
	err.status = status
	err.reason = String(firstReason)
	err.retryable =
		status === 429 ||
		(status >= 500 && status <= 599) ||
		(status === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(combined))
	return err
}

async function sleep(ms) {
	await new Promise((r) => setTimeout(r, ms))
}

export function createGdriveClient({
	indexFile,
	cacheDir,
	getCredentials, // async () => {clientId, clientSecret, refreshToken, folderId, folderName}
	onTokenRefreshed = null,
	fetchImpl = fetch,
	authUrl = DEFAULT_AUTH_URL,
	tokenUrl = DEFAULT_TOKEN_URL,
	apiBase = DEFAULT_API_BASE,
	uploadBase = DEFAULT_UPLOAD_BASE,
	chunkSize = RESUMABLE_CHUNK,
	multipartThreshold = MULTIPART_THRESHOLD,
	now = Date.now,
}) {
	let cachedAccess = null // {token, expiresAt}
	let refreshInflight = null
	let index = {folderId: null, folders: {}, files: {}, updatedAt: 0}
	let indexLoaded = false
	const folderLocks = new Map() // relDir -> Promise<string>
	let indexSaveTimer = null
	let indexDirty = false

	async function loadIndex() {
		if (indexLoaded) return index
		indexLoaded = true
		try {
			const raw = JSON.parse(await readFile(indexFile, 'utf8'))
			if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
				index = {
					folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
					folders: raw.folders && typeof raw.folders === 'object' ? raw.folders : {},
					files: raw.files && typeof raw.files === 'object' ? raw.files : {},
					updatedAt: Number(raw.updatedAt) || 0,
				}
			}
		} catch {
			index = {folderId: null, folders: {}, files: {}, updatedAt: 0}
		}
		return index
	}

	async function flushIndex() {
		if (indexSaveTimer) {
			clearTimeout(indexSaveTimer)
			indexSaveTimer = null
		}
		if (!indexDirty) return
		indexDirty = false
		index.updatedAt = now()
		await mkdir(dirname(indexFile), {recursive: true, mode: 0o700})
		await writeAtomic(indexFile, JSON.stringify(index), {mode: 0o600})
	}

	function scheduleIndexSave() {
		indexDirty = true
		if (indexSaveTimer) return
		indexSaveTimer = setTimeout(() => {
			flushIndex().catch(() => {})
		}, 1500)
		indexSaveTimer.unref?.()
	}

	async function resetIndex(folderId = null) {
		indexLoaded = true
		index = {folderId, folders: {}, files: {}, updatedAt: now()}
		indexDirty = true
		await flushIndex()
	}

	async function clearLocalState() {
		cachedAccess = null
		refreshInflight = null
		indexLoaded = true
		index = {folderId: null, folders: {}, files: {}, updatedAt: 0}
		indexDirty = false
		if (indexSaveTimer) {
			clearTimeout(indexSaveTimer)
			indexSaveTimer = null
		}
		await removeAtomic(indexFile).catch(() => {})
		if (cacheDir) await rm(cacheDir, {recursive: true, force: true}).catch(() => {})
	}

	async function exchangeCode({clientId, clientSecret, code, redirectUri, codeVerifier}) {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
			...(clientSecret ? {client_secret: clientSecret} : {}),
		})
		const r = await fetchImpl(tokenUrl, {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: body.toString(),
			signal: AbortSignal.timeout(20_000),
		})
		const text = await r.text()
		let data = {}
		try {
			data = JSON.parse(text)
		} catch {}
		if (!r.ok || !data.access_token) {
			const detail = data.error_description || data.error || `HTTP ${r.status}`
			throw new RpcError('PRECONDITION_FAILED', `Google didn’t accept that authorization code: ${detail}`)
		}
		assertStrictDriveFileScope(data.scope, {required: true})
		const expiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000
		cachedAccess = {token: String(data.access_token), expiresAt}
		return {
			accessToken: String(data.access_token),
			refreshToken: data.refresh_token ? String(data.refresh_token) : null,
			expiresAt,
			scope: String(data.scope ?? ''),
		}
	}

	async function accessToken({force = false} = {}) {
		if (!force && cachedAccess && cachedAccess.expiresAt - now() > 120_000) return cachedAccess.token
		if (refreshInflight) return refreshInflight
		refreshInflight = (async () => {
			const creds = await getCredentials()
			if (!creds?.clientId || !creds?.refreshToken) {
				throw new RpcError('PRECONDITION_FAILED', 'Google Drive isn’t connected yet')
			}
			const body = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: creds.refreshToken,
				client_id: creds.clientId,
				...(creds.clientSecret ? {client_secret: creds.clientSecret} : {}),
			})
			const r = await fetchImpl(tokenUrl, {
				method: 'POST',
				headers: {'content-type': 'application/x-www-form-urlencoded'},
				body: body.toString(),
				signal: AbortSignal.timeout(20_000),
			})
			const text = await r.text()
			let data = {}
			try {
				data = JSON.parse(text)
			} catch {}
			if (!r.ok || !data.access_token) {
				cachedAccess = null
				const detail = data.error_description || data.error || `HTTP ${r.status}`
				throw new RpcError('UNAUTHORIZED', `Google Drive sign-in expired (${detail}). Connect Google Drive again.`)
			}
			assertStrictDriveFileScope(data.scope, {required: false})
			const expiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000
			cachedAccess = {token: String(data.access_token), expiresAt}
			if (onTokenRefreshed) await onTokenRefreshed(cachedAccess).catch(() => {})
			return cachedAccess.token
		})().finally(() => {
			refreshInflight = null
		})
		return refreshInflight
	}

	async function driveFetch(url, opts = {}, {retries = 4, timeoutMs = 60_000, expectStatus = null} = {}) {
		let lastErr
		let refreshedAfter401 = false
		for (let attempt = 0; attempt <= retries; attempt++) {
			const token = await accessToken({force: attempt > 0 && lastErr?.status === 401})
			const headers = {...(opts.headers ?? {}), authorization: `Bearer ${token}`}
			let r
			try {
				r = await fetchImpl(url, {...opts, headers, signal: AbortSignal.timeout(timeoutMs)})
			} catch (e) {
				lastErr = e
				if (attempt < retries) {
					await sleep(Math.min(10_000, 300 * 2 ** attempt + Math.floor(Math.random() * 200)))
					continue
				}
				throw new Error(`Couldn’t reach Google Drive: ${e?.message || 'network error'}`)
			}
			// One fresh token per call, and it does not use up a retry (a chunk upload has none).
			if (r.status === 401 && !refreshedAfter401) {
				await r.arrayBuffer().catch(() => {})
				refreshedAfter401 = true
				lastErr = {status: 401}
				cachedAccess = null
				attempt--
				continue
			}
			if (r.ok || (expectStatus && expectStatus.includes(r.status))) return r
			const bodyText = await r.text().catch(() => '')
			const err = classifyDriveError(r.status, bodyText)
			if (err instanceof GdriveQuotaError) throw err
			lastErr = err
			if (err.retryable && attempt < retries) {
				const retryAfter = Number(r.headers.get('retry-after'))
				const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : Math.min(15_000, 400 * 2 ** attempt + Math.floor(Math.random() * 250))
				await sleep(waitMs)
				continue
			}
			throw err
		}
		throw lastErr
	}

	async function about() {
		const url = `${apiBase}/about?fields=${encodeURIComponent('user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)')}`
		const r = await driveFetch(url, {method: 'GET'}, {timeoutMs: 20_000})
		const data = await r.json()
		const q = data.storageQuota ?? {}
		const limit = q.limit != null ? Number(q.limit) : null
		const usage = q.usage != null ? Number(q.usage) : 0
		const usageInDrive = q.usageInDrive != null ? Number(q.usageInDrive) : usage
		return {
			email: String(data.user?.emailAddress ?? ''),
			displayName: String(data.user?.displayName ?? ''),
			quota: {
				limit: Number.isFinite(limit) && limit > 0 ? limit : null,
				usage: Number.isFinite(usage) ? usage : 0,
				usageInDrive: Number.isFinite(usageInDrive) ? usageInDrive : 0,
				usageInDriveTrash: Number.isFinite(Number(q.usageInDriveTrash)) ? Number(q.usageInDriveTrash) : 0,
			},
		}
	}

	async function findChild(parentId, name, {folderOnly = false} = {}) {
		const clauses = [`'${escapeDriveQuery(parentId)}' in parents`, `name = '${escapeDriveQuery(name)}'`, 'trashed = false']
		if (folderOnly) clauses.push(`mimeType = '${FOLDER_MIME}'`)
		const url = `${apiBase}/files?q=${encodeURIComponent(clauses.join(' and '))}&fields=${encodeURIComponent('files(id,name,mimeType,size,md5Checksum)')}&pageSize=10&spaces=drive`
		const r = await driveFetch(url, {method: 'GET'})
		const data = await r.json()
		return Array.isArray(data.files) && data.files.length ? data.files[0] : null
	}

	async function findRootFolder(name) {
		const q = `name = '${escapeDriveQuery(name)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`
		const url = `${apiBase}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&pageSize=10&spaces=drive`
		const r = await driveFetch(url, {method: 'GET'})
		const data = await r.json()
		return Array.isArray(data.files) && data.files.length ? data.files[0] : null
	}

	async function createFolder(name, parentId = 'root') {
		const url = `${apiBase}/files?fields=${encodeURIComponent('id,name')}`
		const r = await driveFetch(url, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({name, mimeType: FOLDER_MIME, parents: [parentId]}),
		})
		return r.json()
	}

	async function ensureRootFolder(name) {
		const clean = cleanFolderName(name)
		const existing = await findRootFolder(clean)
		if (existing?.id) return existing.id
		const created = await createFolder(clean, 'root')
		return created.id
	}

	async function ensureFolder(rootFolderId, relDir) {
		await loadIndex()
		if (index.folderId !== rootFolderId) await resetIndex(rootFolderId)
		const clean = String(relDir ?? '')
			.split('/')
			.filter(Boolean)
			.join('/')
		if (!clean) return rootFolderId
		if (index.folders[clean]) return index.folders[clean]
		if (folderLocks.has(clean)) return folderLocks.get(clean)
		const p = (async () => {
			const parts = clean.split('/')
			let curId = rootFolderId
			let curPath = ''
			for (const part of parts) {
				curPath = curPath ? `${curPath}/${part}` : part
				if (index.folders[curPath]) {
					curId = index.folders[curPath]
					continue
				}
				const existing = await findChild(curId, part, {folderOnly: true})
				if (existing?.id) {
					curId = existing.id
				} else {
					const created = await createFolder(part, curId)
					curId = created.id
				}
				index.folders[curPath] = curId
				scheduleIndexSave()
			}
			return curId
		})().finally(() => {
			folderLocks.delete(clean)
		})
		folderLocks.set(clean, p)
		return p
	}

	async function listFolderChildren(folderId) {
		const out = []
		let pageToken = ''
		for (;;) {
			const q = `'${escapeDriveQuery(folderId)}' in parents and trashed = false`
			const url = `${apiBase}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,size,md5Checksum)')}&pageSize=1000&spaces=drive${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
			const r = await driveFetch(url, {method: 'GET'})
			const data = await r.json()
			if (Array.isArray(data.files)) out.push(...data.files)
			if (!data.nextPageToken) break
			pageToken = data.nextPageToken
		}
		return out
	}

	async function findFolderReadOnly(rootFolderId, relDir) {
		const clean = String(relDir ?? '')
			.split('/')
			.filter(Boolean)
			.join('/')
		if (!clean) return rootFolderId
		let curId = rootFolderId
		for (const part of clean.split('/')) {
			const existing = await findChild(curId, part, {folderOnly: true})
			if (!existing?.id) return null
			curId = existing.id
		}
		return curId
	}

	// Recursively rebuild local path->fileId index from Google Drive (used for disaster recovery & verification).
	async function reindex(rootFolderId, {prefix = '', create = false} = {}) {
		await loadIndex()
		const nextFolders = {}
		const nextFiles = {}
		const walk = async (dirId, relPrefix) => {
			const children = await listFolderChildren(dirId)
			for (const item of children) {
				const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name
				if (item.mimeType === FOLDER_MIME) {
					nextFolders[rel] = item.id
					await walk(item.id, rel)
				} else {
					nextFiles[rel] = {
						id: item.id,
						size: Number(item.size) || 0,
						...(item.md5Checksum ? {md5: String(item.md5Checksum)} : {}),
					}
				}
			}
		}
		if (prefix) {
			const subId = create ? await ensureFolder(rootFolderId, prefix) : await findFolderReadOnly(rootFolderId, prefix)
			if (index.folderId !== rootFolderId) index = {folderId: rootFolderId, folders: {}, files: {}, updatedAt: 0}
			for (const k of Object.keys(index.files)) if (k.startsWith(`${prefix}/`)) delete index.files[k]
			if (subId) {
				nextFolders[prefix] = subId
				await walk(subId, prefix)
				Object.assign(index.folders, nextFolders)
				Object.assign(index.files, nextFiles)
			}
		} else {
			await walk(rootFolderId, '')
			index = {folderId: rootFolderId, folders: nextFolders, files: nextFiles, updatedAt: now()}
		}
		indexDirty = true
		await flushIndex()
		return index
	}

	async function uploadSmall(parentId, name, bytes, existingId = null) {
		const boundary = `modc_${randomBytes(12).toString('hex')}`
		const meta = existingId ? {name} : {name, parents: [parentId]}
		const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`)
		const tail = Buffer.from(`\r\n--${boundary}--`)
		const body = Buffer.concat([head, bytes, tail])
		const url = existingId
			? `${uploadBase}/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=${encodeURIComponent('id,name,size,md5Checksum')}`
			: `${uploadBase}/files?uploadType=multipart&fields=${encodeURIComponent('id,name,size,md5Checksum')}`
		const r = await driveFetch(url, {
			method: existingId ? 'PATCH' : 'POST',
			headers: {'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length)},
			body,
		}, {timeoutMs: 120_000})
		return r.json()
	}

	async function uploadResumable(parentId, name, source, totalSize, existingId = null, onBytes = null) {
		const meta = existingId ? {name} : {name, parents: [parentId]}
		const initUrl = existingId
			? `${uploadBase}/files/${encodeURIComponent(existingId)}?uploadType=resumable&fields=${encodeURIComponent('id,name,size,md5Checksum')}`
			: `${uploadBase}/files?uploadType=resumable&fields=${encodeURIComponent('id,name,size,md5Checksum')}`
		const initRes = await driveFetch(initUrl, {
			method: existingId ? 'PATCH' : 'POST',
			headers: {
				'content-type': 'application/json; charset=UTF-8',
				'x-upload-content-type': 'application/octet-stream',
				'x-upload-content-length': String(totalSize),
			},
			body: JSON.stringify(meta),
		}, {timeoutMs: 60_000})
		const sessionUrl = initRes.headers.get('location')
		await initRes.arrayBuffer().catch(() => {})
		if (!sessionUrl) throw new Error('Google Drive did not return a resumable upload URL')

		const queryOffset = async () => {
			const q = await driveFetch(
				sessionUrl,
				{
					method: 'PUT',
					headers: {'content-length': '0', 'content-range': `bytes */${totalSize}`},
				},
				{timeoutMs: 30_000, expectStatus: [200, 201, 308], retries: 2},
			)
			if (q.status === 200 || q.status === 201) return {done: await q.json()}
			const rh = q.headers.get('range')
			await q.arrayBuffer().catch(() => {})
			const mm = /^bytes=0-(\d+)$/.exec(String(rh ?? ''))
			return {offset: mm ? Number(mm[1]) + 1 : 0}
		}

		const fh = typeof source === 'string' ? await open(source, 'r') : null
		try {
			let offset = 0
			let stalled = 0
			while (offset < totalSize) {
				const len = Math.min(chunkSize, totalSize - offset)
				let slice
				if (fh) {
					slice = Buffer.allocUnsafe(len)
					let readTotal = 0
					while (readTotal < len) {
						const {bytesRead} = await fh.read(slice, readTotal, len - readTotal, offset + readTotal)
						if (bytesRead <= 0) break
						readTotal += bytesRead
					}
					if (readTotal !== len) slice = slice.subarray(0, readTotal)
				} else {
					slice = source.subarray(offset, offset + len)
				}
				const end = offset + slice.length - 1
				let r
				try {
					r = await driveFetch(sessionUrl, {
						method: 'PUT',
						headers: {
							'content-type': 'application/octet-stream',
							'content-length': String(slice.length),
							'content-range': `bytes ${offset}-${end}/${totalSize}`,
						},
						body: slice,
					}, {timeoutMs: 180_000, expectStatus: [200, 201, 308], retries: 0})
				} catch (err) {
					if (err instanceof GdriveQuotaError) throw err
					if (err?.retryable || /Couldn’t reach Google Drive/.test(String(err?.message ?? ''))) {
						if (++stalled > 5) throw err
						await sleep(Math.min(10_000, 400 * 2 ** (stalled - 1)))
						const probe = await queryOffset()
						if (probe.done) return probe.done
						offset = probe.offset
						continue
					}
					throw err
				}
				if (r.status === 200 || r.status === 201) {
					const done = await r.json()
					if (onBytes) onBytes(slice.length)
					return done
				}
				// 308 Resume Incomplete: per Google Drive spec, missing Range header means 0 bytes persisted.
				const rangeHeader = r.headers.get('range')
				await r.arrayBuffer().catch(() => {})
				const m = /^bytes=0-(\d+)$/.exec(String(rangeHeader ?? ''))
				if (!m) {
					if (++stalled > 4) throw new Error('Google Drive resumable upload made no progress (308 without Range)')
					offset = 0
					await sleep(300 * stalled)
					continue
				}
				const confirmedNext = Number(m[1]) + 1
				if (confirmedNext <= offset) {
					if (++stalled > 4) throw new Error('Google Drive resumable upload stalled')
					offset = confirmedNext
					await sleep(300 * stalled)
					continue
				}
				stalled = 0
				const delta = confirmedNext - offset
				offset = confirmedNext
				if (onBytes && delta > 0) onBytes(delta)
			}
			throw new Error('Resumable upload ended without confirmation from Google Drive')
		} finally {
			await fh?.close().catch(() => {})
		}
	}

	async function putObject(rootFolderId, relPath, source, {size = null, onBytes = null} = {}) {
		await loadIndex()
		const parts = relPath.split('/').filter(Boolean)
		const fileName = parts.pop()
		const dirPath = parts.join('/')
		const parentId = await ensureFolder(rootFolderId, dirPath)
		const totalSize = size ?? (typeof source === 'string' ? (await stat(source)).size : source.length)
		const existingId = index.files[relPath]?.id ?? null
		let uploaded
		if (totalSize < multipartThreshold) {
			const buf = typeof source === 'string' ? await readFile(source) : source
			uploaded = await uploadSmall(parentId, fileName, buf, existingId)
			if (onBytes) onBytes(buf.length)
		} else {
			uploaded = await uploadResumable(parentId, fileName, source, totalSize, existingId, onBytes)
		}
		const rec = {
			id: uploaded.id,
			size: Number(uploaded.size ?? totalSize),
			...(uploaded.md5Checksum ? {md5: String(uploaded.md5Checksum)} : {}),
		}
		index.files[relPath] = rec
		scheduleIndexSave()
		return rec
	}

	async function deleteObject(rootFolderId, relPath) {
		await loadIndex()
		let fileId = index.files[relPath]?.id
		if (!fileId) {
			const parts = relPath.split('/').filter(Boolean)
			const fileName = parts.pop()
			const dirPath = parts.join('/')
			const parentId = dirPath ? index.folders[dirPath] : rootFolderId
			if (parentId) fileId = (await findChild(parentId, fileName))?.id
		}
		if (!fileId) return false
		await driveFetch(`${apiBase}/files/${encodeURIComponent(fileId)}`, {method: 'DELETE'}, {expectStatus: [200, 204, 404]})
		delete index.files[relPath]
		scheduleIndexSave()
		return true
	}

	async function downloadResponse(fileId, rangeHeader = null) {
		const url = `${apiBase}/files/${encodeURIComponent(fileId)}?alt=media`
		const headers = {}
		if (rangeHeader) headers.range = rangeHeader
		return driveFetch(url, {method: 'GET', headers}, {timeoutMs: 10 * 60_000, expectStatus: [200, 206]})
	}

	async function downloadBuffer(fileId) {
		const r = await downloadResponse(fileId)
		return Buffer.from(await r.arrayBuffer())
	}

	// Quick write/list/delete probe inside the Drive backup folder to verify credentials & permissions.
	async function probe(rootFolderId) {
		const info = await about()
		const probePath = '.modc-backup-check'
		const payload = Buffer.from(`My Own Data Center backup check ${now()}\n`)
		const rec = await putObject(rootFolderId, probePath, payload)
		const back = await downloadBuffer(rec.id)
		await deleteObject(rootFolderId, probePath)
		await flushIndex()
		if (!back.equals(payload)) throw new RpcError('PRECONDITION_FAILED', 'Google Drive check file didn’t match when read back')
		return info
	}

	// Mirror a local encrypted restic repo tree (server/... and computers/...) to Google Drive.
	const ORDER = ['data', 'keys', 'index', 'snapshots', 'config']
	const partOf = (p) => {
		const parts = p.split('/')
		return parts[0] === 'server' ? parts[1] : parts[0] === 'computers' ? parts[2] : parts[0]
	}
	const rankOf = (p) => ORDER.indexOf(partOf(p))

	async function walkLocalFiles(root) {
		const out = new Map()
		const walk = async (dir, prefix = '') => {
			for (const ent of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
				const rel = prefix ? `${prefix}/${ent.name}` : ent.name
				const full = join(dir, ent.name)
				if (ent.isDirectory()) await walk(full, rel)
				else if (ent.isFile()) out.set(rel, (await stat(full)).size)
			}
		}
		await walk(root)
		return out
	}

	async function mirrorLocalRepo(rootFolderId, localRoot, {onProgress = () => {}, concurrency = 4, prefix = ''} = {}) {
		await loadIndex()
		if (index.folderId !== rootFolderId || Object.keys(index.files).length === 0) {
			await reindex(rootFolderId, prefix ? {prefix: prefix.replace(/\/+$/, ''), create: false} : {})
		}
		const local = await walkLocalFiles(localRoot)
		for (const k of [...local.keys()]) {
			if (!ORDER.includes(partOf(k)) || (prefix && !k.startsWith(prefix))) local.delete(k)
		}
		if (!prefix && !local.has('server/config') && index.files['server/config']) {
			throw new RpcError('PRECONDITION_FAILED', 'The local backup store is missing, so the Google Drive copy wasn’t touched.')
		}
		// Safety guard: verify every restic repo's config file matches byte-for-byte before uploading or deleting anything.
		// Prevents a newly initialized local repo (or Direct->Mirror switch) from ever wiping an existing Drive history.
		const configKeys = new Set()
		for (const k of Object.keys(index.files)) {
			if ((!prefix || k.startsWith(prefix)) && (k === 'server/config' || /^computers\/[^/]+\/config$/.test(k))) configKeys.add(k)
		}
		for (const cfgKey of configKeys) {
			const remoteRec = index.files[cfgKey]
			if (!local.has(cfgKey)) {
				if (prefix) {
					throw new RpcError('PRECONDITION_FAILED', `Local store ${cfgKey} is missing, so the Google Drive copy wasn’t touched.`)
				}
				continue
			}
			const localBuf = await readFile(join(localRoot, cfgKey))
			const localMd5 = createHash('md5').update(localBuf).digest('hex')
			if (remoteRec.md5) {
				if (remoteRec.md5 !== localMd5) {
					throw new RpcError('PRECONDITION_FAILED', `The Google Drive folder already holds a different backup repository (${cfgKey} mismatch). Refusing to overwrite it.`)
				}
			} else {
				const remoteBuf = await downloadBuffer(remoteRec.id)
				if (!remoteBuf.equals(localBuf)) {
					throw new RpcError('PRECONDITION_FAILED', `The Google Drive folder already holds a different backup repository (${cfgKey} mismatch). Refusing to overwrite it.`)
				}
			}
		}
		const send = [...local]
			.filter(([p, sz]) => index.files[p]?.size !== sz)
			.sort((a, b) => rankOf(a[0]) - rankOf(b[0]))
		const drop = Object.keys(index.files)
			.filter((p) => (!prefix || p.startsWith(prefix)) && !local.has(p) && ORDER.includes(partOf(p)))
			.sort((a, b) => rankOf(b) - rankOf(a))

		const totalBytes = send.reduce((t, [, sz]) => t + sz, 0) || 1
		let sentBytes = 0
		let uploadedCount = 0
		let quotaError = null

		// Upload stage-by-stage in restic safety order (data -> keys -> index -> snapshots -> config).
		for (const stage of ORDER) {
			if (quotaError) break
			const stageItems = send.filter(([p]) => partOf(p) === stage)
			if (!stageItems.length) continue
			let cursor = 0
			const worker = async () => {
				while (!quotaError) {
					const i = cursor++
					if (i >= stageItems.length) break
					const [rel, sz] = stageItems[i]
					try {
						await putObject(rootFolderId, rel, join(localRoot, rel), {
							size: sz,
							onBytes: (n) => {
								sentBytes += n
								onProgress(Math.min(0.95, sentBytes / totalBytes))
							},
						})
						uploadedCount++
					} catch (e) {
						if (e instanceof GdriveQuotaError) {
							quotaError = e
							break
						}
						throw e
					}
				}
			}
			await Promise.all(Array.from({length: Math.min(concurrency, stageItems.length)}, () => worker()))
		}
		await flushIndex()
		if (quotaError) throw quotaError

		// Remove pruned packs/snapshots in reverse safety order.
		let removedCount = 0
		for (const rel of drop) {
			await deleteObject(rootFolderId, rel)
			removedCount++
		}
		await flushIndex()
		onProgress(1)
		return {uploaded: uploadedCount, uploadedBytes: sentBytes, removed: removedCount}
	}

	// Ephemeral loopback restic REST v2 HTTP server backed directly by Google Drive v3.
	// Allows zero-local-disk encrypted backups & instant random-access restores straight from 30 TB Drive!
	async function startResticBridge(rootFolderId, {repoPrefix = 'server'} = {}) {
		await loadIndex()
		// Always sync the prefix index from Drive on bridge open so crash/restart never orphans packs or creates duplicates.
		await reindex(rootFolderId, {prefix: repoPrefix, create: false})
		const bridgeCache = cacheDir ? join(cacheDir, repoPrefix.replace(/[^a-zA-Z0-9_-]/g, '_')) : null
		if (bridgeCache) await mkdir(bridgeCache, {recursive: true, mode: 0o700})
		const tmpDir = bridgeCache ? join(bridgeCache, '.tmp') : join(dirname(indexFile), '.gdrive-tmp')
		await mkdir(tmpDir, {recursive: true, mode: 0o700})

		const token = randomBytes(24).toString('base64url')
		const expectedAuth = Buffer.from(`Basic ${Buffer.from(`modc:${token}`).toString('base64')}`)
		const checkAuth = (req) => {
			const got = Buffer.from(String(req.headers.authorization ?? ''))
			return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth)
		}
		const relOf = (type, name) => {
			if (type === 'config') return `${repoPrefix}/config`
			if (type === 'data') return `${repoPrefix}/data/${name.slice(0, 2)}/${name}`
			return `${repoPrefix}/${type}/${name}`
		}
		const cachePathOf = (type, name) => {
			if (!bridgeCache || type === 'data' || type === 'locks') return null
			return type === 'config' ? join(bridgeCache, 'config') : join(bridgeCache, type, name)
		}
		let uploadedBytes = 0
		let uploadedFiles = 0
		let downloadedBytes = 0
		let lastQuotaError = null

		const server = http.createServer(async (req, res) => {
			const send = (code, body = '', contentType = 'text/plain') => {
				if (res.headersSent) return res.destroy()
				res.writeHead(code, {'content-type': contentType, 'cache-control': 'no-store'})
				res.end(body)
			}
			if (!checkAuth(req)) return send(401, 'Unauthorized')
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1')
				const parts = url.pathname.split('/').filter(Boolean)
				const method = req.method

				// POST /?create=true -> ensure Drive repo folder exists
				if (parts.length === 0 && method === 'POST') {
					await ensureFolder(rootFolderId, repoPrefix)
					for (const t of RESTIC_TYPES) await ensureFolder(rootFolderId, `${repoPrefix}/${t}`)
					await flushIndex()
					return send(200)
				}

				// /config
				if (parts.length === 1 && parts[0] === 'config') {
					const rel = relOf('config')
					const cpath = cachePathOf('config')
					if (method === 'HEAD') {
						const rec = index.files[rel]
						if (!rec) return send(404)
						res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(rec.size)})
						return res.end()
					}
					if (method === 'GET') {
						const rec = index.files[rel]
						if (!rec) return send(404)
						if (cpath) {
							const cached = await readFile(cpath).catch(() => null)
							if (cached && cached.length === rec.size) {
								res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(cached.length)})
								return res.end(cached)
							}
						}
						const buf = await downloadBuffer(rec.id)
						downloadedBytes += buf.length
						if (cpath) await writeAtomic(cpath, buf, {mode: 0o600}).catch(() => {})
						res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(buf.length)})
						return res.end(buf)
					}
					if (method === 'POST') {
						if (index.files[rel]) return send(403, 'Already exists')
						const chunks = []
						let sz = 0
						for await (const c of req) {
							sz += c.length
							if (sz > 1024 * 1024) return send(413)
							chunks.push(c)
						}
						const buf = Buffer.concat(chunks)
						await putObject(rootFolderId, rel, buf, {size: buf.length})
						uploadedBytes += buf.length
						uploadedFiles++
						if (cpath) await writeAtomic(cpath, buf, {mode: 0o600}).catch(() => {})
						await flushIndex()
						return send(200)
					}
					if (method === 'DELETE') {
						await deleteObject(rootFolderId, rel)
						if (cpath) await removeAtomic(cpath).catch(() => {})
						return send(200)
					}
					return send(405)
				}

				const type = parts[0]
				if (!RESTIC_TYPES.has(type) || parts.length > 2) return send(404)

				// GET /{type}/ -> list objects from Drive index
				if (parts.length === 1) {
					if (method !== 'GET') return send(405)
					const prefix = `${repoPrefix}/${type}/`
					const out = []
					for (const [k, rec] of Object.entries(index.files)) {
						if (!k.startsWith(prefix)) continue
						const name = k.slice(k.lastIndexOf('/') + 1)
						if (RESTIC_OBJECT_RE.test(name)) out.push({name, size: rec.size})
					}
					const v2 = String(req.headers.accept ?? '').includes('application/vnd.x.restic.rest.v2')
					return send(200, JSON.stringify(v2 ? out : out.map((o) => o.name)), v2 ? 'application/vnd.x.restic.rest.v2' : 'application/vnd.x.restic.rest.v1')
				}

				const name = parts[1]
				if (!RESTIC_OBJECT_RE.test(name)) return send(404)
				const rel = relOf(type, name)
				const cpath = cachePathOf(type, name)

				if (method === 'HEAD') {
					const rec = index.files[rel]
					if (!rec) return send(404)
					res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(rec.size)})
					return res.end()
				}
				if (method === 'GET') {
					const rec = index.files[rel]
					if (!rec) return send(404)
					const range = req.headers.range ? String(req.headers.range) : null
					if (!range && cpath) {
						const cached = await readFile(cpath).catch(() => null)
						if (cached && cached.length === rec.size) {
							res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(cached.length)})
							return res.end(cached)
						}
					}
					const upstream = await downloadResponse(rec.id, range)
					const hdrs = {'content-type': 'application/octet-stream'}
					if (upstream.headers.get('content-length')) hdrs['content-length'] = upstream.headers.get('content-length')
					if (upstream.headers.get('content-range')) hdrs['content-range'] = upstream.headers.get('content-range')
					if (!range && cpath) {
						const buf = Buffer.from(await upstream.arrayBuffer())
						downloadedBytes += buf.length
						await mkdir(dirname(cpath), {recursive: true, mode: 0o700}).catch(() => {})
						await writeAtomic(cpath, buf, {mode: 0o600}).catch(() => {})
						res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(buf.length)})
						return res.end(buf)
					}
					res.writeHead(upstream.status === 206 ? 206 : 200, hdrs)
					if (!upstream.body) return res.end()
					const body = Readable.fromWeb(upstream.body)
					body.on('data', (c) => (downloadedBytes += c.length))
					try {
						await pipeline(body, res)
					} catch {
						res.destroy()
					}
					return
				}
				if (method === 'POST') {
					if (type !== 'locks' && index.files[rel]) return send(403, 'Already stored')
					const lenHdr = Number(req.headers['content-length'])
					if (Number.isFinite(lenHdr) && lenHdr > MAX_RESTIC_OBJECT) return send(413)
					const tmpFile = join(tmpDir, `${name}.${randomBytes(4).toString('hex')}.tmp`)
					const out = createWriteStream(tmpFile, {mode: 0o600})
					let size = 0
					try {
						const limit = new Transform({
							transform(chunk, _enc, cb) {
								size += chunk.length
								if (size > MAX_RESTIC_OBJECT) return cb(new Error('Too large'))
								cb(null, chunk)
							},
						})
						await pipeline(req, limit, out)
						await putObject(rootFolderId, rel, tmpFile, {size})
						uploadedBytes += size
						uploadedFiles++
						if (cpath) {
							await mkdir(dirname(cpath), {recursive: true, mode: 0o700}).catch(() => {})
							const data = await readFile(tmpFile)
							await writeAtomic(cpath, data, {mode: 0o600}).catch(() => {})
						}
						return send(200)
					} catch (e) {
						out.destroy()
						if (e instanceof GdriveQuotaError) {
							lastQuotaError = e
							return send(507, e.message)
						}
						return send(e?.message === 'Too large' ? 413 : 502, e?.message || 'Upload failed')
					} finally {
						await rm(tmpFile, {force: true}).catch(() => {})
					}
				}
				if (method === 'DELETE') {
					await deleteObject(rootFolderId, rel)
					if (cpath) await removeAtomic(cpath).catch(() => {})
					return send(200)
				}
				return send(405)
			} catch (e) {
				if (e instanceof GdriveQuotaError) {
					lastQuotaError = e
					return send(507, e.message)
				}
				return send(502, e?.message || 'Google Drive bridge error')
			}
		})
		server.requestTimeout = 0
		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		const port = server.address().port
		return {
			repoUrl: `rest:http://modc:${token}@127.0.0.1:${port}/`,
			port,
			stats: () => ({uploadedBytes, uploadedFiles, downloadedBytes, quotaError: lastQuotaError}),
			async close() {
				await flushIndex().catch(() => {})
				await new Promise((r) => server.close(r))
			},
		}
	}

	async function revokeToken(token) {
		if (!token) return
		await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			signal: AbortSignal.timeout(10_000),
		}).catch(() => {})
	}

	return {
		authUrl,
		exchangeCode,
		accessToken,
		revokeToken,
		about,
		findRootFolder,
		ensureRootFolder,
		ensureFolder,
		reindex,
		putObject,
		deleteObject,
		downloadBuffer,
		probe,
		mirrorLocalRepo,
		startResticBridge,
		loadIndex,
		flushIndex,
		clearLocalState,
	}
}
