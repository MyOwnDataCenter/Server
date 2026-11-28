import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {ApiError, mutate, query, type AssistantAction, type AssistantKey, type InstallReview} from '../api'
import {BeforeInstall} from '../beforeInstall'
import {installNeedsReview, type ReviewInstallInput} from '../installReview'
import {answeredBy, assistantKeyLabel, cardAction, markReopenAssistant, streamAssistant, threadItems, type AssistantConversation, type AssistantConversationSummary, type AssistantItem, type AssistantStreamBody} from '../assistant'
import {useUser} from '../data'
import {Icon} from '../icons'
import {isOwner} from '../isOwner'
import {AppIcon, Sheet, SheetHeader} from '../ui'
import {useDesktop} from '../desktop/Desktop'
import {setAssistantActivity, useAssistantAnimationState} from '../assistantActivity'
import {appendLiveText, canDecideAssistantAction, canSendAssistantMessage, canStartAssistantFollow, finishLiveItems, insertLiveAction, isApprovalRequestError, liveBubbleMark, noteLiveVia, resolveFailedDecision, startLiveTurn} from '../assistantLive'
import {
	abortAssistantTurn,
	assistantEpoch,
	assistantTurn,
	beginAssistantTurn,
	closeAssistantView,
	finishAssistantTurn,
	openAssistantView,
	registerAssistantAbort,
	setTurnActivity,
	setTurnConversationId,
	setTurnError,
	setTurnItems,
	useAssistantTurn,
} from '../assistantTurn'
import {AssistantCharacter, lookName, useAssistantLook} from '../character/AssistantCharacter'
import {patchDeskConfig} from '../desktop/config'
import {SHOW_SHELL_KEY} from '../desktop/settingsPage'
import {haptic, omarchyBackgroundUrl, resetZoom, setLayoutPref, useLayout, useOmarchyThemes, usePortalRoot, useScreenLock, type Prefs} from '../ui'

const prettyTool = (name: string) => name.replaceAll('_', ' ')

// Survive unmount: a second send after closing the window must not reuse live-1 while the first
// turn is still writing, and New session still cancels a send that is looking up the thread id.
let liveSeq = 0
let sendGen = 0

async function waitForDesktopTheme(slug: string) {
	const want = slug.trim().toLowerCase()
	const start = Date.now()
	while (Date.now() - start < 12_000) {
		try {
			const data = await query<{current?: string | null}>('omarchy.themes')
			const now = String(data?.current ?? '').toLowerCase()
			if (want && now === want) return
			if (!want && Date.now() - start > 1500) return
		} catch {}
		await new Promise((r) => setTimeout(r, 400))
	}
}

async function waitForServer() {
	const start = Date.now()
	let sawDown = false
	while (Date.now() - start < 10 * 60_000) {
		try {
			const r = await fetch('/api/bootstrap', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000)})
			if (r.ok && sawDown) return
			if (!r.ok) sawDown = true
		} catch {
			sawDown = true
		}
		await new Promise((r) => setTimeout(r, sawDown ? 1500 : 400))
	}
}

async function renderMarkdown(src: string) {
	const [{marked}, {default: DOMPurify}] = await Promise.all([import('marked'), import('dompurify')])
	const html = await marked.parse(src, {gfm: true, breaks: true})
	return DOMPurify.sanitize(html, {FORBID_TAGS: ['style', 'form', 'input'], USE_PROFILES: {html: true}})
}

function LiveMark({streaming, content}: {streaming?: boolean; content?: string}) {
	const mark = liveBubbleMark({streaming, content})
	if (mark === 'spinner') return <span className="spinner" aria-label="Working" />
	if (mark === 'ellipsis') return <span className="typing" aria-hidden="true">…</span>
	return null
}

