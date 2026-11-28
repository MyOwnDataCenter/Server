// This server's backups: apps, settings, and folders, encrypted locally before upload to Google Drive or a NAS.
// Opened from this server on the Machines page.
import {useEffect, useMemo, useState, type CSSProperties, type FormEvent} from 'react'
import {backupGapText, computerSheetChanged, computerSnapshotRows, folderListError, formatBackupHour, formatBackupStamp, formatBackupWhen, gdriveSignInFinished, historyRowTone, serverLastRun} from './backupHelpers'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from './api'
import {agoText} from './plural'
import {queryProblem, useBrowserOnline} from './connection'
import {errorText} from './queryNotice'
import {Icon} from './icons'
import {Field, Group, Row, Segmented, Sheet, SheetHeader, Switch, bytes, haptic, useConfirm, useToast} from './ui'

type Nas = {host: string; port?: number; share: string; folder: string; username: string; domain?: string; hasPassword?: boolean}
type GdriveQuota = {limit: number | null; usage: number; usageInDrive: number; usageInDriveTrash: number}
type GdriveStatus = {
	connected: boolean
	enabled: boolean
	mode: 'direct' | 'mirror'
	folderName: string
	folderId: string | null
	email: string
	displayName: string
	packSizeMiB: number
	quota: GdriveQuota | null
	quotaPausedUntil: number
	hasClientId: boolean
	hasClientSecret: boolean
	scope: string
}
type Schedule = {frequency: 'off' | 'daily' | 'weekly'; hour: number; weekday: number}
type Keep = {daily: number; weekly: number; monthly: number}
type Include = {apps: boolean; settings: boolean; machineBackups: boolean}
type RunItem = {kind: string; id?: string; name: string; ok: boolean; error?: string; warning?: string; added?: number; skipped?: string[]; unreadable?: boolean; files?: number}
type Run = {
	id: string
	computer?: string
	name?: string
	reason: string
	startedAt: number
	endedAt: number | null
	ok: boolean
	error: string | null
	items: RunItem[]
	added: number
	nas: {ok: boolean; error?: string; uploaded?: number; uploadedBytes?: number} | null
	gdrive?: {ok: boolean; mode?: string; quotaPaused?: boolean; error?: string; uploaded?: number; uploadedBytes?: number; removed?: number} | null
}
export type BackupStatus = {
	configured: boolean
	nas: Nas | null
	gdrive?: GdriveStatus
	repo: string
	include: Include
	customPaths?: string[]
	pauseApps: boolean
	schedule: Schedule
	keep: Keep
	keySaved: boolean
	running: {step: string; progress: number; startedAt: number} | null
	nextRunAt: number | null
	timeZone?: string
	last?: Run | null
	history: Run[]
}
type Snapshot = {id: string; shortId: string; time: number; tags: string[]; paths: string[]; size: number | null}
type Computer = {
	id: string
	name: string
	online: boolean
	allowed: boolean
	on: boolean
	enabled: boolean
	removed?: boolean
	folders: string[]
	schedule: Schedule
	running: {step: string; progress: number; startedAt: number} | null
	last: {at: number; ok: boolean; error: string | null; added: number; skipped?: string[]; unreadable?: boolean; files?: number} | null
	nextRunAt: number | null
	lastRestore: {at: number; ok: boolean; folder?: string; error?: string} | null
}
type Found = {host: string; name: string; address?: string}
type Share = {name: string; comment: string}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ago = (t: number) => agoText((Date.now() - t) / 1000)

function useStatus() {
	const q = useQuery({queryKey: ['backups.status'], queryFn: () => query<BackupStatus>('backups.status'), retry: false, refetchInterval: (s) => (s.state.data?.running ? 1500 : 20_000)})
	return q
}

function useSave() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string}) => mutate(a.path, a.input),
		onSuccess: (_, a) => a.done && toast(a.done),
		onError: (e: Error) => toast(e.message, true),
		onSettled: () => {
			qc.invalidateQueries({queryKey: ['backups.status']})
			qc.invalidateQueries({queryKey: ['backups.snapshots']})
		},
	})
}

