import {useEffect, useRef, useState, type CSSProperties} from 'react'
import {NEEDS_APP_ADDRESSES, useAppTab} from './appTab'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {askApp, explainProbe, openApp, webStatus} from './openApp'
import {mutate, query, type UserApp} from './api'
import {appUrl, useAction, useBootstrap, useUser} from './data'
import {useDesktop} from './desktop/Desktop'
import {isOwner} from './isOwner'
import {Icon, type IconName} from './icons'
import {rovingKeyDown, TAB_SELECTOR} from './roving'
import {AppIcon, Group, KV, Row, Sheet, SheetHeader, StatusPill, Switch, appStatus, haptic, isAppBusy, useConfirm, useToast} from './ui'
import {nearBottom} from './logFollow'
import {DevicesPanel} from './usb'

type AppOidcStatus = {
	supported: boolean
	mode?: 'auto' | 'assisted'
	enabled: boolean
	note?: string
	issuerUrl?: string
	discoveryUrl?: string
	clientId?: string | null
	clientSecret?: string | null
	redirectUris?: string[]
}

type Props = {app: UserApp | null; update?: {version: string}; onClose: () => void; onOpenApp?: (app: UserApp) => void; onTerminal?: (app: {id: string; name?: string; icon?: string}) => void}
type A = {id: string; label: string; icon: IconName; onClick: () => void; disabled?: boolean}

