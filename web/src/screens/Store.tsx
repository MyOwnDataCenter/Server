import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {PluginBrowser} from './Plugins'

import {mutate, query, type RegistryApp, type UserApp} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {plural} from '../plural'
import {appUrl, useAction, useApps, useBootstrap, useMachines, useRegistry, useUser} from '../data'
import {isOwner} from '../isOwner'
import {computerInstallInput, confirmInstallTarget, guestInstallInput, installKindLabel, installTargets, installsOf, machineCountLabel, SERVER_INSTALL_ID, type InstallTarget} from '../fleet/installTargets'
import {type StoreBinding} from '../fleet/openStore'
import {isContainerAgent} from '../swarm/guestLink'
import {BeforeInstall} from '../beforeInstall'
import {CategoryChips} from '../CategoryChips'
import {useDesktop} from '../desktop/Desktop'
import {explainProbe, openApp} from '../openApp'
import {Icon, hasIcon} from '../icons'
import {rovingKeyDown, TAB_SELECTOR} from '../roving'
import {AppIcon, Sheet, SheetHeader, StatusPill, appStatus, bytes, haptic, isAppBusy, useToast} from '../ui'
import {SearchField} from './Apps'
import {remainingSuggestedStores, type StoreRepo} from '../storeSuggestions'
import {isClamped} from '../textClamp'
import {categoryOf, effectiveCategory, joinedFields, nextStartingToast, rankedCategories, searchNeedle, storeDisplayName, storeRiskHints, validCommunityStoreUrl} from '../storeBrowse'

type StoreApp = RegistryApp & {compatible?: boolean; repo?: string; unsupported?: string}

const CATEGORY_LABEL: Record<string, string> = {
	files: 'Files & Productivity',
	bitcoin: 'Bitcoin',
	finance: 'Finance',
	media: 'Media',
	networking: 'Networking',
	social: 'Social',
	automation: 'Home & Automation',
	ai: 'AI',
	developer: 'Developer Tools',
	crypto: 'Crypto',
	gaming: 'Gaming',
	photography: 'Photography',
}
const label = (c: string) => CATEGORY_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1)
const catIcon = (c: string) => (hasIcon(c) ? c : 'category')
// Shown first in "Featured" when present in the catalog; otherwise any app with screenshots.
const FEATURED = ['immich', 'nextcloud', 'home-assistant', 'jellyfin', 'plex', 'bitcoin', 'ollama', 'vaultwarden', 'pi-hole', 'tailscale']

function useStoreApp(app: StoreApp | null, opts?: {detail?: boolean}) {
	// Featured only needs gallery; the sheet always loads detail so permissions feed trust hints.
	const missing = !!app && (opts?.detail || !app.description || !Array.isArray(app.gallery) || !app.website)
	return useQuery({
		queryKey: ['appStore.app', app?.id],
		queryFn: () => query<RegistryApp>('appStore.app', {appId: app!.id}),
		enabled: missing,
		staleTime: 10 * 60_000,
	})
}

// The Omarchy plugins view (its own catalog, next to the app categories).
const PLUGINS = '::omarchy-plugins'