export function BackupsPage({onBack}: {onBack?: () => void}) {
	const status = useStatus()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(status, browserOnline)
	const save = useSave()
	const confirm = useConfirm()
	const toast = useToast()
	const [setup, setSetup] = useState<'new' | 'nas' | null>(null)
	const [gdriveSheet, setGdriveSheet] = useState<'setup' | 'config' | null>(null)
	const [connect, setConnect] = useState(false)
	const [key, setKey] = useState<string | null>(null)
	const [restore, setRestore] = useState<string | null>(null)
	const [computer, setComputer] = useState<string | null>(null)
	const [customDraft, setCustomDraft] = useState('')
	const s = status.data
	const comps = useQuery({
		queryKey: ['backups.computers'],
		queryFn: () => query<Computer[]>('backups.computers'),
		enabled: !!s?.configured,
		retry: false,
		refetchInterval: (q) => (q.state.data?.some((c) => c.running) ? 1500 : 20_000),
	})
	const snaps = useQuery({queryKey: ['backups.snapshots'], queryFn: () => query<Snapshot[]>('backups.snapshots'), enabled: !!s?.configured, retry: false, staleTime: 30_000})
	// Refresh the list of backups when a run finishes.
	const running = !!s?.running
	const qc = useQueryClient()
	useEffect(() => {
		if (!running) qc.invalidateQueries({queryKey: ['backups.snapshots']})
	}, [running, qc])

	const showKey = async () => {
		try {
			const r = await mutate<{recoveryKey: string}>('backups.recoveryKey')
			setKey(r.recoveryKey)
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const set = (input: Record<string, unknown>, done?: string) => save.mutate({path: 'backups.configure', input, done})

	const appsBacked = useMemo(() => {
		const byApp = new Map<string, Snapshot[]>()
		for (const sn of snaps.data ?? []) for (const t of sn.tags) if (t.startsWith('app:')) byApp.set(t.slice(4), [...(byApp.get(t.slice(4)) ?? []), sn])
		return byApp
	}, [snaps.data])
	const names = useMemo(() => {
		const m = new Map<string, string>()
		for (const r of [...(s?.last ? [s.last] : []), ...(s?.history ?? [])]) for (const i of r.items) if (i.kind === 'app' && i.id) m.set(i.id, i.name)
		return m
	}, [s?.history, s?.last])

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				{onBack && (
					<button className="round-btn" aria-label="Back" onClick={onBack}>
						<Icon name="back" size={20} />
					</button>
				)}
				<h1 className="title" style={{flex: 1}}>
					Backups
				</h1>
			</div>

			{status.isLoading && (
				<div className="glass group">
					<div className="row static">
						<span className="spinner" />
					</div>
				</div>
			)}
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}

			{s && !s.configured && (
				<div className="glass empty bk-hero">
					<span className="big">
						<Icon name="shield" size={30} />
					</span>
					<b>Encrypted backups to Google Drive or your NAS</b>
					<p className="muted" style={{margin: '0 0 6px', fontSize: 14.5, lineHeight: 1.45}}>
						Every file is encrypted locally with AES-256 before it leaves this server. Stream up to 30 TB straight to Google Drive with zero duplicate local disk, or copy to a local NAS.
					</p>
					<div className="bk-hero-actions">
						<button className="btn primary" onClick={() => (haptic(6), setGdriveSheet('setup'))}>
							<Icon name="upload" size={17} /> Connect Google Drive
						</button>
						<button className="btn" onClick={() => (haptic(6), setSetup('new'))}>
							<Icon name="server" size={17} /> Set up NAS backup
						</button>
					</div>
					<button className="btn ghost small" onClick={() => setConnect(true)}>
						Restore from an existing backup
					</button>
				</div>
			)}

			{s?.configured && (
				<>
					<StatusCard s={s} busy={save.isPending} onRun={() => save.mutate({path: 'backups.runNow', done: 'Backup started'})} />

					{!s.keySaved && (
						<button className="glass bk-key-warn" onClick={showKey}>
							<Icon name="key" size={20} />
							<span>
								<b>Save your recovery key</b>
								<span>Without it, your encrypted backups can’t be opened if this server is lost.</span>
							</span>
							<Icon name="chevron" size={18} className="chev" />
						</button>
					)}

					<GdriveGroup
						s={s}
						onConfigure={() => setGdriveSheet(s.gdrive?.connected ? 'config' : 'setup')}
					/>

					<Group title="Local NAS">
						{s.nas ? (
							<Row icon="server" color="var(--teal)" label={s.nas.host} sub={`${s.nas.share} › ${s.nas.folder}`} onClick={() => setSetup('nas')} />
						) : (
							<Row icon="server" color="#8e8e93" label="Add a local NAS (3-2-1 backup)" sub="Optional second copy over SMB on your network" onClick={() => setSetup('new')} />
						)}
					</Group>

					<Group title="What’s backed up" footer={s.include.apps && s.pauseApps ? 'Each app pauses for a moment while its files are saved, so databases are saved in a consistent state.' : undefined}>
						<Row icon="apps" color="var(--accent)" label="Apps" sub="Every installed app’s data" trailing={<Switch label="Apps" on={s.include.apps} disabled={save.isPending} onChange={(v) => set({include: {...s.include, apps: v}})} />} />
						{s.include.apps && <Row icon="stop" color="#8e8e93" label="Pause apps while saving" trailing={<Switch label="Pause apps while saving" on={s.pauseApps} disabled={save.isPending} onChange={(v) => set({pauseApps: v})} />} />}
						<Row icon="settings" color="#8e8e93" label="Server settings" sub="Accounts, settings, certificates, VM settings" trailing={<Switch label="Server settings" on={s.include.settings} disabled={save.isPending} onChange={(v) => set({include: {...s.include, settings: v}})} />} />
						<Row icon="machine" color="var(--orange, #f59e0b)" label="VM backups" sub="Home › Backups › Machines" trailing={<Switch label="VM backups" on={s.include.machineBackups} disabled={save.isPending} onChange={(v) => set({include: {...s.include, machineBackups: v}})} />} />
						{(s.customPaths ?? []).map((vp) => (
							<div className="row static" key={vp}>
								<span className="row-ico" style={{'--c': 'var(--teal)'} as CSSProperties}>
									<Icon name="folder" size={18} />
								</span>
								<span className="main">
									<b>{vp}</b>
									<span>Encrypted folder backup</span>
								</span>
								<button
									type="button"
									className="btn ghost small"
									disabled={save.isPending}
									aria-label={`Remove ${vp}`}
									onClick={() => set({customPaths: (s.customPaths ?? []).filter((p) => p !== vp)}, 'Folder removed')}
								>
									<Icon name="trash" size={15} />
								</button>
							</div>
						))}
						<div className="row static">
							<form
								className="bk-custom-add"
								onSubmit={(e) => {
									e.preventDefault()
									const next = customDraft.trim()
									if (!next) return
									set({customPaths: [...(s.customPaths ?? []), next]}, 'Folder added to backup')
									setCustomDraft('')
								}}
							>
								<input
									className="field"
									placeholder="Add folder to back up (e.g. /Pools/Media or /Home/Documents)"
									value={customDraft}
									onChange={(e) => setCustomDraft(e.target.value)}
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
								/>
								<button type="submit" className="btn small" disabled={!customDraft.trim() || save.isPending}>
									<Icon name="plus" size={15} /> Add
								</button>
							</form>
						</div>
					</Group>

					<ScheduleGroup s={s} busy={save.isPending} onChange={set} />

					<Group title="Computers" footer="Computers in Machines › Local swarm back up the folders you choose here, encrypted, then everything goes to the NAS. A computer that’s off at backup time catches up when it’s back.">
						{(comps.data ?? []).filter((c) => !c.removed).map((c) => (
							<ComputerRow key={c.id} c={c} onOpen={() => setComputer(c.id)} />
						))}
						{comps.error && !comps.data && (
							<div className="row static">
								<span className="main">
									<span className="bk-err" role="alert">
										Couldn’t list the computers: {errorText(comps.error)}
									</span>
								</span>
							</div>
						)}
						{comps.isSuccess && (comps.data ?? []).filter((c) => !c.removed).length === 0 && (
							<div className="row static">
								<span className="main">
									<span>No computers yet. Add one in Machines › Local swarm with Backups switched on.</span>
								</span>
							</div>
						)}
					</Group>

					{(comps.data ?? []).some((c) => c.removed) && (
						<Group title="Removed computers" footer="These computers aren’t in your swarm anymore. You can still restore a backup onto this server, or delete the backups. The NAS copy is removed the next time backups are copied there.">
							{(comps.data ?? []).filter((c) => c.removed).map((c) => (
								<ComputerRow key={c.id} c={c} onOpen={() => setComputer(c.id)} />
							))}
						</Group>
					)}

					<Group title="Restore" footer="Restoring puts an app back the way it was in that backup. Its current data is replaced.">
						{snaps.isLoading && (
							<div className="row static">
								<span className="spinner" />
							</div>
						)}
						{snaps.error && appsBacked.size === 0 && (
							<div className="row static">
								<span className="main">
									<span className="bk-err" role="alert">
										Couldn’t list the app backups: {errorText(snaps.error)}
									</span>
								</span>
							</div>
						)}
						{snaps.isSuccess && appsBacked.size === 0 && (
							<div className="row static">
								<span className="main">
									<span>No app backups yet.</span>
								</span>
							</div>
						)}
						{[...appsBacked].map(([id, list]) => (
							<Row key={id} icon="restore" color="var(--accent)" label={names.get(id) ?? id} sub={`${list.length} backup${list.length === 1 ? '' : 's'} · latest ${ago(list[0].time)}`} onClick={() => setRestore(id)} />
						))}
					</Group>

					{s.history.length > 0 && (
						<Group title="History">
							{s.history.slice(0, 8).map((r) => (
								<HistoryRow key={r.id} r={r} timeZone={s.timeZone} />
							))}
						</Group>
					)}

					<Group title="Recovery">
						<Row icon="key" color="var(--yellow, #eab308)" label="Recovery key" sub="Opens these backups on a new server" onClick={showKey} />
					</Group>
				</>
			)}

			{setup && s && (
				<SetupSheet
					mode={setup}
					current={s}
					onClose={() => setSetup(null)}
					onDone={(k) => {
						setSetup(null)
						if (k) setKey(k)
					}}
				/>
			)}
			{gdriveSheet && s && (
				<GdriveSetupSheet
					current={s}
					onClose={() => setGdriveSheet(null)}
					onDone={(k) => {
						setGdriveSheet(null)
						if (k) setKey(k)
					}}
				/>
			)}
			{connect && <ConnectSheet current={s} onConnectGdrive={() => (setConnect(false), setGdriveSheet('setup'))} onClose={() => setConnect(false)} />}
			{computer && comps.data?.find((c) => c.id === computer) && <ComputerSheet c={comps.data.find((c) => c.id === computer)!} timeZone={s?.timeZone} onClose={() => setComputer(null)} />}
			{key && <KeySheet recoveryKey={key} saved={!!s?.keySaved} onClose={() => setKey(null)} />}
			{restore && (
				<RestoreSheet
					appId={restore}
					name={names.get(restore) ?? restore}
					list={appsBacked.get(restore) ?? []}
					timeZone={s?.timeZone}
					onClose={() => setRestore(null)}
					onRestore={async (sn) => {
						const ok = await confirm({
							title: `Restore ${names.get(restore) ?? restore}?`,
							body: `It goes back to how it was on ${formatBackupStamp(sn.time, s?.timeZone)}. Anything it saved since then is replaced. It stops while this happens.`,
							confirm: 'Restore',
							danger: true,
							icon: 'restore',
						})
						if (!ok) return
						setRestore(null)
						save.mutate({path: 'backups.restoreApp', input: {snapshotId: sn.id, appId: restore}, done: `${names.get(restore) ?? restore} restored`})
					}}
				/>
			)}
		</div>
	)
}

