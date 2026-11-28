// Local swarm: other Linux computers that joined this server with the connector (connector/agent.py).
// Watch them, open a terminal or their desktop, and manage them (Omarchy plugins and themes, updates,
// restart), each only as far as that computer allowed when it joined.
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react'

import {mutate, query, type Machine, type UserApp} from '../api'
import {useUser} from '../data'
import {isOwner} from '../isOwner'
import {ClipBook} from '../clips/ClipBook'
import {computerHere} from '../clips/view'
import {hostedVms} from '../fleet/hostedVms'
import {queryProblem, useBrowserOnline} from '../connection'
import {errorText} from '../queryNotice'
import {Icon, type IconName} from '../icons'
import {osLook} from '../osLook'
import {extraDisks, type SwarmBattery} from './gauges'
import {isGuestAgent, linuxConnectorOs} from './guestLink'
import {connectorInstallCommand, connectorInstallCommandWindows} from './installCommand'
import {newlyJoined} from './join'
import {loadPluginNames} from './pluginNames'
import {MachineSeen} from '../fleet/MachineSeen'
import {LiveStats, useStatView} from '../fleet/StatRegion'
import {tempDegrees} from '../fleet/temperatures'
import {MachineActions} from '../fleet/machineActions'
import {MachineShell, MachineTabs, type MachineTab} from '../fleet/MachineTabs'
import {SheetGroup} from '../fleet/sheetGroup'
import {PinButton} from '../fleet/PinButton'
import {MachineApps} from '../fleet/MachineApps'
import {openStore} from '../fleet/openStore'
import {ThemePicker} from '../theme/ThemePicker'
import {themeAction} from '../theme/themeAction'
import {storageRowSub} from './storageHint'
import {wakeOffer} from './wake'
import {StoragePage, StoragePanel} from '../screens/Storage'
import {DetailFrame, type DetailSection} from '../machines/detailFrame'
import {useDesktop} from '../desktop/Desktop'
import {ComputerBackups} from '../backups'
import {Row, Sheet, SheetHeader, StatChip, StatusPill, Switch, bytes, duration, haptic, useConfirm, useToast} from '../ui'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))
const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

type Abilities = {terminal: boolean; desktop: boolean; manage: boolean; storage: boolean; backup: boolean; services: boolean; files: boolean; vms: boolean}
export type Ability = keyof Abilities
export type Agent = {
	id: string
	name: string
	online: boolean
	lastSeen: number | null
	enrolledAt: number
	allowed: Abilities
	on: Abilities
	/** Set when this connector was installed on a virtual machine. Empty for a physical computer. */
	guestOf?: string
	/** Set when this connector was installed inside a system container (LXC name). */
	containerOf?: string
	updateAvailable?: boolean
	helperUpdateAvailable?: boolean
	info: {
		hostname?: string
		os?: string
		osId?: string
		kernel?: string
		arch?: string
		user?: string
		version?: string
		agentSha?: string
		helperSha?: string
		macs?: string[]
		posture?: {rebootRequired: boolean; rebootReason?: string; securityUpdates?: number | null; listeningPorts?: {port: number; proto: string; addr: string}[]; failedUnits?: number} | null
		pkg?: string
		updateCommand?: string
		omarchy?: boolean
		plugins?: string[]
		themes?: string[]
		theme?: string
		desktop?: {kind: string; ok: boolean; why: string}
	} | null
	libvirt?: boolean
	macs?: string[]
	metrics: {
		cpu: number | null
		cores?: number
		load?: number[]
		mem?: {total: number; used: number}
		swap?: {total: number; used: number}
		disks?: {mount: string; total: number; used: number}[]
		gpus?: {id: string; index: number; name: string; used: number | null}[]
		batteries?: SwarmBattery[]
		net?: {rx: number | null; tx: number | null} | null
		temp?: number | null
		uptime?: number
		updates?: number | null
	} | null
}
type Pairing = {token: string; ca: string; expiresAt: number; abilities: Abilities; source: string; port: number; addresses: {address: string; tailscale: boolean}[]}
type SwarmAlert = {id: string; agentId: string; name: string; kind: string; severity: 'info' | 'warning' | 'critical'; message: string}
type HistoryPoint = {at: number; cpu: number | null; memPct: number | null; diskPct: number | null; gpuPct: number | null; temp: number | null; netRx: number | null; netTx: number | null}

// What a Windows computer's or a Mac's connector can do (connector/agent.py WINDOWS_ABILITIES,
// MAC_ABILITIES). The rest needs Linux; the connector on the other computer drops what it can't do.
export const WINDOWS_ABILITIES: Ability[] = ['terminal', 'files', 'manage']
const EVERYWHERE: Ability[] = WINDOWS_ABILITIES

export const ABILITY: Record<Ability, {label: string; icon: IconName; what: string}> = {
	terminal: {label: 'Terminal', icon: 'terminal', what: 'A shell on it, as the person who installed the connector'},
	desktop: {label: 'Desktop', icon: 'devices', what: 'See and use its screen (Hyprland, Sway or an X11 desktop)'},
	manage: {label: 'Manage', icon: 'settings', what: 'Omarchy plugins (verified only) and themes, updates, restart, and wake up'},
	storage: {label: 'Storage', icon: 'disk', what: 'See its drives, format extra disks, and manage pools on that computer'},
	backup: {label: 'Backups', icon: 'history', what: 'Back up folders you choose to this server, on a schedule (open this computer and choose Backups). It can add backups, never delete them.'},
	services: {label: 'Services', icon: 'server', what: 'Inspect logs and start, stop, or restart user systemd services and containers'},
	files: {label: 'Files', icon: 'folder', what: 'Read and write the home folder of the person who installed the connector. The connector’s own keys stay off limits.'},
	vms: {label: 'Virtual machines', icon: 'machine', what: 'Create and run virtual machines on this computer'},
}
export const agentMay = (a: Agent, k: Ability) => !!(a.allowed[k] && a.on[k])
const may = agentMay
const pct = (u?: {total: number; used: number}) => (u && u.total ? Math.round((100 * u.used) / u.total) : null)
const look = (a: Agent) => osLook(a.info?.omarchy ? 'omarchy' : (a.info?.osId ?? ''))
const ago = (t: number | null) => (!t ? 'never' : Date.now() - t < 60_000 ? 'just now' : `${duration((Date.now() - t) / 1000)} ago`)

export const useSwarm = () => useQuery({queryKey: ['swarm.list'], queryFn: () => query<Agent[]>('swarm.list'), refetchInterval: 3000})

export function useSwarmAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input: unknown; done?: string}) => mutate(a.path, a.input).then(() => a.done),
		onSuccess: (done) => (done && toast(done), qc.invalidateQueries({queryKey: ['swarm.list']})),
		onError: (e) => toast((e as Error).message, true),
	})
}

