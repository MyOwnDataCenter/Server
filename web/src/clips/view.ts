// Rules for the clip book screen. The screen renders these. It does not decide them.
import {FOLDER_FROM_COMPUTER, FOLDER_TO_COMPUTER} from '../../../omarchyd/transferRules.mjs'

export {FOLDER_FROM_COMPUTER, FOLDER_TO_COMPUTER}

export type ClipTypeFilter = 'text' | 'picture' | 'file' | 'folder'
export type ClipStatusFilter = 'missing' | 'offline' | 'available'
export type ClipAvailability = 'available' | 'missing' | 'offline'
export type ClipQuery = {text: string; type: ClipTypeFilter | null; status: ClipStatusFilter | null}

export type ClipRow = {
	id: string
	kind: string
	at: number
	label: string
	name: string
	preview: string
	machine: string
	availability: ClipAvailability
	dir?: boolean
	scope?: 'server' | 'swarm' | 'machine'
}

export type ClipHere = {
	id: string
	name: string
	scope: 'server' | 'swarm'
	files: boolean
	clipboard: boolean
}

export type FileClipInput = {
	scope: 'server' | 'swarm'
	path?: string
	paths?: string[]
	id?: string
	cut?: true
}

const TYPE_CYCLE: ClipTypeFilter[] = ['text', 'picture', 'file', 'folder']
const STATUS_CYCLE: ClipStatusFilter[] = ['missing', 'offline', 'available']

export function nextType(current: ClipTypeFilter | null): ClipTypeFilter {
	if (!current) return 'text'
	const index = TYPE_CYCLE.indexOf(current)
	return TYPE_CYCLE[(index + 1) % TYPE_CYCLE.length]
}

export function nextStatus(current: ClipStatusFilter | null): ClipStatusFilter {
	if (!current) return 'missing'
	const index = STATUS_CYCLE.indexOf(current)
	return STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length]
}

export function typeLabel(type: ClipTypeFilter | null): string {
	if (type === 'picture') return 'Picture'
	if (type === 'file') return 'File'
	if (type === 'folder') return 'Folder'
	return 'Text'
}

export function statusLabel(status: ClipStatusFilter | null): string {
	if (status === 'offline') return 'Offline'
	if (status === 'available') return 'Available'
	return 'Missing'
}

export function clipWord(clip: {kind: string; dir?: boolean}): string {
	if (clip.dir || clip.kind === 'folder') return 'Folder'
	if (clip.kind === 'image') return 'Picture'
	if (clip.kind === 'file') return 'File'
	if (clip.kind === 'stats') return 'Stats'
	return 'Text'
}

export function displayMachine(machine: string, serverName?: string): string {
	if ((machine === 'This server' || machine === '') && serverName) return serverName
	return machine || serverName || 'This server'
}

export function matchesClip(clip: ClipRow, query: ClipQuery, serverName?: string): boolean {
	if (query.type && clipWord(clip).toLowerCase() !== query.type) return false
	if (query.status && clip.availability !== query.status) return false
	const needle = query.text.trim().toLowerCase()
	if (!needle) return true
	const machine = displayMachine(clip.machine, serverName)
	const hay = `${clip.label} ${clip.name} ${clip.preview} ${machine} ${clip.machine}`.toLowerCase()
	return hay.includes(needle)
}

export function filterClips<T extends ClipRow>(clips: readonly T[], query: ClipQuery, serverName?: string): T[] {
	return clips.filter((clip) => matchesClip(clip, query, serverName)).slice().sort((a, b) => b.at - a.at)
}

