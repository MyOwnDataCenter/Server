// Toasts for this signed-in person. The box at the top, or the assistant's bubble, both read this list.
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode} from 'react'

import {mutate, query} from '../api'
import {liveRegionText} from '../focus'
import {Icon} from '../icons'
import {openToastPlace} from './open'
import {liveToasts, toastRemaining, type ToastRecord} from './view'

export const TOASTS_QUERY_KEY = ['toasts.list'] as const

type Boot = {session?: unknown; server?: {reachable?: boolean}} | null

type ToastApi = {
	rows: ToastRecord[]
	bubble: boolean
	claimBubble: (on: boolean) => void
	push: (text: string, error?: boolean) => void
	dismiss: (id: string) => void
	open: (row: ToastRecord) => void
}

const EMPTY: ToastApi = {
	rows: [],
	bubble: false,
	claimBubble: () => {},
	push: () => {},
	dismiss: () => {},
	open: () => {},
}

const Ctx = createContext<ToastApi>(EMPTY)

export function useAccountToasts() {
	return useContext(Ctx)
}

function signedInFrom(data: unknown) {
	const boot = data as Boot
	return !!boot?.session && !!boot?.server?.reachable
}

function useSignedIn() {
	const qc = useQueryClient()
	const [signedIn, setSignedIn] = useState(() => signedInFrom(qc.getQueryData(['bootstrap'])))
	useEffect(() => {
		const read = () => setSignedIn(signedInFrom(qc.getQueryData(['bootstrap'])))
		read()
		return qc.getQueryCache().subscribe((event) => {
			if (event.query.queryKey[0] !== 'bootstrap') return
			read()
		})
	}, [qc])
	return signedIn
}

function newToastId() {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function oneLine(text: string) {
	return String(text ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 240)
}

export function useToastClock(rows: readonly ToastRecord[]) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!rows.some((row) => row.expireAt != null)) return
		let id = 0
		const tick = () => {
			setNow(Date.now())
			id = window.setTimeout(tick, 50)
		}
		id = window.setTimeout(tick, 50)
		return () => window.clearTimeout(id)
	}, [rows])
	// Also bump once when an untimed-only list gains a soon expiry via raw poll.
	useEffect(() => {
		const soon = rows.reduce<number>((at, row) => (row.expireAt != null && row.expireAt < at ? row.expireAt : at), Infinity)
		if (!Number.isFinite(soon)) return
		const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, soon - Date.now()) + 30)
		return () => window.clearTimeout(timer)
	}, [rows])
	return now
}

export function ToastRow({
	row,
	now,
	onOpen,
	onDismiss,
	variant,
}: {
	row: ToastRecord
	now: number
	onOpen: (row: ToastRecord) => void
	onDismiss: (id: string) => void
	variant: 'box' | 'bubble'
}) {
	const left = toastRemaining(row, now)
	const problem = row.level === 'problem'
	return (
		<div className={`${variant === 'box' ? 'toast' : 'ac-say-row'}${problem ? (variant === 'box' ? ' error' : ' problem') : ''}`}>
			{variant === 'box' && (
				<span className="ico">
					<Icon name={problem ? 'alert' : 'check'} size={15} stroke={2.6} />
				</span>
			)}
			{row.href ? (
				<button type="button" className={variant === 'box' ? 'toast-open' : 'ac-say-open'} onClick={() => onOpen(row)}>
					{row.text}
				</button>
			) : (
				<span className={variant === 'box' ? 'toast-text' : 'ac-say-text'}>{row.text}</span>
			)}
			<button type="button" className={variant === 'box' ? 'toast-x' : 'ac-say-x'} aria-label="Dismiss" onClick={() => onDismiss(row.id)}>
				<Icon name="close" size={14} />
			</button>
			{left != null && <span className="toast-ttl" aria-hidden="true" style={{'--toast-ttl': String(left)} as CSSProperties} />}
		</div>
	)
}

export function AccountToastProvider({children}: {children: ReactNode}) {
	const qc = useQueryClient()
	const signedIn = useSignedIn()
	const list = useQuery({
		queryKey: TOASTS_QUERY_KEY,
		queryFn: () => query<ToastRecord[]>('toasts.list'),
		enabled: signedIn,
		refetchInterval: signedIn ? 2500 : false,
		retry: false,
	})
	const raw = list.data
	const baseNow = useToastClock(raw ?? [])
	const rows = liveToasts(raw ?? [], baseNow)
	const [bubble, setBubble] = useState(false)
	const claimBubble = useCallback((on: boolean) => setBubble(on), [])
	const dismiss = useCallback(
		(id: string) => {
			qc.setQueryData<ToastRecord[]>(TOASTS_QUERY_KEY, (current) => (current ?? []).filter((row) => row.id !== id))
			void mutate('toasts.dismiss', {id}).catch(() => {
				void qc.invalidateQueries({queryKey: TOASTS_QUERY_KEY})
			})
		},
		[qc],
	)
	const open = useCallback(
		(row: ToastRecord) => {
			if (row.href) openToastPlace(row.href)
			dismiss(row.id)
		},
		[dismiss],
	)
	const push = useCallback(
		(text: string, error = false) => {
			if (!signedIn) return
			const cleaned = oneLine(text)
			if (!cleaned) return
			const at = Date.now()
			const id = newToastId()
			const level = error ? 'problem' : 'note'
			const expireAt = at + (error ? 4500 : 2600)
			const provisional: ToastRecord = {id, text: cleaned, at, href: null, expireAt, level}
			qc.setQueryData<ToastRecord[]>(TOASTS_QUERY_KEY, (current) => [...(current ?? []), provisional])
			void mutate<ToastRecord>('toasts.add', {text: cleaned, href: null, expireAt, level})
				.then((row) => {
					qc.setQueryData<ToastRecord[]>(TOASTS_QUERY_KEY, (current) => {
						const list = current ?? []
						const without = list.filter((item) => item.id !== id && item.id !== row.id)
						return [...without, row]
					})
				})
				.catch(() => {
					qc.setQueryData<ToastRecord[]>(TOASTS_QUERY_KEY, (current) => (current ?? []).filter((item) => item.id !== id))
					void qc.invalidateQueries({queryKey: TOASTS_QUERY_KEY})
				})
		},
		[qc, signedIn],
	)
	const value = useMemo(() => ({rows, bubble, claimBubble, push, dismiss, open}), [rows, bubble, claimBubble, push, dismiss, open])
	const head = rows[0] ?? null
	const [announcedId, setAnnouncedId] = useState<string | null>(null)
	useEffect(() => {
		if (!head) {
			setAnnouncedId(null)
			return
		}
		if (head.id === announcedId) return
		setAnnouncedId(head.id)
	}, [head, announcedId])
	const announced = head && head.id === announcedId ? head : null
	const live = liveRegionText(announced ? {text: announced.text, error: announced.level === 'problem'} : null)
	return (
		<Ctx.Provider value={value}>
			{children}
			<div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{live.status}
			</div>
			<div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
				{live.alert}
			</div>
		</Ctx.Provider>
	)
}

export function AccountToastStack() {
	const {rows, bubble, dismiss, open} = useAccountToasts()
	const now = useToastClock(rows)
	if (bubble || rows.length === 0) return null
	return (
		<div className="toast-stack">
			{rows.map((row) => (
				<ToastRow key={row.id} row={row} now={now} onOpen={open} onDismiss={dismiss} variant="box" />
			))}
		</div>
	)
}