// The section in Machines (phone) and the Local swarm view in the desktop's Machines window.
export function LocalSwarm({
	heading = true,
	hideList = false,
	onlyId,
	selectedId: selectedProp,
	onSelect,
	adding: addingProp,
	onAdding,
	bare,
	vms = [],
	onCreateVm,
	onOpenVm,
	onOpenApp,
	layout = 'page',
}: {
	heading?: boolean
	/** The phone fleet list owns the rows. Sheets still open for the selected computer. */
	hideList?: boolean
	onlyId?: string
	selectedId?: string | null
	onSelect?: (id: string | null) => void
	adding?: boolean
	onAdding?: (open: boolean) => void
	/** Desktop Machines window: the page sits in the split, not over the screen. */
	bare?: boolean
	vms?: Machine[]
	onCreateVm?: (host: {id: string; name: string}) => void
	onOpenVm?: (id: string) => void
	onOpenApp?: (app: UserApp) => void
	/** Compact Machines: the computer page uses the virtual-machine frame. */
	layout?: 'page' | 'nav'
} = {}) {
	const swarm = useSwarm()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(swarm, browserOnline)
	const list = (swarm.data ?? []).filter((a) => !isGuestAgent(a) && (!onlyId || a.id === onlyId))
	const [innerSel, setInnerSel] = useState<string | null>(null)
	const [innerAdd, setInnerAdd] = useState(false)
	const selectedId = selectedProp !== undefined ? selectedProp : innerSel
	const setSelectedId = (id: string | null) => {
		onSelect?.(id)
		if (selectedProp === undefined) setInnerSel(id)
	}
	const adding = addingProp !== undefined ? addingProp : innerAdd
	const setAdding = (open: boolean) => {
		onAdding?.(open)
		if (addingProp === undefined) setInnerAdd(open)
	}
	const [terminal, setTerminal] = useState<{agent: Agent; input?: string} | null>(null)
	const [screen, setScreen] = useState<Agent | null>(null)
	const desk = useDesktop()
	const selected = (swarm.data ?? []).find((a) => a.id === selectedId && !isGuestAgent(a)) ?? null
	const online = list.filter((a) => a.online).length
	const outdated = list.filter((a) => a.online && may(a, 'manage') && a.updateAvailable)
	const alertsQuery = useQuery({queryKey: ['swarm.alerts'], queryFn: () => query<SwarmAlert[]>('swarm.alerts'), refetchInterval: 10_000, enabled: list.length > 0})
	const alerts = (alertsQuery.data ?? []).filter((al) => (al.severity === 'warning' || al.severity === 'critical') && list.some((a) => a.id === al.agentId))
	const act = useSwarmAction()
	const sheets = (
		<>
			{selected && !terminal && !screen && (
				<AgentSheet
					key={selected.id}
					a={selected}
					bare={bare}
					layout={layout}
					vms={hostedVms(vms, selected.id)}
					onCreateVm={onCreateVm ? () => onCreateVm({id: selected.id, name: selected.name}) : undefined}
					onOpenVm={onOpenVm}
					onOpenApp={onOpenApp}
					onClose={() => setSelectedId(null)}
					onTerminal={(input) => setTerminal({agent: selected, input})}
					onDesktop={() => {
						// The same viewer as a virtual machine's: a window on the desktop, full screen on a phone.
						if (desk) desk.openConsole(`agent-${selected.id}`, selected.name)
						else setScreen(selected)
					}}
				/>
			)}
			{adding && <AddComputer before={(swarm.data ?? []).map((a) => a.id)} onClose={() => setAdding(false)} onJoined={(id) => (setAdding(false), setSelectedId(id))} />}
			{terminal && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" role="status" aria-label="Loading" />
						</main>
					}
				>
					<TerminalScreen agent={{id: terminal.agent.id, name: terminal.agent.name}} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
			)}
			{screen && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" role="status" aria-label="Loading" />
						</main>
					}
				>
					<Console machine={{id: `agent-${screen.id}`, name: screen.name, state: 'running'}} onClose={() => setScreen(null)} />
				</Suspense>
			)}
		</>
	)
	if (hideList) return sheets
	return (
		<section className="swarm">
			{heading && (
				<div className="section-head">
					<h2>Local swarm</h2>
					<div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
						{outdated.length > 0 && (
							<button className="btn small" disabled={act.isPending} onClick={() => (haptic(6), act.mutate({path: 'swarm.updateAllConnectors', input: {}, done: `Updating ${outdated.length} connector${outdated.length === 1 ? '' : 's'}…`}))}>
								<Icon name="update" size={15} /> Update connectors ({outdated.length})
							</button>
						)}
						<button className="btn small" onClick={() => (haptic(6), setAdding(true))}>
							<Icon name="plus" size={16} stroke={2.4} /> Add a computer
						</button>
					</div>
				</div>
			)}
			{!heading && (
				<div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12}}>
					<span className="muted" style={{flex: 1}}>
						{list.length ? `${online} of ${list.length} online` : 'Other Linux computers joined to this server'}
					</span>
					{outdated.length > 0 && (
						<button className="btn small" disabled={act.isPending} onClick={() => act.mutate({path: 'swarm.updateAllConnectors', input: {}, done: `Updating ${outdated.length} connector${outdated.length === 1 ? '' : 's'}…`})}>
							<Icon name="update" size={15} /> Update connectors ({outdated.length})
						</button>
					)}
					<button className="btn small primary" onClick={() => setAdding(true)}>
						<Icon name="plus" size={15} /> Add a computer
					</button>
				</div>
			)}
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{alerts.length > 0 && (
				<div className="glass" role="status" style={{padding: '10px 14px', marginBottom: 12, display: 'grid', gap: 6}}>
					{alerts.slice(0, 4).map((al) => (
						<button key={al.id} type="button" onClick={() => setSelectedId(al.agentId)} style={{display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 0, padding: 0, color: al.severity === 'critical' ? 'var(--red)' : 'var(--yellow)', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer'}}>
							<Icon name="alert" size={16} />
							<span>{al.message}</span>
						</button>
					))}
				</div>
			)}
			{list.map((a) => (
				<AgentCard key={a.id} a={a} onClick={() => (haptic(6), setSelectedId(a.id))} />
			))}
			{!problem && swarm.isSuccess && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="devices" size={30} />
					</span>
					<b>No computers yet</b>
					<span>Join your other Linux computers (Omarchy, Ubuntu, Debian, Fedora, Arch, openSUSE…) to watch them, open a terminal or their desktop, and manage them from here.</span>
					<button className="btn primary small" onClick={() => setAdding(true)}>
						Add a computer
					</button>
				</div>
			)}
			{sheets}
		</section>
	)
}

export function AgentCard({a, onClick, footer, extra, className}: {a: Agent; onClick: () => void; footer?: ReactNode; extra?: ReactNode; className?: string}) {
	const os = look(a)
	const m = a.metrics
	return (
		<div className={`glass vm-card${className ? ` ${className}` : ''}`}>
			<span className="top">
				<span className="vm-os" style={{background: os.bg, filter: a.online ? undefined : 'grayscale(.7) brightness(.85)'}}>
					<Icon name={os.icon} size={26} />
				</span>
				<span className="main" style={{flex: 1, minWidth: 0}}>
					<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{a.name}</b>
					<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 4}}>
						{a.info?.os ?? 'Linux'}
						{a.online ? '' : ` · seen ${ago(a.lastSeen)}`}
					</span>
				</span>
				<StatusPill kind={a.online ? 'running' : 'stopped'} label={a.online ? 'Online' : 'Offline'} />
				<button type="button" className="btn small" onClick={onClick}>
					Open
				</button>
			</span>
			{a.online && m && (
				<div className="specs">
					<LiveStats metrics={m} temp={typeof m.temp === 'number' ? m.temp : null} posture={a.info?.posture} machineName={a.name} />
					{!!m.updates && (
						<StatChip icon="update" label="Updates">
							{m.updates} update{m.updates === 1 ? '' : 's'}
						</StatChip>
					)}
				</div>
			)}
			{footer}
			{extra}
		</div>
	)
}

export function ConnectorControls({a, onTerminal, power = true}: {a: Agent; onTerminal: (input?: string) => void; power?: boolean}) {
	const act = useSwarmAction()
	const confirm = useConfirm()
	const [plugins, setPlugins] = useState(false)
	const [reauth, setReauth] = useState(false)
	const manage = agentMay(a, 'manage') && a.online
	const m = a.metrics
	return (
		<>
			{agentMay(a, 'manage') && (
				<SheetGroup title="Manage">
					{a.updateAvailable && (
						<Row
							icon="update"
							color="var(--accent)"
							label="Update connector"
							sub={a.helperUpdateAvailable ? 'Updates the connector and reconnects. Run Change permissions later to update the storage helper too.' : 'Updates the connector on this computer and reconnects automatically'}
							onClick={manage && !act.isPending ? () => act.mutate({path: 'swarm.updateConnector', input: {id: a.id}, done: `Updating connector on ${a.name}…`}) : undefined}
							disabled={!a.online || act.isPending}
						/>
					)}
					{a.info?.updateCommand && (
						<Row
							icon="update"
							color="#2fbf71"
							label="Update"
							sub={m?.updates ? `${m.updates} waiting · opens a terminal with ${a.info.updateCommand}` : `Opens a terminal with ${a.info.updateCommand} ready (you press Enter)`}
							onClick={agentMay(a, 'terminal') && a.online ? () => onTerminal(a.info!.updateCommand!) : undefined}
							disabled={!a.online}
						/>
					)}
					{a.info?.omarchy && (
						<>
							<Row
								icon="palette"
								color="#a855f7"
								label="Theme"
								trailing={
									<ThemePicker
										themes={a.info?.themes ?? []}
										theme={a.info?.theme ?? ''}
										disabled={!manage || act.isPending}
										onPick={(theme) => {
											const call = themeAction({kind: 'computer', id: a.id, theme})
											if ('path' in call) act.mutate({path: call.path, input: call.input, done: `Setting ${theme} on ${a.name}…`})
										}}
									/>
								}
							/>
							<Row icon="puzzle" color="var(--accent)" label="Omarchy plugins" sub={`${a.info.plugins?.length ?? 0} installed`} onClick={manage ? () => setPlugins(true) : undefined} />
						</>
					)}
					{power && (
						<>
							<Row
								icon="power"
								color="#f59e0b"
								label="Suspend"
								onClick={
									manage
										? async () => {
												if (await confirm({title: `Suspend ${a.name}?`, body: 'It goes to sleep right away. Wake it with Wake-on-LAN or its power button.', confirm: 'Suspend', icon: 'power'}))
													act.mutate({path: 'swarm.action', input: {id: a.id, name: 'suspend'}, done: `Suspending ${a.name}…`})
											}
										: undefined
								}
							/>
							<Row
								icon="power"
								color="#ef5350"
								label="Restart"
								onClick={
									manage
										? async () => {
												if (await confirm({title: `Restart ${a.name}?`, body: 'Anything open on it closes. It joins again by itself once it’s back up.', confirm: 'Restart', icon: 'power'}))
													act.mutate({path: 'swarm.action', input: {id: a.id, name: 'reboot'}, done: `Restarting ${a.name}…`})
											}
										: undefined
								}
							/>
							<Row
								icon="power"
								color="#dc2626"
								label="Shut down"
								onClick={
									manage
										? async () => {
												if (await confirm({title: `Shut down ${a.name}?`, body: 'Anything open on it closes and the computer powers off.', confirm: 'Shut down', icon: 'power'}))
													act.mutate({path: 'swarm.action', input: {id: a.id, name: 'shutdown'}, done: `Shutting down ${a.name}…`})
											}
										: undefined
								}
							/>
						</>
					)}
				</SheetGroup>
			)}
			<SheetGroup title="Allowed here">
				<Row icon="sparkle" color="#2fbf71" label="Watch" sub="Always on: CPU, memory, disks, GPU, battery, temperature, updates" />
				{(Object.keys(ABILITY) as Ability[]).map((k) => (
					<Row
						key={k}
						icon={ABILITY[k].icon}
						label={ABILITY[k].label}
						sub={a.allowed[k] ? ABILITY[k].what : 'Not allowed when it joined. Use Change permissions to allow it without removing this computer.'}
						trailing={<Switch on={agentMay(a, k)} disabled={!a.allowed[k] || act.isPending} label={ABILITY[k].label} onChange={(v) => act.mutate({path: 'swarm.setAbilities', input: {id: a.id, [k]: v}})} />}
					/>
				))}
				<Row icon="key" color="var(--accent)" label="Change permissions" sub="Update what this server may do here without losing its name or backups" onClick={() => setReauth(true)} />
			</SheetGroup>
			{plugins && <AgentPlugins a={a} onClose={() => setPlugins(false)} />}
			{reauth && <ReauthorizeComputer a={a} onTerminal={onTerminal} onClose={() => setReauth(false)} />}
		</>
	)
}