export function Store({onOpenInstalled, onBack, onTerminal, bound = null}: {onOpenInstalled: (app: UserApp) => void; onOpenApp?: (app: UserApp) => void; onBack?: () => void; onTerminal?: (input: string) => void; bound?: StoreBinding | null}) {
	const registry = useRegistry()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(registry, browserOnline)
	const apps = useApps()
	const user = useUser()
	const owner = isOwner(user.data)
	const [q, setQ] = useState('')
	const [category, setCategory] = useState('all')
	const [selected, setSelected] = useState<{app: StoreApp; install?: boolean} | null>(null)
	const [stores, setStores] = useState(false)
	// Which store's apps are shown: all of them together, or one store on its own.
	const [storeKey, setStoreKey] = useState('all')
	const qc = useQueryClient()
	const toast = useToast()
	// Stores are checked for new apps every hour; this checks now.
	const refresh = useMutation({
		mutationFn: () => mutate<number>('appStore.refresh'),
		onSuccess: async () => (await qc.invalidateQueries({queryKey: ['appStore.registry']}), toast('Up to date')),
		onError: (e) => toast((e as Error).message, true),
	})

	const storeList = useMemo(
		() => (registry.data ?? []).map((r) => ({key: r.url ?? r.meta.id, name: storeDisplayName(r.meta.name), count: r.apps.length})),
		[registry.data],
	)
	const oneStore = storeKey === 'all' ? null : (storeList.find((st) => st.key === storeKey) ?? null)
	const all = useMemo(() => {
		const seen = new Map<string, StoreApp>()
		for (const repo of registry.data ?? []) {
			if (storeKey !== 'all' && (repo.url ?? repo.meta.id) !== storeKey) continue
			for (const app of repo.apps) if (!seen.has(app.id)) seen.set(app.id, {...app, repo: storeDisplayName(repo.meta.name)})
		}
		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
	}, [registry.data, storeKey])
	const boot = useBootstrap()
	const machines = useMachines()
	const computers = useQuery({queryKey: ['swarm.list'], queryFn: () => query<{id: string; name: string; online: boolean; guestOf?: string; containerOf?: string}[]>('swarm.list')})
	const targets = useMemo(
		() =>
			installTargets({
				serverName: boot.server?.device || 'This server',
				// System containers are not App Store targets (no Podman on stock LXC images).
				computers: (computers.data ?? []).filter((a) => !a.guestOf && !isContainerAgent(a)).map(computerInstallInput),
				guests: (machines.data ?? []).map((m) => guestInstallInput({id: m.id, name: m.name, state: m.state, connector: (computers.data ?? []).some((a) => a.guestOf === m.id && a.online)})),
			}),
		[boot.server?.device, computers.data, machines.data],
	)
	const [browseTargetId, setBrowseTargetId] = useState<string>(SERVER_INSTALL_ID)
	useEffect(() => {
		if (bound) return
		if (!targets.some((t) => t.id === browseTargetId)) setBrowseTargetId(targets[0]?.id ?? SERVER_INSTALL_ID)
	}, [bound, targets, browseTargetId])
	const browseTarget = bound ? null : (targets.find((t) => t.id === browseTargetId) ?? targets[0] ?? null)
	// A store that's gone (removed) falls back to all of them.
	useEffect(() => {
		if (storeKey !== 'all' && registry.data && !storeList.some((st) => st.key === storeKey)) setStoreKey('all')
	}, [storeKey, storeList, registry.data])
	const categories = useMemo(() => rankedCategories(all), [all])
	const active = effectiveCategory(category, categories, [PLUGINS])
	const needle = searchNeedle(q)
	const featured = useMemo(() => {
		const withShots = all.filter((a) => a.shots || (a.gallery?.length ?? 0) > 0)
		const picked = FEATURED.map((id) => withShots.find((a) => a.id === id)).filter(Boolean) as StoreApp[]
		return (picked.length >= 3 ? picked : [...picked, ...withShots.filter((a) => !picked.includes(a))]).slice(0, 6)
	}, [all])
	const installed = useMemo(() => new Map((apps.data ?? []).map((a) => [a.id, a])), [apps.data])
	const installPlaces = useMemo(() => [{appIds: [...installed.keys()]}], [installed])

	const browsing = !needle && active === 'all'
	const shown = all
		.filter((a) => (active === 'all' || active === PLUGINS ? true : categoryOf(a.category) === active))
		.filter((a) => !needle || joinedFields([a.name, a.tagline, a.developer]).toLowerCase().includes(needle))

	const pick = (app: StoreApp, install = false) => {
		haptic(6)
		setSelected({app, install})
	}

	return (
		<div className="stagger">
			<div className="page-head store-head">
				{onBack && (
					<button className="round-btn" aria-label="Back" onClick={onBack}>
						<Icon name="back" size={20} />
					</button>
				)}
				<div className="store-heading">
					<h1 className="title">{bound ? `App Store for ${bound.name}` : 'App Store'}</h1>
					<p className="subtitle">{bound ? `Installs on ${bound.name}` : registry.isLoading ? 'Loading the catalog…' : problem && !registry.data ? 'Can’t reach your server' : oneStore ? `${plural(all.length, 'app')} in ${oneStore.name}` : `${plural(all.length, 'app')} from ${plural(storeList.length, 'store')}`}</p>
				</div>
				<button className="btn small stores-btn" style={{marginLeft: 'auto'}} aria-label="Check for new apps" title="Check for new apps" disabled={refresh.isPending} onClick={() => (haptic(5), refresh.mutate())}>
					{refresh.isPending ? <span className="spinner" /> : <Icon name="restart" size={17} />}
				</button>
				<button className="btn small stores-btn" aria-label="Community app stores" title="Community app stores" onClick={() => (haptic(5), setStores(true))}>
					<Icon name="store" size={17} />
					Stores
				</button>
			</div>
			{storeList.length > 1 && (
				<div className="chips store-picker" role="tablist" aria-label="App stores" onKeyDown={(e) => rovingKeyDown(e, TAB_SELECTOR, 'horizontal')}>
					{[{key: 'all', name: 'All stores', count: null as number | null}, ...storeList].map((st) => (
						<button
							key={st.key}
							role="tab"
							aria-selected={storeKey === st.key}
							tabIndex={storeKey === st.key ? 0 : -1}
							className={`chip${storeKey === st.key ? ' on' : ''}`}
							onClick={() => {
								haptic(5)
								setStoreKey(st.key)
								setCategory('all')
							}}
						>
							<Icon name="store" size={16} />
							{st.name}
							{st.count != null && <span className="store-count">{st.count}</span>}
						</button>
					))}
				</div>
			)}
			{!bound && targets.length > 0 && (
				<div className="store-install-on" role="group" aria-label="Install on">
					<span className="store-install-label">Install on</span>
					<div className="chips store-target-picker" role="listbox" aria-label="Machine for installs" onKeyDown={(e) => rovingKeyDown(e, TAB_SELECTOR, 'horizontal')}>
						{targets.map((t) => (
							<button
								key={`${t.kind}:${t.id}`}
								type="button"
								role="option"
								aria-selected={browseTarget?.id === t.id}
								tabIndex={browseTarget?.id === t.id ? 0 : -1}
								className={`chip${browseTarget?.id === t.id ? ' on' : ''}`}
								onClick={() => {
									haptic(5)
									setBrowseTargetId(t.id)
								}}
							>
								{t.name}
								<span className="store-count">{installKindLabel(t.kind)}</span>
							</button>
						))}
					</div>
				</div>
			)}
			<SearchField value={q} onChange={setQ} placeholder={oneStore ? `Search ${oneStore.name}` : 'Search apps'} />
			<CategoryChips label="Categories">
				{['all', ...(oneStore ? [] : [PLUGINS]), ...categories].map((c) => (
					<button
						key={c}
						role="tab"
						aria-selected={active === c}
						tabIndex={active === c ? 0 : -1}
						className={`chip${active === c ? ' on' : ''}`}
						onClick={() => {
							haptic(5)
							setCategory(c)
						}}
					>
						<Icon name={c === 'all' ? 'all' : c === PLUGINS ? 'puzzle' : catIcon(c)} size={17} />
						{c === 'all' ? 'Discover' : c === PLUGINS ? 'Omarchy plugins' : label(c)}
					</button>
				))}
			</CategoryChips>
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{active === PLUGINS && <PluginBrowser q={q.trim()} />}
			{active !== PLUGINS && registry.isLoading && (
				<>
					<div className="skeleton" style={{height: 220, borderRadius: 26, marginBottom: 20}} />
					{Array.from({length: 4}, (_, i) => (
						<div key={i} className="skeleton" style={{height: 62, margin: '10px 0'}} />
					))}
				</>
			)}

			{browsing && featured.length > 0 && (
				<div className="featured">
					{featured.map((app) => (
						<FeaturedCard key={app.id} app={app} onPick={() => pick(app)} />
					))}
				</div>
			)}

			{active === PLUGINS
				? null
				: browsing
				? categories.slice(0, 8).map((c) => {
						const items = all.filter((a) => categoryOf(a.category) === c).slice(0, 9)
						if (items.length === 0) return null
						return (
							<section key={c}>
								<div className="section-head">
									<h2>{label(c)}</h2>
									<button className="link-btn" onClick={() => setCategory(c)}>
										See all
									</button>
								</div>
								<div className="shelf screen-list glass">
									{items.map((app) => (
										<StoreItem key={app.id} app={app} installed={installed.get(app.id)} count={installsOf(app.id, installPlaces)} onPick={pick} onOpenInstalled={onOpenInstalled} />
									))}
								</div>
							</section>
						)
					})
				: !registry.isLoading && !(problem && !registry.data) && (
						shown.length === 0 ? (
							<div className="glass empty">
								<span className="big">
									<Icon name="search" size={30} />
								</span>
								<b>No apps found</b>
								<span>Try a different search, or submit the app you’re looking for.</span>
								<a className="btn small" href={SUBMIT_APP_URL} target="_blank" rel="noopener noreferrer" style={{marginTop: 10}}>
									Submit an app
								</a>
							</div>
						) : (
						<div className="list-store screen-list glass" style={{marginTop: 4}}>
							{shown.map((app) => (
								<StoreItem key={app.id} app={app} installed={installed.get(app.id)} count={installsOf(app.id, installPlaces)} onPick={pick} onOpenInstalled={onOpenInstalled} />
							))}
						</div>
						)
					)}

			{browsing && !registry.isLoading && <SubmitApp compact />}

			{stores && (
				<CommunityStores
					owner={owner}
					onClose={() => setStores(false)}
					onView={(key) => {
						setStoreKey(key)
						setCategory('all')
						setStores(false)
					}}
				/>
			)}

			{selected && (
				<StoreSheet
					key={`${selected.app.id}:${bound?.kind ?? 'any'}:${bound?.id ?? ''}:${browseTarget?.id ?? ''}`}
					app={selected.app}
					startInstall={selected.install}
					all={all}
					installed={installed}
					bound={bound}
					preferredTarget={browseTarget}
					onSelect={(a) => setSelected({app: a})}
					onClose={() => setSelected(null)}
					onTerminal={onTerminal}
				/>
			)}
		</div>
	)
}

