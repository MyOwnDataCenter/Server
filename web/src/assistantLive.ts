// What a live assistant bubble and the character badge show. Pure: the screen and the widget
// decide from this, so the mark and the count stay in one place.
import type {AssistantAction, AssistantItem} from './assistant.ts'

export type LiveBubbleMark = 'spinner' | 'ellipsis' | null

export function liveBubbleMark({streaming, content}: {streaming?: boolean; content?: string; activity?: string | null}): LiveBubbleMark {
	if (!streaming) return null
	return content ? 'ellipsis' : 'spinner'
}

export type LiveTurnState = {
	baseId: string
	liveId: string
	afterTool: boolean
	part: number
}

export const startLiveTurn = (aid: string): LiveTurnState => ({baseId: aid, liveId: aid, afterTool: false, part: 1})

// Append streamed text to the live assistant reply. When a tool ran after earlier text,
// finish that bubble and open a new one so live replies match the saved chat after reload.
export function appendLiveText(items: AssistantItem[] | null, turn: LiveTurnState, text: string): {items: AssistantItem[] | null; turn: LiveTurnState} {
	if (!items || !text) return {items, turn}
	const cur = items.find((b) => b.kind === 'text' && b.id === turn.liveId)
	if (!cur || cur.kind !== 'text') return {items, turn}
	if (turn.afterTool && cur.content) {
		const part = turn.part + 1
		const nextId = `${turn.baseId}-${part}`
		const next: AssistantItem[] = items.map((b) => (b.kind === 'text' && b.id === turn.liveId ? {...b, streaming: false} : b))
		next.push({id: nextId, kind: 'text', role: 'assistant', content: text, streaming: true, ...(cur.via ? {via: cur.via} : {})})
		return {items: next, turn: {...turn, liveId: nextId, afterTool: false, part}}
	}
	return {
		items: items.map((b) => (b.kind === 'text' && b.id === turn.liveId ? {...b, content: b.content + text} : b)),
		turn: turn.afterTool ? {...turn, afterTool: false} : turn,
	}
}

export function insertLiveAction(items: AssistantItem[] | null, liveId: string, action: AssistantAction): AssistantItem[] | null {
	if (!items || !action.id) return items
	const card: AssistantItem = {id: `card-${action.id}`, kind: 'card', action}
	const idx = items.findIndex((b) => b.kind === 'card' && b.action.id === action.id)
	if (idx >= 0) return items.map((b, i) => (i === idx ? card : b))
	const live = items.findIndex((b) => b.kind === 'text' && b.id === liveId && !b.content)
	if (live >= 0) {
		const next = items.slice()
		next.splice(live, 0, card)
		return next
	}
	return [...items, card]
}

// The line above a live reply: a switch notice, or the name of the provider that answered.
// A notice already on the bubble stays when the speaker name arrives after it.
export function noteLiveVia(items: AssistantItem[] | null, liveId: string, via: string, opts?: {keep?: boolean}): AssistantItem[] | null {
	const line = via.trim()
	if (!items || !line) return items
	return items.map((b) => {
		if (b.kind !== 'text' || b.id !== liveId) return b
		if (opts?.keep && b.via) return b
		return {...b, via: line}
	})
}

export function finishLiveItems(items: AssistantItem[] | null, liveId: string, dropEmpty: boolean): AssistantItem[] | null {
	if (!items) return items
	return items.flatMap((b) => {
		if (b.kind !== 'text' || b.id !== liveId) return [b]
		if (!b.content && dropEmpty && !b.via) return []
		return [{...b, streaming: false}]
	})
}

export type AssistantIconBadge = {count: number} | {warn: true} | null

export function assistantIconBadge({unread = 0, pending = 0, phase}: {unread?: number; pending?: number; phase?: string}): AssistantIconBadge {
	if (unread > 0) return {count: unread}
	if (pending > 0) return {count: pending}
	if (phase === 'error') return {warn: true}
	return null
}

// One reply runs per chat on the server, so wait until the current reply finishes before sending
// another message, starting an Approve/Reject, or opening a follow-up stream.
export function canSendAssistantMessage({draft, itemsLoaded, streaming, decidingCount}: {draft: string; itemsLoaded: boolean; streaming: boolean; decidingCount: number}): boolean {
	return draft.trim().length > 0 && itemsLoaded && !streaming && decidingCount === 0
}

export function canDecideAssistantAction({status, streaming}: {status: string; streaming: boolean}): boolean {
	return status === 'pending' && !streaming
}

export function canStartAssistantFollow({pumping, decidingCount, followQueued, streaming}: {pumping: boolean; decidingCount: number; followQueued: boolean; streaming: boolean}): boolean {
	return !pumping && decidingCount === 0 && followQueued && !streaming
}

export type ApprovalErrorInfo = {
	isApiError: boolean
	code?: string
	status?: number
	message: string
}

// True when the request itself failed (timeout, proxy or connection error, or missing input)
// rather than the approved step failing on the server.
export function isApprovalRequestError(err: Pick<ApprovalErrorInfo, 'isApiError' | 'code' | 'status'>): boolean {
	if (!err.isApiError) return true
	if (
		err.code === 'UNREACHABLE'
		|| err.code === 'BAD_RESPONSE'
		|| err.code === 'ERROR'
		|| err.code === 'INTERNAL'
		|| err.code === 'NOT_CONFIGURED'
		|| err.code === 'UNAUTHORIZED'
		|| err.code === 'BAD_REQUEST'
	) return true
	if (err.status === 503 || err.status === 504) return true
	return false
}

// Decide what an Approve card should show after the call throws: use the server's real status when
// the request itself failed, instead of marking a still-running or finished step as a final error.
export function resolveFailedDecision(
	current: AssistantAction,
	err: ApprovalErrorInfo,
	serverAction: AssistantAction | null,
): {action: AssistantAction; banner: string | null; follow: boolean} {
	if (!isApprovalRequestError(err)) {
		if (err.code === 'CONFLICT' && serverAction) return {action: serverAction, banner: null, follow: false}
		return {action: {...current, status: 'error', error: err.message}, banner: null, follow: false}
	}
	if (serverAction) {
		if (serverAction.status === 'done' || serverAction.status === 'rejected') return {action: serverAction, banner: null, follow: true}
		if (serverAction.status === 'error') return {action: serverAction, banner: null, follow: false}
		return {action: serverAction, banner: err.message, follow: false}
	}
	const action: AssistantAction = current.status === 'running' ? {...current, status: 'pending'} : current
	return {action, banner: err.message, follow: false}
}