export function formatClipWhen(at: number, now: number): string {
	const delta = Math.max(0, now - at)
	if (delta < 60_000) return 'Just now'
	if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} min ago`
	if (delta < 24 * 60 * 60_000) return new Date(at).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})
	return new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})
}

export function statusMark(availability: ClipAvailability): 'Missing' | 'Offline' | null {
	if (availability === 'missing') return 'Missing'
	if (availability === 'offline') return 'Offline'
	return null
}

export function copyPlan(clip: {kind: string; availability: string}): 'text' | 'image' | 'path' | 'unavailable' {
	if (clip.kind === 'text' || clip.kind === 'stats') return clip.availability === 'missing' ? 'unavailable' : 'text'
	if (clip.availability !== 'available') return 'unavailable'
	if (clip.kind === 'image') return 'image'
	return 'path'
}

export function sendKind(clip: {kind: string}): 'clipboard' | 'folder' {
	if (clip.kind === 'text' || clip.kind === 'stats') return 'clipboard'
	return 'folder'
}

export type ClipBatchKind = 'clipboard' | 'folder' | 'mixed' | 'empty'
export type ClipBatchPlan = {kind: ClipBatchKind; targets: ClipHere[]; problem: string | null}

const MIXED = 'Text and files go to different places.'
const GONE = 'One of these is gone.'
const QUIET = 'One of these isn’t answering.'
const NO_CLIPBOARD = 'This machine can’t take text on its own clipboard yet.'
const NO_FILES = 'This machine can’t take a file right now.'

export function clipIsFolder(clip: {kind: string; dir?: boolean; ref?: {dir?: boolean; items?: {dir?: boolean}[]}}): boolean {
	return !!clip.dir || clip.kind === 'folder' || !!clip.ref?.dir || !!clip.ref?.items?.some((item) => item.dir)
}

/** Join clipboard clips in the order given, with a blank line between them. */
export function joinClipText(parts: readonly string[]): string {
	return parts.map((part) => part.trim()).filter((part) => part.length > 0).join('\n\n')
}

function folderElsewhere(clip: {dir?: boolean; kind: string; scope?: string; where?: string; ref?: {dir?: boolean; scope?: string; items?: {dir?: boolean}[]}}): boolean {
	if (!clipIsFolder(clip)) return false
	const scope = clip.scope ?? clip.ref?.scope ?? (clip.where === 'swarm' || clip.where === 'machine' ? clip.where : undefined)
	return scope === 'swarm' || scope === 'machine'
}

export function batchPlan(
	clips: readonly {kind: string; availability: string; dir?: boolean; scope?: string; where?: string; ref?: {dir?: boolean; scope?: string; items?: {dir?: boolean}[]}}[],
	targets: readonly ClipHere[],
): ClipBatchPlan {
	if (!clips.length) return {kind: 'empty', targets: [], problem: null}
	const kinds = new Set(clips.map((clip) => sendKind(clip)))
	if (kinds.size > 1) return {kind: 'mixed', targets: [], problem: MIXED}
	const kind: ClipBatchKind = kinds.has('clipboard') ? 'clipboard' : 'folder'
	if (clips.some((clip) => clip.availability === 'missing')) return {kind, targets: [], problem: GONE}
	if (kind === 'folder' && clips.some((clip) => clip.availability === 'offline')) return {kind, targets: [], problem: QUIET}
	if (kind === 'clipboard') {
		const ok = targets.filter((item) => item.clipboard)
		if (!ok.length) return {kind, targets: [], problem: NO_CLIPBOARD}
		return {kind, targets: ok.slice(), problem: null}
	}
	if (clips.some((clip) => folderElsewhere(clip))) return {kind, targets: [], problem: FOLDER_FROM_COMPUTER}
	const folder = clips.some((clip) => clipIsFolder(clip))
	const ok = targets.filter((item) => item.files && (!folder || item.scope === 'server'))
	if (!ok.length) return {kind, targets: [], problem: folder ? FOLDER_TO_COMPUTER : NO_FILES}
	return {kind, targets: ok.slice(), problem: null}
}

export function serverHere(name: string): ClipHere {
	return {id: 'server', name, scope: 'server', files: true, clipboard: true}
}

export function computerHere(agent: {id: string; name: string; online: boolean; allowed?: {files?: boolean}; on?: {files?: boolean}}): ClipHere {
	const files = !!(agent.online && agent.allowed?.files && agent.on?.files)
	return {id: agent.id, name: agent.name, scope: 'swarm', files, clipboard: false}
}

export function guestHere(
	machine: {id: string; name: string},
	agent: {id: string; name: string; online: boolean; allowed?: {files?: boolean}; on?: {files?: boolean}} | null | undefined,
): ClipHere {
	if (!agent) return {id: machine.id, name: machine.name, scope: 'swarm', files: false, clipboard: false}
	return {...computerHere(agent), name: machine.name}
}

type ComputerTarget = {id: string; name: string; online: boolean; guestOf?: string; allowed?: {files?: boolean}; on?: {files?: boolean}}

export function sendTargets(input: {serverName: string; computers: ComputerTarget[]; machines: {id: string; name: string}[]}): ClipHere[] {
	const targets: ClipHere[] = [serverHere(input.serverName)]
	for (const agent of input.computers) {
		if (agent.guestOf) continue
		const here = computerHere(agent)
		if (here.files) targets.push(here)
	}
	for (const machine of input.machines) {
		const agent = input.computers.find((item) => item.guestOf === machine.id && item.online)
		if (!agent) continue
		const here = guestHere(machine, agent)
		if (here.files) targets.push(here)
	}
	return targets
}

export function fileClipInput(scope: 'server' | 'swarm', id: string | undefined, paths: string[], cut = false): FileClipInput | null {
	const clean = paths.filter((path) => path && !path.startsWith('/Trash/'))
	if (!clean.length) return null
	const body: FileClipInput = {scope}
	if (id) body.id = id
	if (cut) body.cut = true
	if (clean.length === 1) body.path = clean[0]
	else body.paths = clean
	return body
}