function AgentSheet({
	a,
	onClose,
	onTerminal,
	onDesktop,
	bare,
	layout = 'page',
	vms = [],
	onCreateVm,
	onOpenVm,
	onOpenApp,
}: {
	a: Agent
	onClose: () => void
	onTerminal: (input?: string) => void
	onDesktop: () => void
	bare?: boolean
	layout?: 'page' | 'nav'
	vms?: Machine[]
	onCreateVm?: () => void
	onOpenVm?: (id: string) => void
	onOpenApp?: (app: UserApp) => void
}) {
	const os = look(a)
	const act = useSwarmAction()
	const confirm = useConfirm()
	const user = useUser()
	const owner = isOwner(user.data)
	const [name, setName] = useState(a.name)
	const [backups, setBackups] = useState(false)
	const [storage, setStorage] = useState(false)
	const [services, setServices] = useState(false)
	const [tab, setTab] = useState(layout === 'nav' ? 'summary' : 'files')
	const m = a.metrics
	const desk = a.info?.desktop
	const offline = !a.online
	const wake = wakeOffer(a)
	if (storage) return <StoragePanel bare={bare} target={{agentId: a.id, name: a.name}} onClose={() => setStorage(false)} />
	if (backups) return <ComputerBackups id={a.id} name={a.name} onClose={() => setBackups(false)} />
	if (services) return <AgentServices a={a} onClose={() => setServices(false)} />
	const tabs: MachineTab[] = [
		...(may(a, 'files')
			? [
					{
						id: 'files',
						label: 'Files',
						body: !a.online ? (
							<p className="reason">{a.name} is offline.</p>
						) : (
							<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
								<MachineFiles scope={{kind: 'computer', id: a.id, name: a.name}} windowId={`machine:${a.id}`} />
							</Suspense>
						),
					},
				]
			: []),
		{
			id: 'clips',
			label: 'Clip book',
			body: <ClipBook here={computerHere({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on})} readings={owner && a.online} />,
		},
		...(a.online
			? [
					{
						id: 'apps',
						label: 'Apps',
						body: <Row icon="store" color="var(--accent)" label="App Store" sub="Installs on this computer" onClick={() => (haptic(6), onClose(), openStore({id: a.id, kind: 'computer', name: a.name}))} />,
					},
				]
			: []),
		...(a.allowed.services
			? [
					{
						id: 'services',
						label: 'Services',
						body: (
							<Row
								icon="server"
								color="#6366f1"
								label="Services"
								sub={offline ? undefined : may(a, 'services') ? 'User services, failed system units, and containers' : 'Switched off. Turn Services on under Manage.'}
								onClick={a.online && may(a, 'services') ? () => (haptic(8), setServices(true)) : undefined}
								disabled={offline || !may(a, 'services')}
							/>
						),
					},
				]
			: []),
		{
			id: 'storage',
			label: 'Storage',
			body: (
				<Row
					icon="disk"
					color="var(--teal)"
					label="Storage"
					sub={offline ? undefined : storageRowSub(a.allowed.storage, a.on.storage)}
					onClick={a.online && may(a, 'storage') ? () => (haptic(8), setStorage(true)) : undefined}
					disabled={offline}
				/>
			),
		},
		...((may(a, 'vms') && a.libvirt) || vms.length
			? [
					{
						id: 'machines',
						label: 'Virtual machines',
						body: (
							<>
								{vms.length === 0 ? (
									<p className="quiet">No virtual machines on {a.name}.</p>
								) : (
									vms.map((vm) => (
										<Row key={vm.id} icon="machine" label={vm.name} sub="Virtual machine" onClick={onOpenVm ? () => (haptic(6), onOpenVm(vm.id)) : undefined} />
									))
								)}
								{onCreateVm && may(a, 'vms') && a.libvirt && (
									<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), onCreateVm())}>
										<Icon name="plus" size={15} /> Create VM
									</button>
								)}
							</>
						),
					},
				]
			: []),
		{
			id: 'backups',
			label: 'Backups',
			body: (
				<Row
					icon="history"
					color="var(--green)"
					label="Backups"
					sub={a.allowed.backup ? (a.on.backup ? 'Folders on this computer, on a schedule' : 'Switched off here. Turn Backups on under Allowed here.') : 'Pair this computer again with Backups switched on.'}
					onClick={() => (haptic(8), setBackups(true))}
				/>
			),
		},
		{
			id: 'manage',
			label: 'Manage',
			body: (
				<>
					<ConnectorControls a={a} onTerminal={onTerminal} power={layout !== 'nav'} />
					<SheetGroup title="About">
						<div className="row static" style={{minHeight: 56, gap: 10}}>
							<input
								aria-label="Name"
								value={name}
								maxLength={48}
								onChange={(e) => setName(e.target.value)}
								style={{flex: 1, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontWeight: 600, padding: '0 6px'}}
							/>
							<button className="btn small" disabled={!name.trim() || name.trim() === a.name} onClick={() => act.mutate({path: 'swarm.rename', input: {id: a.id, name: name.trim()}, done: 'Renamed'})}>
								Rename
							</button>
						</div>
						{a.info && (
							<>
								<Row icon="server" color="#8e8e93" label={a.info.os ?? 'Linux'} sub={`${a.info.kernel ?? ''} · ${a.info.arch ?? ''}`} />
								<Row icon="user" color="#8e8e93" label={`Runs as ${a.info.user ?? '?'}`} sub={`on ${a.info.hostname ?? '?'} · connector ${a.info.version ?? '?'}`} />
							</>
						)}
						<Row icon="history" color="#8e8e93" label="Joined" sub={new Date(a.enrolledAt).toLocaleString()} />
					</SheetGroup>
					<button
						className="btn danger"
						style={{width: '100%', marginTop: 20}}
						onClick={async () => {
							if (
								await confirm({
									title: `Remove ${a.name}?`,
									body: 'It’s cut off from this server straight away. If it’s online, its connector forgets this server and stops; if it’s offline, it’s refused when it comes back. To remove the connector from that computer too, run the uninstall command shown in Add a computer.',
									confirm: 'Remove',
									icon: 'trash',
								})
							)
								act.mutate({path: 'swarm.remove', input: {id: a.id}, done: `${a.name} removed`}, {onSuccess: onClose})
						}}
					>
						<Icon name="trash" size={18} /> Remove from swarm
					</button>
				</>
			),
		},
	]
	if (layout === 'nav') {
		return <ComputerDetail a={a} tabs={tabs} tab={tab} onTab={setTab} onTerminal={onTerminal} onDesktop={onDesktop} onOpenApp={onOpenApp} />
	}
	return (
		<MachineShell bare={bare} label={a.name} onClose={onClose}>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={a.name}
				subtitle={
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
						<StatusPill kind={a.online ? 'running' : 'stopped'} label={a.online ? 'Online' : `Offline · seen ${ago(a.lastSeen)}`} />
					</span>
				}
				onClose={onClose}
			/>
			<MachineActions terminal={!offline && may(a, 'terminal')} desktop={!offline && may(a, 'desktop') && desk?.ok !== false} onTerminal={() => onTerminal()} onDesktop={onDesktop} pin={<PinButton pin={{kind: 'machine', id: a.id, computer: ''}} name={a.name} />} />
<DesktopHelp a={a} onTerminal={onTerminal} />
			{a.online && m && <LiveStats metrics={m} temp={typeof m.temp === 'number' ? m.temp : null} posture={a.info?.posture} machineName={a.name} />}
			<MachineSeen online={a.online} uptime={m?.uptime} lastSeen={a.lastSeen} />
			{a.online && <HistorySparklines agentId={a.id} />}
			{wake && (
				<div style={{marginTop: 12}}>
					<button
						className="btn primary"
						style={{width: '100%'}}
						disabled={!wake.enabled || act.isPending}
						title={wake.why || undefined}
						onClick={
							wake.enabled
								? async () => {
										if (await confirm({title: `Wake up ${a.name}?`, body: 'This sends a wake packet on the local network from this server and every computer that is on. The computer needs Wake-on-LAN switched on, and it has to be on one of those networks.', confirm: 'Wake up', icon: 'power'}))
											act.mutate({path: 'swarm.wake', input: {id: a.id}, done: `Waking ${a.name}…`})
									}
								: undefined
						}
					>
						<Icon name="power" size={18} /> Wake up
					</button>
					{!wake.enabled && wake.why ? <p className="quiet" style={{marginTop: 8}}>{wake.why}</p> : null}
				</div>
			)}
			{a.online && m && (extraDisks(m.disks).length > 0 || (m.net && (m.net.rx != null || m.net.tx != null))) && (
				<div className="glass group machine-extra">
					{extraDisks(m.disks).map((d) => (
						<Row key={d.mount} icon="disk" color="#f0a020" label={d.mount} sub={`${bytes(d.used)} of ${bytes(d.total)}`} trailing={<b>{pct(d)}%</b>} />
					))}
					{m.net && (m.net.rx != null || m.net.tx != null) && <Row icon="network" color="#3b82f6" label="Network" trailing={<b>↓ {bytes(m.net.rx ?? 0)}/s · ↑ {bytes(m.net.tx ?? 0)}/s</b>} />}
				</div>
			)}
			<MachineTabs label={`${a.name} sections`} tabs={tabs} tab={tab} onTab={setTab} />
		</MachineShell>
	)
}