function BubbleMarkdown({text}: {text: string}) {
	const [html, setHtml] = useState('')
	useEffect(() => {
		if (!text) {
			setHtml('')
			return
		}
		let on = true
		void renderMarkdown(text).then((next) => {
			if (on) setHtml(next)
		})
		return () => {
			on = false
		}
	}, [text])
	if (!html) return <>{text}</>
	return (
		<div
			className="md"
			dangerouslySetInnerHTML={{__html: html}}
			onClick={(e) => {
				const a = (e.target as HTMLElement).closest('a')
				if (!a?.href) return
				e.preventDefault()
				window.open(a.href, '_blank', 'noopener,noreferrer')
			}}
		/>
	)
}

const statusText = (action: AssistantAction) => {
	if (action.status === 'done') return 'Approved'
	if (action.status === 'rejected') return 'Rejected'
	if (action.status === 'error') return action.error || 'Didn’t finish'
	return null
}

function WallpaperPicker({
	action,
	selected,
	disabled,
	onChange,
}: {
	action: AssistantAction
	selected: string
	disabled: boolean
	onChange: (id: string) => void
}) {
	const themes = useOmarchyThemes()
	const groups = themes.data?.groups ?? []
	const want = (action.picker?.theme || action.detail || themes.data?.theme || '').trim()
	const group = groups.find((g) => g.theme === want) ?? groups.find((g) => g.theme === themes.data?.theme) ?? groups[0]
	const items = group?.items ?? []
	const fallback = (action.picker?.selected && items.some((it) => it.id === action.picker?.selected) ? action.picker.selected : items[0]?.id) ?? ''
	useEffect(() => {
		if (fallback && (!selected || !items.some((it) => it.id === selected))) onChange(fallback)
	}, [fallback, items, selected, onChange])
	if (themes.isLoading) return <p>Looking for wallpapers…</p>
	if (!items.length) return <p>No pictures for this theme.</p>
	return (
		<div className="assistant-bg-pick" role="radiogroup" aria-label="Wallpaper">
			{items.map((it) => {
				const on = selected === it.id
				return (
					<label key={it.id} className={`assistant-bg-row${on ? ' on' : ''}`}>
						<input type="radio" name={`bg-${action.id}`} checked={on} disabled={disabled} onChange={() => onChange(it.id)} />
						<img src={omarchyBackgroundUrl(it.id)} alt="" loading="lazy" decoding="async" />
						<span>{it.name}</span>
					</label>
				)
			})}
		</div>
	)
}

function ActionCard({
	action,
	busy = false,
	onDecide,
}: {
	action: AssistantAction
	busy?: boolean
	onDecide: (actionId: string, path: 'assistant.approve' | 'assistant.reject', extra?: {id?: string; password?: string}) => void
}) {
	const running = action.status === 'running'
	const pending = action.status === 'pending' || running
	const canDecide = canDecideAssistantAction({status: action.status, streaming: busy})
	const status = statusText(action)
	const wallpaper = action.toolName === 'omarchy_setBackground'
	const [chosen, setChosen] = useState(action.picker?.selected ?? '')
	// A new machine's password is typed here and sent only with Approve: the model and the chat never see it.
	const vm = action.toolName === 'machines_create'
	const [password, setPassword] = useState('')
	return (
		<div className="assistant-card glass" role="group" aria-label={action.title || 'Approval'}>
			<b>{action.title || 'Approve this step'}</b>
			{wallpaper ? null : action.detail ? <p>{action.detail}</p> : null}
			{wallpaper && pending ? <WallpaperPicker action={action} selected={chosen} disabled={running} onChange={setChosen} /> : null}
			{vm && action.status === 'pending' ? (
				<label className="field assistant-password">
					<span>Password for the machine</span>
					<input type="password" autoComplete="new-password" value={password} maxLength={256} onChange={(e) => setPassword(e.target.value)} />
				</label>
			) : null}
			{pending ? (
				<div className="assistant-actions">
					<button type="button" className="btn primary" disabled={!canDecide || (wallpaper && !chosen) || (vm && !password)} onClick={() => onDecide(action.id, 'assistant.approve', wallpaper ? {id: chosen} : vm ? {password} : undefined)}>
						Approve
					</button>
					<button type="button" className="btn" disabled={!canDecide} onClick={() => onDecide(action.id, 'assistant.reject')}>
						Reject
					</button>
				</div>
			) : status ? (
				<p>{status}</p>
			) : null}
		</div>
	)
}

