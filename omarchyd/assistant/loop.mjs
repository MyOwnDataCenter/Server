import {createHash} from 'node:crypto'

import {callMcpTool, capToolResult, forgetMcpTools, listMcpTools} from './mcp.mjs'
import {streamAnthropic} from './anthropic.mjs'
import {apiOf, effortOf} from './keys.mjs'
import {chatOrResponses, describeReachFailure, streamResponses, withToolFallback} from './providers.mjs'
import {backoffMs, retryableStreamError, retryingFetch, sleepFor} from './retry.mjs'
import {needsSummary, pickCut, summaryNote, summaryOf, unsummarized, writeSummary} from './summary.mjs'
import {appearanceCatalog, coerceDeskShell, declaredArgs, filterAppStore, isWriteTool, lookupTool, openAiTools, writeTool} from './tools.mjs'

export const SYSTEM_PROMPT = 'You are the Omarchy Server assistant on this machine and its Local swarm. You do not write programs or propose shell commands. Use only the given tools. Lookups run immediately. Writes become Approve cards the person must approve. Ubuntu vs Hyprland layout on this server: desktop_setLayout. App chrome (Appearance, glass): appearance_list. Theme colours only: omarchy_setTheme. Wallpaper or theme plus wallpaper: only omarchy_setBackground with the theme slug. Do not call both. Stay on this host.'

const LIMIT = 'I hit the lookup limit for this turn.'
const KEY_REJECTED = 'That API key was rejected. Replace it in Settings → Assistant.'
const CHATGPT_REJECTED = 'ChatGPT turned down the request. Sign in with ChatGPT again in Settings → Assistant.'
const MAX_CALLS = 16
const MAX_MESSAGES = 40
// Fresh requests after the provider reports itself busy mid-stream, before any of the answer arrived.
const STREAM_RETRIES = 2
// After a summary fails, wait for this many more messages before trying again.
const SUMMARY_RETRY_AFTER = 10

const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null))
const toolOutcome = (content, state) => ({content: capToolResult(content), state})
// OpenAI and Anthropic reject a tool list when any name is longer than this.
const MAX_TOOL_NAME = 64

function providerToolName(full, seen) {
	if (full.length <= MAX_TOOL_NAME) return seen.has(full) ? null : full
	const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
	for (let n = 0; n < 36; n++) {
		const suffix = n === 0 ? `_${hash}` : `_${hash.slice(0, 6)}${n.toString(36)}`
		const short = full.slice(0, MAX_TOOL_NAME - suffix.length) + suffix
		if (short.length <= MAX_TOOL_NAME && /^[a-zA-Z0-9_-]+$/.test(short) && !seen.has(short)) return short
	}
	return null
}

function stripSecrets(value) {
	if (Array.isArray(value)) return value.map(stripSecrets)
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const [k, v] of Object.entries(value)) {
		if (k === 'password' || k === 'apiKey' || k === 'credentials' || k === 'defaultPassword' || k === 'accessToken' || k === 'refreshToken' || k === 'idToken') continue
		out[k] = stripSecrets(v)
	}
	return out
}