function ComputerDetail({
	a,
	tabs,
	tab,
	onTab,
	onTerminal,
	onDesktop,
	onOpenApp,
}: {
	a: Agent
	tabs: MachineTab[]
	tab: string
	onTab: (id: string) => void
	onTerminal: (input?: string) => void
	onDesktop: () => void
	onOpenApp?: (app: UserApp) => void
}) {
	const os = look(a)
	const act = useSwarmAction()
	const confirm = useConfirm()
	const desk = a.info?.desktop
	const offline = !a.online
	const wake = wakeOffer(a)
	const m = a.metrics
	const manage = !offline && may(a, 'manage')
	const sections: DetailSection[] = [
		{id: 'summary', label: 'Summary', icon: 'activity'},
		...tabs.map((item) => ({id: item.id, label: item.label, icon: sectionIcon(item.id)})),
	]
	const current = sections.some((item) => item.id === tab) ? tab : 'summary'
	const power = (action: 'suspend' | 'reboot' | 'shutdown', title: string, body: string, confirmLabel: string, done: string) => async () => {
		if (await confirm({title, body, confirm: confirmLabel, icon: 'power'})) act.mutate({path: 'swarm.action', input: {id: a.id, name: action}, done})
	}
	return (
		<DetailFrame
			name={a.name}
			facts={a.info?.hostname ? [{label: 'Hostname', value: a.info.hostname}] : []}
			icon={os.icon}
			iconBg={os.bg}
			status={<StatusPill kind={a.online ? 'running' : 'stopped'} label={a.online ? 'Online' : 'Offline'} />}
			navLabel={`${a.name} sections`}
			sections={sections}
			section={current}
			onSection={onTab}
			store={
				a.online ? (
					<button type="button" className="btn small" title="Installs on this computer" onClick={() => (haptic(6), openStore({id: a.id, kind: 'computer', name: a.name}))}>
						<Icon name="store" size={14} /> App Store
					</button>
				) : undefined
			}
			toolbar={
				manage || wake?.enabled ? (
					<div className="pve-toolbar">
						{manage && (
							<>
								<button type="button" className="btn small" disabled={act.isPending} onClick={power('suspend', `Suspend ${a.name}?`, 'It goes to sleep right away. Wake it with Wake-on-LAN or its power button.', 'Suspend', `Suspending ${a.name}…`)}>
									<Icon name="power" size={14} /> Suspend
								</button>
								<button type="button" className="btn small" disabled={act.isPending} onClick={power('reboot', `Restart ${a.name}?`, 'Anything open on it closes. It joins again by itself once it’s back up.', 'Restart', `Restarting ${a.name}…`)}>
									<Icon name="restart" size={14} /> Restart
								</button>
								<button type="button" className="btn small" disabled={act.isPending} onClick={power('shutdown', `Shut down ${a.name}?`, 'Anything open on it closes and the computer powers off.', 'Shut down', `Shutting down ${a.name}…`)}>
									<Icon name="power" size={14} /> Shut down
								</button>
							</>
						)}
						{wake?.enabled && (
							<button
								type="button"
								className="btn small"
								disabled={act.isPending}
								onClick={async () => {
									if (await confirm({title: `Wake up ${a.name}?`, body: 'This sends a wake packet on the local network from this server and every computer that is on. The computer needs Wake-on-LAN switched on, and it has to be on one of those networks.', confirm: 'Wake up', icon: 'power'}))
										act.mutate({path: 'swarm.wake', input: {id: a.id}, done: `Waking ${a.name}…`})
								}}
							>
								<Icon name="power" size={14} /> Wake up
							</button>
						)}
					</div>
				) : undefined
			}
		>
			{current === 'summary' ? (
				<>
					<MachineActions terminal={!offline && may(a, 'terminal')} desktop={!offline && may(a, 'desktop') && desk?.ok !== false} onTerminal={() => onTerminal()} onDesktop={onDesktop} pin={<PinButton pin={{kind: 'machine', id: a.id, computer: ''}} name={a.name} />} />
					<DesktopHelp a={a} onTerminal={onTerminal} />
					{a.online && m && <LiveStats metrics={m} temp={typeof m.temp === 'number' ? m.temp : null} posture={a.info?.posture} machineName={a.name} />}
					<MachineSeen online={a.online} uptime={m?.uptime} lastSeen={a.lastSeen} />
					{a.online && <HistorySparklines agentId={a.id} />}
					{wake && !wake.enabled && wake.why ? <p className="quiet">{wake.why}</p> : null}
					{a.online && m && (extraDisks(m.disks).length > 0 || (m.net && (m.net.rx != null || m.net.tx != null))) && (
						<div className="glass group machine-extra">
							{extraDisks(m.disks).map((d) => (
								<Row key={d.mount} icon="disk" color="#f0a020" label={d.mount} sub={`${bytes(d.used)} of ${bytes(d.total)}`} trailing={<b>{pct(d)}%</b>} />
							))}
							{m.net && (m.net.rx != null || m.net.tx != null) && <Row icon="network" color="#3b82f6" label="Network" trailing={<b>↓ {bytes(m.net.rx ?? 0)}/s · ↑ {bytes(m.net.tx ?? 0)}/s</b>} />}
						</div>
					)}
				</>
			) : current === 'storage' && a.online && may(a, 'storage') ? (
				<StoragePage target={{agentId: a.id, name: a.name}} />
			) : current === 'apps' ? (
				<MachineApps computerId={a.id} name={a.name} onOpenApp={onOpenApp} />
			) : (
				tabs.find((item) => item.id === current)?.body
			)}
		</DetailFrame>
	)
}

function sectionIcon(id: string): IconName {
	if (id === 'files') return 'folder'
	if (id === 'clips') return 'clipboard'
	if (id === 'apps') return 'store'
	if (id === 'services') return 'server'
	if (id === 'storage') return 'disk'
	if (id === 'machines') return 'machine'
	if (id === 'backups') return 'save'
	return 'settings'
}

