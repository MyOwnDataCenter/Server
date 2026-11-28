import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {getBootstrap, query, type Bootstrap, type User, type UserApp} from './api'
import {plural} from './plural'
import {bootstrapPollInterval, useServerReachable} from './connection'
import {AppSheet} from './AppSheet'
import {AppViewer} from './AppViewer'
import {VIEW_APP} from './openApp'
import {OPEN_TERMINAL} from './terminalEvent'
import {OPEN_FLEET} from './fleet/openMember'
import {OPEN_STORE, type StoreBinding} from './fleet/openStore'
import {BootstrapContext, useAction, useApps, useNotifications, useUpdates, useUser} from './data'
import {Icon, type IconName} from './icons'
import {entrypointHost} from './entrypointHost'
import {isOwner} from './isOwner'
import {APP_TITLE, pageTitle} from './pageTitle'
import {Apps} from './screens/Apps'
import {Connect, Login} from './screens/Auth'
import {Home} from './screens/Home'
import {Desktop} from './desktop/Desktop'
import {resetDeskConfig} from './desktop/config'
import {OPEN_SETTINGS} from './desktop/settingsPage'
import {safeSession} from './safeStorage'
import {phoneSettingsGearAction} from './settingsChrome'
import {ScreenErrorBoundary} from './screenBoundary'
import {inAppBackTarget, markInAppHistory, readInAppHistoryFlag} from './inAppHistory'
import {ThemeModeButton} from './theme/ThemeModeButton'
import {Backdrop, Sheet, SheetHeader, haptic, layoutAsked, scrollPhoneToTop, useLayout, usePrefs, type Prefs} from './ui'
import {WhatsNewOnUpdate} from './WhatsNew'
import {WelcomeForUser} from './Welcome'
import {InstallerPrompt} from './InstallerPrompt'
import {consumeReopenAssistant, reopenOnMount} from './assistant'
import {closeAssistantView, openAssistantView, resetAssistantTurn, useAssistantTurn} from './assistantTurn'
import {AssistantLookContext, cleanLook, DEFAULT_LOOK, type AssistantLook} from './character/AssistantCharacter'
import {StatViewProvider} from './fleet/StatRegion'
import {AssistantCharacterWidget} from './character/widgets'

const Clips = lazy(() => import('./screens/Clips').then((m) => ({default: m.Clips})))
const Files = lazy(() => import('./screens/Files').then((m) => ({default: m.Files})))
const Machines = lazy(() => import('./screens/Machines').then((m) => ({default: m.Machines})))
const Terminals = lazy(() => import('./fleet/Terminals').then((m) => ({default: m.Terminals})))
const More = lazy(() => import('./screens/More').then((m) => ({default: m.More})))
const Settings = lazy(() => import('./screens/Settings').then((m) => ({default: m.Settings})))
const Store = lazy(() => import('./screens/Store').then((m) => ({default: m.Store})))
const TerminalScreen = lazy(() => import('./Terminal').then((m) => ({default: m.TerminalScreen})))
const Assistant = lazy(() => import('./screens/Assistant').then((m) => ({default: m.Assistant})))

function ScreenFallback() {
	return (
		<main className="screen center">
			<span className="spinner" role="status" aria-label="Loading" />
		</main>
	)
}

type Tab = 'home' | 'apps' | 'files' | 'machines' | 'terminals' | 'more' | 'settings' | 'store' | 'clips'
// `tone`: the palette colour each tab's icon takes in the themed looks (the same as on the desktop).
const TABS: {id: Tab; label: string; icon: IconName; active: IconName; tone: string}[] = [
	{id: 'home', label: 'Home', icon: 'home', active: 'home-filled', tone: 'var(--accent)'},
	{id: 'apps', label: 'Apps', icon: 'apps', active: 'apps-filled', tone: 'var(--mauve)'},
	{id: 'files', label: 'Files', icon: 'folder', active: 'folder-filled', tone: 'var(--blue)'},
	{id: 'machines', label: 'Machines', icon: 'machine', active: 'machine-filled', tone: 'var(--teal)'},
	{id: 'more', label: 'System', icon: 'activity', active: 'activity-filled', tone: 'var(--peach)'},
]
function dockTabs(_owner: boolean) {
	// Phone dock stays Home / Apps / Files / Machines / System. Terminals stays on #/terminals and System for owners; desktop may still pin it.
	return TABS
}
const tabFromHash = (allowTerminals: boolean): Tab => {
	const h = location.hash.replace('#/', '') as Tab
	if (h === 'terminals') return allowTerminals ? 'terminals' : 'home'
	return h === 'settings' || h === 'store' || h === 'clips' || TABS.some((t) => t.id === h) ? h : 'home'
}