export function AppSheet({app, update, onClose, onTerminal}: Props) {
	const desk = useDesktop()
	const boot = useBootstrap()
	const user = useUser()
	const qc = useQueryClient()
	const action = useAction()
	const confirm = useConfirm()
	const toast = useToast()
	const appTab = useAppTab()
	const owner = isOwner(user.data)
	const [logsOpen, setLogsOpen] = useState(false)
	const [tab, setTab] = useState<'overview' | 'usb'>('overview')
	const [waiting, setWaiting] = useState<number | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [showOidcCreds, setShowOidcCreds] = useState(false)
	const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
	useEffect(() => {
		setRevealedSecret(null)
	}, [app?.id])
	const waitCtrl = useRef<AbortController | null>(null)
	useEffect(() => () => waitCtrl.current?.abort(), [])
	useEffect(() => (waitCtrl.current?.abort(), setWaiting(null), setProblem(null)), [app?.id, app?.state])
	// "Running" only says its containers run. Whether its web page answers is asked separately.
	const web = useQuery({
		queryKey: ['apps.probe', app?.id],
		queryFn: () => askApp(app!),
		enabled: !!app && app.state === 'running' && !!app.port,
		refetchInterval: (q) => (q.state.data?.readiness === 'ready' ? 30_000 : 4000),
		retry: false,
	})
	const oidcStatus = useQuery({
		queryKey: ['apps.oidcStatus', app?.id],
		queryFn: () => query<AppOidcStatus>('apps.oidcStatus', {appId: app!.id}),
		enabled: !!app && owner && !app.system && app.state !== 'installing',
		retry: false,
	})
	const setOidc = useMutation({
		mutationFn: (enabled: boolean) =>
			mutate<AppOidcStatus>('apps.setOidc', {
				appId: app!.id,
				enabled,
				...(enabled && !oidcStatus.data?.issuerUrl ? {issuerUrl: location.origin} : {}),
			}),
		onSuccess: (res) => {
			toast(res.enabled ? 'Sign in with My Own Data Center enabled' : 'Sign in with My Own Data Center disabled')
			setRevealedSecret(res.enabled ? (res.clientSecret ?? null) : null)
			if (res.enabled && res.mode === 'assisted') setShowOidcCreds(true)
			qc.invalidateQueries({queryKey: ['apps.oidcStatus', app?.id]})
			qc.invalidateQueries({queryKey: ['apps.list']})
			qc.invalidateQueries({queryKey: ['oidc.clients']})
			qc.invalidateQueries({queryKey: ['oidc.status']})
		},
		onError: (e: Error) => toast(e.message, true),
	})
	useEffect(() => setLogsOpen(false), [app?.id])
	useEffect(() => setTab('overview'), [app?.id])
	useEffect(() => setShowOidcCreds(false), [app?.id])
	const copyOidc = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text)
			toast(`${label} copied`)
		} catch {
			toast(`Couldn’t copy ${label.toLowerCase()}`, true)
		}
	}

	if (!app) return null
	const status = appStatus(app.state, !!update)
	const busy = isAppBusy(app.state) || action.isPending
	const stopped = app.state === 'stopped'
	const url = appUrl(app, boot.server!.host)
	const name = app.name ?? app.id

	const run = (path: string, optimisticState: UserApp['state'], done: string) => {
		haptic(10)
		action.mutate({path, input: {appId: app.id}, optimistic: {appId: app.id, state: optimisticState}, done})
	}
	const open = () => {
		if (!url) return
		haptic(6)
		if (desk) {
			onClose()
			desk.launch(app)
			return
		}
		// Inside My Own Data Center, full screen, once it answers (see openApp). The back button, on screen
		// or the browser's own, returns here.
		const ctrl = new AbortController()
		waitCtrl.current?.abort()
		waitCtrl.current = ctrl
		setProblem(null)
		openApp(app, url, {signal: ctrl.signal, onWaiting: (s) => setWaiting(s)})
			.then((r) => {
				if (waitCtrl.current !== ctrl || r.opened || ctrl.signal.aborted) return
				setProblem(explainProbe(name, r.probe) ?? `${name} didn’t answer in time.`)
			})
			.finally(() => waitCtrl.current === ctrl && setWaiting(null))
	}
	const copy = async () => {
		if (!url) return
		// The address that works from here: the app's own address behind a proxy (see appTab.ts).
		const where = await appTab.address(app).catch((e: Error) => (toast(e.message, true), null))
		if (!where) {
			if (appTab.access === 'none') toast(NEEDS_APP_ADDRESSES, true)
			return
		}
		try {
			await navigator.clipboard.writeText(where)
			toast('Address copied')
		} catch {
			toast(where)
		}
	}

	const all: Record<string, A> = {
		open: {id: 'open', label: waiting !== null ? `Starting… ${waiting}s` : 'Open', icon: 'open', onClick: open, disabled: !url || stopped || waiting !== null},
		start: {id: 'start', label: 'Start', icon: 'play', onClick: () => run('apps.start', 'starting', `${name} started`)},
		stop: {id: 'stop', label: 'Stop', icon: 'stop', onClick: () => run('apps.stop', 'stopping', `${name} stopped`)},
		restart: {id: 'restart', label: 'Restart', icon: 'restart', onClick: () => run('apps.restart', 'restarting', `${name} restarted`), disabled: stopped},
		update: {id: 'update', label: `Update to ${update?.version}`, icon: 'update', onClick: () => run('apps.update', 'updating', `${name} updated to ${update?.version}`)},
		logs: {id: 'logs', label: 'Logs', icon: 'logs', onClick: () => setLogsOpen(true)},
		copy: {id: 'copy', label: 'Copy link', icon: 'link', onClick: copy, disabled: !url},
		shell: {id: 'shell', label: 'Terminal', icon: 'terminal', onClick: () => onTerminal?.({id: app.id, name, icon: app.icon}), disabled: stopped},
	}
	const primary = stopped ? all.start : update ? all.update : all.open
	const tiles = stopped
		? [all.logs, all.copy]
		: update
			? [all.open, all.restart, all.stop, all.logs]
			: [all.restart, all.stop, all.logs, ...(onTerminal && !app.system ? [all.shell] : [all.copy])]

	const uninstall = async () => {
		const ok = await confirm({
			title: `Uninstall ${name}?`,
			body: `${name} and all of its data will be permanently removed from your server. This can’t be undone.`,
			confirm: `Uninstall ${name}`,
			danger: true,
			icon: 'trash',
		})
		if (ok) {
			run('apps.uninstall', 'uninstalling', `${name} uninstalled`)
			onClose()
		}
	}

	const creds = app.credentials
	const rows: [string, React.ReactNode][] = []
	if (creds?.defaultUsername) rows.push(['Username', creds.defaultUsername])
	if (creds?.defaultPassword) rows.push([creds.label || 'Password', creds.defaultPassword])
	if (app.apiPort) rows.push(['Job API', `${boot.server!.host}:${app.apiPort}`])
	rows.push(['Version', update ? `${app.version} → ${update.version}` : (app.version ?? '–')])
	const webNow = app.state === 'running' ? webStatus(web.data) : null
	if (webNow) rows.push(['Web page', <span key="web" style={{color: webNow.tone === 'bad' ? 'var(--red)' : webNow.tone === 'wait' ? 'var(--yellow)' : undefined}}>{webNow.label}</span>])
	if (url) rows.push(['Address', <a key="addr" href={url} style={{color: 'var(--accent-text)'}}>{new URL(url).host}</a>])

	return (
		<>
			<Sheet
				open={!logsOpen}
				onClose={() => {
					waitCtrl.current?.abort()
					setWaiting(null)
					onClose()
				}}
				label={`${name} actions`}
			>
				{problem && waiting === null && (
					<div className="glass card open-problem" role="alert">
						<span>{problem}</span>
						<div className="open-problem-actions">
							<button className="btn small" onClick={open}>
								Try again
							</button>
							{url && (
								<a className="btn small" href={url}>
									Open anyway
								</a>
							)}
						</div>
					</div>
				)}
				{waiting !== null && (
					<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, borderRadius: 16}}>
						<span className="spinner" />
						<span style={{fontSize: 14.5}}>{name} is still starting. It opens as soon as it answers.</span>
					</div>
				)}
				<SheetHeader
					icon={<AppIcon src={app.icon} name={name} size={64} dim={stopped} progress={isAppBusy(app.state) ? (app.progress || 'spin') : undefined} />}
					title={name}
					subtitle={
						<>
							<StatusPill {...status} />
							{isAppBusy(app.state) && app.progress ? <span className="num">{app.progress}%</span> : null}
						</>
					}
					onClose={onClose}
				/>
				<div className="mx-tabs" role="tablist" aria-label={`${name} sections`} onKeyDown={(e) => rovingKeyDown(e, TAB_SELECTOR, 'horizontal')}>
					<button type="button" role="tab" aria-selected={tab === 'overview'} tabIndex={tab === 'overview' ? 0 : -1} className={`chip${tab === 'overview' ? ' on' : ''}`} onClick={() => (haptic(5), setTab('overview'))}>
						Overview
					</button>
					<button type="button" role="tab" aria-selected={tab === 'usb'} tabIndex={tab === 'usb' ? 0 : -1} className={`chip${tab === 'usb' ? ' on' : ''}`} onClick={() => (haptic(5), setTab('usb'))}>
						<Icon name="usb" size={15} />
						Devices
					</button>
				</div>
				{tab === 'usb' ? (
					<DevicesPanel guest={{kind: 'app', id: app.id, name}} />
				) : (
				<>
				{app.error && (
					<div className="error" role="alert" style={{marginBottom: 14, display: 'block'}}>
						<div style={{display: 'flex', gap: 8, alignItems: 'flex-start'}}>
							<Icon name="alert" size={18} />
							<span style={{wordBreak: 'break-word'}}>{app.error}</span>
						</div>
						<button
							className="btn small"
							style={{marginTop: 10}}
							disabled={busy}
							onClick={() => (haptic(10), action.mutate({path: 'apps.install', input: {appId: app.id}, optimistic: {appId: app.id, state: 'installing'}, done: `${name} installed`}))}
						>
							<Icon name="restart" size={16} /> Try again
						</button>
					</div>
				)}
				<div className="primary-row">
					<button className="btn primary" onClick={primary.onClick} disabled={primary.disabled || busy}>
						{busy ? <span className="spinner" /> : <Icon name={primary.icon} size={20} />}
						{busy ? `${app.state === 'ready' ? 'Working' : (app.state ?? 'Working').replace(/^\w/, (c) => c.toUpperCase())}…` : primary.label}
					</button>
				</div>
				<div className="actions" style={{gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`}}>
					{tiles.map((a) => (
						<button key={a.id} className="action" onClick={a.onClick} disabled={a.disabled || (busy && a.id !== 'logs' && a.id !== 'copy' && a.id !== 'shell')}>
							<Icon name={a.icon} size={22} />
							{a.label}
						</button>
					))}
				</div>
				<KV rows={rows} />
				{owner && oidcStatus.data?.supported && (
					<Group
						title="Single Sign-On (OIDC)"
						footer={oidcStatus.data.enabled && oidcStatus.data.note ? oidcStatus.data.note : undefined}
					>
						<Row
							icon="key"
							color="var(--accent)"
							label="Sign in with My Own Data Center"
							sub={
								oidcStatus.data.enabled
									? oidcStatus.data.mode === 'auto'
										? 'Active · configured automatically'
										: 'Active · paste credentials into app settings'
									: oidcStatus.data.mode === 'auto'
										? 'Automatically configure OIDC SSO'
										: 'Pre-register an OIDC client for this app'
							}
							trailing={
								<Switch
									on={oidcStatus.data.enabled}
									disabled={busy || setOidc.isPending}
									label="Sign in with My Own Data Center"
									onChange={(on) => {
										void (async () => {
											if (on) {
												const ok = await confirm({
													title: `Let ${name} use your accounts?`,
													body: 'People will sign into this app with accounts on this server, including two-factor. Only turn this on for an app you trust with those sign-ins.',
													confirm: 'Share sign-in',
													danger: true,
													icon: 'key',
												})
												if (!ok) return
											}
											setOidc.mutate(on)
										})()
									}}
								/>
							}
						/>
						{oidcStatus.data.enabled && oidcStatus.data.clientId && (
							<>
								{oidcStatus.data.mode === 'auto' && !showOidcCreds ? (
									<div className="row static">
										<button type="button" className="btn small" onClick={() => setShowOidcCreds(true)}>
											Show OIDC details
										</button>
									</div>
								) : (
									<>
										{oidcStatus.data.issuerUrl && (
											<Row
												icon="link"
												color="var(--blue)"
												label="Issuer URL"
												sub={oidcStatus.data.issuerUrl}
												trailing={
													<button type="button" className="btn small" onClick={() => copyOidc(oidcStatus.data!.issuerUrl!, 'Issuer URL')}>
														Copy
													</button>
												}
											/>
										)}
										{oidcStatus.data.discoveryUrl && (
											<Row
												icon="networking"
												color="var(--teal)"
												label="Discovery URL"
												sub={oidcStatus.data.discoveryUrl}
												trailing={
													<button type="button" className="btn small" onClick={() => copyOidc(oidcStatus.data!.discoveryUrl!, 'Discovery URL')}>
														Copy
													</button>
												}
											/>
										)}
										<Row
											icon="key"
											color="var(--green)"
											label="Client ID"
											sub={oidcStatus.data.clientId}
											trailing={
												<button type="button" className="btn small" onClick={() => copyOidc(oidcStatus.data!.clientId!, 'Client ID')}>
													Copy
												</button>
											}
										/>
										{revealedSecret && (
											<Row
												icon="shield"
												color={'var(--orange, #f59e0b)' as CSSProperties['color']}
												label="Client Secret (shown once)"
												sub={revealedSecret}
												trailing={
													<button type="button" className="btn small" onClick={() => copyOidc(revealedSecret, 'Client secret')}>
														Copy
													</button>
												}
											/>
										)}
									</>
								)}
							</>
						)}
					</Group>
				)}
				<button className="btn danger block" onClick={uninstall} disabled={busy}>
					<Icon name="trash" size={19} />
					Uninstall
				</button>
				</>
				)}
			</Sheet>
			{logsOpen && <LogsSheet appId={app.id} name={name} icon={app.icon} onClose={() => setLogsOpen(false)} />}
		</>
	)
}

function LogsSheet({appId, name, icon, onClose}: {appId: string; name: string; icon?: string; onClose: () => void}) {
	const logs = useQuery({
		queryKey: ['apps.logs', appId],
		queryFn: () => query<string>('apps.logs', {appId, maxOutputBytes: 200_000}),
		refetchInterval: 5000,
	})
	const [el, setEl] = useState<HTMLPreElement | null>(null)
	const stick = useRef(true)
	useEffect(() => {
		if (el && stick.current) el.scrollTop = el.scrollHeight
	}, [el, logs.data])
	return (
		<Sheet open onClose={onClose} label={`${name} logs`} tall>
			<SheetHeader
				icon={<AppIcon src={icon} name={name} size={44} />}
				title="Logs"
				subtitle={
					<>
						<span className="dot live" /> {name} · live
					</>
				}
				onClose={onClose}
			/>
			<pre
				className="logs"
				ref={setEl}
				onScroll={(e) => {
					stick.current = nearBottom(e.currentTarget)
				}}
			>
				{logs.isLoading ? 'Loading…' : logs.error ? (logs.error as Error).message : logs.data?.trim() || 'No log output yet.'}
			</pre>
		</Sheet>
	)
}