type Plugin = {id: string; name: string; description?: string; author?: string}
export function AgentPlugins({a, onClose}: {a: Agent; onClose: () => void}) {
	const [q, setQ] = useState('')
	const act = useSwarmAction()
	const confirm = useConfirm()
	const installed = new Set(a.info?.plugins ?? [])
	// The same verified list as the App Store (plugins.omarchy.org, verified, pinned).
	const page = useQuery({
		queryKey: ['omarchy.plugins', q, '', 'stars', 60],
		queryFn: () => query<{plugins: Plugin[]}>('omarchy.plugins', {q, category: '', sort: 'stars', limit: 60}),
		placeholderData: (prev) => prev,
	})
	const list = page.data?.plugins ?? []
	// The Installed rows read their names from the whole list, not from what the search shows.
	const names = useQuery({
		queryKey: ['omarchy.plugins', 'names'],
		queryFn: () => loadPluginNames((offset) => query<{total: number; plugins: Plugin[]}>('omarchy.plugins', {q: '', category: '', sort: 'stars', limit: 60, offset}), 60),
		staleTime: 5 * 60_000,
	})
	return (
		<Sheet open onClose={onClose} label={`Plugins on ${a.name}`} tall>
			<SheetHeader icon={<Icon name="puzzle" size={30} />} title="Omarchy plugins" subtitle={`On ${a.name}`} onClose={onClose} />
			<p className="muted" style={{fontSize: 13, margin: '0 4px 10px'}}>
				Only plugins the Omarchy plugin registry verified, installed at the exact version it checked. They run inside that computer’s Omarchy desktop with its user’s permissions.
			</p>
			{installed.size > 0 && (
				<SheetGroup title="Installed">
					{[...installed].map((id) => (
						<Row
							key={id}
							icon="puzzle"
							label={names.data?.get(id) ?? list.find((p) => p.id === id)?.name ?? id}
							trailing={
								<button
									className="btn small"
									disabled={act.isPending}
									onClick={async () => {
										if (await confirm({title: `Remove ${id}?`, body: `It’s turned off and removed from ${a.name}.`, confirm: 'Remove', danger: true, icon: 'trash'}))
											act.mutate({path: 'swarm.action', input: {id: a.id, name: 'plugin-remove', pluginId: id}, done: `Removed from ${a.name}`})
									}}
								>
									Remove
								</button>
							}
						/>
					))}
				</SheetGroup>
			)}
			<div className="field" style={{marginTop: 18}}>
				<input placeholder="Search verified plugins" value={q} onChange={(e) => setQ(e.target.value)} />
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{page.isLoading && <Row icon="puzzle" label="Loading…" />}
				{page.error && <Row icon="alert" label="Couldn’t load the plugin list" sub={errorText(page.error)} />}
				{list
					.filter((p) => !installed.has(p.id))
					.map((p) => (
						<Row
							key={p.id}
							icon="puzzle"
							label={p.name}
							sub={p.description}
							trailing={
								<button
									className="btn small primary"
									disabled={act.isPending}
									onClick={async () => {
										if (await confirm({title: `Install ${p.name} on ${a.name}?`, body: `By ${p.author || 'its author'}. Installed at the version the registry verified (an automated check, not a full security review).`, confirm: 'Install', icon: 'puzzle'}))
											act.mutate({path: 'swarm.action', input: {id: a.id, name: 'plugin-install', pluginId: p.id}, done: `${p.name} installed on ${a.name}`})
									}}
								>
									{act.isPending && act.variables?.input && (act.variables.input as {pluginId?: string}).pluginId === p.id ? <><span className="spinner" /><span className="sr-only">Install</span></> : 'Install'}
								</button>
							}
						/>
					))}
			</div>
		</Sheet>
	)
}

// ---- Add a computer: what it may do → the command → step by step → it appears. ----------------
export function AddComputer({before, onClose, onJoined, guest}: {before: string[]; onClose: () => void; onJoined: (id: string) => void; guest?: {id: string; name: string; osId?: string}}) {
	const [beforeIds] = useState(before)
	// Storage can format disks there, so it's a choice you make. A guest watches, and can open files,
	// a terminal, and a desktop. Backups stay off: a guest does not back up through this yet.
	const [allow, setAllow] = useState<Abilities>(
		guest
			? {terminal: true, desktop: true, manage: true, storage: false, backup: false, services: false, files: true, vms: false}
			: {terminal: true, desktop: true, manage: true, storage: false, backup: true, services: false, files: false, vms: false},
	)
	const [pairing, setPairing] = useState<Pairing | null>(null)
	// One set of permissions for any computer: the same one-time code works from Linux, a Mac or
	// Windows, and each connector keeps only what it can do there. Only the command differs.
	const [os, setOs] = useState<'unix' | 'windows'>(() => (/Windows/.test(navigator.userAgent) ? 'windows' : 'unix'))
	const windows = guest ? false : os === 'windows'
	const guestLinux = !guest || linuxConnectorOs(guest.osId ?? '')
	const shown = (Object.keys(ABILITY) as Ability[]).filter((k) => !guest || k !== 'vms')
	const asked = allow
	const [host, setHost] = useState('')
	const [copied, setCopied] = useState('')
	const [now, setNow] = useState(Date.now())
	const toast = useToast()
	const swarm = useSwarm()
	const pair = useMutation({
		mutationFn: () => mutate<Pairing>('swarm.pair', guest ? {...allow, vms: false, machineId: guest.id} : asked),
		onSuccess: (p) => {
			setPairing(p)
			const here = location.hostname
			const local = here === 'localhost' || here === '127.0.0.1' || here === '::1'
			setHost(local ? (p.addresses[0]?.address ?? here) : here)
		},
		onError: (e) => toast((e as Error).message, true),
	})
	useEffect(() => {
		if (!pairing) return
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [pairing])
	// The new computer, once it shows up. beforeIds is frozen at open so a live swarm.list cannot hide it.
	const joined = guest ? (swarm.data ?? []).find((a) => a.guestOf === guest.id && !beforeIds.includes(a.id)) : newlyJoined(swarm.data ?? [], beforeIds)
	const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
	const list = (Object.keys(asked) as Ability[]).filter((k) => asked[k]).join(',')
	const install = useMemo(() => {
		if (!pairing) return null
		const server = `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${pairing.port}`
		return (windows ? connectorInstallCommandWindows : connectorInstallCommand)({source: pairing.source, server, ca: pairing.ca, token: pairing.token, allow: list})
	}, [pairing, host, list, windows])
	const command = install?.command ?? ''
	const uninstall = install?.uninstall ?? ''
	const copy = async (text: string, what: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(what)
			haptic(8)
			setTimeout(() => setCopied(''), 2000)
		} catch {
			toast('Couldn’t copy. Select the text and copy it yourself.', true)
		}
	}
	const hosts = pairing ? [...new Set([location.hostname, ...pairing.addresses.map((x) => x.address)].filter((h) => h && h !== 'localhost' && h !== '127.0.0.1'))] : []

	return (
		<Sheet open onClose={onClose} label={guest ? 'Install connector' : 'Add a computer'} tall>
			<SheetHeader
				icon={<Icon name="devices" size={30} />}
				title={guest ? 'Install connector' : 'Add a computer'}
				subtitle={guest ? `Linux with systemd or Alpine OpenRC, inside ${guest.name}. Not Windows or Home Assistant.` : 'Linux (systemd or Alpine OpenRC), a Mac, or Windows 10 or later.'}
				onClose={onClose}
			/>
			{guest && !guestLinux ? (
				<p className="muted" style={{fontSize: 14, margin: '0 4px 12px'}}>
					This operating system can’t run the connector. It runs on Linux with systemd or Alpine OpenRC.
				</p>
			) : !pairing ? (
				<>
					<p className="muted" style={{fontSize: 14, margin: '0 4px 12px'}}>
						Choose what this server may do on the new computer. The connector there enforces it too. Later you can switch any of these off and on again from the computer’s page, and Change permissions there can allow more without removing it.
					</p>
					<div className="glass group wrap-sub" style={{'--inset': '62px'} as CSSProperties}>
						<Row icon="sparkle" color="#2fbf71" label="Watch" sub="Always: CPU, memory, disks, temperature, updates waiting" />
						{shown.map((k) => (
							<Row key={k} icon={ABILITY[k].icon} label={ABILITY[k].label} sub={guest || EVERYWHERE.includes(k) ? ABILITY[k].what : `${ABILITY[k].what} · Linux`} trailing={<Switch on={allow[k]} label={ABILITY[k].label} onChange={(v) => setAllow({...allow, [k]: v})} />} />
						))}
					</div>
					<button className="btn primary" style={{width: '100%', marginTop: 18}} disabled={pair.isPending} onClick={() => pair.mutate()}>
						{pair.isPending ? <span className="spinner" /> : <Icon name="key" size={18} />} Make the install command
					</button>
				</>
			) : joined ? (
				<div className="glass empty">
					<span className="big" style={{color: 'var(--ok, #2fbf71)'}}>
						<Icon name="check" size={30} />
					</span>
					<b>{joined.name} joined</b>
					<span>{guest ? 'Files, a terminal, and a desktop can open on this virtual machine now.' : 'It’s in your local swarm now.'}</span>
					<button className="btn primary small" onClick={() => onJoined(joined.id)}>
						{guest ? 'Done' : 'Open it'}
					</button>
				</div>
			) : (
				<>
					{!guest && (
						<div className="chips" role="radiogroup" aria-label="The other computer runs" style={{margin: '0 4px 12px'}}>
							{(['unix', 'windows'] as const).map((o) => (
								<button key={o} type="button" role="radio" aria-checked={os === o} className={`chip${os === o ? ' on' : ''}`} onClick={() => (haptic(5), setOs(o))}>
									{o === 'unix' ? 'Linux or Mac' : 'Windows'}
								</button>
							))}
						</div>
					)}
					<ol className="swarm-steps">
						<li>
							<b>{windows ? (guest ? 'On this virtual machine, open PowerShell' : 'On the Windows computer, open PowerShell') : guest ? 'On this virtual machine, open a terminal' : 'On the other computer, open a terminal (on a Mac: Terminal)'}</b>
							<span>{windows ? (guest ? 'Signed in as the person who uses it; no Administrator needed. The guest has to reach this server on the network.' : 'Signed in as the person who uses it; no Administrator needed. It needs Python 3.8 or later (winget install Python.Python.3.12) and to reach this server on your network (or your tailnet).') : guest ? 'Signed in as the person who uses it, not root. The guest has to reach this server on the network.' : 'Signed in as the person who uses it, not root. It finds the Linux distribution (or macOS) itself and needs to reach this server on your network (or your tailnet).'}</span>
						</li>
						{hosts.length > 1 && (
							<li>
								<b>Pick the address it reaches this server on</b>
								<span className="chips" style={{marginTop: 8}}>
									{hosts.map((h) => (
										<button key={h} className={`chip${h === host ? ' on' : ''}`} aria-pressed={h === host} onClick={() => setHost(h)}>
											{h}
											{pairing.addresses.find((x) => x.address === h)?.tailscale ? ' · Tailscale' : ''}
										</button>
									))}
								</span>
							</li>
						)}
						<li>
							<b>Paste this and press Enter</b>
							<p className="muted" style={{fontSize: 13, margin: '8px 0 10px', lineHeight: 1.45}}>
								It checks this server’s fingerprint before it pairs. The one-time code lasts about 15 minutes and works once. It can only do what you granted above. Fetching the installer may skip the TLS check; the installer then verifies the fingerprint before it trusts anything else.
							</p>
							<code className="swarm-cmd mono">{left ? command : 'This command has expired.'}</code>
							{left ? (
								<span style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 8}}>
									<button className="btn small primary" onClick={() => copy(command, 'cmd')}>
										<Icon name={copied === 'cmd' ? 'check' : 'copy'} size={15} /> {copied === 'cmd' ? 'Copied' : 'Copy'}
									</button>
									<span className="muted" style={{fontSize: 12.5}}>
										Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
									</span>
								</span>
							) : (
								<button className="btn small" style={{marginTop: 8}} onClick={() => (setPairing(null), pair.mutate())}>
									Make a new one
								</button>
							)}
						</li>
						<li>
							<b>Enter your password when it asks</b>
							<span>Only so it can install what it needs (Python, git, and screen sharing if Desktop is on) and keep running while you’re signed out. The connector itself runs as you, never as root.</span>
						</li>
						<li>
							<b>Wait here</b>
							<span style={{display: 'flex', alignItems: 'center', gap: 8}}>
								<span className="spinner" /> It appears as soon as it joins.
							</span>
						</li>
					</ol>
					<details className="muted" style={{fontSize: 13, margin: '16px 4px 0'}}>
						<summary>How it stays safe</summary>
						<p>
							The connector dials out to this server; the other computer opens no ports. It checks this server’s certificate against the fingerprint in the command before it sends anything, and the one-time code is
							useless after it’s used or after 15 minutes. It can only do what you allowed above, and there’s no “run any command” from here: the terminal is a shell you type into, and Manage is a short fixed
							list.
						</p>
						<p>
							To remove it from a computer later:
							<code className="swarm-cmd mono">{uninstall}</code>
						</p>
					</details>
				</>
			)}
		</Sheet>
	)
}