export function App() {
	const qc = useQueryClient()
	const boot = useQuery({
		queryKey: ['bootstrap'],
		queryFn: getBootstrap,
		retry: 1,
		refetchInterval: (q) => bootstrapPollInterval(q.state),
		refetchOnWindowFocus: (q) => bootstrapPollInterval(q.state) !== false,
	})
	const signedIn = !!boot.data?.session && !!boot.data?.server?.reachable
	const user = useQuery({queryKey: ['user.get'], queryFn: () => query<User>('user.get'), enabled: signedIn, staleTime: 5 * 60_000})
	const [loginId, setLoginId] = useState<string>()
	const account = boot.data?.accounts.find((a) => a.userId === (signedIn ? boot.data?.session?.accountId : loginId)) ?? boot.data?.accounts[0]
	const wallpaper = (signedIn ? user.data?.wallpaper : null) ?? account?.wallpaper ?? null
	const [prefs, setPrefs] = usePrefs(wallpaper?.brandColorHsl, signedIn)
	// The assistant's look (character, name, motion), saved with this account's preferences.
	const look = useMemo(() => cleanLook(prefs.assistantLook ?? DEFAULT_LOOK), [prefs.assistantLook])
	const lookValue = useMemo(() => ({look, setLook: (next: AssistantLook) => setPrefs({...prefs, assistantLook: next})}), [look, prefs, setPrefs])
	const refresh = useCallback(() => qc.invalidateQueries({queryKey: ['bootstrap']}), [qc])
	const retryBootstrap = useCallback(async () => {
		const res = await boot.refetch()
		if (res.error) throw res.error
		return res.data ?? null
	}, [boot])
	const layout = useLayout()
	// The first time anyone signs in on this device: a short welcome setup (then What's New).
	const [askLayout, setAskLayout] = useState(() => !layoutAsked())
	// Consumed once per page load. Cleared after the first signed-in Shell or Desktop has seen it,
	// so a later remount (wallpaper, theme, restart) does not open the assistant again.
	const reopenWantedRef = useRef<boolean | null>(null)
	if (reopenWantedRef.current === null) reopenWantedRef.current = consumeReopenAssistant()
	const [reopenGiven, setReopenGiven] = useState(false)
	const reopenAssistant = reopenOnMount(reopenWantedRef.current, reopenGiven)
	const showShell = !!boot.data?.configured && !!boot.data?.server?.reachable && !!boot.data?.session

	useEffect(() => {
		if (!showShell || !reopenAssistant) return
		setReopenGiven(true)
	}, [showShell, reopenAssistant])

	useEffect(() => {
		const onOut = () => {
			resetDeskConfig()
			resetAssistantTurn()
			qc.removeQueries({predicate: (q) => q.queryKey[0] !== 'bootstrap'})
			refresh()
		}
		window.addEventListener('touch:signed-out', onOut)
		return () => window.removeEventListener('touch:signed-out', onOut)
	}, [qc, refresh])

	// The installer prompt waits for What's New, so the two don't stack.
	const [whatsNewDone, setWhatsNewDone] = useState(false)
	const b = boot.data
	let content
	if (boot.isLoading) {
		content = (
			<main className="auth center">
				<span className="spinner" style={{width: 30, height: 30, margin: '0 auto', color: 'var(--accent-text)'}} role="status" aria-label="Loading" />
			</main>
		)
	} else if (boot.error || !b) {
		content = (
			<main className="auth center screen">
				<h1>My Own Data Center is offline</h1>
				<p className="lead">The server isn’t answering. Is it still running?</p>
				<button className="btn primary block" onClick={() => void boot.refetch()}>
					Try again
				</button>
			</main>
		)
	} else if (!b.configured) content = <Connect onDone={refresh} />
	else if (!b.server?.reachable) content = <Connect onDone={refresh} onRetry={retryBootstrap} unreachable={b.server} />
	else if (!b.session) content = <Login boot={b} userId={loginId} setUserId={setLoginId} onDone={refresh} />
	else
		content = (
			<BootstrapContext.Provider value={b}>
			<AssistantLookContext.Provider value={lookValue}>
			<StatViewProvider prefs={prefs} setPrefs={setPrefs}>
				{layout.desktop ? <Desktop boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} reopenAssistant={reopenAssistant} /> : <Shell boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} reopenAssistant={reopenAssistant} />}
				{askLayout ? <WelcomeForUser prefs={prefs} setPrefs={setPrefs} onDone={() => setAskLayout(false)} /> : <WhatsNewOnUpdate version={b.touch.version} onDone={() => setWhatsNewDone(true)} />}
				<InstallerPrompt ready={whatsNewDone} />
			</StatViewProvider>
			</AssistantLookContext.Provider>
			</BootstrapContext.Provider>
		)

	return (
		<>
			<Backdrop wallpaper={wallpaper} prefs={prefs} signedIn={!!boot.data?.session} />
			{content}
		</>
	)
}