// ---- community app stores ------------------------------------------------------------------------
// Modc is where anyone can submit an app (the official store is packaged by My Own Data Center).
const MODC_URL = 'https://github.com/MyOwnDataCenter/Modc-app-store'
const SUBMIT_APP_URL = `${MODC_URL}/issues/new?template=submit-app.yml`
const SUBMIT_GUIDE_URL = `${MODC_URL}/blob/main/CONTRIBUTING.md`
const SUGGESTED_STORES = [
	{
		url: 'https://github.com/MyOwnDataCenter/app-store',
		name: 'My Own Data Center',
		blurb: 'Google Chrome and Brave browsers that run on your server and stream to any device.',
	},
	{
		url: MODC_URL,
		name: 'MODC community',
		blurb: 'Apps submitted by the community, checked automatically and reviewed before they’re added.',
	},
]

/** "Have an app?": where to submit one, for anyone signed in. */
function SubmitApp({compact = false}: {compact?: boolean}) {
	return (
		<div className={`glass card submit-app${compact ? ' compact' : ''}`}>
			<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
				<Icon name="upload" size={19} />
			</span>
			<span className="main">
				<b>{compact ? 'Don’t see an app?' : 'Have an app to share?'}</b>
				<span className="muted">Submit it to the Modc App Store. Fill in a short form, or open a pull request with two files.</span>
			</span>
			<span className="submit-app-actions">
				<a className="btn small primary" href={SUBMIT_APP_URL} target="_blank" rel="noopener noreferrer">
					Submit an app
				</a>
				{!compact && (
					<a className="btn small" href={SUBMIT_GUIDE_URL} target="_blank" rel="noopener noreferrer">
						How it works
					</a>
				)}
			</span>
		</div>
	)
}
function CommunityStores({owner, onClose, onView}: {owner: boolean; onClose: () => void; onView: (key: string) => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const repos = useQuery({queryKey: ['appStore.repositories'], queryFn: () => query<StoreRepo[]>('appStore.repositories')})
	const [url, setUrl] = useState('')
	const [removing, setRemoving] = useState<string | null>(null)
	const refresh = () => {
		qc.invalidateQueries({queryKey: ['appStore.repositories']})
		qc.invalidateQueries({queryKey: ['appStore.registry']})
	}
	const add = useMutation({
		mutationFn: (u: string) => mutate('appStore.addRepository', {url: u}),
		onSuccess: () => {
			toast('Store added. Its apps are now in the App Store.')
			setUrl('')
			refresh()
		},
		onError: (e) => toast((e as Error).message, true),
	})
	const remove = useMutation({
		mutationFn: (u: string) => mutate('appStore.removeRepository', {url: u}),
		onSuccess: () => {
			toast('Store removed')
			setRemoving(null)
			refresh()
		},
		onError: (e) => toast((e as Error).message, true),
	})
	const community = repos.data ?? []
	const suggestions = remainingSuggestedStores(SUGGESTED_STORES, repos.data ?? [])
	const valid = validCommunityStoreUrl(url)
	return (
		<Sheet open onClose={onClose} label="Community app stores">
			<SheetHeader
				icon={
					<span className="sheet-icon" style={{background: 'var(--accent)'}}>
						<Icon name="store" size={28} />
					</span>
				}
				title="Community stores"
				subtitle="Extra app catalogs from other developers"
				onClose={onClose}
			/>
			<div className="screen">
				<p className="prose" style={{margin: '0 0 14px'}}>
					{owner
						? 'Community stores aren’t reviewed. Their apps run on your server like any other app, so only add stores from developers you trust.'
						: 'Only the owner can add or remove a store.'}
				</p>
				{repos.isLoading && (
					<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', borderRadius: 18}}>
						<span className="spinner" /> Loading your stores…
					</div>
				)}
				{community.length > 0 && (
					<>
						<h4 className="list-head">Added</h4>
						<div className="glass group">
							{community.map((r) => (
								<div key={r.url} className="row static">
									<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
										<Icon name="store" size={19} />
									</span>
									<span className="main">
										<b>{storeDisplayName(r.meta.name)}</b>
										<span className="mono muted" style={{fontSize: 12, wordBreak: 'break-all'}}>{r.url}</span>
									</span>
									<button className="btn small" onClick={() => (haptic(5), onView(r.url))} aria-label={`View ${storeDisplayName(r.meta.name)}’s apps`}>
										View apps
									</button>
									{owner && (removing === r.url ? (
										<button className="btn small danger" disabled={remove.isPending} onClick={() => remove.mutate(r.url)}>
											{remove.isPending ? 'Removing…' : 'Remove'}
										</button>
									) : (
										<button className="btn small" onClick={() => setRemoving(r.url)} aria-label={`Remove ${storeDisplayName(r.meta.name)}`}>
											Remove
										</button>
									))}
								</div>
							))}
						</div>
						{removing && <p className="muted" style={{fontSize: 13, margin: '8px 4px 0'}}>Apps you installed from it keep running; they just won’t get updates.</p>}
					</>
				)}
				{owner && suggestions.length > 0 && (
					<>
						<h4 className="list-head">Suggested</h4>
						<div className="glass group">
							{suggestions.map((sg) => (
								<div key={sg.url} className="row static">
									<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
										<Icon name="store" size={19} />
									</span>
									<span className="main">
										<b>{storeDisplayName(sg.name)}</b>
										<span className="muted" style={{fontSize: 13}}>{sg.blurb}</span>
									</span>
									<button className="btn small primary" disabled={add.isPending} onClick={() => add.mutate(sg.url)}>
										{add.isPending && add.variables === sg.url ? 'Adding…' : 'Add'}
									</button>
								</div>
							))}
						</div>
					</>
				)}
				{owner && (
					<>
						<h4 className="list-head">Add by link</h4>
						<form
							className="store-add"
							onSubmit={(e) => {
								e.preventDefault()
								if (valid) add.mutate(url.trim())
							}}
						>
							<input
								className="field"
								type="url"
								inputMode="url"
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								placeholder="https://github.com/someone/app-store"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								aria-label="Community app store link"
							/>
							<button className="btn primary" type="submit" disabled={!valid || add.isPending}>
								{add.isPending && add.variables === url.trim() ? 'Adding…' : 'Add'}
							</button>
						</form>
						{add.isPending && <p className="muted" style={{fontSize: 13, margin: '8px 4px 0'}}>Downloading the store’s catalog. This can take a minute.</p>}
					</>
				)}
				<h4 className="list-head">Submit an app</h4>
				<SubmitApp />
			</div>
		</Sheet>
	)
}

function StoreItem({
	app,
	installed,
	count = 0,
	onPick,
	onOpenInstalled,
}: {
	app: StoreApp
	installed?: UserApp
	count?: number
	onPick: (app: StoreApp, install?: boolean) => void
	onOpenInstalled: (app: UserApp) => void
}) {
	const machines = machineCountLabel(count)
	const risks = storeRiskHints(app)
	return (
		<div className="store-item">
			<button className="store-main" onClick={() => onPick(app)}>
				<AppIcon src={app.icon} name={app.name} size={58} />
				<span className="t">
					<b>
						{app.name}
						{machines && (
							<span className="count-machines" style={{marginLeft: 6, fontSize: 12}} aria-label={`On ${machines} machines`}>
								{machines}
							</span>
						)}
					</b>
					<span>{app.tagline}</span>
					{(app.repo || risks.length > 0) && (
						<span className="store-trust">
							{app.repo && <span className="store-source">{app.repo}</span>}
							{risks.map((hint) => (
								<span key={hint} className="store-risk">
									{hint}
								</span>
							))}
						</span>
					)}
				</span>
			</button>
			<span className="end">
				{installed ? (
					<button className="btn get open" onClick={() => onOpenInstalled(installed)} aria-label={`Open ${app.name}`}>
						{isAppBusy(installed.state) ? <><span className="spinner" style={{width: 14, height: 14}} /><span className="sr-only">Open</span></> : 'Open'}
					</button>
				) : (
					<button className="btn get primary" onClick={() => onPick(app, true)} aria-label={`Get ${app.name}`} disabled={app.compatible === false || !!app.unsupported}>
						Get
					</button>
				)}
			</span>
		</div>
	)
}

function FeaturedCard({app, onPick}: {app: StoreApp; onPick: () => void}) {
	const detail = useStoreApp(app)
	const shot = app.gallery?.[0] ?? detail.data?.gallery?.[0]
	return (
		<button className="feature" onClick={onPick}>
			{shot ? <img src={shot} alt="" loading="lazy" decoding="async" /> : null}
			<span className="scrim-b" />
			<span className="tag">{label(app.category ?? 'Featured')}</span>
			<span className="meta">
				<AppIcon src={app.icon} name={app.name} size={44} />
				<span className="t">
					<b>{app.name}</b>
					<span>{app.tagline}</span>
				</span>
			</span>
		</button>
	)
}

function StoreSheet({
	app,
	startInstall,
	all,
	installed,
	bound,
	preferredTarget,
	onSelect,
	onClose,
	onTerminal,
}: {
	app: StoreApp
	startInstall?: boolean
	all: StoreApp[]
	installed: Map<string, UserApp>
	bound: StoreBinding | null
	preferredTarget: InstallTarget | null
	onSelect: (a: StoreApp) => void
	onClose: () => void
	onOpenApp?: (app: UserApp) => void
	onTerminal?: (input: string) => void
}) {
	const boot = useBootstrap()
	const machines = useMachines()
	const computers = useQuery({queryKey: ['swarm.list'], queryFn: () => query<{id: string; name: string; online: boolean; guestOf?: string; containerOf?: string; allowed?: {apps?: boolean}; on?: {apps?: boolean}}[]>('swarm.list')})
	const targets = useMemo(
		() =>
			installTargets({
				serverName: boot.server?.device || 'This server',
				computers: (computers.data ?? []).filter((a) => !a.guestOf && !isContainerAgent(a)).map(computerInstallInput),
				guests: (machines.data ?? []).map((m) => guestInstallInput({id: m.id, name: m.name, state: m.state, connector: (computers.data ?? []).some((a) => a.guestOf === m.id && a.online)})),
			}),
		[boot.server?.device, computers.data, machines.data],
	)
	const boundTarget = bound ? (targets.find((t) => t.id === bound.id && t.kind === bound.kind) ?? null) : null
	const preferredReady = preferredTarget && targets.some((t) => t.id === preferredTarget.id && t.ability === 'ready')
	const boundReady = !bound || boundTarget?.ability === 'ready'
	const desk = useDesktop()
	const openTerminal = desk ? (input: string) => desk.openTerminal(undefined, input) : onTerminal
	const toast = useToast()
	const action = useAction()
	const presetId = bound?.id ?? (preferredReady ? preferredTarget!.id : null)
	const [choosing, setChoosing] = useState(!!startInstall && !presetId)
	const [reviewing, setReviewing] = useState(false)
	const [chosenId, setChosenId] = useState<string | null>(presetId)
	const started = useRef(false)
	useEffect(() => {
		if (!startInstall || !presetId || started.current) return
		const ready = bound ? boundTarget?.ability === 'ready' : preferredReady
		if (!ready) return
		started.current = true
		setChosenId(presetId)
		setReviewing(true)
	}, [startInstall, presetId, bound, boundTarget, preferredReady])
	const [more, setMore] = useState(false)
	const proseRef = useRef<HTMLDivElement>(null)
	const [clipped, setClipped] = useState(false)
	const detail = useStoreApp(app, {detail: true})
	const website = detail.data?.website ?? app.website
	const view = {
		...app,
		description: detail.data?.description ?? app.description,
		gallery: detail.data?.gallery ?? app.gallery,
		website: typeof website === 'string' && /^https?:\/\//i.test(website) ? website : undefined,
		releaseNotes: detail.data?.releaseNotes ?? app.releaseNotes,
	}
	// "More" shows when the text really is cut off, so a short list of lines gets it too.
	useLayoutEffect(() => {
		const el = proseRef.current
		if (!el || more) return
		const measure = () => setClipped(isClamped(el))
		measure()
		const watch = new ResizeObserver(measure)
		watch.observe(el)
		return () => watch.disconnect()
	}, [view.description, more])

	const live = installed.get(app.id)
	// What it needs that isn't installed yet (an installed app can stand in, e.g. Bitcoin Knots).
	const covered = (id: string) => installed.has(id) || [...installed.keys()].some((k) => all.find((a) => a.id === k)?.implements?.includes(id))
	const missingDeps = (app.needs ?? app.dependencies ?? []).filter((d) => !covered(d))
	const incompatible = app.compatible === false || !!app.unsupported
	const canInstall = !live && !incompatible
	const chosen = targets.find((t) => t.id === chosenId) ?? null
	const chosenReady = chosen?.ability === 'ready'
	const machineName = bound?.name || chosen?.name || preferredTarget?.name || ''
	const targetGone = reviewing && canInstall && !chosenReady
	const showChooser = canInstall && (choosing || (targetGone && !bound))
	// The confirmation, and its install button, stay hidden until a machine is chosen.
	const showReview = reviewing && canInstall && chosenReady && machineName !== '' && (!bound || boundTarget?.ability === 'ready')
	const blockedReason = bound && !boundReady ? (boundTarget?.reason || (machines.isLoading || computers.isLoading ? '' : `${bound.name} isn’t available for an install.`)) : ''
	const liveUrl = live ? appUrl(live, boot.server!.host) : null
	const detailPerms = Array.isArray(detail.data?.permissions) ? detail.data!.permissions : app.permissions
	const riskHints = storeRiskHints({oidc: app.oidc ?? detail.data?.oidc, caution: app.caution, permissions: detailPerms})
	const sourceName = storeDisplayName(app.repo)
	const beginInstall = () => {
		if (bound) {
			if (boundTarget?.ability === 'ready') setReviewing(true)
			return
		}
		if (chosenReady && chosenId) {
			setReviewing(true)
			return
		}
		if (preferredReady && preferredTarget) {
			setChosenId(preferredTarget.id)
			setReviewing(true)
			return
		}
		setChoosing(true)
	}

	return (
		<Sheet open onClose={onClose} label={app.name}>
			<SheetHeader icon={<AppIcon src={app.icon} name={app.name} size={72} />} title={app.name} subtitle={app.developer ?? sourceName} onClose={onClose} />

			{showChooser ? (
				<>
					<button type="button" className="btn small" onClick={() => (setChoosing(false), setReviewing(false))}>
						<Icon name="back" size={16} /> Back
					</button>
					<div className="section-head" style={{margin: '14px 0 8px'}}>
						<h2>Install on</h2>
					</div>
					{targetGone && (
						<p className="footer-note" style={{textAlign: 'left'}}>
							{chosen?.reason || 'That computer isn’t available for an install.'}
						</p>
					)}
					<div className="glass group">
						{targets.map((t) => (
							<button key={`${t.kind}:${t.id}`} type="button" className="row" disabled={t.ability !== 'ready'} onClick={() => (setChosenId(t.id), setChoosing(false), setReviewing(true))}>
								<span className="main">
									<b>{t.name}</b>
									<span>{t.ability === 'ready' ? installKindLabel(t.kind) : t.reason}</span>
								</span>
							</button>
						))}
					</div>
				</>
			) : showReview ? (
				<BeforeInstall
					appId={app.id}
					appName={app.name}
					machineName={machineName}
					installSize={app.installSize}
					pending={action.isPending}
					cancelLabel="Back"
					openTerminal={openTerminal}
					onInstall={(input) => {
						const target = confirmInstallTarget(chosen)
						if (!target) {
							setChoosing(true)
							setReviewing(false)
							return
						}
						action.mutate(
							{
								path: 'apps.install',
								input: {appId: app.id, ...input, target},
								...(target === 'server'
									? {adding: [...missingDeps.map((d) => all.find((a) => a.id === d)).filter((a): a is StoreApp => !!a), app].map((a) => ({id: a.id, name: a.name, icon: a.icon}))}
									: {}),
								done: `Installing ${app.name}…`,
							},
							{onSuccess: () => setReviewing(false)},
						)
					}}
					onCancel={() => setReviewing(false)}
				/>
			) : (
				<>
					{live ? (
						<div className="primary-row">
							{isAppBusy(live.state) ? (
								<div className="glass card" style={{flex: 1, display: 'flex', alignItems: 'center', gap: 12, borderRadius: 18}}>
									<span className="spinner" style={{color: 'var(--accent-text)'}} />
									<span style={{flex: 1, fontWeight: 600, textTransform: 'capitalize'}}>
										{live.state}… {live.progress ? `${live.progress}%` : ''}
									</span>
								</div>
							) : (
								<>
									<button
										className="btn"
										disabled={!liveUrl}
										onClick={() => {
											haptic(6)
											onClose()
											if (desk) desk.launch(live)
											else if (liveUrl) {
												toast(`Opening ${live.name ?? app.name}…`)
												openApp(live, liveUrl, {
													onWaiting: (() => {
														let lastShown = 0
														return (sec: number) => {
															const next = nextStartingToast(sec, lastShown)
															lastShown = next.lastShown
															if (next.show) toast(`${live.name ?? app.name} is still starting (${sec}s)…`)
														}
													})(),
												}).then(
													(r) => !r.opened && toast(explainProbe(live.name ?? app.name, r.probe) ?? `${live.name ?? app.name} didn’t answer in time.`, true),
												)
											}
										}}
									>
										<Icon name="open" size={20} />
										Open
									</button>
									<span style={{display: 'flex', alignItems: 'center'}}>
										<StatusPill {...appStatus(live.state)} />
									</span>
								</>
							)}
						</div>
					) : incompatible ? (
						<div className="error" role="alert">
							<Icon name="alert" size={18} />
							{app.unsupported ?? 'This app needs a newer version of My Own Data Center.'}
						</div>
					) : (
						<>
							<div className="primary-row">
								<button className="btn primary" onClick={beginInstall} disabled={action.isPending || !!blockedReason}>
									<Icon name="download" size={20} />
									Install{machineName ? ` on ${machineName}` : ''}
								</button>
							</div>
							{!bound && preferredTarget && !blockedReason && (
								<p className="footer-note" style={{textAlign: 'left'}}>
									Installs on {preferredTarget.name}. Change the target at the top of the App Store.
								</p>
							)}
							{blockedReason && <p className="footer-note" style={{textAlign: 'left'}}>{blockedReason}</p>}
							{missingDeps.length > 0 && (
								<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
									<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
										Needs {missingDeps.length > 1 ? 'these apps' : 'this app'} · installed with it
									</div>
									{missingDeps.map((d) => {
										const dep = all.find((a) => a.id === d)
										return (
											<button key={d} className="row" style={{minHeight: 60}} onClick={() => dep && onSelect(dep)} disabled={!dep}>
												<AppIcon src={dep?.icon} name={dep?.name ?? d} size={38} />
												<span className="main">
													<b>{dep?.name ?? d}</b>
													{dep?.tagline && <span>{dep.tagline}</span>}
												</span>
												<Icon name="chevron" size={18} className="chev" />
											</button>
										)
									})}
								</div>
							)}
						</>
					)}
					{(app.repo || riskHints.length > 0) && !live && (
						<div className="store-trust detail" style={{marginBottom: 14}}>
							{app.repo && <span className="store-source">From {sourceName}</span>}
							{riskHints.map((hint) => (
								<span key={hint} className="store-risk">
									{hint}
								</span>
							))}
						</div>
					)}
					{app.caution && !live && (
						<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
							<span className="row-ico" style={{'--c': 'var(--blue)'} as React.CSSProperties}>
								<Icon name="info" size={18} />
							</span>
							<span style={{fontSize: 14.5}}>{app.caution}</span>
						</div>
					)}
					{app.oidc?.supported && (
						<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
							<span className="row-ico" style={{'--c': 'var(--accent)'} as React.CSSProperties}>
								<Icon name="key" size={18} />
							</span>
							<span style={{fontSize: 14}}>
								<b>Sign in with My Own Data Center</b> · {app.oidc.mode === 'auto' ? 'Accounts and two-factor on this server can sign into this app' : 'Pre-registers an OIDC client so you can paste credentials after install'}
							</span>
						</div>
					)}

					<div className="store-stats">
						<div>
							<small>Version</small>
							<b>{app.version ?? '–'}</b>
						</div>
						<div>
							<small>Category</small>
							<b>
								<Icon name={catIcon(app.category ?? '')} size={15} />
								{app.category ? label(app.category).split(' ')[0] : '–'}
							</b>
						</div>
						<div>
							<small>Size</small>
							<b>{app.installSize ? bytes(app.installSize, 0) : '–'}</b>
						</div>
					</div>

					{app.tagline && <p style={{margin: '0 0 16px', fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em'}}>{app.tagline}</p>}
					{(view.gallery?.length ?? 0) > 0 && (
						<div className="gallery">
							{view.gallery!.slice(0, 6).map((src) => (
								<img key={src} src={src} alt="" loading="lazy" decoding="async" />
							))}
						</div>
					)}
					{view.description && (
						<>
							<div ref={proseRef} className={`prose${more ? '' : ' clamp'}`}>
								{view.description}
							</div>
							{!more && clipped && (
								<button className="link-btn" style={{paddingLeft: 0}} onClick={() => setMore(true)}>
									More
								</button>
							)}
						</>
					)}
					{view.website && (
						<p className="footer-note" style={{textAlign: 'left', marginTop: 18}}>
							<a href={view.website} target="_blank" rel="noreferrer">
								{view.website.replace(/^https?:\/\//, '')}
							</a>
						</p>
					)}
					{app.repo && <p className="footer-note" style={{textAlign: 'left', marginTop: 18}}>From {sourceName}</p>}
				</>
			)}
		</Sheet>
	)
}