function Sparkline({values, max = 100, color, label, suffix = '%'}: {values: Array<number | null>; max?: number; color: string; label: string; suffix?: string}) {
	const clean = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
	const present = clean.filter((v): v is number => v !== null)
	if (present.length < 2) return null
	const latest = present[present.length - 1]
	const hi = Math.max(max, ...present, 1)
	const w = 120
	const h = 28
	const pts = clean
		.map((v, i) => (v === null ? null : `${((i / Math.max(1, clean.length - 1)) * w).toFixed(1)},${(h - (Math.min(hi, Math.max(0, v)) / hi) * (h - 4) - 2).toFixed(1)}`))
		.filter(Boolean)
		.join(' ')
	return (
		<div style={{display: 'grid', gap: 4}}>
			<div style={{display: 'flex', justifyContent: 'space-between', fontSize: 12}}>
				<span className="muted">{label}</span>
				<b>
					{Math.round(latest)}
					{suffix}
				</b>
			</div>
			<svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} aria-label={`${label} history`} style={{display: 'block'}}>
				<polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={pts} />
			</svg>
		</div>
	)
}

function HistorySparklines({agentId}: {agentId: string}) {
	const {tempUnit} = useStatView()
	const [range, setRange] = useState<'1h' | '24h'>('1h')
	const hist = useQuery({
		queryKey: ['swarm.history', agentId, range],
		queryFn: () => query<{id: string; range: '1h' | '24h'; points: HistoryPoint[]}>('swarm.history', {id: agentId, range}),
		refetchInterval: 10_000,
	})
	const points = hist.data?.points ?? []
	if (points.length < 2) return null
	return (
		<div className="glass" style={{marginTop: 12, padding: '12px 14px', display: 'grid', gap: 10}}>
			<div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
				<span className="muted" style={{fontSize: 12.5, fontWeight: 600}}>
					Recent history
				</span>
				<span className="chips">
					{(['1h', '24h'] as const).map((r) => (
						<button key={r} type="button" className={`chip${range === r ? ' on' : ''}`} onClick={() => setRange(r)}>
							{r}
						</button>
					))}
				</span>
			</div>
			<div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12}}>
				<Sparkline label="CPU" values={points.map((p) => p.cpu)} color="var(--accent)" />
				<Sparkline label="Memory" values={points.map((p) => p.memPct)} color="#38bdf8" />
				<Sparkline label="Temp" values={points.map((p) => (typeof p.temp === 'number' ? tempDegrees(p.temp, tempUnit) : p.temp))} max={tempUnit === 'f' ? tempDegrees(100, 'f') : 100} color="#ef5350" suffix={tempUnit === 'f' ? '°F' : '°C'} />
			</div>
		</div>
	)
}

type ServiceUnit = {name: string; scope: 'user' | 'system'; load: string; active: string; sub: string; description: string}
type ContainerItem = {id: string; name: string; image: string; state: string; status: string; engine: string}
type ServicesPayload = {systemd: ServiceUnit[]; systemFailed: ServiceUnit[]; containers: ContainerItem[]; engine: string}