export function Assistant({onClose, onSettings, prefs, setPrefs, active = true}: {onClose?: () => void; onSettings: () => void; prefs?: Prefs; setPrefs?: (p: Prefs) => void; active?: boolean}) {
	const portalRoot = usePortalRoot()
	const screenRef = useRef<HTMLDivElement>(null)
	const threadRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const stick = useRef(true)
	const deciding = useRef(new Set<string>())
	const [installGate, setInstallGate] = useState<{actionId: string; appId: string; appName: string} | null>(null)
	const desk = useDesktop()
	const layout = useLayout()
	const decisionAbort = useRef(new Map<string, AbortController>())
	const followQueued = useRef(false)
	const pumping = useRef(false)
	const focused = useRef(false)
	const user = useUser()
	const qc = useQueryClient()
	const member = !isOwner(user.data)
	const keys = useQuery({queryKey: ['assistant.keys', undefined], queryFn: () => query<AssistantKey[]>('assistant.keys'), retry: false, staleTime: 15_000})
	const hasKeys = (keys.data ?? []).some((k) => !k.offered || !k.declined)
	const convs = useQuery({
		queryKey: ['assistant.conversations', undefined],
		queryFn: () => query<AssistantConversationSummary[]>('assistant.conversations'),
		enabled: hasKeys,
		retry: false,
		staleTime: 0,
	})
	const lastId = convs.data?.[0]?.id
	const thread = useQuery({
		queryKey: ['assistant.getConversation', lastId ? {id: lastId} : undefined],
		queryFn: () => query<AssistantConversation>('assistant.getConversation', {id: lastId}),
		enabled: hasKeys && !!lastId,
		retry: false,
		staleTime: 0,
	})
	const {items, activity, error: turnError, streaming} = useAssistantTurn()
	const [draft, setDraft] = useState('')
	const [decidingCount, setDecidingCount] = useState(0)
	const noteDeciding = () => setDecidingCount(deciding.current.size)
	const {look} = useAssistantLook()
	const [composing, setComposing] = useState(false)

	// Tell the assistant's character what's happening, from what this screen already shows: a reply
	// being written (thinking until text arrives), a lookup or an approved step running, a problem,
	// and Approve cards waiting. "Done" only when the server said an approved step finished.
	const cardStatus = useRef(new Map<string, string>())
	useEffect(() => {
		const live = items?.find((b) => b.kind === 'text' && b.streaming)
		const cards = (items ?? []).filter((b): b is Extract<AssistantItem, {kind: 'card'}> => b.kind === 'card')
		let successAt = 0
		for (const c of cards) {
			const before = cardStatus.current.get(c.action.id)
			if (before === 'running' && c.action.status === 'done') successAt = Date.now()
			cardStatus.current.set(c.action.id, c.action.status)
		}
		const running = cards.some((c) => c.action.status === 'running')
		const phase = turnError ? 'error' : running || (live && activity) ? 'working' : live ? (live.kind === 'text' && live.content ? 'responding' : 'thinking') : streaming ? 'thinking' : 'idle'
		setAssistantActivity({phase, pending: cards.filter((c) => c.action.status === 'pending').length, composing, ...(successAt ? {successAt} : {})})
	}, [items, activity, turnError, composing, streaming])
	useEffect(() => {
		if (active) openAssistantView()
		return () => closeAssistantView()
	}, [])
	const faceState = useAssistantAnimationState({reactions: look.reactions})
	const name = lookName(look)

	// Full screen on a phone: hold the page behind still. Otherwise iOS Safari sends a drag over the
	// chat to the page underneath (Home, scrolled) instead of the messages. Touches aren't blocked,
	// so the chat, the message box and the cards still scroll themselves.
	useScreenLock(screenRef, false, !!onClose && active)

	useEffect(() => {
		if (!onClose) return
		const vv = window.visualViewport
		const el = screenRef.current
		if (!vv || !el) return
		const apply = () => {
			el.style.top = `${vv.offsetTop}px`
			el.style.height = `${vv.height}px`
			el.classList.toggle('kbd-open', window.innerHeight - vv.height > 120)
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
		}
	}, [onClose])

	// Closing the chat while zoomed in would leave the screen behind it zoomed. The chat stays mounted
	// after it closes (so a reply can finish), so this runs when it stops being the active view.
	const wasActive = useRef(active)
	useEffect(() => {
		if (wasActive.current && !active && onClose) resetZoom()
		wasActive.current = active
	}, [active, onClose])
	useEffect(() => () => resetZoom(), [])

	useEffect(() => {
		if (!onClose || !active) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose, active])

	useEffect(() => {
		if (items !== null || streaming || !keys.isSuccess || !hasKeys) return
		if (convs.isError) {
			setTurnItems([])
			setTurnError((convs.error as Error).message)
			return
		}
		if (!convs.isSuccess) return
		if (!convs.data.length) {
			setTurnItems([])
			return
		}
		if (thread.isError) {
			setTurnItems([])
			setTurnError((thread.error as Error).message)
			return
		}
		if (!thread.isSuccess) return
		setTurnConversationId(thread.data.id)
		const label = assistantKeyLabel((keys.data ?? []).find((k) => k.id === thread.data.keyId))
		setTurnItems(answeredBy(threadItems(thread.data), label ? `Answered by ${label}` : ''))
	}, [items, streaming, keys.isSuccess, hasKeys, keys.data, convs.isError, convs.isSuccess, convs.data, convs.error, thread.isError, thread.isSuccess, thread.data, thread.error])

	useEffect(() => {
		const el = threadRef.current
		if (el && stick.current) el.scrollTop = el.scrollHeight
	}, [items, activity, turnError])

	useEffect(() => {
		if (onClose || !items || focused.current) return
		focused.current = true
		inputRef.current?.focus()
	}, [items, onClose])

	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`
	}

	const runStream = async (body: AssistantStreamBody, ac: AbortController, aid: string, since: number) => {
		let aborted = false
		let failed = false
		let sawAction = false
		let turn = startLiveTurn(aid)
		const stale = () => assistantEpoch() !== since
		try {
			await streamAssistant(body, (e) => {
				if (ac.signal.aborted || stale()) return
				if (e.event === 'text') {
					setTurnActivity(null)
					setTurnItems((bs) => {
						const step = appendLiveText(bs, turn, e.data.text)
						turn = step.turn
						return step.items
					})
				} else if (e.event === 'tool') {
					turn = {...turn, afterTool: true}
					const name = prettyTool(e.data.name)
					setTurnActivity(e.data.state === 'error' ? `Couldn’t check ${name}` : `Checked ${name}`)
				} else if (e.event === 'notice') {
					const message = e.data.message?.trim()
					if (message) setTurnItems((bs) => noteLiveVia(bs, turn.liveId, message))
				} else if (e.event === 'speaker') {
					const name = e.data.name?.trim()
					if (name) setTurnItems((bs) => noteLiveVia(bs, turn.liveId, `Answered by ${name}`, {keep: true}))
				} else if (e.event === 'action') {
					sawAction = true
					const action = cardAction(e.data)
					if (!action.id) return
					setTurnActivity(null)
					setTurnItems((bs) => insertLiveAction(bs, turn.liveId, action))
				} else if (e.event === 'done') {
					setTurnConversationId(e.data.conversationId, since)
				} else if (e.event === 'error') {
					failed = true
					setTurnError(e.data.message)
					if (e.data.conversationId) setTurnConversationId(e.data.conversationId, since)
				}
			}, ac.signal)
		} catch (err) {
			aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError')
			if (stale()) return
			if (!aborted) {
				failed = true
				setTurnError(err instanceof Error ? err.message : 'The assistant did not answer')
			}
		} finally {
			if (stale()) return
			setTurnItems((bs) => finishLiveItems(bs, turn.liveId, aborted || failed || sawAction))
			finishAssistantTurn(ac, since)
			if (canStartAssistantFollow({pumping: pumping.current, decidingCount: deciding.current.size, followQueued: followQueued.current, streaming: assistantTurn().streaming})) void pumpFollow()
		}
	}

	const newSession = () => {
		haptic(6)
		const running = assistantTurn().conversationId
		abortAssistantTurn()
		// Leaving the chat also stops the reply the server is still writing to it.
		if (running) void mutate('assistant.stop', {conversationId: running}).catch(() => {})
		sendGen++
		followQueued.current = false
		setTurnConversationId(undefined)
		setTurnItems([])
		setTurnError(null)
		setDraft('')
		if (inputRef.current) inputRef.current.style.height = 'auto'
	}

	const send = async () => {
		if (!canSendAssistantMessage({draft, itemsLoaded: items !== null, streaming: assistantTurn().streaming, decidingCount: deciding.current.size})) return
		const text = draft.trim()
		const token = ++sendGen
		const since = assistantEpoch()
		const hadTurn = assistantTurn().streaming
		let conversationId = assistantTurn().conversationId
		// The id arrives on `done`. A second send before that stays on the thread just created.
		if (hadTurn && !conversationId) {
			const list = await query<AssistantConversationSummary[]>('assistant.conversations').catch(() => null)
			if (assistantEpoch() !== since || sendGen !== token || deciding.current.size > 0) return
			const found = list?.[0]?.id
			if (found) {
				conversationId = found
				setTurnConversationId(found, since)
			}
		}
		if (assistantEpoch() !== since || sendGen !== token || deciding.current.size > 0) return
		const ac = new AbortController()
		beginAssistantTurn(ac, since)
		const id = ++liveSeq
		const aid = `live-${id}`
		setDraft('')
		if (inputRef.current) inputRef.current.style.height = 'auto'
		setTurnError(null)
		setTurnActivity(null)
		stick.current = true
		setTurnItems((bs) => [...(bs ?? []), {id: `user-${id}`, kind: 'text', role: 'user', content: text}, {id: aid, kind: 'text', role: 'assistant', content: '', streaming: true}])
		await runStream(conversationId ? {conversationId, message: text} : {message: text}, ac, aid, since)
	}

	const pumpFollow = async () => {
		if (!canStartAssistantFollow({pumping: pumping.current, decidingCount: deciding.current.size, followQueued: followQueued.current, streaming: assistantTurn().streaming})) return
		const since = assistantEpoch()
		pumping.current = true
		followQueued.current = false
		const conversationId = assistantTurn().conversationId
		const ac = new AbortController()
		beginAssistantTurn(ac, since)
		const id = ++liveSeq
		const aid = `live-${id}`
		stick.current = true
		setTurnError(null)
		setTurnActivity(null)
		if (conversationId) setTurnItems((bs) => [...(bs ?? []), {id: aid, kind: 'text', role: 'assistant', content: '', streaming: true}])
		try {
			if (conversationId) await runStream({conversationId, continue: true}, ac, aid, since)
			else finishAssistantTurn(ac, since)
		} finally {
			pumping.current = false
			if (assistantEpoch() !== since) return
			if (canStartAssistantFollow({pumping: pumping.current, decidingCount: deciding.current.size, followQueued: followQueued.current, streaming: assistantTurn().streaming})) void pumpFollow()
		}
	}

	const decide = async (actionId: string, path: 'assistant.approve' | 'assistant.reject', extra?: {id?: string; password?: string} & ReviewInstallInput) => {
		if (deciding.current.has(actionId)) return
		const since = assistantEpoch()
		const conversationId = assistantTurn().conversationId
		if (!conversationId) {
			setTurnError('That chat isn’t here')
			return
		}
		const cur = assistantTurn().items?.find((b) => b.kind === 'card' && b.action.id === actionId)
		if (!cur || cur.kind !== 'card' || cur.action.status !== 'pending') return
		const own = new AbortController()
		const dropAbort = registerAssistantAbort(own)
		decisionAbort.current.set(actionId, own)
		deciding.current.add(actionId)
		noteDeciding()
		// Never abort a running reply here: the server finishes it anyway and holds the chat lock.
		haptic(6)
		setTurnError(null)
		setTurnActivity(null)
		setTurnItems((bs) => bs?.map((b) => (b.kind === 'card' && b.action.id === actionId ? {...b, action: {...b.action, status: 'running'}} : b)) ?? bs)
		let follow = false
		let reloadTheme: string | null = null
		let reloadAfterRestart = false
		try {
			const updated = await mutate<AssistantAction>(path, {
				actionId,
				...(extra?.id ? {id: extra.id} : {}),
				...(extra?.password ? {password: extra.password} : {}),
				...(extra?.grant ? {grant: extra.grant} : {}),
				...(extra?.folders ? {folders: extra.folders} : {}),
				...(extra?.folderAccess ? {folderAccess: extra.folderAccess} : {}),
			})
			if (assistantEpoch() !== since || own.signal.aborted) return
			setTurnItems((bs) =>
				bs?.map((b) => {
					if (b.kind !== 'card' || b.action.id !== actionId) return b
					const extra = updated && typeof updated === 'object' && !Array.isArray(updated) ? updated : {}
					return {...b, action: cardAction({...b.action, ...extra, id: actionId})}
				}) ?? bs,
			)
			follow = true
			const status = updated && typeof updated === 'object' && !Array.isArray(updated) ? updated.status : undefined
			const ok = !status || status === 'done'
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'omarchy_setTheme') reloadTheme = cur.action.detail || ''
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'system_restart') reloadAfterRestart = true
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'desktop_setLayout') {
				const label = String((updated && typeof updated === 'object' && 'detail' in updated ? updated.detail : cur.action.detail) ?? '').toLowerCase()
				const shell = label.includes('hyprland') ? 'hyprland' : label.includes('ubuntu') ? 'gnome' : null
				if (shell) {
					patchDeskConfig({shell})
					if (!layout.desktop) {
						try {
							sessionStorage.setItem(SHOW_SHELL_KEY, 'retile')
						} catch {
							/* private */
						}
						setLayoutPref('desktop')
					}
				}
			}
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'omarchy_setBackground' && extra?.id && setPrefs && prefs) {
				setPrefs({
					...prefs,
					omarchyBackground: extra.id,
					solidColor: null,
					theme: prefs.theme === 'horizon' ? 'horizon' : 'omarchy',
				})
				void qc.invalidateQueries({queryKey: ['omarchy-themes']})
				const theme = cur.action.picker?.theme || cur.action.detail || ''
				if (theme) reloadTheme = theme
			}
		} catch (err) {
			if (assistantEpoch() !== since || own.signal.aborted) return
			const info = err instanceof ApiError
				? {isApiError: true, code: err.code, status: err.status, message: err.message}
				: {isApiError: false, message: err instanceof Error ? err.message : 'That step didn’t finish'}
			let serverAction: AssistantAction | null = null
			if ((isApprovalRequestError(info) || info.code === 'CONFLICT') && info.code !== 'UNAUTHORIZED') {
				const conv = await query<AssistantConversation>('assistant.getConversation', {id: conversationId}).catch(() => null)
				if (assistantEpoch() !== since || own.signal.aborted) return
				const found = conv?.actions?.find((a) => a.id === actionId)
				if (found) serverAction = cardAction(found)
			}
			const resolved = resolveFailedDecision({...cur.action, status: 'running'}, info, serverAction)
			setTurnItems((bs) =>
				bs?.map((b) => (b.kind === 'card' && b.action.id === actionId ? {...b, action: cardAction({...b.action, ...resolved.action, id: actionId})} : b)) ?? bs,
			)
			if (resolved.banner) setTurnError(resolved.banner)
			if (resolved.follow) follow = true
		} finally {
			dropAbort()
			deciding.current.delete(actionId)
			decisionAbort.current.delete(actionId)
			noteDeciding()
			if (assistantEpoch() !== since) return
			if (follow) followQueued.current = true
			if (followQueued.current && deciding.current.size === 0) {
				if (reloadAfterRestart) {
					markReopenAssistant()
					setTurnActivity('Waiting for the server to come back…')
					void (async () => {
						await waitForServer()
						if (assistantEpoch() !== since) return
						location.reload()
					})()
				} else if (reloadTheme != null) {
					markReopenAssistant()
					void (async () => {
						try {
							await pumpFollow()
						} finally {
							if (assistantEpoch() !== since) return
							await waitForDesktopTheme(reloadTheme)
							if (assistantEpoch() !== since) return
							location.reload()
						}
					})()
				} else {
					void pumpFollow()
				}
			}
		}
	}

	const maybeReview = async (action: AssistantAction) => {
		if (!action.appId || installGate?.actionId === action.id || deciding.current.has(action.id)) return
		try {
			const review = await query<InstallReview>('apps.installReview', {appId: action.appId})
			qc.setQueryData(['apps.installReview', action.appId], review)
			if (!installNeedsReview(review)) {
				void decide(action.id, 'assistant.approve')
				return
			}
			const appName = action.title.replace(/^Install\s+/, '').trim() || 'this app'
			setInstallGate({actionId: action.id, appId: action.appId, appName})
		} catch {
			void decide(action.id, 'assistant.approve')
		}
	}

	const cancelInstall = () => {
		const gate = installGate
		setInstallGate(null)
		if (gate) void decide(gate.actionId, 'assistant.reject')
	}

	const loading = keys.isLoading || (hasKeys && items === null && !keys.isError)
	const column = (
		<div className="assistant glass" role="dialog" aria-modal={onClose ? true : undefined} aria-label={name}>
			<header className="assistant-head">
				{onClose && (
					<button type="button" className="round-btn" aria-label="Back" onClick={() => (haptic(6), onClose())}>
						<Icon name="back" size={20} />
					</button>
				)}
				<AssistantCharacter id={look.character} state={faceState} size={34} animate={look.animate} intensity={look.intensity} />
				<b>{name}</b>
				{hasKeys && (
					<button type="button" className="round-btn" aria-label="New session" title="New session" onClick={newSession} disabled={items === null}>
						<Icon name="reset" size={19} />
					</button>
				)}
				<button type="button" className="round-btn" aria-label="Settings" title="Settings" onClick={() => (haptic(6), onSettings())}>
					<Icon name="settings" size={19} />
				</button>
			</header>
			{keys.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(keys.error as Error).message}
				</div>
			)}
			{loading && (
				<div className="assistant-thread">
					<span className="spinner" role="status" aria-label="Loading" />
				</div>
			)}
			{keys.isSuccess && !hasKeys && (
				<div className="assistant-thread">
					<div className="empty">
						<span className="big">
							<Icon name="sparkle" size={30} />
						</span>
						<b>Add a provider to talk to the assistant.</b>
						<span>ChatGPT, Grok, OpenAI, Anthropic, or a model on this server.</span>
						{member && <span>If the owner offered a provider, it is listed in Settings. You can refuse it there.</span>}
						<button type="button" className="btn primary" onClick={() => (haptic(6), onSettings())}>
							Settings → Assistant
						</button>
					</div>
				</div>
			)}
			{hasKeys && items && (
				<>
					<div
						className="assistant-thread"
						role="log"
						aria-live="polite"
						aria-relevant="additions"
						aria-label="Conversation"
						ref={threadRef}
						onScroll={(e) => {
							const el = e.currentTarget
							stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
						}}
					>
						{items.length === 0 && !turnError && (
							<div className="empty">
								<AssistantCharacter id={look.character} state={faceState} size={96} animate={look.animate} intensity={look.intensity} />
								<b>Ask {name} about this server</b>
								<span>Usage, apps, machines, and the Local swarm.</span>
							</div>
						)}
						{(items.length > 0 || activity || turnError) && (
							<div className="assistant-thread-end">
								{items.map((b) =>
									b.kind === 'card' ? (
										<ActionCard key={b.id} action={b.action} busy={streaming} onDecide={(id, path, extra) => {
											if (assistantTurn().streaming) return
											const cur = assistantTurn().items?.find((item) => item.kind === 'card' && item.action.id === id)
											if (path === 'assistant.approve' && !extra && cur?.kind === 'card' && cur.action.toolName === 'apps_install' && cur.action.appId) {
												void maybeReview(cur.action)
												return
											}
											void decide(id, path, extra)
										}} />
									) : b.role === 'assistant' ? (
										<div key={b.id} className="assistant-msg">
											{/* The character beside its replies; only the one being written moves. */}
											<AssistantCharacter id={look.character} state={b.streaming ? faceState : 'idle'} size={28} animate={look.animate && !!b.streaming} intensity={look.intensity} />
											<div className={`bubble ${b.role}${b.streaming ? ' live' : ''}`} aria-busy={b.streaming ? true : undefined}>
												{b.via && <p className="assistant-via">{b.via}</p>}
												<BubbleMarkdown text={b.content} />
												<LiveMark streaming={b.streaming} content={b.content} />
											</div>
										</div>
									) : (
										<div key={b.id} className={`bubble ${b.role}`}>
											{b.content}
										</div>
									),
								)}
								{activity && (
									<p className="assistant-activity" role="status">
										{activity}
									</p>
								)}
								{turnError && (
									<div className="error" role="alert">
										<Icon name="alert" size={18} />
										{turnError}
									</div>
								)}
							</div>
						)}
					</div>
					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault()
							void send()
						}}
					>
						<textarea
							ref={inputRef}
							rows={1}
							value={draft}
							placeholder="Message"
							aria-label="Message"
							enterKeyHint="send"
							disabled={decidingCount > 0}
							onChange={(e) => {
								setDraft(e.target.value)
								fit(e.target)
							}}
							onFocus={() => setComposing(true)}
							onBlur={() => setComposing(false)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault()
									void send()
								}
							}}
						/>
						<button type="submit" className="btn primary small" disabled={!canSendAssistantMessage({draft, itemsLoaded: items !== null, streaming, decidingCount})}>
							Send
						</button>
					</form>
				</>
			)}
			{installGate && (
				<Sheet open onClose={cancelInstall} label={`Install ${installGate.appName}`}>
					<SheetHeader icon={<AppIcon name={installGate.appName} size={72} />} title={installGate.appName} onClose={cancelInstall} />
					<BeforeInstall
						appId={installGate.appId}
						appName={installGate.appName}
						cancelLabel="Cancel"
						openTerminal={desk ? (command) => desk.openTerminal(undefined, command) : undefined}
						onInstall={(input) => {
							const gate = installGate
							setInstallGate(null)
							void decide(gate.actionId, 'assistant.approve', input)
						}}
						onCancel={cancelInstall}
					/>
				</Sheet>
			)}
		</div>
	)
	if (!onClose) return column
	return createPortal(
		<div ref={screenRef} className="assistant-screen" hidden={!active} aria-hidden={!active}>
			{column}
		</div>,
		portalRoot,
	)
}