function Shell({boot, prefs, setPrefs, onSignedOut, reopenAssistant}: {boot: Bootstrap; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; reopenAssistant?: boolean}) {
	const [tab, setTab] = useState<Tab>(() => tabFromHash(false))
	const [storeBound, setStoreBound] = useState<StoreBinding | null>(null)
	const [appId, setAppId] = useState<string | null>(null)
	// An app open inside My Own Data Center (full screen, back button returns here).
	const [viewing, setViewing] = useState<UserApp | null>(null)
	useEffect(() => {
		const onView = (e: Event) => (setAppId(null), setViewing((e as CustomEvent<UserApp>).detail))
		window.addEventListener(VIEW_APP, onView)
		return () => window.removeEventListener(VIEW_APP, onView)
	}, [])
	const [bellOpen, setBellOpen] = useState(false)
	// Remount Settings when the chrome gear resets a nested page to main.
	const [settingsEpoch, setSettingsEpoch] = useState(0)
	const [terminal, setTerminal] = useState<{app?: {id: string; name?: string; icon?: string}; input?: string} | null>(null)
	const [assistantOpen, setAssistantOpen] = useState(() => !!reopenAssistant)
	const turn = useAssistantTurn()
	const keepAssistant = assistantOpen || turn.streaming
	const user = useUser()
	// Every terminal socket is owner-only. Hide the tab until that is known.
	const owner = isOwner(user.data)
	const tabs = dockTabs(owner)
	// omarchyd only gives the owner a shell.
	const openTerminal = !owner
		? undefined
		: (app?: {id: string; name?: string; icon?: string}, input?: string) => {
				haptic(8)
				setAppId(null)
				setTerminal({app, input})
			}
	// "Open Terminal" buttons elsewhere (e.g. a one-time fix for network shares).
	useEffect(() => {
		const onOpen = (e: Event) => openTerminal?.(undefined, (e as CustomEvent<string>).detail)
		window.addEventListener(OPEN_TERMINAL, onOpen)
		return () => window.removeEventListener(OPEN_TERMINAL, onOpen)
	})
	const apps = useApps()
	const updates = useUpdates()
	const notifications = useNotifications()

	// Each phone screen is its own history entry, so each one names itself in the tab and the history list.
	useEffect(() => {
		document.title = pageTitle(tab)
		return () => {
			document.title = APP_TITLE
		}
	}, [tab])
	useEffect(() => {
		const onHash = () => setTab(tabFromHash(owner))
		window.addEventListener('hashchange', onHash)
		return () => window.removeEventListener('hashchange', onHash)
	}, [owner])
	useEffect(() => {
		if (!user.isSuccess) return
		const hash = location.hash.replace('#/', '')
		if (owner) {
			if (hash === 'terminals') setTab('terminals')
			return
		}
		if (hash === 'terminals' || tab === 'terminals') {
			history.replaceState(null, '', '#/home')
			setTab('home')
		}
	}, [user.isSuccess, owner, tab])
	useEffect(() => {
		const onOpen = (e: Event) => {
			setStoreBound((e as CustomEvent<StoreBinding>).detail ?? null)
			setTab('store')
			markInAppHistory((key, value) => sessionStorage.setItem(key, value))
			history.pushState(null, '', '#/store')
			scrollPhoneToTop()
		}
		window.addEventListener(OPEN_STORE, onOpen)
		return () => window.removeEventListener(OPEN_STORE, onOpen)
	}, [])
	useEffect(() => {
		const onOpen = (e: Event) => {
			const page = String((e as CustomEvent<string>).detail || 'main')
			if (page === 'main') safeSession.remove('omarchy-server:settings-page')
			else safeSession.set('omarchy-server:settings-page', page)
			setTab((cur) => {
				if (cur === 'settings') setSettingsEpoch((n) => n + 1)
				else {
					markInAppHistory((key, value) => sessionStorage.setItem(key, value))
					history.pushState(null, '', '#/settings')
				}
				return 'settings'
			})
			scrollPhoneToTop()
		}
		window.addEventListener(OPEN_SETTINGS, onOpen)
		return () => window.removeEventListener(OPEN_SETTINGS, onOpen)
	}, [])
	useEffect(() => {
		const onOpen = () => {
			setTab('machines')
			markInAppHistory((key, value) => sessionStorage.setItem(key, value))
			history.pushState(null, '', '#/machines')
			scrollPhoneToTop()
		}
		window.addEventListener(OPEN_FLEET, onOpen)
		return () => window.removeEventListener(OPEN_FLEET, onOpen)
	}, [])
	useEffect(() => {
		if (tab !== 'store') setStoreBound((cur) => (cur ? null : cur))
	}, [tab])
	const go = (t: Tab) => {
		haptic(5)
		if (t === tab) scrollPhoneToTop('smooth')
		else {
			markInAppHistory((key, value) => sessionStorage.setItem(key, value))
			history.pushState(null, '', `#/${t}`)
			setTab(t)
			scrollPhoneToTop()
		}
	}
	// Chrome gear: open Settings from elsewhere; if already in Settings (including Appearance), return to main.
	const openSettingsFromChrome = () => {
		if (phoneSettingsGearAction(tab) === 'reset-main') {
			haptic(5)
			safeSession.remove('omarchy-server:settings-page')
			setSettingsEpoch((n) => n + 1)
			scrollPhoneToTop()
			return
		}
		go('settings')
	}
	// A direct open of #/settings (or store, or clips) has no in-app entry to pop.
	const backInApp = () => {
		const flag = readInAppHistoryFlag((key) => sessionStorage.getItem(key))
		if (inAppBackTarget(flag) === 'back') history.back()
		else go('home')
	}

	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	const conn = useServerReachable()
	const online = conn.reachable
	const updateCount = updates.data?.length ?? 0
	const notes = notifications.data ?? []
	const index = tabs.findIndex((t) => t.id === tab)

	return (
		<>
			<div className="shell">
				<div className="shell-col">
				<header className="topbar">
					<span className="device">
						<span className={`dot ${online ? 'live' : 'down'}`} />
						{boot.server?.device ?? 'server'}
						<span className="mono">{entrypointHost(boot.server)}</span>
					</span>
					<span className="spacer-x" />
					<button
						className="round-btn"
						aria-label="Settings"
						onClick={openSettingsFromChrome}
					>
						<Icon name="settings" size={20} />
					</button>
					<ThemeModeButton prefs={prefs} setPrefs={setPrefs} className="round-btn theme-mode" size={20} />
					<button
						className={`round-btn bell${notes.length ? ' lit' : ''}${notes.includes('update-available') ? ' ringing' : ''}`}
						aria-label={notes.length ? plural(notes.length, 'notification') : 'Notifications'}
						onClick={() => {
							haptic(6)
							setBellOpen(true)
						}}
					>
						<Icon name="bell" size={20} />
						{notes.length > 0 && <span className="badge-n">{notes.length}</span>}
					</button>
				</header>
				{!online && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{conn.message}
					</div>
				)}
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<main key={tab} className="screen">
						{tab === 'home' && (
							<Home
								onOpenApp={(a) => setAppId(a.id)}
								go={go}
								onTerminal={openTerminal}
								onAssistant={() => {
									haptic(8)
									setAppId(null)
									setAssistantOpen(true)
									openAssistantView()
								}}
							/>
						)}
						{tab === 'apps' && <Apps onOpenApp={(a) => setAppId(a.id)} onStore={() => go('store')} />}
						{tab === 'files' && <Files />}
						{tab === 'store' && <Store bound={storeBound} onOpenInstalled={(a) => setAppId(a.id)} onBack={backInApp} onTerminal={openTerminal && ((input) => openTerminal(undefined, input))} />}
						{tab === 'machines' && <Machines prefs={prefs} setPrefs={setPrefs} onOpenApp={(a) => setAppId(a.id)} onTerminal={openTerminal} />}
						{tab === 'terminals' && owner && <Terminals />}
						{tab === 'more' && <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onSettings={() => go('settings')} onClips={() => go('clips')} onTerminals={owner ? () => go('terminals') : undefined} />}
						{tab === 'clips' && <Clips onBack={backInApp} />}
						{tab === 'settings' && <Settings key={settingsEpoch} prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onBack={backInApp} />}
					</main>
				</Suspense>
				</ScreenErrorBoundary>
				</div>
			</div>
			<nav className="dock" aria-label="Main" data-tabs={tabs.length} style={{'--dock-tabs': tabs.length} as CSSProperties}>
				<span className="indicator" style={{transform: `translateX(${Math.max(index, 0) * 100}%)`, opacity: index < 0 ? 0 : 1}} aria-hidden="true" />
				{tabs.map((t) => (
					<button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => {
						if (t.id === 'store') setStoreBound(null)
						go(t.id)
					}} style={{'--tone': t.tone} as CSSProperties}>
						<Icon name={tab === t.id ? t.active : t.icon} size={23} stroke={tab === t.id ? 2 : 1.75} />
						{t.label}
						{t.id === 'apps' && updateCount > 0 && <span className="badge-update" aria-label={plural(updateCount, 'update')}>{updateCount}</span>}
					</button>
				))}
			</nav>
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} onTerminal={openTerminal} />
			{viewing && <AppViewer app={viewing} onClose={() => setViewing(null)} />}

			{terminal && (
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<TerminalScreen app={terminal.app} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
				</ScreenErrorBoundary>
			)}
			{/* Not over Settings, which has its own preview of the character (and forms it would cover). */}
			{!assistantOpen && !terminal && !viewing && tab !== 'settings' && (
				<AssistantCharacterWidget
					onOpen={() => {
						setAppId(null)
						setAssistantOpen(true)
						openAssistantView()
					}}
				/>
			)}
			{keepAssistant && (
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<Assistant
						active={assistantOpen}
						onClose={() => {
							closeAssistantView()
							setAssistantOpen(false)
						}}
						onSettings={() => {
							safeSession.set('omarchy-server:settings-page', 'assistant')
							closeAssistantView()
							setAssistantOpen(false)
							go('settings')
						}}
						prefs={prefs}
						setPrefs={setPrefs}
					/>
				</Suspense>
				</ScreenErrorBoundary>
			)}
			<NotificationsSheet
				open={bellOpen}
				notes={notes}
				onClose={() => setBellOpen(false)}
				onOpen={(n) => {
					setBellOpen(false)
					if (n === 'update-available') {
						safeSession.remove('omarchy-server:settings-page')
						go('settings')
					}
				}}
			/>
		</>
	)
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'A new version of My Own Data Center is available',
	migration: 'Your data migration finished',
}
const noteText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function NotificationsSheet({open, notes, onClose, onOpen}: {open: boolean; notes: string[]; onClose: () => void; onOpen?: (n: string) => void}) {
	const action = useAction()
	return (
		<Sheet open={open} onClose={onClose} label="Notifications">
			<SheetHeader title="Notifications" subtitle={notes.length ? `${notes.length}` : undefined} onClose={onClose} />
			{notes.length === 0 ? (
				<div className="empty" style={{paddingTop: 20}}>
					<span className="big">
						<Icon name="check" size={30} />
					</span>
					<b>You’re all caught up</b>
				</div>
			) : (
				<div className="glass group" style={{borderRadius: 18, '--inset': '62px'} as React.CSSProperties}>
					{notes.map((n) => (
						<div key={n} className="row static">
							<span className="row-ico" style={{'--c': 'var(--yellow)', color: '#1a1300'} as React.CSSProperties}>
								<Icon name="bell" size={18} />
							</span>
							<button className="main" style={{background: 'none', border: 0, color: 'inherit', textAlign: 'left', font: 'inherit', padding: 0, cursor: 'pointer'}} onClick={() => onOpen?.(n)}>
								<b style={{fontWeight: 550, whiteSpace: 'normal'}}>{noteText(n)}</b>
								{n === 'update-available' && <span>Tap to see what’s new and update</span>}
							</button>
							<button className="icon-btn" style={{alignSelf: 'center'}} aria-label="Dismiss" onClick={() => action.mutate({path: 'notifications.clear', input: n})}>
								<Icon name="close" size={16} stroke={2.2} />
							</button>
						</div>
					))}
				</div>
			)}
		</Sheet>
	)
}
