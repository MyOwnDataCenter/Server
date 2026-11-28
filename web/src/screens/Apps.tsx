import {useMemo, useState, type CSSProperties} from 'react'

import type {UserApp} from '../api'
import {appVersionLine, joinedFields, searchNeedle} from '../storeBrowse'
import {queryProblem, useBrowserOnline} from '../connection'
import {useAction, useApps, useBootstrap, useUpdates} from '../data'
import {groupApps} from '../fleet/groupApps'
import {machineCountLabel} from '../fleet/installTargets'
import {PinButton} from '../fleet/PinButton'
import {Icon} from '../icons'
import {AppIcon, Segmented, StatusPill, StoreIcon, appStatus, haptic, isAppBusy, useConfirm} from '../ui'
import {plural} from '../plural'

type Filter = 'all' | 'running' | 'stopped' | 'updates'

export function SearchField({value, onChange, placeholder}: {value: string; onChange: (v: string) => void; placeholder: string}) {
	return (
		<label className="search glass">
			<Icon name="search" size={19} />
			<span className="sr-only">{placeholder}</span>
			<input type="search" enterKeyHint="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
			{value && (
				<button type="button" className="clear" aria-label="Clear search" onClick={() => onChange('')}>
					<Icon name="close" size={14} stroke={2.4} />
				</button>
			)}
		</label>
	)
}

