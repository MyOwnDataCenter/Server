// One clip book for the signed-in person. A machine section shows this same book.
import {useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties} from 'react'
import {createPortal} from 'react-dom'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type Machine} from '../api'
import {clipItemUrl} from '../clips'
import {useBootstrap, useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {isOwner} from '../isOwner'
import {type Agent} from '../swarm/Swarm'
import {FilterBar} from '../FilterBar'
import {Field, InWindow, Row, Sheet, SheetHeader, haptic, useConfirm, usePortalRoot, useToast} from '../ui'
import {
	batchPlan,
	clipIsFolder,
	FOLDER_TO_COMPUTER,
	clipWord,
	copyPlan,
	displayMachine,
	filterClips,
	formatClipWhen,
	nextStatus,
	nextType,
	sendTargets,
	statusLabel,
	statusMark,
	typeLabel,
	type ClipHere,
	type ClipQuery,
	type ClipRow,
	type ClipStatusFilter,
	type ClipTypeFilter,
} from './view'

type ClipRef = {
	scope: 'server' | 'swarm' | 'machine'
	path: string
	id?: string
	size: number | null
	mtime: number | null
	dir?: true
	items?: {path: string; dir?: true}[]
}
type Clip = {
	id: string
	kind: 'text' | 'image' | 'stats' | 'file'
	at: number
	label: string
	name: string
	preview: string
	machine?: string
	availability?: ClipRow['availability']
	dir?: boolean
	ref?: ClipRef
}
type Book = {clips: Clip[]; damaged: boolean}
type TransferJob = {
	id: string
	state: 'queued' | 'running' | 'paused' | 'done' | 'cancelled'
	name: string
	canResume: boolean
	progress: {done: number; total: number; current: string | null}
}
type SendDraft = {ids: string[]; target: string; folder: string}
type AskAnchor = {id: string; top: number; left: number; bottom: number; right: number}

const CLIPBOARD_LIMIT = 'This machine can’t take text on its own clipboard yet.'

function asRow(clip: Clip): ClipRow {
	return {
		id: clip.id,
		kind: clip.kind,
		at: clip.at,
		label: clip.label,
		name: clip.name,
		preview: clip.preview,
		machine: clip.machine || 'This server',
		availability: clip.availability || 'available',
		dir: clipIsFolder(clip),
		scope: clip.ref?.scope,
	}
}

function clipIcon(clip: {kind: string; dir?: boolean}): IconName {
	const word = clipWord(clip)
	if (word === 'Folder') return 'folder'
	if (word === 'Picture') return 'image'
	if (word === 'File') return 'file'
	if (word === 'Stats') return 'activity'
	return 'file-text'
}

function clipPaths(clip: Clip): string {
	if (clip.ref?.items?.length) return clip.ref.items.map((item) => item.path).join('\n')
	return clip.ref?.path ?? ''
}

function jobTitle(job: TransferJob): string {
	if (job.state === 'queued') return `Waiting to send to ${job.name}`
	if (job.state === 'running') return `Sending to ${job.name}`
	if (job.state === 'paused') return `Paused · ${job.name}`
	if (job.state === 'cancelled') return `Cancelled · ${job.name}`
	return `Sent to ${job.name}`
}

function folderFor(target: ClipHere, current: string): string {
	if (target.scope === 'server') return current.startsWith('/') ? current : '/Home'
	return current.startsWith('/') ? '' : current
}

function DeleteFlyout({anchor, busy, onClose, onDelete}: {anchor: AskAnchor; busy: boolean; onClose: () => void; onDelete: () => void}) {
	const root = usePortalRoot()
	const ref = useRef<HTMLDivElement>(null)
	const cancelRef = useRef<HTMLButtonElement>(null)
	const closeRef = useRef(onClose)
	const [pos, setPos] = useState<{top: number; left: number} | null>(null)
	closeRef.current = onClose
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const width = el.offsetWidth
		const height = el.offsetHeight
		let left = anchor.right - width
		left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
		let top = anchor.bottom + 8
		if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 8)
		setPos({top, left})
	}, [anchor.top, anchor.left, anchor.bottom, anchor.right])
	useEffect(() => {
		cancelRef.current?.focus()
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeRef.current()
		}
		const onPointer = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) closeRef.current()
		}
		document.addEventListener('keydown', onKey)
		document.addEventListener('pointerdown', onPointer)
		return () => {
			document.removeEventListener('keydown', onKey)
			document.removeEventListener('pointerdown', onPointer)
		}
	}, [])
	return createPortal(
		<div ref={ref} className="clip-fly" role="dialog" aria-label="Delete this clip?" style={{top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden'}}>
			<b>Delete this clip?</b>
			<p>It’s taken out of your clip book. The original file is left where it is.</p>
			<div className="clip-fly-actions">
				<button ref={cancelRef} type="button" className="btn" onClick={onClose}>
					Cancel
				</button>
				<button type="button" className="btn danger" disabled={busy} onClick={onDelete}>
					Delete
				</button>
			</div>
		</div>,
		root,
	)
}

export function ClipBook({onBack, here, readings}: {onBack?: () => void; here?: ClipHere | null; readings?: boolean}) {
	const toast = useToast()
	const confirm = useConfirm()
	const qc = useQueryClient()
	const user = useUser()
	const boot = useBootstrap()
	const serverName = boot.server?.device || 'This server'
	const owner = isOwner(user.data)
	const inWindow = useContext(InWindow)
	const book = useQuery({queryKey: ['clips.list'], queryFn: () => query<Book>('clips.list')})
	const jobs = useQuery({queryKey: ['transfers.list'], queryFn: () => query<TransferJob[]>('transfers.list'), enabled: !here, refetchInterval: here ? false : 2000})
	const machines = useQuery({queryKey: ['machines.list'], queryFn: () => query<Machine[]>('machines.list'), enabled: owner && !here})
	const computers = useQuery({queryKey: ['swarm.list'], queryFn: () => query<Agent[]>('swarm.list'), enabled: owner && !here})
	const [open, setOpen] = useState<Clip | null>(null)
	const [text, setText] = useState('')
	const [type, setType] = useState<ClipTypeFilter | null>(null)
	const [status, setStatus] = useState<ClipStatusFilter | null>(null)
	const [selected, setSelected] = useState<Set<string>>(() => new Set())
	const [send, setSend] = useState<SendDraft | null>(null)
	const [ask, setAsk] = useState<AskAnchor | null>(null)
	const [busy, setBusy] = useState(false)
	const busyRef = useRef(false)
	const confirming = useRef(false)

	const refresh = () => qc.invalidateQueries({queryKey: ['clips.list']})
	const run = async (work: () => Promise<void>) => {
		if (busyRef.current) return
		busyRef.current = true
		setBusy(true)
		try {
			await work()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			busyRef.current = false
			setBusy(false)
		}
	}

	const clips = book.data?.clips ?? []
	useEffect(() => {
		if (!book.data) return
		const live = new Set(book.data.clips.map((clip) => clip.id))
		setSelected((prev) => {
			let changed = false
			const next = new Set<string>()
			for (const id of prev) {
				if (live.has(id)) next.add(id)
				else changed = true
			}
			return changed ? next : prev
		})
		setAsk((prev) => (prev && !live.has(prev.id) ? null : prev))
	}, [book.data])

	const rows = clips.map(asRow)
	const viewQuery: ClipQuery = {text, type, status}
	const shown = filterClips(rows, viewQuery, serverName)
	const shownIds = new Set(shown.map((clip) => clip.id))
	const visible = clips.filter((clip) => shownIds.has(clip.id)).sort((a, b) => b.at - a.at)
	const filtering = text.trim() !== '' || type != null || status != null
	const targets = here
		? [here]
		: sendTargets({
				serverName,
				computers: (computers.data ?? []).map((agent) => ({
					id: agent.id,
					name: agent.name,
					online: agent.online,
					guestOf: agent.guestOf,
					allowed: agent.allowed,
					on: agent.on,
				})),
				machines: (machines.data ?? []).filter((machine) => machine.id && machine.id !== 'desktop').map((machine) => ({id: machine.id, name: machine.name})),
			})
	const chosen = clips.filter((clip) => selected.has(clip.id)).sort((a, b) => b.at - a.at)
	const selection = batchPlan(chosen.map(asRow), targets)

	const copyClip = (clip: Clip) =>
		run(async () => {
			const plan = copyPlan(asRow(clip))
			if (plan === 'unavailable') {
				toast(clip.availability === 'offline' ? 'That machine isn’t answering.' : 'This content is gone.', true)
				return
			}
			if (plan === 'text') {
				const result = await mutate<{text?: string}>('clips.paste', {id: clip.id, dest: 'text'})
				const value = result.text ?? ''
				if (value && navigator.clipboard?.writeText) await navigator.clipboard.writeText(value).catch(() => {})
				toast('Copied')
				return
			}
			if (plan === 'image') {
				const res = await fetch(clipItemUrl(clip.id), {credentials: 'same-origin'})
				if (!res.ok) throw new Error('Couldn’t copy that picture')
				const blob = await res.blob()
				const write = navigator.clipboard && 'write' in navigator.clipboard ? navigator.clipboard.write.bind(navigator.clipboard) : null
				if (!write || typeof ClipboardItem === 'undefined') throw new Error('This browser can’t copy a picture. Use Send to…')
				await write([new ClipboardItem({'image/png': blob})])
				toast('Copied')
				return
			}
			const path = clipPaths(clip)
			if (path && navigator.clipboard?.writeText) await navigator.clipboard.writeText(path).catch(() => {})
			toast('Copied')
		})

	const deliverClipboard = (items: Clip[], target: ClipHere) =>
		run(async () => {
			const ids = items.map((clip) => clip.id)
			await mutate('clips.paste', {ids, dest: {clipboard: 'server'}})
			toast(ids.length === 1 ? `Sent to ${target.name}` : `Sent ${ids.length} to ${target.name}`)
			setSend(null)
			setSelected(new Set())
		})

	// The server keeps sending after this page closes. The global Clip book shows how far it got.
	const deliverFiles = (ids: string[], target: ClipHere, folder: string) => {
		if (busyRef.current) return
		busyRef.current = true
		setBusy(true)
		const named = clips.filter((clip) => ids.includes(clip.id)).map((clip) => ({id: clip.id, name: clip.name || clip.label}))
		const dest = target.scope === 'server' ? {folder} : {computer: target.id, folder}
		void (async () => {
			try {
				await mutate('transfers.start', {name: target.name, dest, clips: named})
				setSelected(new Set())
				setSend(null)
				void qc.invalidateQueries({queryKey: ['transfers.list']})
				void qc.invalidateQueries({queryKey: ['toasts.list']})
			} catch (error) {
				toast((error as Error).message, true)
			} finally {
				busyRef.current = false
				setBusy(false)
			}
		})()
	}

	const changeJob = (path: 'transfers.resume' | 'transfers.cancel' | 'transfers.dismiss', id: string) => {
		if (busyRef.current) return
		busyRef.current = true
		setBusy(true)
		void (async () => {
			try {
				await mutate(path, {id})
				void qc.invalidateQueries({queryKey: ['transfers.list']})
				void qc.invalidateQueries({queryKey: ['toasts.list']})
			} catch (error) {
				toast((error as Error).message, true)
			} finally {
				busyRef.current = false
				setBusy(false)
			}
		})()
	}

	const beginSend = (items: Clip[]) => {
		const plan = batchPlan(items.map(asRow), targets)
		if (plan.problem || !plan.targets.length) {
			if (plan.problem) toast(plan.problem, true)
			return
		}
		setAsk(null)
		if (plan.kind === 'clipboard') {
			void deliverClipboard(items, plan.targets[0])
			return
		}
		const first = plan.targets[0]
		setSend({ids: items.map((clip) => clip.id), target: first.id, folder: first.scope === 'server' ? '/Home' : ''})
	}

	const remove = async (clip: Clip) => {
		const ok = await confirm({title: 'Delete this clip?', body: 'It’s taken out of your clip book. The original file is left where it is.', confirm: 'Delete', danger: true, icon: 'trash'})
		if (!ok) return
		await run(async () => {
			await mutate('clips.remove', {id: clip.id})
			if (open?.id === clip.id) setOpen(null)
			setSelected((prev) => {
				if (!prev.has(clip.id)) return prev
				const next = new Set(prev)
				next.delete(clip.id)
				return next
			})
			toast('Deleted')
			refresh()
		})
	}

	const removeNow = (clip: Clip) => {
		if (busyRef.current) return
		busyRef.current = true
		setBusy(true)
		void (async () => {
			try {
				await mutate('clips.remove', {id: clip.id})
				if (open?.id === clip.id) setOpen(null)
				setAsk(null)
				setSelected((prev) => {
					if (!prev.has(clip.id)) return prev
					const next = new Set(prev)
					next.delete(clip.id)
					return next
				})
				toast('Deleted')
				refresh()
			} catch (error) {
				toast((error as Error).message, true)
			} finally {
				busyRef.current = false
				setBusy(false)
			}
		})()
	}

	const removeSelected = async () => {
		if (confirming.current || busyRef.current) return
		const ids = chosen.map((clip) => clip.id)
		const n = ids.length
		if (!n) return
		confirming.current = true
		try {
			const ok = await confirm({
				title: n === 1 ? 'Delete 1 selected item?' : `Delete ${n} selected items?`,
				body: n === 1 ? 'It’s taken out of your clip book. The original file is left where it is.' : 'They’re taken out of your clip book. The original files are left where they are.',
				confirm: 'Delete',
				danger: true,
				icon: 'trash',
			})
			if (!ok) return
			await run(async () => {
				let removed = 0
				try {
					for (const id of ids) {
						await mutate('clips.remove', {id})
						removed += 1
					}
				} finally {
					if (removed > 0) refresh()
				}
				if (open && ids.includes(open.id)) setOpen(null)
				setSelected(new Set())
				toast(n === 1 ? 'Deleted' : `Deleted ${n}`)
			})
		} finally {
			confirming.current = false
		}
	}

	const clipReadings = () =>
		run(async () => {
			if (!here) return
			await mutate('clips.addStats', here.scope === 'server' ? {scope: 'server'} : {scope: 'swarm', id: here.id})
			toast('Saved to the clip book')
			refresh()
		})

	const toggle = (id: string) => {
		haptic(6)
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	const openClip = open && clips.some((clip) => clip.id === open.id) ? clips.find((clip) => clip.id === open.id) ?? open : open
	const openRow = openClip ? asRow(openClip) : null
	const folderClip = openClip ? clipIsFolder(openClip) : false
	const detailPlan = openRow ? batchPlan([openRow], targets) : null
	const sending = send ? clips.filter((clip) => send.ids.includes(clip.id)).sort((a, b) => b.at - a.at) : []
	const sendPlan = sending.length ? batchPlan(sending.map(asRow), targets) : null
	const sendChoices = sendPlan?.targets ?? []
	const sendTarget = send ? (sendChoices.find((item) => item.id === send.target) ?? sendChoices[0] ?? null) : null
	const asked = ask ? (clips.find((clip) => clip.id === ask.id) ?? null) : null
	const now = Date.now()
	const sendLabel = here ? `Send to ${here.name}` : 'Send to…'

	return (
		<div className="stagger clip-book">
			{!here && (
				<div style={{display: 'flex', alignItems: 'center', gap: 10}}>
					{onBack && !inWindow && (
						<button className="round-btn" aria-label="Back" onClick={onBack}>
							<Icon name="back" size={20} />
						</button>
					)}
					<div>
						<h1 className="title" style={{margin: 0}}>
							Clip book
						</h1>
						<p className="subtitle">Text, pictures, and files you copied. A file stays where it is until you send it.</p>
					</div>
				</div>
			)}
			{book.data?.damaged && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					The clip book is damaged and was left unchanged.
				</div>
			)}
			{book.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(book.error as Error).message}
				</div>
			)}
			{!here && (jobs.data?.length ?? 0) > 0 && (
				<section className="clip-jobs" aria-label="Transfers">
					<h2>Transfers</h2>
					{jobs.data?.map((job) => {
						const moving = job.progress.current ? ` · ${job.progress.current}` : ''
						const gap = job.state !== 'running' && job.state !== 'queued' && job.progress.done < job.progress.total ? ' · Some didn’t send.' : ''
						return (
							<div key={job.id} className="clip-job">
								<div className="clip-job-copy">
									<b>{jobTitle(job)}</b>
									<p>
										{job.progress.done} of {job.progress.total}
										{moving}
										{gap}
									</p>
								</div>
								<div className="clip-job-actions">
									{job.canResume && (
										<button type="button" className="btn" disabled={busy} onClick={() => changeJob('transfers.resume', job.id)}>
											Resume
										</button>
									)}
									{(job.state === 'running' || job.state === 'queued') && (
										<button type="button" className="btn" disabled={busy} onClick={() => changeJob('transfers.cancel', job.id)}>
											Cancel
										</button>
									)}
									{(job.state === 'done' || job.state === 'cancelled' || job.state === 'paused') && (
										<button type="button" className="btn" disabled={busy} onClick={() => changeJob('transfers.dismiss', job.id)}>
											Dismiss
										</button>
									)}
								</div>
							</div>
						)
					})}
				</section>
			)}
			<FilterBar
				query={text}
				onQuery={setText}
				queryLabel="Find a clip"
				placeholder="Name, words, or machine"
				slotsLabel="Which clips"
				slots={[
					{id: 'all', label: 'All', pressed: type == null && status == null},
					{id: 'type', label: typeLabel(type), pressed: type != null},
					{id: 'status', label: statusLabel(status), pressed: status != null},
				]}
				onSlot={(id) => {
					if (id === 'all') {
						setType(null)
						setStatus(null)
						return
					}
					if (id === 'type') setType(nextType(type))
					else setStatus(nextStatus(status))
				}}
			/>
			{readings && here && !book.data?.damaged && (
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="activity" color="var(--peach)" label="Clip the readings" sub="A snapshot of this machine, kept in the book." onClick={() => (haptic(6), clipReadings())} />
				</div>
			)}
			<section className="clip-list">
				<div className="section-head">
					<h2>{filtering && shown.length > 0 && shown.length !== clips.length ? `${shown.length} of ${clips.length} shown` : 'Clip book'}</h2>
				</div>
				{selected.size > 0 && (
					<div className="clip-select-pin">
						<div className="clip-select" role="region" aria-label="Selected clips">
							<p className="clip-select-count">{selected.size === 1 ? '1 selected' : `${selected.size} selected`}</p>
							{selection.problem && <p className="clip-select-note">{selection.problem}</p>}
							<div className="clip-select-actions">
								<button type="button" className="btn" onClick={() => setSelected(new Set())}>
									Clear
								</button>
								<button type="button" className="btn danger" disabled={busy} onClick={() => void removeSelected()}>
									Delete
								</button>
								<button type="button" className="btn primary" disabled={busy || !!selection.problem || selection.targets.length === 0} onClick={() => beginSend(chosen)}>
									{sendLabel}
								</button>
							</div>
						</div>
					</div>
				)}
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{book.isPending && <p className="footer-note">Loading…</p>}
				{!book.isPending && clips.length === 0 && <p className="footer-note">Nothing clipped yet.</p>}
				{!book.isPending && clips.length > 0 && visible.length === 0 && <p className="footer-note">No clips match.</p>}
				{visible.map((clip) => {
					const row = asRow(clip)
					const mark = statusMark(row.availability)
					const on = selected.has(clip.id)
					const canRowSend = batchPlan([row], targets).targets.length > 0
					const color = clip.kind === 'image' ? 'var(--mauve)' : clip.kind === 'stats' ? 'var(--peach)' : 'var(--blue)'
					return (
						<div key={clip.id} className={`row static clip-row${on ? ' on' : ''}`}>
							<button type="button" className="clip-check" role="checkbox" aria-checked={on} aria-label={`Select ${clip.label}`} onClick={() => toggle(clip.id)}>
								<Icon name={on ? 'checked' : 'unchecked'} size={22} />
							</button>
							<button
								type="button"
								className="clip-open"
								onClick={() => {
									haptic(6)
									setAsk(null)
									setOpen(clip)
								}}
							>
								<span className="row-ico" style={{'--c': color} as CSSProperties}>
									<Icon name={clipIcon(row)} size={19} />
								</span>
								<span className="main">
									<b>
										{clipWord(row)} · {clip.label}
									</b>
									<span>
										{displayMachine(row.machine, serverName)} · {clip.preview} · {formatClipWhen(clip.at, now)}
									</span>
								</span>
								{mark ? <b className="clip-mark">{mark}</b> : null}
							</button>
							<span className="clip-actions">
								{canRowSend && (
									<button type="button" className="icon-btn" aria-label="Send" disabled={busy} onClick={() => beginSend([clip])}>
										<Icon name="share" size={18} />
									</button>
								)}
								<button
									type="button"
									className="icon-btn clip-delete"
									aria-label="Delete"
									disabled={busy}
									onClick={(event) => {
										const rect = event.currentTarget.getBoundingClientRect()
										setAsk({id: clip.id, top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right})
									}}
								>
									<Icon name="trash" size={18} />
								</button>
							</span>
						</div>
					)
				})}
				</div>
			</section>
			{asked && ask && <DeleteFlyout anchor={ask} busy={busy} onClose={() => setAsk(null)} onDelete={() => removeNow(asked)} />}
			<Sheet open={!!openClip} onClose={() => setOpen(null)} label={openClip?.label ?? 'Clip'} tall>
				{openClip && openRow && (
					<>
						<SheetHeader icon={<Icon name={clipIcon(openRow)} size={28} />} title={openClip.label} subtitle={`${clipWord(openRow)} · ${displayMachine(openRow.machine, serverName)} · ${formatClipWhen(openClip.at, now)}`} onClose={() => setOpen(null)} />
						{openRow.availability === 'missing' && <p className="footer-note">This content is gone.</p>}
						{openRow.availability === 'offline' && <p className="footer-note">That machine isn’t answering.</p>}
						{openClip.kind === 'image' && openRow.availability === 'available' && <img src={clipItemUrl(openClip.id)} alt="" style={{width: '100%', borderRadius: 12, margin: '8px 0'}} />}
						{(openClip.kind === 'text' || openClip.kind === 'stats') && <p className="footer-note">{openClip.preview}</p>}
						{clipPaths(openClip) && (
							<p className="footer-note">
								{clipWord(openRow) === 'Folder' ? 'Folder' : 'Path'} · {clipPaths(openClip)}
							</p>
						)}
						<div className="primary-row">
							<button className="btn primary" disabled={busy || copyPlan(openRow) === 'unavailable'} onClick={() => copyClip(openClip)}>
								Copy
							</button>
							{detailPlan && detailPlan.targets.length > 0 && (
								<button className="btn" disabled={busy} onClick={() => beginSend([openClip])}>
									{sendLabel}
								</button>
							)}
						</div>
						{detailPlan?.problem === CLIPBOARD_LIMIT && <p className="footer-note">Copy puts this on the device clipboard. This machine can’t take text on its own clipboard yet.</p>}
						{detailPlan?.problem && detailPlan.problem !== CLIPBOARD_LIMIT && openRow.availability === 'available' && <p className="footer-note">{detailPlan.problem}</p>}
						{folderClip && openRow.availability === 'available' && !detailPlan?.problem && (here ? here.scope !== 'server' : true) && (
							<p className="footer-note">{FOLDER_TO_COMPUTER}</p>
						)}
						<div className="stack" style={{marginTop: 8}}>
							<button className="btn block danger" disabled={busy} onClick={() => remove(openClip)}>
								Delete
							</button>
						</div>
					</>
				)}
			</Sheet>
			<Sheet open={!!send && !!sendTarget} onClose={() => setSend(null)} label={sendLabel}>
				{send && sendTarget && (
					<>
						<SheetHeader title={sendChoices.length > 1 && !here ? 'Send to…' : `Send to ${sendTarget.name}`} subtitle={sending.length === 1 ? sending[0]?.label : `${sending.length} clips`} onClose={() => setSend(null)} />
						<div className="stack">
							{sendChoices.length > 1 &&
								sendChoices.map((item) => (
									<button key={item.id} type="button" className="btn block" aria-pressed={item.id === sendTarget.id} onClick={() => setSend({...send, target: item.id, folder: folderFor(item, send.folder)})}>
										{item.name}
									</button>
								))}
							<Field label={sendTarget.scope === 'server' ? 'Folder on this server' : `Folder on ${sendTarget.name}`} value={send.folder} onChange={(e) => setSend({...send, folder: e.target.value})} placeholder={sendTarget.scope === 'server' ? '/Home' : 'Home'} />
							<button className="btn block" disabled={busy || (sendTarget.scope === 'server' ? !send.folder.startsWith('/') : false)} onClick={() => deliverFiles(send.ids, sendTarget, send.folder)}>
								Save into that folder
							</button>
						</div>
					</>
				)}
			</Sheet>
		</div>
	)
}