function AgentServices({a, onClose}: {a: Agent; onClose: () => void}) {
	const [tab, setTab] = useState<'user' | 'containers' | 'failed'>('user')
	const [logTarget, setLogTarget] = useState<{kind: 'user' | 'system' | 'container'; name: string} | null>(null)
	const qc = useQueryClient()
	const toast = useToast()
	const data = useQuery({
		queryKey: ['swarm.services.list', a.id],
		queryFn: () => query<ServicesPayload>('swarm.services.list', {id: a.id}),
		refetchInterval: 8000,
	})
	const logs = useQuery({
		queryKey: ['swarm.services.logs', a.id, logTarget?.kind, logTarget?.name],
		queryFn: () => query<{logs: string}>('swarm.services.logs', {id: a.id, kind: logTarget!.kind, name: logTarget!.name, lines: 200}),
		enabled: !!logTarget,
	})
	const ctrl = useMutation({
		mutationFn: (p: {kind: 'user' | 'container'; name: string; action: 'start' | 'stop' | 'restart'}) => mutate('swarm.services.control', {id: a.id, ...p}),
		onSuccess: (_r, p) => (toast(`${p.action} sent to ${p.name}`), qc.invalidateQueries({queryKey: ['swarm.services.list', a.id]})),
		onError: (e) => toast((e as Error).message, true),
	})
	const payload = data.data
	return (
		<Sheet open onClose={onClose} label={`Services on ${a.name}`} tall>
			<SheetHeader icon={<Icon name="server" size={30} />} title="Services & Containers" subtitle={`On ${a.name}`} onClose={onClose} />
			<div className="chips" style={{marginBottom: 12}}>
				<button type="button" className={`chip${tab === 'user' ? ' on' : ''}`} onClick={() => setTab('user')}>
					User services ({payload?.systemd.length ?? 0})
				</button>
				<button type="button" className={`chip${tab === 'containers' ? ' on' : ''}`} onClick={() => setTab('containers')}>
					Containers ({payload?.containers.length ?? 0})
				</button>
				<button type="button" className={`chip${tab === 'failed' ? ' on' : ''}`} onClick={() => setTab('failed')}>
					Failed system ({payload?.systemFailed.length ?? 0})
				</button>
			</div>
			{data.isLoading && <p className="muted">Loading…</p>}
			{data.error && <div className="error" role="alert">{(data.error as Error).message}</div>}
			{tab === 'user' && payload && (
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{payload.systemd.length === 0 && <Row icon="server" label="No user services found" />}
					{payload.systemd.map((u) => (
						<Row
							key={u.name}
							icon="server"
							color={u.active === 'active' ? '#2fbf71' : u.active === 'failed' ? '#ef5350' : '#8e8e93'}
							label={u.name}
							sub={u.description || `${u.active} (${u.sub})`}
							trailing={
								<span style={{display: 'flex', gap: 6, alignItems: 'center'}}>
									<StatusPill kind={u.active === 'active' ? 'running' : 'stopped'} label={u.sub || u.active} />
									<button type="button" className="btn small" disabled={ctrl.isPending} onClick={() => ctrl.mutate({kind: 'user', name: u.name, action: u.active === 'active' ? 'restart' : 'start'})}>
										{u.active === 'active' ? 'Restart' : 'Start'}
									</button>
									{u.active === 'active' && (
										<button type="button" className="btn small" disabled={ctrl.isPending} onClick={() => ctrl.mutate({kind: 'user', name: u.name, action: 'stop'})}>
											Stop
										</button>
									)}
									<button type="button" className="btn small" onClick={() => setLogTarget({kind: 'user', name: u.name})}>
										Logs
									</button>
								</span>
							}
						/>
					))}
				</div>
			)}
			{tab === 'containers' && payload && (
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{payload.containers.length === 0 && <Row icon="server" label={payload.engine ? `No ${payload.engine} containers found` : 'No container runtime installed'} />}
					{payload.containers.map((c) => (
						<Row
							key={c.id || c.name}
							icon="server"
							color={c.state === 'running' ? '#2fbf71' : '#8e8e93'}
							label={c.name}
							sub={`${c.image}${c.status ? ` · ${c.status}` : ''}`}
							trailing={
								<span style={{display: 'flex', gap: 6, alignItems: 'center'}}>
									<StatusPill kind={c.state === 'running' ? 'running' : 'stopped'} label={c.state === 'running' ? 'Running' : 'Stopped'} />
									<button type="button" className="btn small" disabled={ctrl.isPending} onClick={() => ctrl.mutate({kind: 'container', name: c.name, action: c.state === 'running' ? 'restart' : 'start'})}>
										{c.state === 'running' ? 'Restart' : 'Start'}
									</button>
									{c.state === 'running' && (
										<button type="button" className="btn small" disabled={ctrl.isPending} onClick={() => ctrl.mutate({kind: 'container', name: c.name, action: 'stop'})}>
											Stop
										</button>
									)}
									<button type="button" className="btn small" onClick={() => setLogTarget({kind: 'container', name: c.name})}>
										Logs
									</button>
								</span>
							}
						/>
					))}
				</div>
			)}
			{tab === 'failed' && payload && (
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{payload.systemFailed.length === 0 && <Row icon="check" color="#2fbf71" label="No failed system services" />}
					{payload.systemFailed.map((u) => (
						<Row
							key={u.name}
							icon="alert"
							color="#ef5350"
							label={u.name}
							sub={u.description || `${u.active} (${u.sub}) · read-only`}
							trailing={
								<button type="button" className="btn small" onClick={() => setLogTarget({kind: 'system', name: u.name})}>
									Logs
								</button>
							}
						/>
					))}
				</div>
			)}
			{logTarget && (
				<div className="glass" style={{marginTop: 14, padding: 12}}>
					<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}>
						<b>Logs: {logTarget.name}</b>
						<button type="button" className="btn small" onClick={() => setLogTarget(null)}>
							Close
						</button>
					</div>
					<pre className="mono" style={{maxHeight: 260, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', margin: 0}}>
						{logs.isLoading ? 'Loading logs…' : logs.error ? (logs.error as Error).message : (logs.data?.logs ?? 'No log lines.')}
					</pre>
				</div>
			)}
		</Sheet>
	)
}

type RemoteFile = {name: string; path: string; isDir: boolean; size: number; modified: number}

export function AgentFiles({a, onClose}: {a: Agent; onClose: () => void}) {
	const [path, setPath] = useState('/Home')
	const [busy, setBusy] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const dir = useQuery({
		queryKey: ['swarm.files.list', a.id, path],
		queryFn: () => query<{path: string; items: RemoteFile[]}>('swarm.files.list', {id: a.id, path}),
	})
	const refresh = () => qc.invalidateQueries({queryKey: ['swarm.files.list', a.id, path]})
	const parentPath = path === '/' ? null : path.split('/').filter(Boolean).length <= 1 ? '/' : '/' + path.split('/').filter(Boolean).slice(0, -1).join('/')

	const createFolder = async () => {
		const name = window.prompt('New folder name')
		if (!name?.trim()) return
		try {
			await mutate('swarm.files.mkdir', {id: a.id, path: `${path.replace(/\/+$/, '')}/${name.trim()}`})
			toast('Folder created')
			refresh()
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const renameItem = async (item: RemoteFile) => {
		const next = window.prompt('New name', item.name)
		if (!next?.trim() || next.trim() === item.name) return
		try {
			await mutate('swarm.files.rename', {id: a.id, path: item.path, newName: next.trim()})
			toast('Renamed')
			refresh()
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const trashItem = async (item: RemoteFile) => {
		if (!(await confirm({title: `Move ${item.name} to Trash?`, body: `Moves it to ${a.name}’s Trash.`, confirm: 'Move to Trash', icon: 'trash'}))) return
		try {
			await mutate('swarm.files.trash', {id: a.id, path: item.path})
			toast('Moved to Trash')
			refresh()
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const copyToServer = async (item: RemoteFile) => {
		try {
			const res = await mutate<{path: string}>('swarm.files.copyToServer', {id: a.id, remotePath: item.path, serverDir: '/Home'})
			toast(`Copied to ${res.path} on this server`)
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const uploadFile = async (file: File) => {
		setBusy(true)
		try {
			const qs = new URLSearchParams({id: a.id, path: `${path.replace(/\/+$/, '')}/${file.name}`}).toString()
			const r = await fetch(`/api/swarm/files/upload?${qs}`, {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/octet-stream'}, body: file})
			if (!r.ok) {
				const err = await r.json().catch(() => null)
				throw new Error(err?.error?.message || err?.error || `Upload failed (${r.status})`)
			}
			toast(`Uploaded ${file.name}`)
			refresh()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet open onClose={onClose} label={`Files on ${a.name}`} tall>
			<SheetHeader icon={<Icon name="folder" size={30} />} title="Files" subtitle={`${a.name} · ${path}`} onClose={onClose} />
			<div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap'}}>
				{parentPath && (
					<button type="button" className="btn small" onClick={() => setPath(parentPath)}>
						<Icon name="back" size={15} /> Up
					</button>
				)}
				{path !== '/' && (
					<>
						<button type="button" className="btn small" onClick={createFolder}>
							<Icon name="folder-plus" size={15} /> New folder
						</button>
						<button type="button" className="btn small primary" disabled={busy} onClick={() => fileInput.current?.click()}>
							<Icon name="upload" size={15} /> {busy ? 'Uploading…' : 'Upload'}
						</button>
						<input
							ref={fileInput}
							type="file"
							style={{display: 'none'}}
							onChange={(e) => {
								const f = e.target.files?.[0]
								e.target.value = ''
								if (f) uploadFile(f)
							}}
						/>
					</>
				)}
			</div>
			{dir.isLoading && <p className="muted">Loading…</p>}
			{dir.error && <div className="error" role="alert">{(dir.error as Error).message}</div>}
			{dir.data && (
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{dir.data.items.length === 0 && <Row icon="folder" label="Empty folder" />}
					{dir.data.items.map((item) => (
						<Row
							key={item.path}
							icon={item.isDir ? 'folder' : 'file'}
							color={item.isDir ? '#38bdf8' : '#8e8e93'}
							label={item.name}
							sub={item.isDir ? 'Folder' : bytes(item.size)}
							onClick={item.isDir ? () => setPath(item.path) : undefined}
							trailing={
								path !== '/' ? (
									<span style={{display: 'flex', gap: 6, alignItems: 'center'}} onClick={(e) => e.stopPropagation()}>
										{!item.isDir && (
											<>
												<a className="btn small" href={`/api/swarm/files/download?${new URLSearchParams({id: a.id, path: item.path}).toString()}`}>
													Download
												</a>
												<button type="button" className="btn small" onClick={() => copyToServer(item)}>
													To server
												</button>
											</>
										)}
										<button type="button" className="btn small" onClick={() => renameItem(item)}>
											Rename
										</button>
										<button type="button" className="btn small" onClick={() => trashItem(item)}>
											Trash
										</button>
									</span>
								) : undefined
							}
						/>
					))}
				</div>
			)}
		</Sheet>
	)
}

// Why Desktop can't be used on a computer, with the fix one tap away: allow it (the computer runs a
// command that updates its permissions), or install its screen sharing in its own terminal.
const INSTALL: Record<string, string> = {pacman: 'sudo pacman -S --needed', apt: 'sudo apt install -y', dnf: 'sudo dnf install -y', zypper: 'sudo zypper install -y'}
export function desktopFix(a: Agent): {why: string; install?: string} | null {
	if (!a.online) return null
	if (!a.allowed.desktop) return {why: `Seeing ${a.name}’s screen wasn’t allowed when it joined.`}
	const d = a.info?.desktop
	if (!d || d.ok) return null
	const pkg = d.kind === 'wlroots' ? 'wayvnc' : d.kind === 'x11' ? 'x11vnc' : null
	const missing = pkg && /isn’t installed/.test(d.why ?? '')
	const cmd = missing && a.info?.pkg ? INSTALL[a.info.pkg] : undefined
	return {why: d.why ?? 'Its screen can’t be shared right now.', install: cmd && pkg ? `${cmd} ${pkg}` : undefined}
}
function DesktopHelp({a, onTerminal}: {a: Agent; onTerminal: (input?: string) => void}) {
	const [reauth, setReauth] = useState(false)
	const fix = desktopFix(a)
	if (!fix) return null
	return (
		<div className="desk-help" role="status">
			<Icon name="window" size={18} />
			<span>{fix.why}</span>
			{!a.allowed.desktop ? (
				<button type="button" className="btn small" onClick={() => (haptic(6), setReauth(true))}>
					Allow the desktop
				</button>
			) : fix.install && a.allowed.terminal ? (
				<button type="button" className="btn small" title={fix.install} onClick={() => (haptic(6), onTerminal(fix.install))}>
					Install screen sharing
				</button>
			) : null}
			{reauth && <ReauthorizeComputer a={a} onTerminal={onTerminal} onClose={() => setReauth(false)} />}
		</div>
	)
}

function ReauthorizeComputer({a, onClose, onTerminal}: {a: Agent; onClose: () => void; onTerminal?: (input?: string) => void}) {
	const [allow, setAllow] = useState<Abilities>({...a.allowed})
	const [before] = useState(() => JSON.stringify(a.allowed))
	const list = (Object.keys(allow) as Ability[]).filter((k) => allow[k]).join(',')
	const [pairing, setPairing] = useState<Pairing | null>(null)
	const [host, setHost] = useState('')
	const [copied, setCopied] = useState(false)
	const [now, setNow] = useState(Date.now())
	const toast = useToast()
	const swarm = useSwarm()
	const liveAgent = swarm.data?.find((x) => x.id === a.id) ?? a
	// Its connector is online with a terminal: run the update there instead of asking for a copy and paste.
	// The terminal is already a shell as that user, so this reaches no further than the user could by typing.
	const direct = Boolean(onTerminal && liveAgent.online && agentMay(liveAgent, 'terminal'))
	const [ran, setRan] = useState(false)
	const reauth = useMutation({
		mutationFn: () => mutate<Pairing>('swarm.reauthorize', {id: a.id, ...allow}),
		onSuccess: (p) => {
			setPairing(p)
			const here = location.hostname
			const local = here === 'localhost' || here === '127.0.0.1' || here === '::1'
			const h = local ? (p.addresses[0]?.address ?? here) : here
			setHost(h)
			if (direct && onTerminal) {
				const server = `https://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${p.port}`
				const make = a.info?.osId === 'windows' ? connectorInstallCommandWindows : connectorInstallCommand
				const cmd = make({source: p.source, server, ca: p.ca, token: p.token, allow: list}).command
				setRan(true)
				// Ctrl+U clears anything half-typed at a Unix prompt (PowerShell has no such key); Enter runs it.
				onTerminal(`${a.info?.osId === 'windows' ? '' : '\x15'}${cmd}\r`)
			}
		},
		onError: (e) => toast((e as Error).message, true),
	})
	useEffect(() => {
		if (!pairing) return
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [pairing])
	const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
	const command = useMemo(() => {
		if (!pairing) return ''
		const server = `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${pairing.port}`
		// A Windows computer updates from PowerShell; Linux and a Mac from their terminal.
		const make = a.info?.osId === 'windows' ? connectorInstallCommandWindows : connectorInstallCommand
		return make({source: pairing.source, server, ca: pairing.ca, token: pairing.token, allow: list}).command
	}, [pairing, host, list, a.info?.osId])
	const hosts = pairing ? [...new Set([location.hostname, ...pairing.addresses.map((x) => x.address)].filter((h) => h && h !== 'localhost' && h !== '127.0.0.1'))] : []
	const updated = Boolean(pairing && JSON.stringify(liveAgent.allowed) !== before)
	const copy = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(true)
			haptic(8)
			setTimeout(() => setCopied(false), 2000)
		} catch {
			toast('Couldn’t copy. Select the text and copy it yourself.', true)
		}
	}
	return (
		<Sheet open onClose={onClose} label={`Change permissions for ${a.name}`} tall>
			<SheetHeader icon={<Icon name="key" size={30} />} title={`Change permissions`} subtitle={`For ${a.name} · keeps its name and backups`} onClose={onClose} />
			{!pairing ? (
				<>
					<p className="muted" style={{fontSize: 14, margin: '0 4px 12px'}}>
						{direct
							? `Choose the abilities this server may use on ${a.name}. Its connector updates its permissions in place, rotates its key and reconnects; a terminal on ${a.name} opens to show it working.`
							: `Choose the abilities this server may use on ${a.name}. Running the command on that computer updates its permissions in place and rotates its key.`}
					</p>
					<div className="glass group wrap-sub" style={{'--inset': '62px'} as CSSProperties}>
						{(Object.keys(ABILITY) as Ability[]).map((k) => (
							<Row key={k} icon={ABILITY[k].icon} label={ABILITY[k].label} sub={ABILITY[k].what} trailing={<Switch on={allow[k]} label={ABILITY[k].label} onChange={(v) => setAllow({...allow, [k]: v})} />} />
						))}
					</div>
					<button className="btn primary" style={{width: '100%', marginTop: 18}} disabled={reauth.isPending} onClick={() => reauth.mutate()}>
						{reauth.isPending ? <span className="spinner" /> : <Icon name="key" size={18} />} {direct ? `Update ${a.name} now` : 'Make the update command'}
					</button>
				</>
			) : updated ? (
				<div className="glass empty">
					<span className="big" style={{color: 'var(--ok, #2fbf71)'}}>
						<Icon name="check" size={30} />
					</span>
					<b>Permissions updated</b>
					<span>{a.name} kept its name and backups.</span>
					<button className="btn primary small" onClick={onClose}>
						Done
					</button>
				</div>
			) : ran ? (
				<div className="glass empty">
					<span className="spinner" />
					<b>Updating {a.name}</b>
					<span>Its connector is running the update in the terminal that just opened. If it asks for a password, type it there. It reconnects by itself, and this changes to Permissions updated.</span>
					<button className="btn small" onClick={() => setRan(false)}>
						Show the command instead
					</button>
				</div>
			) : (
				<ol className="swarm-steps">
					<li>
						<b>On {a.name}, open a terminal</b>
						<span>Run this as {a.info?.user || 'the user who installed the connector'}. Its connector updates its permissions and reconnects.</span>
					</li>
					{hosts.length > 1 && (
						<li>
							<b>Pick the address it reaches this server on</b>
							<span className="chips" style={{marginTop: 8}}>
								{hosts.map((h) => (
									<button key={h} className={`chip${h === host ? ' on' : ''}`} aria-pressed={h === host} onClick={() => setHost(h)}>
										{h}
										{pairing.addresses.find((x) => x.address === h)?.tailscale ? ' · Tailscale' : ''}
									</button>
								))}
							</span>
						</li>
					)}
					<li>
						<b>Paste this and press Enter</b>
						<code className="swarm-cmd mono">{left ? command : 'This command has expired.'}</code>
						{left ? (
							<span style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 8}}>
								<button className="btn small primary" onClick={() => copy(command)}>
									<Icon name={copied ? 'check' : 'copy'} size={15} /> {copied ? 'Copied' : 'Copy'}
								</button>
								<span className="muted" style={{fontSize: 12.5}}>
									Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
								</span>
							</span>
						) : (
							<button className="btn small" style={{marginTop: 8}} onClick={() => (setPairing(null), reauth.mutate())}>
								Make a new one
							</button>
						)}
					</li>
				</ol>
			)}
		</Sheet>
	)
}