export function Apps({onOpenApp, onStore}: {onOpenApp: (app: UserApp) => void; onStore?: () => void}) {
	const apps = useApps()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(apps, browserOnline)
	const updates = useUpdates()
	const action = useAction()
	const confirm = useConfirm()
	const [q, setQ] = useState('')
	const [filter, setFilter] = useState<Filter>('all')
	const [openId, setOpenId] = useState<string | null>(null)
	const boot = useBootstrap()
	const serverName = boot.server?.device || 'This server'
	const updateMap = useMemo(() => new Map((updates.data ?? []).map((u) => [u.id, u.version])), [updates.data])
	const list = apps.data ?? []

	const counts = {
		all: list.length,
		running: list.filter((a) => appStatus(a.state).kind === 'running').length,
		stopped: list.filter((a) => a.state === 'stopped').length,
		updates: list.filter((a) => updateMap.has(a.id)).length,
	}
	const needle = searchNeedle(q)
	const shown = list.filter((a) => {
		if (needle && !joinedFields([a.name, a.id]).toLowerCase().includes(needle)) return false
		if (filter === 'running') return appStatus(a.state).kind === 'running'
		if (filter === 'stopped') return a.state === 'stopped'
		if (filter === 'updates') return updateMap.has(a.id)
		return true
	})
	const groups = groupApps(shown.map((app) => ({appId: app.id, name: app.name ?? app.id, computerId: app.computerId || 'server', computerName: app.computerName || serverName})))

	const updateAll = async () => {
		const targets = list.filter((a) => updateMap.has(a.id))
		const ok = await confirm({
			title: `Update ${targets.length} apps?`,
			body: `${targets.map((a) => a.name).join(', ')} will update one after another. Each app restarts while it updates.`,
			confirm: 'Update all',
			icon: 'update',
		})
		if (!ok) return
		for (const app of targets) {
			await action
				.mutateAsync({path: 'apps.update', input: {appId: app.id}, optimistic: {appId: app.id, state: 'updating'}, done: `${app.name} updated`})
				.catch(() => {})
		}
	}

	const segments: {id: Filter; label: string; count?: number}[] = [
		{id: 'all', label: 'All', count: counts.all},
		{id: 'running', label: 'Running', count: counts.running},
		{id: 'stopped', label: 'Stopped', count: counts.stopped},
	]
	if (counts.updates) segments.push({id: 'updates', label: 'Updates', count: counts.updates})

	return (
		<div className="stagger">
			<div>
				<h1 className="title">Apps</h1>
				<p className="subtitle">
					{apps.isLoading ? 'Loading…' : problem && !apps.data ? 'Can’t reach your server' : `${counts.running} running${counts.stopped ? ` · ${counts.stopped} stopped` : ''}${counts.updates ? ` · ${counts.updates} to update` : ''}`}
				</p>
			</div>
			{onStore && (
				<div className="system-tiles">
					<button className="glass system-tile press" onClick={() => (haptic(6), onStore())}>
						<StoreIcon size={46} />
						<span>
							<b>App Store</b>
							<small>Find new apps</small>
						</span>
					</button>
				</div>
			)}
			<SearchField value={q} onChange={setQ} placeholder={`Search ${plural(list.length, 'app')}`} />
			<Segmented value={filter} options={segments} onChange={setFilter} label="Filter apps" />
			{filter === 'updates' && counts.updates > 1 && (
				<button className="btn primary block" style={{marginBottom: 14}} onClick={updateAll} disabled={action.isPending}>
					<Icon name="update" size={20} />
					Update all {counts.updates}
				</button>
			)}
			{apps.isLoading ? (
				<div className="glass group screen-list">
					{Array.from({length: 6}, (_, i) => (
						<div key={i} className="row static">
							<div className="skeleton" style={{width: 46, height: 46, borderRadius: 12}} />
							<div style={{flex: 1}}>
								<div className="skeleton" style={{width: '50%', height: 12, marginBottom: 8}} />
								<div className="skeleton" style={{width: '30%', height: 10}} />
							</div>
						</div>
					))}
				</div>
			) : problem && !apps.data ? (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			) : shown.length === 0 ? (
				<div className="glass empty">
					<span className="big">
						<Icon name={needle ? 'search' : filter === 'updates' ? 'check' : 'store'} size={30} />
					</span>
					<b>{needle ? 'No matches' : filter === 'updates' ? 'All up to date' : list.length === 0 ? 'No apps yet' : 'Nothing here'}</b>
					{needle && <span>No apps match “{q.trim()}”.</span>}
					{!needle && filter === 'all' && list.length === 0 && onStore && (
						<>
							<span>Find something to run on your machines.</span>
							<button
								type="button"
								className="btn primary"
								style={{marginTop: 12}}
								onClick={() => {
									haptic(6)
									onStore()
								}}
							>
								Find apps
							</button>
						</>
					)}
				</div>
			) : (
				<div className="glass group screen-list" style={{'--inset': '74px'} as CSSProperties}>
					{groups.map((group) => {
						const app = list.find((a) => a.id === group.appId)
						if (!app) return null
						const status = appStatus(app.state, updateMap.has(app.id))
						const busy = isAppBusy(app.state)
						const count = machineCountLabel(group.instances.length)
						const many = group.instances.length > 1
						return (
							<div key={group.appId} className="row" style={{position: 'relative'}}>
								<button
									type="button"
									onClick={() => {
										haptic(6)
										if (many) setOpenId((id) => (id === group.appId ? null : group.appId))
										else if (!app.remote && (app.computerId ?? 'server') === 'server') onOpenApp(app)
									}}
									style={{flex: 1, display: 'flex', alignItems: 'center', gap: 13, minWidth: 0, border: 0, background: 'none', padding: 0, color: 'inherit', textAlign: 'left'}}
								>
									<AppIcon src={app.icon} name={app.name ?? app.id} size={46} dim={app.state === 'stopped'} progress={busy ? app.progress || 'spin' : undefined} />
									<span className="main">
										<b>
											{app.name ?? app.id}
											{count && (
												<span className="count-machines" style={{marginLeft: 6, fontSize: 12}} aria-label={`On ${count} machines`}>
													{count}
												</span>
											)}
										</b>
										<span>{app.error ? app.error : appVersionLine(app, updateMap.has(app.id) ? updateMap.get(app.id) : undefined)}</span>
									</span>
									<StatusPill {...status} />
								</button>
								<PinButton pin={{kind: 'app', id: app.id, computer: 'server'}} name={app.name ?? app.id} mini />
								{many && openId === group.appId && (
									<div className="fleet-menu glass" role="menu" aria-label={group.name}>
										{group.instances.map((inst) => (
											<button
												key={inst.computerId}
												type="button"
												role="menuitem"
												onClick={() => {
													setOpenId(null)
													if (!app.remote && inst.computerId === 'server') onOpenApp(app)
												}}
											>
												{inst.computerName}
											</button>
										))}
									</div>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