function plainInput(args) {
	const input = stripSecrets(args)
	return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

function redactToolResult(name, result) {
	if (name !== 'apps_list' && name !== 'appStore_app') return result
	if (Array.isArray(result)) return result.map(stripSecrets)
	return stripSecrets(result)
}

const BACKGROUND_ID = /^[0-9a-f]{16}$/

function lookAlreadyApplied(row) {
	let lastUserAt = 0
	for (const m of row?.messages ?? []) if (m.role === 'user') lastUserAt = m.at ?? 0
	return (row?.actions ?? []).some((a) => {
		if (a.toolName !== 'omarchy_setTheme' && a.toolName !== 'omarchy_setBackground') return false
		if (a.status !== 'done') return false
		return (a.resolvedAt ?? a.createdAt ?? 0) >= lastUserAt
	})
}

export function publicAction(action) {
	if (!action || typeof action !== 'object') return action
	const copy = {...action}
	delete copy.password
	if (action.rpc && typeof action.rpc === 'object') copy.rpc = {path: action.rpc.path, input: plainInput(action.rpc.input)}
	if (action.mcp && typeof action.mcp === 'object') copy.mcp = {...action.mcp, arguments: stripSecrets(action.mcp.arguments)}
	if (action.toolName === 'omarchy_setBackground') {
		const input = copy.rpc?.input && typeof copy.rpc.input === 'object' ? copy.rpc.input : {}
		const theme = String(input.theme ?? action.detail ?? '').trim() || null
		const selected = BACKGROUND_ID.test(String(input.id ?? '')) ? String(input.id) : null
		copy.picker = {theme, selected}
	}
	return copy
}

function storedArguments(name, raw) {
	const text = raw || '{}'
	if (name !== 'machines_create') return text
	try {
		return JSON.stringify(plainInput(parseArgs(text)))
	} catch {
		return text
	}
}

function storedMcpArguments(raw) {
	try {
		return JSON.stringify(plainInput(parseArgs(raw)))
	} catch {
		return raw || '{}'
	}
}

function prettySlug(value) {
	const s = String(value ?? '').trim()
	if (!s) return ''
	return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function isTechnicalId(value) {
	const s = String(value ?? '').trim()
	if (!s) return true
	if (/^usb-/i.test(s)) return true
	if (/^[0-9a-f]{6,}$/i.test(s)) return true
	if (/^[0-9a-f-]{8,}$/i.test(s) && !/[g-z]/i.test(s)) return true
	return false
}

function lookup(map, id, fallback) {
	const hit = map?.[id]
	if (typeof hit === 'string' && hit.trim()) return hit.trim()
	return fallback
}

function slugLabel(value, fallback) {
	const s = String(value ?? '').trim()
	if (!s || isTechnicalId(s)) return fallback
	return prettySlug(s) || fallback
}

function guestLabel(a, names) {
	const kind = a?.guest?.kind
	const id = a?.guest?.id
	if (kind === 'machine') return lookup(names.machines, id, 'this virtual machine')
	return lookup(names.apps, id, 'this app')
}

function indexById(rows) {
	const out = {}
	if (!Array.isArray(rows)) return out
	for (const row of rows) {
		const id = row?.id
		const label = typeof row?.name === 'string' ? row.name.trim() : ''
		if (id != null && id !== '' && label) out[id] = label
	}
	return out
}

function boundGuestName(bound, names) {
	if (!bound || typeof bound !== 'object') return ''
	const fromBound = typeof bound.name === 'string' ? bound.name.trim() : ''
	if (fromBound) return fromBound
	if (bound.kind === 'machine') return lookup(names.machines, bound.id, 'this virtual machine')
	if (bound.kind === 'app') return lookup(names.apps, bound.id, 'this app')
	return ''
}

export function namesFromInventory({apps, machines, swarm, usb, os} = {}) {
	const names = {
		apps: indexById(apps),
		machines: indexById(machines),
		swarm: indexById(swarm),
		usb: {},
		usbBound: {},
		os: os && typeof os === 'object' && !Array.isArray(os) ? os : {},
	}
	for (const d of usb?.devices ?? []) {
		if (d?.id && d?.name) names.usb[d.id] = String(d.name).trim()
		const guest = boundGuestName(d?.bound, names)
		if (d?.id && guest) names.usbBound[d.id] = guest
	}
	return names
}

export function cardFor(name, args, names = {}) {
	const a = args && typeof args === 'object' ? args : {}
	const maps = names && typeof names === 'object' ? names : {}
	const appId = String(a.appId ?? '').trim()
	const apps = {apps_install: 'Install', apps_start: 'Start', apps_stop: 'Stop', apps_restart: 'Restart', apps_uninstall: 'Uninstall', apps_update: 'Update'}
	if (apps[name]) {
		const app = lookup(maps.apps, appId, '') || slugLabel(appId, 'this app')
		return {title: `${apps[name]} ${app}`, detail: ''}
	}
	if (name === 'machines_create') {
		const vm = String(a.name ?? '').trim()
		const bits = []
		const os = lookup(maps.os, a.osId, '') || slugLabel(a.osId, '')
		if (os) bits.push(os)
		if (a.cores != null && a.cores !== '') bits.push(`${a.cores} cores`)
		if (a.memoryGb != null && a.memoryGb !== '') bits.push(`${a.memoryGb} GB memory`)
		if (a.diskSizeGb != null && a.diskSizeGb !== '') bits.push(`${a.diskSizeGb} GB disk`)
		if (a.username) bits.push(`user ${a.username}`)
		bits.push('You type its password when you approve')
		return {title: vm ? `Create virtual machine “${vm}”` : 'Create a virtual machine', detail: bits.join(' · ')}
	}
	const id = String(a.id ?? '').trim()
	const vmVerb = {machines_start: 'Start', machines_stop: 'Stop', machines_restart: 'Restart', machines_uninstall: 'Remove'}[name]
	if (vmVerb) {
		const vm = lookup(maps.machines, id, 'this virtual machine')
		return {title: vm === 'this virtual machine' ? `${vmVerb} this virtual machine` : `${vmVerb} virtual machine “${vm}”`, detail: ''}
	}
	if (name === 'machines_updateSettings') {
		const vm = lookup(maps.machines, id, 'this virtual machine')
		const n = Array.isArray(a.portForwards) ? a.portForwards.length : 0
		return {title: `Change port forwards on ${vm}`, detail: n ? `${n} port forward${n === 1 ? '' : 's'}` : ''}
	}
	if (name === 'swarm_action' || name === 'swarm_power') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		if (a.name === 'reboot') return {title: `Restart ${host}`, detail: ''}
		if (a.name === 'shutdown') return {title: `Shut down ${host}`, detail: ''}
		if (a.name === 'suspend') return {title: `Suspend ${host}`, detail: ''}
		if (a.name === 'theme-set') return {title: `Set ${slugLabel(a.theme, 'a theme')} on ${host}`, detail: ''}
		if (a.name === 'plugin-install') return {title: `Install ${slugLabel(a.pluginId, 'a plugin')} on ${host}`, detail: ''}
		if (a.name === 'plugin-remove') return {title: `Remove ${slugLabel(a.pluginId, 'a plugin')} from ${host}`, detail: ''}
		return {title: `Manage ${host}`, detail: ''}
	}
	if (name === 'swarm_wake') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Wake ${host}`, detail: a.mac ? `Wake-on-LAN to ${a.mac}` : 'Wake-on-LAN'}
	}
	if (name === 'swarm_update_connector') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Update the connector on ${host}`, detail: ''}
	}
	if (name === 'swarm_update_all_connectors') {
		return {title: 'Update all outdated swarm connectors', detail: ''}
	}
	if (name === 'swarm_storage_mount') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Mount ${a.device || 'drive'} on ${host}`, detail: ''}
	}
	if (name === 'swarm_storage_unmount') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Unmount ${a.device || 'drive'} on ${host}`, detail: ''}
	}
	if (name === 'swarm_storage_scrub') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Scrub pool ${a.name || ''} on ${host}`.trim(), detail: a.kind ? String(a.kind).toUpperCase() : ''}
	}
	if (name === 'swarm_storage_setSleep') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		const mins = Number(a.minutes)
		return {title: `Set drive sleep on ${host}`, detail: `${a.device || 'drive'} · ${mins > 0 ? `${mins} min` : 'never sleep'}`}
	}
	if (name === 'swarm_service_control') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		const verb = a.action === 'stop' ? 'Stop' : a.action === 'restart' ? 'Restart' : 'Start'
		return {title: `${verb} ${a.name || 'service'} on ${host}`, detail: a.kind === 'container' ? 'Container' : 'User service'}
	}
	if (name === 'swarm_backup_run') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		return {title: `Back up ${host} now`, detail: ''}
	}
	if (name === 'swarm_fleet_action') {
		const ids = Array.isArray(a.ids) ? a.ids : []
		const target = ids.length ? ids.map((x) => lookup(maps.swarm, x, 'a computer')).join(', ') : 'all online computers'
		if (a.name === 'theme-set') return {title: `Set ${slugLabel(a.theme, 'a theme')} across the swarm`, detail: target}
		if (a.name === 'plugin-install') return {title: `Install ${slugLabel(a.pluginId, 'a plugin')} across the swarm`, detail: target}
		if (a.name === 'plugin-remove') return {title: `Remove ${slugLabel(a.pluginId, 'a plugin')} across the swarm`, detail: target}
		if (a.name === 'update-connector') return {title: 'Update connectors across the swarm', detail: target}
		return {title: 'Run a swarm fleet action', detail: target}
	}
	if (name === 'swarm_rename') {
		const host = lookup(maps.swarm, a.id, 'this computer')
		const next = String(a.name ?? '').trim()
		return {title: next ? `Rename ${host} to ${next}` : `Rename ${host}`, detail: ''}
	}
	if (name === 'desktop_setLayout') {
		const shell = String(a.shell ?? '').trim()
		const label = shell === 'hyprland' ? 'Hyprland' : shell === 'gnome' ? 'Ubuntu' : 'desktop'
		return {title: `Switch to ${label} layout`, detail: label === 'desktop' ? '' : label}
	}
	if (name === 'omarchy_setTheme') {
		const slug = String(a.slug ?? '').trim()
		return {title: slug ? `Set the ${prettySlug(slug)} colours` : 'Set the Omarchy theme', detail: slug}
	}
	if (name === 'omarchy_setBackground') {
		const theme = String(a.theme ?? '').trim()
		return {title: theme ? `Set the ${prettySlug(theme)} wallpaper` : 'Set the wallpaper', detail: theme}
	}
	if (name === 'omarchy_installPlugin') return {title: `Install ${slugLabel(a.id, 'an Omarchy plugin')}`, detail: ''}
	if (name === 'omarchy_removePlugin') return {title: `Remove ${slugLabel(a.id, 'an Omarchy plugin')}`, detail: ''}
	if (name === 'system_restart') return {title: 'Restart this server', detail: 'The server restarts when you approve'}
	if (name === 'system_shutdown') return {title: 'Shut down this server', detail: 'The server shuts down when you approve'}
	if (name === 'usb_attach') {
		const stick = lookup(maps.usb, a.deviceId, '')
		const guest = guestLabel(a, maps)
		return {title: stick ? `Give the ${stick} stick to ${guest}` : `Give this USB stick to ${guest}`, detail: ''}
	}
	if (name === 'usb_detach') {
		const stick = lookup(maps.usb, a.deviceId, '')
		const guest = lookup(maps.usbBound, a.deviceId, 'this guest')
		const left = stick ? `the ${stick} stick` : 'this USB stick'
		return {title: `Stop sharing ${left} with ${guest}`, detail: ''}
	}
	return {title: 'Approve this step', detail: ''}
}

// Exact names, plurals, and the nested forms (access_token, Authorization). A secret key drops the
// whole value, including an array of secrets. Array indexes are not keys, so objects inside arrays
// are walked too.
const MCP_SECRET = /^(?:password|passphrase|secret|tokens?|api[-_]?keys?|credentials?|authorizations?|(?:access|refresh)[-_]?tokens?)$/i

function redactArgs(value) {
	if (Array.isArray(value)) {
		const out = []
		for (const item of value) {
			const next = redactArgs(item)
			if (next !== undefined) out.push(next)
		}
		return out
	}
	if (value && typeof value === 'object') {
		const out = {}
		for (const [k, v] of Object.entries(value)) {
			if (MCP_SECRET.test(k)) continue
			const next = redactArgs(v)
			if (next !== undefined) out[k] = next
		}
		return out
	}
	return value
}

function humanArgValue(value) {
	if (typeof value === 'string') return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	if (typeof value === 'boolean') return value ? 'yes' : 'no'
	if (value && typeof value === 'object') {
		try {
			return JSON.stringify(redactArgs(value)) ?? ''
		} catch {
			return ''
		}
	}
	return ''
}

// An app's tools describe themselves, and the Approve card is the person's one check before the step runs.
// So the headline uses the app's description only as a short first sentence, and the card always names the
// app and the real tool and shows every argument (ids included: they often say what gets changed or
// deleted). Only secrets are left off.
export function cardForMcp(spec, args) {
	const shown = plainInput(args)
	const bits = []
	for (const [k, v] of Object.entries(shown)) {
		if (MCP_SECRET.test(k)) continue
		const text = humanArgValue(v)
		if (text) bits.push(`${k}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`)
	}
	const first = String(spec?.description ?? '').trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, '').trim()
	const said = first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first
	const action = said || prettySlug(spec?.mcpName) || 'Use a tool'
	const app = String(spec?.appName ?? '').trim()
	const tool = String(spec?.mcpName ?? '').trim()
	const source = [app, tool].filter(Boolean).join(' · ')
	return {title: app ? `${action} in ${app}` : action, detail: [source, ...bits].filter(Boolean).join(' · ')}
}

function pendingNote(actions) {
	const open = (actions ?? []).filter((a) => a.status === 'pending')
	if (!open.length) return ''
	return open.map((a) => `Pending approval: ${a.title}. ${a.detail}`).join('\n')
}

const WAITING = 'this step is still waiting for Approve'

function toOpenAI(m) {
	if (m.role === 'user') return {role: 'user', content: String(m.content ?? '')}
	if (m.role === 'assistant') {
		const msg = {role: 'assistant', content: m.content ? String(m.content) : null}
		if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
			msg.tool_calls = m.toolCalls.map((t) => ({
				id: t.id,
				type: 'function',
				function: {name: t.name, arguments: t.arguments || '{}'},
			}))
		}
		return msg
	}
	if (m.role === 'tool') return {role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '')}
	return null
}

function placeholder(action) {
	if (action?.status === 'error') return action.error || 'That step failed'
	if (action?.status === 'rejected') return 'user rejected this step'
	return WAITING
}

// Tool results must sit immediately after their tool_calls. A later user message, or an Approve that appends the real result at the end, would otherwise leave a gap the provider rejects. Missing results stay synthetic; the action is not changed.
function providerHistory(messages, actions) {
	const toolById = new Map()
	for (const m of messages) {
		if (m?.role === 'tool' && m.toolCallId && !toolById.has(m.toolCallId)) toolById.set(m.toolCallId, m)
	}
	const actionByCall = new Map()
	for (const a of actions ?? []) if (a?.toolCallId) actionByCall.set(a.toolCallId, a)
	const out = []
	for (const m of messages) {
		if (m?.role === 'tool') continue
		const o = toOpenAI(m)
		if (!o) continue
		out.push(o)
		if (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || !m.toolCalls.length) continue
		for (const t of m.toolCalls) {
			const found = toolById.get(t.id)
			out.push(found ? toOpenAI(found) : {role: 'tool', tool_call_id: t.id, content: placeholder(actionByCall.get(t.id))})
		}
	}
	// Start on the person's message a 40-message cut would split, then drop the oldest
	// assistant-and-tool groups until the slice fits. A long tool chain must not go out in full.
	let start = Math.max(0, out.length - MAX_MESSAGES)
	while (start > 0 && out[start]?.role !== 'user') start--
	const history = out.slice(start)
	while (history.length > MAX_MESSAGES) {
		const at = history.findIndex((m) => m.role === 'assistant')
		if (at < 0) break
		let end = at + 1
		while (end < history.length && history[end]?.role === 'tool') end++
		history.splice(at, end - at)
	}
	while (history.length && history[0]?.role !== 'user') history.shift()
	if (history.length > MAX_MESSAGES) {
		let cut = history.length - MAX_MESSAGES
		while (cut < history.length && history[cut]?.role !== 'user') cut++
		if (cut < history.length) return history.slice(cut)
	}
	if (!history.length) {
		const tail = out.slice(Math.max(0, out.length - MAX_MESSAGES))
		while (tail[0]?.role === 'tool') tail.shift()
		return tail
	}
	return history
}

function parseArgs(raw) {
	if (!raw || !String(raw).trim()) return {}
	const args = JSON.parse(raw)
	if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
	return args
}

function abortError() {
	const error = new Error('The turn was stopped')
	error.name = 'AbortError'
	return error
}

// Stop waiting as soon as the turn is aborted, and pass the signal through so the call can stop too.
function watchAbort(signal, pending) {
	if (!signal) return pending
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError())
		if (signal.aborted) {
			onAbort()
			Promise.resolve(pending).catch(() => {})
			return
		}
		signal.addEventListener('abort', onAbort, {once: true})
		Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
	})
}

export function createLoop({keys, conversations, runProcedure, fetchImpl, mcpTargets, chatgpt = null, now = () => Date.now(), sleep = sleepFor}) {
	const stamp = () => now()
	// Provider requests wait and try again when the provider is busy; MCP and lookups do not go through this.
	const providerFetch = retryingFetch(fetchImpl ?? fetch, {sleep})

	async function grab(name, auth, input = {}) {
		if (!runProcedure) return null
		try {
			return await runProcedure(name, input, auth)
		} catch {
			return null
		}
	}

	async function actionNames(auth, toolName, args) {
		const a = args && typeof args === 'object' ? args : {}
		const [apps, machines, swarm, usb] = await Promise.all(['apps.list', 'machines.list', 'swarm.list', 'usb.list'].map((p) => grab(p, auth)))
		const names = namesFromInventory({apps, machines, swarm, usb})
		if (String(toolName).startsWith('apps_') && a.appId && !names.apps[a.appId]) {
			const listing = await grab('appStore.app', auth, {appId: a.appId})
			if (listing?.name) names.apps[a.appId] = String(listing.name).trim()
		}
		if (toolName === 'machines_create' && a.osId) {
			const images = await grab('machines.osImages', auth)
			const img = (Array.isArray(images) ? images : []).find((i) => i?.id === a.osId)
			if (img?.name) names.os[a.osId] = String(img.name).trim()
		}
		return names
	}

	async function facts(role, auth) {
		const owner = role === 'owner'
		const hostname = await grab('system.getHostname', auth)
		const device = await grab('system.device', auth)
		const apps = await grab('apps.list', auth)
		const swarm = owner ? await grab('swarm.list', auth) : null
		const appIds = Array.isArray(apps) ? apps.map((a) => a?.id).filter(Boolean) : []
		const swarmNames = Array.isArray(swarm) ? swarm.map((s) => s?.name).filter(Boolean) : []
		const lines = [SYSTEM_PROMPT, '', `Role: ${owner ? 'owner' : 'member'}`]
		if (typeof hostname === 'string' && hostname) lines.push(`Hostname: ${hostname}`)
		if (device && typeof device === 'object' && device.device) lines.push(`Device: ${device.device}${device.os ? ` (${device.os})` : ''}`)
		lines.push(`Installed apps: ${appIds.join(', ') || 'none'}`)
		if (owner) lines.push(`Swarm: ${swarmNames.join(', ') || 'none'}`)
		return lines.join('\n')
	}

	// Built-in writes live in WRITE_TOOLS. An MCP tool is a write unless readOnlyHint is true.
	// URLs this loop last saw running. A URL that leaves mcpTargets drops its cached tool list; the 60s TTL still covers apps that stay up.
	const mcpLive = new Set()
	async function mcpCatalog(signal) {
		if (typeof mcpTargets !== 'function') return []
		let targets
		try {
			targets = await mcpTargets()
		} catch (e) {
			if (e?.name === 'AbortError' || signal?.aborted) throw e
			return []
		}
		if (!Array.isArray(targets)) return []
		const running = []
		for (const target of targets) {
			if (!target || target.running === false) continue
			if (typeof target.appId !== 'string' || !target.appId || typeof target.url !== 'string' || !target.url) continue
			running.push(target)
		}
		const urls = new Set(running.map((t) => t.url))
		const gone = []
		for (const url of mcpLive) if (!urls.has(url)) gone.push(url)
		if (gone.length) forgetMcpTools(gone)
		mcpLive.clear()
		for (const url of urls) mcpLive.add(url)
		const out = []
		const seen = new Set()
		for (const target of running) {
			let listed = []
			try {
				listed = await listMcpTools({url: target.url, transport: target.transport, fetchImpl, signal})
			} catch (e) {
				if (e?.name === 'AbortError' || signal?.aborted) throw e
				continue
			}
			for (const tool of listed ?? []) {
				if (!tool?.name) continue
				const full = `app__${target.appId}__${tool.name}`
				if (!/^[a-zA-Z0-9_-]+$/.test(full)) continue
				const name = providerToolName(full, seen)
				if (!name) continue
				seen.add(name)
				out.push({
					name,
					appId: target.appId,
					appName: String(target.name || target.appId),
					mcpName: tool.name,
					description: tool.description || tool.name,
					parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {type: 'object', properties: {}},
					readOnly: tool.readOnly === true,
					url: target.url,
				})
			}
		}
		return out
	}

	async function propose(tool, auth, conversationId) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		let name = tool.name
		if (name === 'omarchy_setTheme') {
			const slug = String(args.slug ?? args.theme ?? '').trim()
			name = 'omarchy_setBackground'
			args = {theme: slug, ...(BACKGROUND_ID.test(String(args.id ?? '')) ? {id: String(args.id)} : {})}
		}
		if (name === 'desktop_setLayout') {
			const shell = coerceDeskShell(args.shell)
			if (!shell) return {content: 'Use gnome (Ubuntu) or hyprland', state: 'error'}
			args = {shell}
		}
		const spec = writeTool(name)
		if (!spec || (spec.ownerOnly && auth.role !== 'owner')) return {content: 'unknown tool', state: 'done'}
		if (name === 'omarchy_setBackground') {
			const row = await conversations.get(auth.userId, conversationId)
			if (lookAlreadyApplied(row)) {
				return {content: 'Theme and wallpaper were already applied for this request. Do not call omarchy_setTheme or omarchy_setBackground again unless they ask for a different look.', state: 'done'}
			}
		}
		const card = cardFor(spec.name, args, await actionNames(auth, spec.name, args))
		const action = await conversations.putAction(auth.userId, conversationId, {
			kind: 'rpc',
			toolName: spec.name,
			toolCallId: tool.id,
			title: card.title,
			detail: card.detail,
			rpc: {path: spec.rpc, input: plainInput(declaredArgs(spec, args))},
			mcp: null,
			ownerOnly: !!spec.ownerOnly,
		})
		return {action}
	}

	async function proposeMcp(tool, auth, conversationId, spec) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		const card = cardForMcp(spec, args)
		const action = await conversations.putAction(auth.userId, conversationId, {
			kind: 'mcp',
			toolName: spec.name,
			toolCallId: tool.id,
			title: card.title,
			detail: card.detail,
			rpc: null,
			mcp: {appId: spec.appId, tool: spec.mcpName, arguments: plainInput(args)},
			ownerOnly: false,
		})
		return {action}
	}

	async function runMcp(tool, spec, signal) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		try {
			const result = await callMcpTool({url: spec.url, name: spec.mcpName, arguments: args, fetchImpl, signal})
			return toolOutcome(textOf(result), 'done')
		} catch (e) {
			if (e?.name === 'AbortError' || signal?.aborted) throw e
			return toolOutcome(e?.message || 'tool failed', 'error')
		}
	}

	async function runTool(tool, auth, signal) {
		if (signal?.aborted) throw abortError()
		const read = lookupTool(tool.name)
		if (!read || (read.ownerOnly && auth.role !== 'owner')) return toolOutcome('unknown tool', 'done')
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return toolOutcome('invalid arguments', 'error')
		}
		try {
			if (signal?.aborted) throw abortError()
			if (read.name === 'appearance_list') return toolOutcome(textOf(appearanceCatalog()), 'done')
			if (!runProcedure) return toolOutcome('tool failed', 'error')
			const pending = read.name === 'appStore_search' ? runProcedure('appStore.registry', {}, auth, signal) : runProcedure(read.rpc, args, auth, signal)
			const raw = await watchAbort(signal, pending)
			if (signal?.aborted) throw abortError()
			const result = read.name === 'appStore_search' ? filterAppStore(raw, args) : raw
			return toolOutcome(textOf(redactToolResult(read.name, result)), 'done')
		} catch (e) {
			if (signal?.aborted || e?.name === 'AbortError') throw e?.name === 'AbortError' ? e : abortError()
			return toolOutcome(e?.message || 'tool failed', 'error')
		}
	}

	// Once a chat is long, have the model summarize its older part, so later turns send the summary and
	// the recent messages rather than silently losing the start. A failed summary changes nothing.
	// Chats whose summary just failed, by how many messages they had then: don't ask again every turn.
	const summaryFailed = new Map()
	async function summarizeIfLong(row, key, userId, signal) {
		if (!needsSummary(row)) return row
		if (row.messages.length - (summaryFailed.get(row.id) ?? -Infinity) < SUMMARY_RETRY_AFTER) return row
		const from = summaryOf(row)?.upTo ?? 0
		const cut = pickCut(row.messages, from)
		if (cut < 0) return row
		let accessToken
		if (key.provider === 'chatgpt') {
			try {
				accessToken = await chatgpt.accessToken(key.id)
			} catch {
				return row
			}
		}
		const openAiStyle = apiOf(key) === 'responses' ? streamResponses : chatOrResponses
		const base = key.provider === 'chatgpt' ? streamResponses : key.provider === 'anthropic' ? streamAnthropic : openAiStyle
		const stream = (opts) => base({baseUrl: key.baseUrl, apiKey: key.apiKey, ...(accessToken ? {accessToken} : {}), model: key.model, fetchImpl: providerFetch, ...opts})
		let text = null
		try {
			text = await writeSummary({stream, previous: summaryOf(row)?.text, messages: row.messages.slice(from, cut), actions: row.actions, signal})
		} catch (e) {
			if (signal?.aborted || e?.name === 'AbortError') return row
		}
		if (signal?.aborted) return row
		if (!text) {
			summaryFailed.set(row.id, row.messages.length)
			return row
		}
		summaryFailed.delete(row.id)
		return conversations.setSummary(userId, row.id, {text, upTo: cut})
	}

	async function runTurn({userId, role, message, conversationId, keyId, signal, emit, continue: resume}) {
		const say = (event, data) => {
			if (typeof emit === 'function') emit({event, data})
		}
		let row = null
		const finish = (conversationIdOut) => ({conversationId: conversationIdOut ?? null})
		try {
			if (conversationId) row = await conversations.get(userId, conversationId)
			let key
			try {
				if (keyId) {
					key = await keys.resolveForUser(userId, keyId)
				} else if (row?.keyId) {
					// If the chat's remembered key was deleted or unshared, switch to another key they can use.
					key = await keys.resolveForUser(userId, row.keyId).catch((e) => {
						if (e?.code !== 'NOT_FOUND') throw e
						return keys.resolveForUser(userId)
					})
				} else {
					key = await keys.resolveForUser(userId)
				}
			} catch (e) {
				say('error', {message: e?.message || 'Add an API key in Settings → Assistant, or ask the owner to share one'})
				return finish(row?.id)
			}
			if (resume && !row) {
				say('error', {message: 'That chat isn’t here'})
				return finish(null)
			}
			if (!row) {
				const title = String(message ?? '').split(/\r?\n/)[0].trim().slice(0, 48) || 'Chat'
				row = await conversations.create(userId, {keyId: key.id, title})
			} else if (row.keyId !== key.id) {
				row = await conversations.setKey(userId, row.id, key.id)
			}
			const auth = {userId, role}
			if (!resume) row = await conversations.append(userId, row.id, {role: 'user', content: String(message ?? ''), at: stamp()})
			row = await summarizeIfLong(row, key, userId, signal)
			if (signal?.aborted) return finish(row.id)
			const summary = summaryOf(row)
			const system = summary ? `${await facts(role, auth)}\n\n${summaryNote(summary.text)}` : await facts(role, auth)
			let catalog = []
			try {
				catalog = await mcpCatalog(signal)
			} catch (e) {
				if (signal?.aborted || e?.name === 'AbortError') return finish(row.id)
				catalog = []
			}
			if (signal?.aborted) return finish(row.id)
			const mcpByName = new Map(catalog.map((t) => [t.name, t]))
			const mcpWrite = (name) => {
				const spec = mcpByName.get(name)
				return !!spec && spec.readOnly !== true
			}
			const tools = [
				...openAiTools(role),
				...catalog.map((t) => ({
					type: 'function',
					function: {name: t.name, description: t.description, parameters: t.parameters},
				})),
			]
			let used = 0

			const stopped = async (text) => {
				if (text) row = await conversations.append(userId, row.id, {role: 'assistant', content: text, at: stamp()})
			}

			// Anthropic thinking from this run of the tool loop, by the tool call it led to. Kept in memory
			// only: it is valid to send back within this run, never after the history changes.
			const thinkingByCall = new Map()
			let streamRetries = 0
			for (;;) {
				if (signal?.aborted) return finish(row.id)
				const history = providerHistory(unsummarized(row), row.actions)
				if (key.provider === 'anthropic') {
					for (const m of history) {
						const blocks = m.role === 'assistant' && m.tool_calls?.length ? thinkingByCall.get(m.tool_calls[0].id) : null
						if (blocks) m.thinking = blocks
					}
				}
				const note = pendingNote(row.actions)
				const messages = [{role: 'system', content: note ? `${system}\n\n${note}` : system}, ...history]
				let text = ''
				const toolCalls = []
				const thinking = []
				let providerError = null
				try {
					// A ChatGPT sign-in uses the person's plan through the Responses API. Other OpenAI-style
					// endpoints fall back to tools-as-text when a model can't take native tools.
					const accessToken = key.provider === 'chatgpt' ? await chatgpt.accessToken(key.id) : undefined
					const openAiStyle = apiOf(key) === 'responses' ? streamResponses : chatOrResponses
					const stream = key.provider === 'chatgpt' ? streamResponses : key.provider === 'anthropic' ? streamAnthropic : (opts) => withToolFallback(openAiStyle, opts)
					for await (const ev of stream({
						baseUrl: key.baseUrl,
						apiKey: key.apiKey,
						...(accessToken ? {accessToken} : {}),
						model: key.model,
						effort: effortOf(key),
						messages,
						tools,
						fetchImpl: providerFetch,
						signal,
					})) {
						if (signal?.aborted) break
						if (ev.type === 'text') {
							text += ev.text
							say('text', {text: ev.text})
						} else if (ev.type === 'tool') toolCalls.push(ev)
						else if (ev.type === 'thinking') thinking.push(ev.block)
						else if (ev.type === 'error') {
							providerError = ev
							break
						}
					}
				} catch (e) {
					await stopped(text)
					if (signal?.aborted || e?.name === 'AbortError') return finish(row.id)
					say('error', {message: describeReachFailure(key.baseUrl, e)})
					return finish(row.id)
				}
				if (signal?.aborted) {
					await stopped(text)
					return finish(row.id)
				}
				if (providerError && retryableStreamError(providerError) && !text && !toolCalls.length && streamRetries < STREAM_RETRIES) {
					try {
						await sleep(backoffMs(streamRetries++), signal)
					} catch {
						return finish(row.id)
					}
					continue
				}
				if (providerError) {
					await stopped(text)
					if (providerError.status === 401 && key.provider !== 'chatgpt') await keys.recordCheck?.(key.id, {ok: false, status: 'rejected', message: 'The provider rejected this key'}, {updatedAt: key.updatedAt, apiKey: key.apiKey, model: key.model, baseUrl: key.baseUrl}).catch(() => {})
					say('error', {message: providerError.status === 401 ? (key.provider === 'chatgpt' ? CHATGPT_REJECTED : KEY_REJECTED) : (providerError.message || 'The assistant did not answer')})
					return finish(row.id)
				}
				if (!toolCalls.length) {
					await stopped(text)
					say('done', {conversationId: row.id})
					return finish(row.id)
				}
				let end = toolCalls.length
				for (let i = 0; i < toolCalls.length; i++) {
					if (isWriteTool(toolCalls[i].name) || mcpWrite(toolCalls[i].name)) {
						end = i + 1
						break
					}
				}
				const batch = toolCalls.slice(0, end)
				if (thinking.length) thinkingByCall.set(batch[0].id, thinking)
				row = await conversations.append(userId, row.id, {
					role: 'assistant',
					content: text,
					toolCalls: batch.map((t) => ({id: t.id, name: t.name, arguments: mcpByName.has(t.name) ? storedMcpArguments(t.arguments) : storedArguments(t.name, t.arguments)})),
					at: stamp(),
				})
				let hit = false
				for (const tool of batch) {
					if (isWriteTool(tool.name)) {
						const outcome = await propose(tool, auth, row.id)
						if (outcome.action) {
							say('action', publicAction(outcome.action))
							say('done', {conversationId: row.id})
							return finish(row.id)
						}
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: outcome.content,
							at: stamp(),
						})
						say('tool', {name: tool.name, state: outcome.state})
						used++
						if (used >= MAX_CALLS) hit = true
						continue
					}
					if (mcpWrite(tool.name)) {
						const outcome = await proposeMcp(tool, auth, row.id, mcpByName.get(tool.name))
						if (outcome.action) {
							say('action', publicAction(outcome.action))
							say('done', {conversationId: row.id})
							return finish(row.id)
						}
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: outcome.content,
							at: stamp(),
						})
						say('tool', {name: tool.name, state: outcome.state})
						used++
						if (used >= MAX_CALLS) hit = true
						continue
					}
					if (used >= MAX_CALLS) {
						hit = true
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: LIMIT,
							at: stamp(),
						})
						continue
					}
					if (signal?.aborted) return finish(row.id)
					const outcome = mcpByName.has(tool.name) ? await runMcp(tool, mcpByName.get(tool.name), signal) : await runTool(tool, auth, signal)
					if (signal?.aborted) return finish(row.id)
					used++
					row = await conversations.append(userId, row.id, {
						role: 'tool',
						toolCallId: tool.id,
						name: tool.name,
						content: outcome.content,
						at: stamp(),
					})
					say('tool', {name: tool.name, state: outcome.state})
					if (used >= MAX_CALLS) hit = true
				}
				if (!hit) continue
				row = await conversations.append(userId, row.id, {role: 'assistant', content: LIMIT, at: stamp()})
				say('text', {text: LIMIT})
				say('done', {conversationId: row.id})
				return finish(row.id)
			}
		} catch (e) {
			if (signal?.aborted || e?.name === 'AbortError') return finish(row?.id)
			say('error', {message: e?.message || 'The assistant did not answer'})
			return finish(row?.id)
		}
	}

	function runTurnContinue(opts) {
		return runTurn({...opts, continue: true})
	}

	return {runTurn, runTurnContinue}
}