function StatusCard({s, busy, onRun}: {s: BackupStatus; busy: boolean; onRun: () => void}) {
	// This server's own runs (computers show in their own rows).
	const last = serverLastRun(s)
	return (
		<div className="glass card bk-status">
			{s.running ? (
				<>
					<div className="bk-status-line">
						<span className="spinner" />
						<b>{s.running.step}…</b>
					</div>
					<div className="bk-bar" role="progressbar" aria-valuenow={Math.round(s.running.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
						<span style={{width: `${Math.max(3, Math.round(s.running.progress * 100))}%`}} />
					</div>
				</>
			) : (
				<>
					<div className="bk-status-line">
						<span className="bk-dot" style={{'--c': !last ? '#8e8e93' : last.ok ? 'var(--green)' : 'var(--red)'} as CSSProperties}>
							<Icon name={!last ? 'clock' : last.ok ? 'check' : 'alert'} size={16} />
						</span>
						<b>{!last ? 'No backups yet' : last.ok ? `Backed up ${ago(last.endedAt!)}` : `Last backup ${ago(last.endedAt!)} had a problem`}</b>
					</div>
					{last && !last.ok && last.error && <p className="bk-err" role="alert">{last.error}</p>}
					<p className="muted bk-next">{s.nextRunAt ? `Next backup ${formatBackupWhen(s.nextRunAt, s.timeZone)}` : 'Scheduled backups are off'}</p>
				</>
			)}
			<button className="btn primary" disabled={!!s.running || busy} onClick={() => (haptic(8), onRun())}>
				<Icon name="history" size={17} /> Back up now
			</button>
		</div>
	)
}

function ScheduleGroup({s, busy, onChange}: {s: BackupStatus; busy: boolean; onChange: (input: Record<string, unknown>) => void}) {
	const sc = s.schedule
	// Each save sends the whole schedule or keep object. A second change before the first is saved would send the old values back.
	const put = (patch: Partial<Schedule>) => !busy && onChange({schedule: {...sc, ...patch}})
	const keep = (patch: Partial<Keep>) => !busy && onChange({keep: {...s.keep, ...patch}})
	return (
		<Group title="Schedule" footer={`Keeps the last ${s.keep.daily} days, ${s.keep.weekly} weeks and ${s.keep.monthly} months of backups. Older ones are removed from the server and the NAS.`}>
			<div className="row static bk-sched">
				<Segmented
					label="How often"
					value={sc.frequency}
					options={[
						{id: 'off', label: 'Off'},
						{id: 'daily', label: 'Daily'},
						{id: 'weekly', label: 'Weekly'},
					]}
					onChange={(v) => put({frequency: v})}
				/>
			</div>
			{sc.frequency !== 'off' && (
				<div className="row static bk-pick">
					{sc.frequency === 'weekly' && (
						<label>
							<span>Day</span>
							<select className="field" disabled={busy} value={sc.weekday} onChange={(e) => put({weekday: Number(e.target.value)})}>
								{DAYS.map((d, i) => (
									<option key={d} value={i}>
										{d}
									</option>
								))}
							</select>
						</label>
					)}
					<label>
						<span>Time{s.timeZone ? ` (${s.timeZone})` : ''}</span>
						<select className="field" disabled={busy} value={sc.hour} onChange={(e) => put({hour: Number(e.target.value)})}>
							{Array.from({length: 24}, (_, h) => (
								<option key={h} value={h}>
									{formatBackupHour(h)}
								</option>
							))}
						</select>
					</label>
				</div>
			)}
			<div className="row static bk-pick">
				{(
					[
						['daily', 'Days', [3, 7, 14, 30]],
						['weekly', 'Weeks', [0, 4, 8, 12]],
						['monthly', 'Months', [0, 3, 6, 12, 24]],
					] as const
				).map(([k, label, opts]) => (
					<label key={k}>
						<span>{label}</span>
						<select className="field" disabled={busy} value={s.keep[k]} onChange={(e) => keep({[k]: Number(e.target.value)})}>
							{[...new Set([...opts, s.keep[k]])]
								.sort((a, b) => a - b)
								.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
						</select>
					</label>
				))}
			</div>
		</Group>
	)
}

function computerRowSub(c: Computer) {
	if (c.running) return `${c.running.step}… ${Math.round(c.running.progress * 100)}%`
	const gap = backupGapText(c.last)
	if (c.removed) return gap ? `Removed · ${gap}` : 'Removed from your swarm'
	if (!c.allowed) return 'Backups not allowed on it'
	if (!c.enabled) return 'Not backed up'
	if (c.last?.ok && gap) return `Backed up ${ago(c.last.at)} · ${gap}`
	if (c.last) return `${c.last.ok ? 'Backed up' : 'Problem'} ${ago(c.last.at)} · ${c.folders.join(', ')}`
	return `${c.folders.join(', ')} · ${c.online ? 'first backup soon' : 'offline'}`
}

function ComputerRow({c, onOpen}: {c: Computer; onOpen: () => void}) {
	const gap = !c.running && c.last?.ok ? backupGapText(c.last) : ''
	return (
		<Row
			icon={gap || c.removed ? 'alert' : 'devices'}
			color={gap || c.removed ? 'var(--orange, #f59e0b)' : c.enabled ? 'var(--green)' : '#8e8e93'}
			label={c.name}
			sub={computerRowSub(c)}
			onClick={onOpen}
		/>
	)
}

function HistoryRow({r, timeZone}: {r: Run; timeZone?: string}) {
	const [open, setOpen] = useState(false)
	const tone = historyRowTone(r)
	const gap = r.items.map((i) => backupGapText(i)).filter(Boolean).join(' · ')
	const gdrivePart = r.gdrive?.uploaded
		? ` · ${r.gdrive.uploaded} file${r.gdrive.uploaded === 1 ? '' : 's'}${r.gdrive.uploadedBytes ? ` (${bytes(r.gdrive.uploadedBytes, 1, 1024)})` : ''} to Google Drive`
		: r.gdrive?.quotaPaused
			? ' · paused for Google 750 GB daily cap'
			: ''
	const sub = tone === 'running'
		? 'Running'
		: tone === 'warn'
			? gap
			: tone === 'ok'
				? `${bytes(r.added, 1, 1024)} new${r.nas?.uploaded ? ` · ${r.nas.uploaded} file${r.nas.uploaded === 1 ? '' : 's'} to the NAS` : ''}${gdrivePart}`
				: (r.error ?? 'Failed')
	return (
		<>
			<Row
				icon={tone === 'running' ? 'clock' : tone === 'ok' ? 'check' : 'alert'}
				color={tone === 'running' ? '#8e8e93' : tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--orange, #f59e0b)' : 'var(--red)'}
				label={`${r.computer ? r.name : 'This server'} · ${formatBackupStamp(r.startedAt, timeZone)}${r.reason === 'scheduled' ? '' : ' · by hand'}`}
				sub={sub}
				onClick={r.items.length ? () => setOpen(!open) : undefined}
				expanded={r.items.length ? open : undefined}
			/>
			{open &&
				r.items.map((i, n) => {
					const itemGap = backupGapText(i)
					return (
					<div className="row static bk-item" key={n}>
						<Icon name={!i.ok || itemGap ? 'alert' : 'check'} size={15} />
						<span className="main">
							<span>
								{i.name}
								{i.ok ? ` · ${bytes(i.added ?? 0, 1, 1024)} new${itemGap ? ` · ${itemGap}` : i.warning ? ` · ${i.warning}` : ''}` : ` · ${i.error}`}
							</span>
						</span>
					</div>
					)
				})}
		</>
	)
}

// Connect (or change) the NAS. A new setup ends by showing the recovery key.
function SetupSheet({mode, current, onClose, onDone}: {mode: 'new' | 'nas'; current: BackupStatus; onClose: () => void; onDone: (key?: string) => void}) {
	const toast = useToast()
	const qc = useQueryClient()
	const found = useQuery({queryKey: ['backups.discover'], queryFn: () => query<Found[]>('backups.discover'), retry: false, staleTime: 60_000})
	const [host, setHost] = useState(current.nas ? `${current.nas.host}${current.nas.port ? `:${current.nas.port}` : ''}` : '')
	const [username, setUsername] = useState(current.nas?.username ?? '')
	const [password, setPassword] = useState('')
	const [shares, setShares] = useState<Share[] | null>(null)
	const [share, setShare] = useState(current.nas?.share ?? '')
	const [folder, setFolder] = useState(current.nas?.folder ?? 'Omarchy Server')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const reuse = !!current.nas?.hasPassword && current.nas.host === host.split(':')[0] && current.nas.username === username

	const findShares = async (e?: FormEvent) => {
		e?.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const list = await mutate<Share[]>('backups.shares', {host, username, ...(password ? {password} : {})})
			setShares(list)
			if (!list.some((x) => x.name === share)) setShare(list[0]?.name ?? '')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	const finish = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const r = await mutate<BackupStatus & {recoveryKey?: string}>('backups.configure', {nas: {host, username, share, folder, ...(password ? {password} : {})}})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast(mode === 'new' ? 'Backups are on' : 'NAS updated')
			onDone(r.recoveryKey)
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Connect your NAS" tall>
			<SheetHeader title={mode === 'new' ? 'Connect your NAS' : 'NAS'} subtitle="Any NAS or computer that shares folders over SMB (Windows file sharing): Synology, QNAP, TrueNAS, Unraid, a Windows PC." onClose={onClose} />
			{!shares ? (
				<form onSubmit={findShares}>
					{(found.data?.length ?? 0) > 0 && (
						<div className="bk-found">
							<span className="muted">Found on your network</span>
							<div>
								{found.data!.map((f) => (
									<button type="button" key={f.host} className={`chip${host === f.host ? ' on' : ''}`} aria-pressed={host === f.host} onClick={() => (haptic(5), setHost(f.host))}>
										<Icon name="server" size={14} /> {f.name}
									</button>
								))}
							</div>
						</div>
					)}
					<Field id="bk-host" label="NAS name or address" placeholder="nas.local or 192.168.1.20" value={host} onChange={(e) => setHost(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
					<Field id="bk-user" label="Username" hint="An account on the NAS that can write to the share. A separate account just for backups is safest." value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoComplete="off" required />
					<Field id="bk-pass" label="Password" type="password" placeholder={reuse ? 'Saved (leave empty to keep it)' : ''} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required={!reuse} />
					{error && (
						<div className="error" role="alert">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy || !host || !username || (!password && !reuse)} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						Connect
					</button>
				</form>
			) : (
				<form onSubmit={finish}>
					<div className="section-head">
						<h2>Share</h2>
					</div>
					{shares.length === 0 ? (
						<p className="muted">This account can’t see any shared folders on {host}. Create one on the NAS, then try again.</p>
					) : (
						<div className="glass group" style={{marginBottom: 14}} role="radiogroup" aria-label="Share">
							{shares.map((x) => (
								<button type="button" key={x.name} className="row" role="radio" aria-checked={share === x.name} onClick={() => (haptic(5), setShare(x.name))} style={{minHeight: 52}}>
									<span className="row-ico" style={{'--c': 'var(--teal)'} as CSSProperties}>
										<Icon name="folder" size={18} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>{x.name}</b>
										{x.comment && <span>{x.comment}</span>}
									</span>
									{share === x.name && <Icon name="check" size={18} />}
								</button>
							))}
						</div>
					)}
					<Field id="bk-folder" label="Folder on the share" hint="Created if it isn’t there. Use a folder only these backups go in." value={folder} onChange={(e) => setFolder(e.target.value)} required />
					{error && (
						<div className="error" role="alert">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy || !share || !folder.trim()} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						{mode === 'new' ? 'Turn on backups' : 'Save'}
					</button>
					<button type="button" className="btn block ghost" onClick={() => setShares(null)} style={{marginTop: 8}}>
						Back
					</button>
					{mode === 'new' && (
						<p className="muted" style={{fontSize: 13, marginTop: 10}}>
							Backs up apps and server settings every night at {formatBackupHour(current.schedule.hour)}
							{current.timeZone ? ` (${current.timeZone})` : ''}. You can change this next.
						</p>
					)}
				</form>
			)}
		</Sheet>
	)
}

function KeySheet({recoveryKey, saved, onClose}: {recoveryKey: string; saved: boolean; onClose: () => void}) {
	const toast = useToast()
	const qc = useQueryClient()
	const [ok, setOk] = useState(saved)
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(recoveryKey)
			toast('Recovery key copied')
		} catch {
			toast('Couldn’t copy. Select the key and copy it.', true)
		}
	}
	const download = () => {
		const text = `My Own Data Center backup recovery key\n\n${recoveryKey}\n\nYou need this key to open your backups on a new server (open this server from Machines, then Backups › Restore from an existing backup).\nKeep it somewhere safe, away from the server: a password manager, or printed.\n`
		const url = URL.createObjectURL(new Blob([text], {type: 'text/plain'}))
		const a = Object.assign(document.createElement('a'), {href: url, download: 'modc-recovery-key.txt'})
		a.click()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
	}
	const done = async () => {
		if (ok && !saved) {
			await mutate('backups.keySaved').catch(() => {})
			qc.invalidateQueries({queryKey: ['backups.status']})
		}
		onClose()
	}
	return (
		<Sheet open onClose={done} label="Recovery key">
			<SheetHeader title="Your recovery key" subtitle="Your backups are encrypted with this key. If this server is ever lost, you need it to get them back. Nobody else has a copy." onClose={done} />
			<div className="glass bk-keybox" aria-label={`Recovery key: ${recoveryKey}`}>
				{recoveryKey.split('-').map((g, i) => (
					<span key={i}>{g}</span>
				))}
			</div>
			<div style={{display: 'flex', gap: 8, margin: '12px 0'}}>
				<button className="btn" style={{flex: 1}} onClick={copy}>
					<Icon name="copy" size={16} /> Copy
				</button>
				<button className="btn" style={{flex: 1}} onClick={download}>
					<Icon name="download" size={16} /> Save as file
				</button>
			</div>
			{!saved && (
				<label className="bk-check">
					<input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
					<span>I’ve saved it somewhere safe, away from this server (a password manager, or printed).</span>
				</label>
			)}
			<button className="btn block primary" disabled={!ok} onClick={done} style={{marginTop: 8}}>
				Done
			</button>
		</Sheet>
	)
}

function RestoreSheet({name, list, timeZone, onClose, onRestore}: {appId: string; name: string; list: Snapshot[]; timeZone?: string; onClose: () => void; onRestore: (s: Snapshot) => void}) {
	return (
		<Sheet open onClose={onClose} label={`Restore ${name}`}>
			<SheetHeader title={`Restore ${name}`} subtitle="Choose the backup to go back to." onClose={onClose} />
			<div className="glass group">
				{list.map((sn, i) => (
					<div className="row static" key={sn.id} style={{minHeight: 56}}>
						<span className="main">
							<b style={{fontWeight: 550}}>{formatBackupStamp(sn.time, timeZone)}</b>
							<span>
								{i === 0 ? 'Latest · ' : ''}
								{ago(sn.time)}
								{sn.size ? ` · ${bytes(sn.size, 1, 1024)}` : ''}
							</span>
						</span>
						<button className="btn small" onClick={() => onRestore(sn)}>
							Restore
						</button>
					</div>
				))}
			</div>
		</Sheet>
	)
}

// A new or rebuilt server: open existing encrypted backups on Google Drive or a NAS with the recovery key.
function ConnectSheet({current, onConnectGdrive, onClose}: {current?: BackupStatus; onConnectGdrive: () => void; onClose: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const [source, setSource] = useState<'gdrive' | 'nas'>('gdrive')
	const [gFolder, setGFolder] = useState(current?.gdrive?.folderName ?? 'My Own Data Center Backups')
	const [gKey, setGKey] = useState('')
	const [f, setF] = useState({host: '', username: '', password: '', share: '', folder: 'Omarchy Server', recoveryKey: ''})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const put = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({...f, [k]: e.target.value})
	const goNas = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const {recoveryKey, ...nas} = f
			await mutate('backups.connectExisting', {nas, recoveryKey})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Backups connected')
			onClose()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	const goGdrive = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await mutate('backups.gdrive.connectExisting', {folderName: gFolder, recoveryKey: gKey})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Google Drive backups connected')
			onClose()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Restore from an existing backup" tall>
			<SheetHeader title="Use an existing backup" subtitle="Open your encrypted backups on a new or rebuilt server using your recovery key." onClose={onClose} />
			<div style={{marginBottom: 14}}>
				<Segmented
					label="Backup source"
					value={source}
					options={[
						{id: 'gdrive', label: 'Google Drive'},
						{id: 'nas', label: 'Local NAS'},
					]}
					onChange={(v) => {
						setError(null)
						setSource(v)
					}}
				/>
			</div>
			{source === 'gdrive' ? (
				current?.gdrive?.connected ? (
					<form onSubmit={goGdrive}>
						<p className="muted" style={{fontSize: 13.5, marginTop: 0}}>
							Signed in as <b>{current.gdrive.email || 'Google Drive'}</b>. Enter the backup folder name and your 32-character recovery key to decrypt and browse snapshots directly from Drive.
						</p>
						<Field id="bkcg-folder" label="Google Drive folder" value={gFolder} onChange={(e) => setGFolder(e.target.value)} required />
						<Field id="bkcg-key" label="Recovery key" placeholder="abcd-efgh-…" value={gKey} onChange={(e) => setGKey(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
						{error && (
							<div className="error" role="alert">
								<Icon name="alert" size={18} />
								{error}
							</div>
						)}
						<button className="btn block primary" disabled={busy || !gKey.trim()} style={{marginTop: 6}}>
							{busy && <span className="spinner" />}
							Unlock Google Drive backup
						</button>
					</form>
				) : (
					<div>
						<p className="muted" style={{fontSize: 14, lineHeight: 1.45, marginTop: 0}}>
							Sign in to your Google Drive account first so My Own Data Center can find your encrypted backup folder.
						</p>
						<button className="btn block primary" onClick={onConnectGdrive}>
							<Icon name="upload" size={17} /> Connect Google Drive first
						</button>
					</div>
				)
			) : (
				<form onSubmit={goNas}>
					<Field id="bkc-host" label="NAS name or address" value={f.host} onChange={put('host')} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
					<Field id="bkc-user" label="Username" value={f.username} onChange={put('username')} autoCapitalize="off" autoComplete="off" required />
					<Field id="bkc-pass" label="Password" type="password" value={f.password} onChange={put('password')} autoComplete="new-password" required />
					<Field id="bkc-share" label="Share" value={f.share} onChange={put('share')} autoCapitalize="off" required />
					<Field id="bkc-folder" label="Folder on the share" value={f.folder} onChange={put('folder')} required />
					<Field id="bkc-key" label="Recovery key" placeholder="abcd-efgh-…" value={f.recoveryKey} onChange={put('recoveryKey')} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
					{error && (
						<div className="error" role="alert">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						Connect
					</button>
				</form>
			)}
		</Sheet>
	)
}

function GdriveGroup({s, onConfigure}: {s: BackupStatus; onConfigure: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const [busy, setBusy] = useState<'test' | 'quota' | 'disconnect' | null>(null)
	const g = s.gdrive
	const paused = !!(g?.quotaPausedUntil && g.quotaPausedUntil > Date.now())
	const pct = g?.quota?.limit ? Math.min(100, Math.round((g.quota.usage / g.quota.limit) * 100)) : null

	const runTest = async () => {
		setBusy('test')
		try {
			await mutate('backups.gdrive.test')
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Google Drive connection verified')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(null)
		}
	}
	const refreshQuota = async () => {
		setBusy('quota')
		try {
			await query('backups.gdrive.status', {refresh: true})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Google Drive quota updated')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(null)
		}
	}
	const disconnect = async () => {
		const ok = await confirm({
			title: 'Disconnect Google Drive?',
			body: 'This removes the Google Drive token from this server. Your encrypted backup files already on Google Drive stay untouched.',
			confirm: 'Disconnect',
			danger: true,
			icon: 'trash',
		})
		if (!ok) return
		setBusy('disconnect')
		try {
			await mutate('backups.gdrive.disconnect')
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Google Drive disconnected')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(null)
		}
	}

	return (
		<Group
			title="Google Drive (Encrypted)"
			footer={
				g?.connected
					? 'Encrypted locally with AES-256 before upload. Scoped strictly to its own Drive folder (drive.file): My Own Data Center never sees your other Drive files. Save your OAuth Client ID alongside your recovery key for disaster recovery.'
					: 'Client-side AES-256 encrypted backups supporting up to 30 TB Google Drive storage with zero duplicate local disk.'
			}
		>
			{g?.connected ? (
				<>
					<Row
						icon="shield"
						color={g.enabled ? 'var(--green)' : '#8e8e93'}
						label={g.email || 'Google Drive'}
						sub={`${g.folderName} · ${g.mode === 'direct' && !s.nas ? 'Direct to Drive (0 local duplicate)' : '3-2-1 off-site mirror'} · ${g.packSizeMiB} MiB packs · AES-256`}
						onClick={onConfigure}
					/>
					{g.quota && (
						<div className="row static">
							<div className="bk-quota">
								<div className="bk-quota-head">
									<span>Storage used</span>
									<b>
										{bytes(g.quota.usage, 1, 1000)}
										{g.quota.limit ? ` / ${bytes(g.quota.limit, 1, 1000)} (${pct}%)` : ' (unlimited)'}
									</b>
								</div>
								{pct != null && (
									<div className="bk-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
										<span style={{width: `${Math.max(2, pct)}%`}} />
									</div>
								)}
							</div>
						</div>
					)}
					{paused && (
						<div className="row static">
							<span className="row-ico" style={{'--c': 'var(--orange, #f59e0b)'} as CSSProperties}>
								<Icon name="clock" size={18} />
							</span>
							<span className="main">
								<b>Paused for Google’s 750 GB daily upload limit</b>
								<span>Uploads resume automatically {formatBackupWhen(g.quotaPausedUntil, s.timeZone)}. Already uploaded packs are safe.</span>
							</span>
						</div>
					)}
					<div className="row static">
						<div className="bk-gdrive-actions">
							<button type="button" className="btn small" disabled={busy !== null} onClick={runTest}>
								{busy === 'test' && <span className="spinner" />}
								Test connection
							</button>
							<button type="button" className="btn small" disabled={busy !== null} onClick={refreshQuota}>
								{busy === 'quota' && <span className="spinner" />}
								Refresh quota
							</button>
							<button type="button" className="btn small" disabled={busy !== null} onClick={onConfigure}>
								Settings
							</button>
							<button type="button" className="btn ghost small" disabled={busy !== null} onClick={disconnect}>
								Disconnect
							</button>
						</div>
					</div>
				</>
			) : (
				<Row icon="upload" color="var(--accent)" label="Connect Google Drive (30 TB encrypted)" sub="Zero-knowledge AES-256 encryption before upload" onClick={onConfigure} />
			)}
		</Group>
	)
}

function GdriveSetupSheet({current, onClose, onDone}: {current: BackupStatus; onClose: () => void; onDone: (key?: string) => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const g = current.gdrive
	const [connected, setConnected] = useState(!!g?.connected)
	const [email, setEmail] = useState(g?.email ?? '')
	const [quota, setQuota] = useState<GdriveQuota | null>(g?.quota ?? null)
	const [redirectKind, setRedirectKind] = useState<'web' | 'loopback'>(() =>
		typeof window !== 'undefined' && /^https:\/\//.test(window.location.origin) && !/^https:\/\/\d+\.\d+\.\d+\.\d+/.test(window.location.origin) ? 'web' : 'loopback',
	)
	const redirectUri =
		redirectKind === 'web' && typeof window !== 'undefined' ? `${window.location.origin}/api/backups/gdrive/callback` : 'http://127.0.0.1'
	const [clientId, setClientId] = useState('')
	const [clientSecret, setClientSecret] = useState('')
	const [folderName, setFolderName] = useState(g?.folderName ?? 'My Own Data Center Backups')
	const [authUrl, setAuthUrl] = useState<string | null>(null)
	const [authState, setAuthState] = useState('')
	const [codeInput, setCodeInput] = useState('')
	const [mode, setMode] = useState<'direct' | 'mirror'>(g?.mode ?? (current.nas ? 'mirror' : 'direct'))
	const [packSizeMiB, setPackSizeMiB] = useState(g?.packSizeMiB ?? 64)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// If the user completes OAuth in the popup/tab via /api/backups/gdrive/callback, auto-advance when they focus back.
	useEffect(() => {
		if (!authUrl || connected) return
		const check = async () => {
			try {
				const st = await query<GdriveStatus>('backups.gdrive.status')
				if (gdriveSignInFinished(st, {connected: !!g?.connected, email: g?.email})) {
					setConnected(true)
					setEmail(st.email)
					setQuota(st.quota)
					setAuthUrl(null)
					qc.invalidateQueries({queryKey: ['backups.status']})
				}
			} catch {}
		}
		const onFocus = () => void check()
		window.addEventListener('focus', onFocus)
		const id = window.setInterval(check, 2500)
		return () => {
			window.removeEventListener('focus', onFocus)
			window.clearInterval(id)
		}
	}, [authUrl, connected, qc, g?.connected, g?.email])

	const copyUri = async () => {
		try {
			await navigator.clipboard.writeText(redirectUri)
			toast('Redirect URI copied')
		} catch {
			toast('Couldn’t copy URI', true)
		}
	}

	const startAuth = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const r = await mutate<{authUrl: string; state: string}>('backups.gdrive.authStart', {
				...(clientId.trim() ? {clientId: clientId.trim()} : {}),
				...(clientSecret.trim() ? {clientSecret: clientSecret.trim()} : {}),
				redirectUri,
				folderName: folderName.trim() || 'My Own Data Center Backups',
			})
			setAuthUrl(r.authUrl)
			setAuthState(r.state)
			window.open(r.authUrl, '_blank', 'noopener,noreferrer')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const finishAuth = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const st = await mutate<GdriveStatus>('backups.gdrive.authFinish', {code: codeInput.trim(), state: authState})
			setConnected(true)
			setEmail(st.email)
			setQuota(st.quota)
			setAuthUrl(null)
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Google Drive signed in')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const saveConfig = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const r = await mutate<BackupStatus & {recoveryKey?: string}>('backups.gdrive.configure', {
				enabled: true,
				mode: current.nas ? 'mirror' : mode,
				folderName: folderName.trim() || 'My Own Data Center Backups',
				packSizeMiB,
			})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Encrypted Google Drive backups enabled')
			onDone(r.recoveryKey)
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet open onClose={onClose} label="Google Drive encrypted backups" tall>
			<SheetHeader
				title={connected ? 'Google Drive Backup Settings' : 'Connect Google Drive'}
				subtitle={
					connected
						? `Signed in as ${email || 'Google Drive'}${quota?.limit ? ` · ${bytes(quota.limit - quota.usage, 1, 1000)} free of ${bytes(quota.limit, 1, 1000)}` : ''}. All files are AES-256 encrypted locally before upload.`
						: 'Zero-knowledge encrypted backups straight into your Google Drive (up to 30 TB). My Own Data Center only requests drive.file access to its own backup folder.'
				}
				onClose={onClose}
			/>

			{!connected ? (
				<>
					<div style={{marginBottom: 12}}>
						<Segmented
							label="OAuth client type"
							value={redirectKind}
							options={[
								{id: 'loopback', label: 'Desktop / LAN IP'},
								{id: 'web', label: 'Web HTTPS domain'},
							]}
							onChange={setRedirectKind}
						/>
					</div>
					<div className="glass group bk-oauth-steps" style={{marginBottom: 14}}>
						<a className="row" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">
							<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
								<Icon name="open" size={16} />
							</span>
							<span className="main">
								<b>1. Enable the Google Drive API</b>
								<span>Select or create a Google Cloud project and click Enable</span>
							</span>
							<Icon name="arrow" size={16} className="chev" />
						</a>
						<a className="row" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener noreferrer">
							<span className="row-ico" style={{'--c': 'var(--teal)'} as CSSProperties}>
								<Icon name="user" size={16} />
							</span>
							<span className="main">
								<b>2. Add yourself as a Test User</b>
								<span>Configure OAuth consent (External) and add your Gmail under Test users</span>
							</span>
							<Icon name="arrow" size={16} className="chev" />
						</a>
						<a className="row" href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener noreferrer">
							<span className="row-ico" style={{'--c': 'var(--green)'} as CSSProperties}>
								<Icon name="key" size={16} />
							</span>
							<span className="main">
								<b>3. Create OAuth Client ID ({redirectKind === 'loopback' ? 'Desktop app' : 'Web application'})</b>
								<span>
									{redirectKind === 'loopback'
										? 'Copy the Client ID & Client Secret below, then paste the http://127.0.0.1/?code=… URL after signing in'
										: 'Add the Authorized redirect URI below, then paste your Client ID & Client Secret'}
								</span>
							</span>
							<Icon name="arrow" size={16} className="chev" />
						</a>
					</div>
					{redirectKind === 'web' && (
						<div className="bk-uri-box">
							<code>{redirectUri}</code>
							<button type="button" className="btn small" onClick={copyUri}>
								<Icon name="copy" size={14} /> Copy
							</button>
						</div>
					)}
					<form onSubmit={startAuth}>
						<Field
							id="gd-cid"
							label="Google OAuth Client ID"
							placeholder={g?.hasClientId ? 'Saved (leave empty to keep it)' : '1234567890-xxxx.apps.googleusercontent.com'}
							value={clientId}
							onChange={(e) => setClientId(e.target.value)}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							required={!g?.hasClientId}
						/>
						<Field
							id="gd-csec"
							label="Client Secret"
							type="password"
							hint="Copy the full GOCSPX-… secret from the same OAuth Client ID page (click the copy icon in Google Cloud Console)."
							placeholder={g?.hasClientSecret && !clientId.trim() ? 'Saved (leave empty to keep it)' : 'GOCSPX-…'}
							value={clientSecret}
							onChange={(e) => setClientSecret(e.target.value)}
							autoComplete="new-password"
							required={redirectKind === 'web' && (!g?.hasClientSecret || !!clientId.trim())}
						/>
						<Field
							id="gd-folder"
							label="Google Drive folder name"
							hint="Created automatically at the root of your Google Drive."
							value={folderName}
							onChange={(e) => setFolderName(e.target.value)}
							required
						/>
						{!authUrl && error && (
							<div className="error" role="alert">
								<Icon name="alert" size={18} />
								{error}
							</div>
						)}
						<button className="btn block primary" disabled={busy || (!clientId.trim() && !g?.hasClientId)} style={{marginTop: 6}}>
							{busy && !authUrl && <span className="spinner" />}
							{authUrl ? 'Re-open Google sign-in' : 'Continue to Google sign-in'}
						</button>
					</form>

					{authUrl && (
						<form onSubmit={finishAuth} style={{marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line-2)'}}>
							<Field
								id="gd-code"
								label="Paste callback URL or authorization code"
								hint={
									redirectKind === 'web'
										? 'If the sign-in tab redirects automatically, this window advances on its own. Otherwise paste the full URL here.'
										: 'After approving access, your browser will jump to http://127.0.0.1/?code=…, then paste that entire address bar URL here.'
								}
								placeholder="http://127.0.0.1/?state=…&code=4/0A…"
								value={codeInput}
								onChange={(e) => setCodeInput(e.target.value)}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								required
							/>
							{error && (
								<div className="error" role="alert">
									<Icon name="alert" size={18} />
									{error}
								</div>
							)}
							<button className="btn block primary" disabled={busy || !codeInput.trim()}>
								{busy && <span className="spinner" />}
								Complete Google sign-in
							</button>
						</form>
					)}
				</>
			) : (
				<form onSubmit={saveConfig}>
					{!current.nas && (
						<div style={{marginBottom: 14}}>
							<div className="section-head">
								<h2>Storage mode</h2>
							</div>
							<Segmented
								label="Storage mode"
								value={mode}
								options={[
									{id: 'direct', label: 'Direct to Drive (0 local disk)'},
									{id: 'mirror', label: '3-2-1 Local + Drive'},
								]}
								onChange={setMode}
							/>
							<p className="muted" style={{fontSize: 13, lineHeight: 1.45, marginTop: 8}}>
								{mode === 'direct'
									? 'Streams AES-256 encrypted restic packs directly into Google Drive without duplicating multi-TB data on your local drives.'
									: 'Keeps a fast local encrypted repository on this server and mirrors it off-site to Google Drive.'}
							</p>
						</div>
					)}
					<Field id="gd-cfg-folder" label="Google Drive folder" value={folderName} onChange={(e) => setFolderName(e.target.value)} required />
					<div className="row static bk-pick" style={{padding: '4px 0 12px'}}>
						<label>
							<span>Encrypted pack size (larger is faster for multi-TB backups)</span>
							<select className="field" value={packSizeMiB} onChange={(e) => setPackSizeMiB(Number(e.target.value))}>
								<option value={16}>16 MiB (small backups)</option>
								<option value={32}>32 MiB (balanced)</option>
								<option value={64}>64 MiB (recommended for 30 TB)</option>
								<option value={128}>128 MiB (maximum throughput)</option>
							</select>
						</label>
					</div>
					{error && (
						<div className="error" role="alert">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						{g?.enabled ? 'Save Google Drive settings' : 'Enable encrypted Google Drive backups'}
					</button>
					<button type="button" className="btn block ghost" style={{marginTop: 8}} onClick={() => setConnected(false)}>
						Switch Google account
					</button>
				</form>
			)}
		</Sheet>
	)
}

function ComputerSheet({c, timeZone, onClose}: {c: Computer; timeZone?: string; onClose: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const folders = useQuery({
		queryKey: ['backups.computerFolders', c.id],
		queryFn: () => mutate<{home: string; folders: {name: string}[]}>('backups.computerFolders', {id: c.id}),
		enabled: c.on && c.online,
		retry: false,
		staleTime: 60_000,
	})
	const snaps = useQuery({queryKey: ['backups.computerSnapshots', c.id], queryFn: () => query<Snapshot[]>('backups.computerSnapshots', {id: c.id}), enabled: c.enabled || !!c.removed, retry: false})
	const [picked, setPicked] = useState<string[]>(c.folders)
	const [schedule, setSchedule] = useState<Schedule>(c.schedule)
	const [busy, setBusy] = useState(false)
	const refresh = () => {
		qc.invalidateQueries({queryKey: ['backups.computers']})
		qc.invalidateQueries({queryKey: ['backups.status']})
		qc.invalidateQueries({queryKey: ['backups.computerSnapshots', c.id]})
	}
	const act = async (path: string, input: unknown, done?: string) => {
		setBusy(true)
		try {
			await mutate(path, input)
			if (done) toast(done)
			refresh()
			return true
		} catch (e) {
			toast((e as Error).message, true)
			return false
		} finally {
			setBusy(false)
		}
	}
	const changed = computerSheetChanged(picked, c.folders, schedule, c.schedule)
	const toggle = (name: string) => setPicked(picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name])
	const shown = [...new Set([...(folders.data?.folders.map((f) => f.name) ?? []), ...c.folders])].sort((a, b) => a.localeCompare(b))
	return (
		<Sheet open onClose={onClose} label={`Back up ${c.name}`} tall>
			<SheetHeader title={c.name} subtitle={c.removed ? 'Removed from your swarm. Its backups are still here.' : c.online ? 'Online' : 'Offline. Backups run when it’s back.'} onClose={onClose} />
			{c.removed && (
				<p className="prose" style={{fontSize: 14.5}}>
					This computer isn’t in your swarm anymore. Restoring puts the files on this server, under Home › Restored. Nothing that’s on a computer is changed.
				</p>
			)}
			{!c.removed && !c.allowed ? (
				<p className="prose" style={{fontSize: 14.5}}>
					This computer joined without Backups allowed, and the server can’t switch that on by itself (the computer decides). In Machines › Local swarm, remove it and add it again with Backups switched on: it’s one command to paste on that computer.
				</p>
			) : !c.removed && !c.on ? (
				<p className="prose" style={{fontSize: 14.5}}>
					Backups are switched off for this computer in Machines › Local swarm. Switch them on there first.
				</p>
			) : (
				<>
					{!c.removed && c.running && (
						<div className="glass card bk-status">
							<div className="bk-status-line">
								<span className="spinner" />
								<b>{c.running.step}…</b>
							</div>
							<div className="bk-bar">
								<span style={{width: `${Math.max(3, Math.round(c.running.progress * 100))}%`}} />
							</div>
						</div>
					)}
					{c.lastRestore && (
						<p className={c.lastRestore.ok ? 'footer-note' : 'bk-err'} style={{textAlign: 'left', margin: '0 4px 12px'}}>
							{c.lastRestore.ok ? `Restored ${ago(c.lastRestore.at)} into ${c.lastRestore.folder}` : `Restore ${ago(c.lastRestore.at)} didn’t work: ${c.lastRestore.error}`}
						</p>
					)}
					{!c.removed && <div className="section-head">
						<h2>Folders to back up</h2>
					</div>}
					{!c.removed && <div className="glass group" style={{marginBottom: 6}}>
						{folders.isLoading && (
							<div className="row static">
								<span className="spinner" />
							</div>
						)}
						{folderListError(folders.error) && (
							<div className="row static">
								<span className="main">
									<span>{folderListError(folders.error)}</span>
								</span>
							</div>
						)}
						{shown.map((name) => (
							<button type="button" key={name} className="row" style={{minHeight: 50}} role="checkbox" aria-checked={picked.includes(name)} onClick={() => (haptic(5), toggle(name))}>
								<span className="row-ico" style={{'--c': picked.includes(name) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
									<Icon name={picked.includes(name) ? 'checked' : 'unchecked'} size={18} />
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>{name}</b>
								</span>
							</button>
						))}
					</div>}
					{!c.removed && <p className="footer-note" style={{textAlign: 'left', margin: '0 6px 14px'}}>
						Folders in {folders.data?.home ?? 'its home folder'}. Caches and trash inside them are skipped.
					</p>}
					{!c.removed && <div className="section-head">
						<h2>When</h2>
					</div>}
					{!c.removed && <div className="glass group" style={{marginBottom: 14}}>
						<div className="row static bk-sched">
							<Segmented
								label="How often"
								value={schedule.frequency}
								options={[
									{id: 'off', label: 'Off'},
									{id: 'daily', label: 'Daily'},
									{id: 'weekly', label: 'Weekly'},
								]}
								onChange={(v) => setSchedule({...schedule, frequency: v})}
							/>
						</div>
						{schedule.frequency !== 'off' && (
							<div className="row static bk-pick">
								{schedule.frequency === 'weekly' && (
									<label>
										<span>Day</span>
										<select className="field" value={schedule.weekday} onChange={(e) => setSchedule({...schedule, weekday: Number(e.target.value)})}>
											{DAYS.map((d, i) => (
												<option key={d} value={i}>
													{d}
												</option>
											))}
										</select>
									</label>
								)}
								<label>
									<span>Time{timeZone ? ` (${timeZone})` : ''}</span>
									<select className="field" value={schedule.hour} onChange={(e) => setSchedule({...schedule, hour: Number(e.target.value)})}>
										{Array.from({length: 24}, (_, h) => (
											<option key={h} value={h}>
												{formatBackupHour(h)}
											</option>
										))}
									</select>
								</label>
							</div>
						)}
					</div>}
					{!c.removed && (changed || !c.enabled) && (
						<button
							className="btn block primary"
							disabled={busy || !picked.length}
							onClick={() => act('backups.setComputer', {id: c.id, folders: picked, schedule, enabled: true}, c.enabled ? 'Saved' : `${c.name} will be backed up`)}
						>
							{busy && <span className="spinner" />}
							{c.enabled ? 'Save' : 'Back up this computer'}
						</button>
					)}
					{!c.removed && c.enabled && !changed && (
						<button className="btn block primary" disabled={busy || !!c.running || !c.online} onClick={() => act('backups.runComputer', {id: c.id}, 'Backup started')}>
							<Icon name="history" size={17} /> Back up now
						</button>
					)}
					{(c.enabled || c.removed) && snaps.error && computerSnapshotRows(snaps.data).length === 0 && (
						<p className="bk-err" role="alert">
							Couldn’t list the backups: {errorText(snaps.error)}
						</p>
					)}
					{(c.enabled || c.removed) && computerSnapshotRows(snaps.data).length > 0 && (
						<>
							<div className="section-head" style={{marginTop: 16}}>
								<h2>Backups</h2>
							</div>
							<div className="glass group">
								{computerSnapshotRows(snaps.data).map((sn, i) => (
									<div className="row static" key={sn.id} style={{minHeight: 56}}>
										<span className="main">
											<b style={{fontWeight: 550}}>{formatBackupStamp(sn.time, timeZone)}</b>
											<span>
												{i === 0 ? 'Latest · ' : ''}
												{sn.size ? bytes(sn.size, 1, 1024) : ago(sn.time)}
											</span>
										</span>
										<button
											className="btn small"
											disabled={busy || !!c.running || (!c.online && !c.removed)}
											onClick={async () => {
												const ok = await confirm({
													title: c.removed ? `Restore ${c.name}’s backup here?` : `Restore to ${c.name}?`,
													body: c.removed
														? `Its folders as they were on ${formatBackupStamp(sn.time, timeZone)} go into Home › Restored › ${c.name} on this server.`
														: `Its folders as they were on ${formatBackupStamp(sn.time, timeZone)} go into a new “Restored” folder in its home folder. Nothing that’s there now is changed.`,
													confirm: 'Restore',
													icon: 'restore',
												})
												if (ok) act('backups.restoreComputer', {id: c.id, snapshotId: sn.id}, 'Restoring…')
											}}
										>
											Restore
										</button>
									</div>
								))}
							</div>
						</>
					)}
					{c.enabled && !c.removed && (
						<button className="btn block ghost" style={{marginTop: 12}} disabled={busy} onClick={() => act('backups.setComputer', {id: c.id, enabled: false}, `${c.name} won’t be backed up any more`)}>
							Stop backing up this computer
						</button>
					)}
					{c.removed && (
						<button
							className="btn block ghost"
							style={{marginTop: 12}}
							disabled={busy}
							onClick={async () => {
								const ok = await confirm({
									title: `Delete ${c.name}’s backups?`,
									body: 'The backups kept on this server are deleted, including the key that opens them. The copy on the NAS is removed the next time backups are copied there.',
									confirm: 'Delete',
									danger: true,
									icon: 'trash',
								})
								if (ok && (await act('backups.setComputer', {id: c.id, remove: true}, `${c.name}’s backups were deleted`))) onClose()
							}}
						>
							Delete these backups
						</button>
					)}
				</>
			)}
		</Sheet>
	)
}

/** One computer's backup folders and schedule, opened from that computer's machine page. */
export function ComputerBackups({id, name, onClose}: {id: string; name: string; onClose: () => void}) {
	const status = useStatus()
	const comps = useQuery({
		queryKey: ['backups.computers'],
		queryFn: () => query<Computer[]>('backups.computers'),
		enabled: !!status.data?.configured,
		retry: false,
	})
	const computer = comps.data?.find((row) => row.id === id) ?? null
	if (computer && status.data) return <ComputerSheet c={computer} timeZone={status.data.timeZone} onClose={onClose} />
	const waiting = status.isLoading || (!!status.data?.configured && comps.isLoading)
	const body = waiting
		? null
		: !status.data?.configured
			? `Backups for ${name} copy its folders to this server’s NAS. Open this server and choose Backups to set that up.`
			: `${name} isn’t in Backups yet. If it joined without Backups allowed, remove it and add it again with Backups switched on.`
	return (
		<Sheet open onClose={onClose} label={`Back up ${name}`}>
			<SheetHeader title="Backups" subtitle={name} onClose={onClose} />
			{waiting ? (
				<div className="row static">
					<span className="spinner" />
				</div>
			) : (
				<p className="prose" style={{fontSize: 14.5}}>
					{body}
				</p>
			)}
		</Sheet>
	)
}
