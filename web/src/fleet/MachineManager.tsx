// Machines list. Manage opens the existing machine page: a sheet on the phone, a split pane on the desktop.
import {lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query, type Machine} from '../api'
import {Icon, type IconName} from '../icons'
import {useStats} from '../machines/api'
import {usePowerActions} from '../machines/panels'
import {containerAgent, guestAgent, hostGuestMetrics, isContainerAgent, isGuestAgent} from '../swarm/guestLink'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {agentMay, useSwarmAction, type Agent} from '../swarm/Swarm'
import {FilterBar} from '../FilterBar'
import {StatusPill, haptic, useConfirm} from '../ui'
import {MACHINES_FILTER_TIP, type TutorialId} from '../tutorials'
import {PinButton} from './PinButton'
import {SERVER_FLEET_ID, type FleetMember} from './list'
import {containerPill, containerState, NewContainerSheet, osColor, type Container, useContainerAction} from '../containers/Containers'
import {
	filterLabel,
	filterSlot,
	fleetStatus,
	healthPill,
	isOffline,
	isOnline,
	nextFilter,
	managerAccess,
	managerBusy,
	managerHealth,
	managerPower,
	managerRows,
	mergeMotion,
	reachLabel,
	seenFact,
	worstAlert,
	type FilterSlot,
	type ManagerFilter,
	type ManagerHealth,
	type ManagerKind,
	type ManagerPower,
	type MotionPhase,
} from './machineManagerLogic'
import {LiveStats} from './StatRegion'
import {useServerGaugeMetrics} from './serverGauges'
const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

type Alert = {agentId: string; severity: 'info' | 'warning' | 'critical'}

const FILTER_SLOTS: FilterSlot[] = ['all', 'kind', 'health', 'reach']

export const MOTION_MS = 320

export function useListMotion(nextIds: readonly string[]) {
	const key = nextIds.join('\0')
	const nextRef = useRef(nextIds)
	nextRef.current = nextIds
	const [slots, setSlots] = useState<{id: string; phase: MotionPhase}[]>(() => nextIds.map((id) => ({id, phase: 'stay' as const})))
	const slotsRef = useRef(slots)
	slotsRef.current = slots
	const seenKey = useRef<string | null>(null)
	useEffect(() => {
		const next = nextRef.current
		if (seenKey.current === null) {
			seenKey.current = key
			setSlots((cur) => {
				if (cur.length === next.length && cur.every((slot, i) => slot.id === next[i])) return cur
				return next.map((id) => ({id, phase: 'stay' as const}))
			})
			return
		}
		if (seenKey.current === key) return
		seenKey.current = key
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		const prev = slotsRef.current.map((slot) => slot.id)
		const merged = reduced ? next.map((id) => ({id, phase: 'stay' as const})) : mergeMotion(prev, next)
		setSlots((cur) => {
			if (cur.length === merged.length && cur.every((slot, i) => slot.id === merged[i].id && slot.phase === merged[i].phase)) return cur
			return merged
		})
	}, [key])
	const leaveKey = slots
		.filter((slot) => slot.phase === 'leave')
		.map((slot) => slot.id)
		.join('\0')
	const enterKey = slots
		.filter((slot) => slot.phase === 'enter')
		.map((slot) => slot.id)
		.join('\0')
	useEffect(() => {
		if (!leaveKey) return
		const timer = window.setTimeout(() => setSlots((cur) => cur.filter((slot) => slot.phase !== 'leave')), MOTION_MS)
		return () => window.clearTimeout(timer)
	}, [leaveKey])
	useEffect(() => {
		if (!enterKey) return
		const timer = window.setTimeout(() => setSlots((cur) => cur.map((slot) => (slot.phase === 'enter' ? {id: slot.id, phase: 'stay' as const} : slot))), MOTION_MS)
		return () => window.clearTimeout(timer)
	}, [enterKey])
	return slots
}

export function MotionSlot({phase, children}: {phase: MotionPhase; children: ReactNode}) {
	const ref = useRef<HTMLDivElement>(null)
	const [shown, setShown] = useState(phase !== 'enter')
	useLayoutEffect(() => {
		if (phase !== 'enter') {
			setShown(true)
			return
		}
		setShown(false)
		let second = 0
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setShown(true))
		})
		return () => {
			cancelAnimationFrame(first)
			cancelAnimationFrame(second)
		}
	}, [phase])
	const covered = phase === 'leave' || (phase === 'enter' && !shown)
	useEffect(() => {
		ref.current?.toggleAttribute('inert', covered)
	}, [covered])
	const cls = ['mm-slot', phase === 'enter' && !shown ? 'is-enter' : '', phase === 'enter' && shown ? 'is-enter is-in' : '', phase === 'leave' ? 'is-leave' : ''].filter(Boolean).join(' ')
	return (
		<div ref={ref} className={cls} aria-hidden={phase === 'leave' || undefined}>
			<div className="mm-slot-in">{children}</div>
		</div>
	)
}

export function Ease({open, children}: {open: boolean; children: ReactNode}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		// Keeps the collapsed controls out of tab order. The React 18 types do not know `inert` yet.
		ref.current?.toggleAttribute('inert', !open)
	}, [open])
	return (
		<div ref={ref} className={open ? 'mm-ease is-open' : 'mm-ease'}>
			<div className="mm-ease-in">{children}</div>
		</div>
	)
}

function powerLabel(kind: ManagerKind, id: ManagerPower): string {
	if (id === 'reboot') return kind === 'computer' ? 'Restart' : 'Reboot'
	if (id === 'shutdown') return 'Shut down'
	if (id === 'suspend') return 'Suspend'
	if (id === 'resume') return 'Resume'
	if (id === 'pause') return 'Pause'
	if (id === 'stop') return 'Stop'
	return 'Start'
}

function powerIcon(id: ManagerPower): IconName {
	if (id === 'start' || id === 'resume') return 'play'
	if (id === 'reboot') return 'restart'
	if (id === 'pause') return 'pulse'
	if (id === 'stop') return 'stop'
	return 'power'
}

function snaps(metrics: SwarmMetrics | null | undefined) {
	return swarmGaugeItems(metrics).map((g) => ({name: g.k, percent: g.p, ready: g.ready}))
}

function ActionRow({
	kind,
	access,
	powers,
	busy,
	pending,
	seen,
	onTerminal,
	onDesktop,
	onPower,
}: {
	kind: ManagerKind
	access: {terminal: boolean; desktop: boolean}
	powers: readonly ManagerPower[]
	busy: boolean
	pending: boolean
	seen: {label: string; text: string} | null
	onTerminal: () => void
	onDesktop: () => void
	onPower: (id: ManagerPower) => void
}) {
	return (
		<div className="mm-actions">
			<div className="mm-actions-left">
				{access.terminal && (
					<button type="button" className="btn small" aria-label="Terminal" onClick={() => (haptic(8), onTerminal())}>
						<Icon name="terminal" size={18} />
					</button>
				)}
				{access.desktop && (
					<button type="button" className="btn small" aria-label="Desktop" onClick={() => (haptic(8), onDesktop())}>
						<Icon name="devices" size={18} />
					</button>
				)}
				{busy ? (
					<span className="mm-working">
						<span className="spinner" /> Working…
					</span>
				) : (
					powers.map((id) => (
						<button key={id} type="button" className={`btn small${id === 'start' || id === 'resume' ? ' primary' : ''}`} disabled={pending} onClick={() => onPower(id)}>
							<Icon name={powerIcon(id)} size={16} /> {powerLabel(kind, id)}
						</button>
					))
				)}
			</div>
			{seen && (
				<span className="mm-seen">
					{seen.label} {seen.text}
				</span>
			)}
		</div>
	)
}

function LineButton({
	name,
	icon,
	iconBg,
	reach,
	selected,
	onSelect,
}: {
	name: string
	icon: IconName
	iconBg: string
	reach: {kind: 'running' | 'stopped' | 'busy' | 'error' | 'update'; label: string}
	selected: boolean
	onSelect: () => void
}) {
	return (
		<button type="button" className={selected ? 'mm-line on' : 'mm-line'} aria-current={selected ? 'true' : undefined} onClick={() => (haptic(6), onSelect())}>
			<span className="vm-os mm-ico" style={{background: iconBg}}>
				<Icon name={icon} size={16} />
			</span>
			<span className="mm-name">{name}</span>
			<StatusPill {...reach} />
			<Icon name="chevron" size={16} className="mm-chev" />
		</button>
	)
}

function RowFrame({
	open,
	name,
	icon,
	iconBg,
	reach,
	health,
	onToggle,
	children,
}: {
	open: boolean
	name: string
	icon: IconName
	iconBg: string
	reach: {kind: 'running' | 'stopped' | 'busy' | 'error' | 'update'; label: string}
	health: {kind: 'running' | 'stopped' | 'busy' | 'error' | 'update'; label: string}
	onToggle: () => void
	children: ReactNode
}) {
	return (
		<article className={open ? 'mm-row is-open' : 'mm-row'}>
			<button type="button" className="mm-head" aria-expanded={open} onClick={onToggle}>
				<span className="vm-os mm-ico" style={{background: iconBg}}>
					<Icon name={icon} size={22} />
				</span>
				<span className="mm-name">{name}</span>
				<span className="mm-pills">
					<StatusPill {...reach} />
					<StatusPill {...health} />
				</span>
				<Icon name={open ? 'chevron-down' : 'chevron'} size={18} className="mm-chev" />
			</button>
			<Ease open={open}>{children}</Ease>
		</article>
	)
}

const noReadings = <p className="quiet mm-noread">No readings yet.</p>

function ServerRow({
	member,
	health,
	owner,
	serverTerminal,
	open,
	lines,
	selected,
	onToggle,
	onManage,
	onTerminal,
	onDesktop,
}: {
	member: FleetMember
	health: ManagerHealth
	owner: boolean
	serverTerminal: boolean
	open: boolean
	lines: boolean
	selected: boolean
	onToggle: () => void
	onManage: () => void
	onTerminal: () => void
	onDesktop: () => void
}) {
	const {metrics, temp, sensors, uptime} = useServerGaugeMetrics()
	if (lines) return <LineButton name={member.name} icon="server" iconBg="linear-gradient(140deg,#2b2b2b,#0b0b0b)" reach={reachLabel('server', member.online)} selected={selected} onSelect={onManage} />
	const seen = seenFact(member.online, uptime, null, Date.now())
	return (
		<RowFrame open={open} name={member.name} icon="server" iconBg="linear-gradient(140deg,#2b2b2b,#0b0b0b)" reach={reachLabel('server', member.online)} health={healthPill(health)} onToggle={onToggle}>
			<div className="mm-panel">
				<LiveStats metrics={metrics} temp={temp} sensors={sensors} machineName={member.name} empty={noReadings} />
				<ActionRow
					kind="server"
					access={managerAccess({kind: 'server', linkOnline: member.online, owner, serverTerminal, terminalGranted: false, desktopGranted: false, desktopOk: false, guestRunning: false})}
					powers={[]}
					busy={false}
					pending={false}
					seen={seen}
					onTerminal={onTerminal}
					onDesktop={onDesktop}
					onPower={() => {}}
				/>
				<div className="mm-foot">
					<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={member.name} />
					<button type="button" className="btn small" onClick={() => (haptic(6), onManage())}>
						Manage
					</button>
				</div>
			</div>
		</RowFrame>
	)
}

function ComputerRow({
	member,
	agent,
	health,
	open,
	lines,
	selected,
	onToggle,
	onManage,
	onTerminal,
	onDesktop,
}: {
	member: FleetMember
	agent: Agent
	health: ManagerHealth
	open: boolean
	lines: boolean
	selected: boolean
	onToggle: () => void
	onManage: () => void
	onTerminal: () => void
	onDesktop: () => void
}) {
	const confirm = useConfirm()
	const act = useSwarmAction()
	const metrics = agent.metrics
	if (lines) return <LineButton name={member.name} icon="machine" iconBg="linear-gradient(140deg,#3a3a3c,#1c1c1e)" reach={reachLabel('computer', agent.online)} selected={selected} onSelect={onManage} />
	const seen = seenFact(agent.online, metrics?.uptime, agent.lastSeen, Date.now())
	const powers = managerPower({kind: 'computer', online: agent.online, manage: agentMay(agent, 'manage')})
	const run = (id: ManagerPower) => {
		const name = agent.name
		const go = async (action: 'suspend' | 'reboot' | 'shutdown', title: string, body: string, confirmLabel: string, done: string) => {
			if (await confirm({title, body, confirm: confirmLabel, icon: 'power'})) act.mutate({path: 'swarm.action', input: {id: agent.id, name: action}, done})
		}
		if (id === 'suspend') void go('suspend', `Suspend ${name}?`, 'It goes to sleep right away. Wake it with Wake-on-LAN or its power button.', 'Suspend', `Suspending ${name}…`)
		if (id === 'reboot') void go('reboot', `Restart ${name}?`, 'Anything open on it closes. It joins again by itself once it’s back up.', 'Restart', `Restarting ${name}…`)
		if (id === 'shutdown') void go('shutdown', `Shut down ${name}?`, 'Anything open on it closes and the computer powers off.', 'Shut down', `Shutting down ${name}…`)
	}
	return (
		<RowFrame open={open} name={member.name} icon="machine" iconBg="linear-gradient(140deg,#3a3a3c,#1c1c1e)" reach={reachLabel('computer', agent.online)} health={healthPill(health)} onToggle={onToggle}>
			<div className="mm-panel">
				<LiveStats metrics={metrics} temp={metrics?.temp ?? null} machineName={member.name} posture={agent.info?.posture} empty={noReadings} />
				<ActionRow
					kind="computer"
					access={managerAccess({
						kind: 'computer',
						linkOnline: agent.online,
						owner: false,
						serverTerminal: false,
						terminalGranted: agentMay(agent, 'terminal'),
						desktopGranted: agentMay(agent, 'desktop'),
						desktopOk: agent.info?.desktop?.ok !== false,
						guestRunning: false,
					})}
					powers={powers}
					busy={false}
					pending={act.isPending}
					seen={seen}
					onTerminal={onTerminal}
					onDesktop={onDesktop}
					onPower={run}
				/>
				<div className="mm-foot">
					<PinButton pin={{kind: 'machine', id: agent.id, computer: ''}} name={agent.name} />
					<button type="button" className="btn small" onClick={() => (haptic(6), onManage())}>
						Manage
					</button>
				</div>
			</div>
		</RowFrame>
	)
}

function GuestRow({
	machine,
	agents,
	health,
	open,
	lines,
	selected,
	onToggle,
	onManage,
	onTerminal,
	onDesktop,
}: {
	machine: Machine
	agents: readonly Agent[]
	health: ManagerHealth
	open: boolean
	lines: boolean
	selected: boolean
	onToggle: () => void
	onManage: () => void
	onTerminal: (agent: Agent) => void
	onDesktop: () => void
}) {
	const agent = guestAgent(agents, machine.id)
	const connectorOnline = !!agent?.online
	const statsQ = useStats(machine.id, open && machine.state === 'running' && !connectorOnline)
	const host = !connectorOnline && machine.state === 'running' ? hostGuestMetrics(statsQ.data?.last, machine.memoryMb ?? (machine.memoryGb ? machine.memoryGb * 1024 : 0), machine.cores ?? 0) : null
	const metrics = connectorOnline ? agent?.metrics : host
	const power = usePowerActions({id: machine.id, name: machine.name, state: machine.state, protected: machine.protected})!
	if (lines) return <LineButton name={machine.name} icon="vm" iconBg="linear-gradient(140deg,#3a3a3c,#1c1c1e)" reach={reachLabel('guest', machine.state === 'running', machine.state)} selected={selected} onSelect={onManage} />
	const seen = seenFact(machine.state === 'running', connectorOnline ? agent?.metrics?.uptime : undefined, agent?.lastSeen, Date.now())
	const busy = managerBusy('guest', machine.state, !!(power.pending || machine.pending))
	const powers = managerPower({kind: 'guest', online: machine.state === 'running', manage: false, state: machine.state, pending: busy})
	const run = (id: ManagerPower) => {
		if (id === 'start') power.start()
		else if (id === 'resume') (machine.state === 'hibernated' ? power.start() : power.resume())
		else if (id === 'shutdown') void power.shutdown()
		else if (id === 'reboot') void power.reboot()
		else if (id === 'pause') power.pause()
		else if (id === 'stop') void power.stop()
	}
	return (
		<RowFrame open={open} name={machine.name} icon="vm" iconBg="linear-gradient(140deg,#3a3a3c,#1c1c1e)" reach={reachLabel('guest', machine.state === 'running', machine.state)} health={healthPill(health)} onToggle={onToggle}>
			<div className="mm-panel">
				<LiveStats metrics={metrics} temp={connectorOnline ? (agent?.metrics?.temp ?? null) : null} diskSizeGb={machine.diskSizeGb ?? null} machineName={machine.name} empty={noReadings} />
				<ActionRow
					kind="guest"
					access={managerAccess({
						kind: 'guest',
						linkOnline: connectorOnline,
						owner: false,
						serverTerminal: false,
						terminalGranted: !!agent && agentMay(agent, 'terminal'),
						desktopGranted: false,
						desktopOk: false,
						guestRunning: machine.state === 'running',
					})}
					powers={powers}
					busy={busy}
					pending={!!power.pending}
					seen={seen}
					onTerminal={() => agent && onTerminal(agent)}
					onDesktop={onDesktop}
					onPower={run}
				/>
				<div className="mm-foot">
					<PinButton pin={{kind: 'vm', id: machine.id, computer: SERVER_FLEET_ID}} name={machine.name} />
					<button type="button" className="btn small" onClick={() => (haptic(6), onManage())}>
						Manage
					</button>
				</div>
			</div>
		</RowFrame>
	)
}

function ContainerFleetRow({
	c,
	health,
	open,
	lines,
	selected,
	onToggle,
	onManage,
	onTerminal,
}: {
	c: Container
	health: ManagerHealth
	open: boolean
	lines: boolean
	selected: boolean
	onToggle: () => void
	onManage: () => void
	onTerminal?: () => void
}) {
	const action = useContainerAction()
	const state = containerState(c)
	const reach = reachLabel('container', c.status === 'running', state)
	const busy = action.isPending || containerPill(c).kind === 'busy'
	const run = (path: string, done: string) => action.mutate({path, input: {name: c.name}, done})
	if (lines) return <LineButton name={c.name} icon="category" iconBg={osColor(c.os)} reach={reach} selected={selected} onSelect={onManage} />
	return (
		<RowFrame open={open} name={c.name} icon="category" iconBg={osColor(c.os)} reach={reach} health={healthPill(health)} onToggle={onToggle}>
			<div className="mm-panel">
				<p className="quiet" style={{margin: 0, overflowWrap: 'anywhere'}}>
					{c.progress ||
						[c.os ? c.os[0].toUpperCase() + c.os.slice(1) : '', c.addresses.find((a) => a.family === 'IPv4')?.address, c.memoryUsedGiB !== null ? `${c.memoryUsedGiB} GB memory in use` : null]
							.filter(Boolean)
							.join(' · ') ||
						'Container'}
				</p>
				{!c.pending && (
					<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
						{c.status !== 'running' ? (
							<button type="button" className="btn small" disabled={busy} onClick={() => run('containers.start', `${c.name} is starting`)}>
								<Icon name="play" size={14} /> Start
							</button>
						) : (
							<>
								{onTerminal && (
									<button type="button" className="btn small" aria-label="Terminal" onClick={() => (haptic(8), onTerminal())}>
										<Icon name="terminal" size={18} />
									</button>
								)}
								<button type="button" className="btn small" disabled={busy} onClick={() => run('containers.restart', `${c.name} is restarting`)}>
									<Icon name="restart" size={14} /> Restart
								</button>
								<button type="button" className="btn small" disabled={busy} onClick={() => run('containers.stop', `${c.name} is shut down`)}>
									<Icon name="power" size={14} /> Shut down
								</button>
							</>
						)}
					</div>
				)}
				<div className="mm-foot">
					<span />
					<button type="button" className="btn small" onClick={() => (haptic(6), onManage())}>
						Manage
					</button>
				</div>
			</div>
		</RowFrame>
	)
}

export function MachineManager({
	owner,
	serverTerminal,
	online,
	total,
	loading,
	problem,
	swarmProblem,
	members,
	machines,
	containers = [],
	agents,
	onManage,
	onServerTerminal,
	onServerDesktop,
	onGuestDesktop,
	onAddComputer,
	onCreateVm,
	lines = false,
	selectedKey = null,
	queryValue,
	onQueryText,
	filterValue,
	onFilter,
	dismissedTutorials,
	onDismissTutorial,
}: {
	owner: boolean
	serverTerminal: boolean
	online: number
	total: number
	loading: boolean
	problem: string | null
	swarmProblem: string | null
	members: readonly FleetMember[]
	machines: readonly Machine[]
	containers?: readonly Container[]
	agents: readonly Agent[]
	onManage: (kind: ManagerKind, id: string) => void
	onServerTerminal: () => void
	onServerDesktop: () => void
	onGuestDesktop: (id: string) => void
	onAddComputer: () => void
	onCreateVm: () => void
	/** One line per machine, for the desktop Compact split. */
	lines?: boolean
	selectedKey?: string | null
	queryValue?: string
	onQueryText?: (value: string) => void
	filterValue?: ManagerFilter
	onFilter?: (value: ManagerFilter) => void
	dismissedTutorials?: readonly string[]
	onDismissTutorial?: (id: TutorialId) => void
}) {
	const [ownQuery, setOwnQuery] = useState('')
	const [ownFilter, setOwnFilter] = useState<ManagerFilter>('all')
	const queryText = queryValue ?? ownQuery
	const setQueryText = onQueryText ?? setOwnQuery
	const filter = filterValue ?? ownFilter
	const setFilter = onFilter ?? setOwnFilter
	const tip = !(dismissedTutorials ?? []).includes(MACHINES_FILTER_TIP)
	const [openId, setOpenId] = useState<string | null>(null)
	const [addOpen, setAddOpen] = useState(false)
	const [newContainer, setNewContainer] = useState(false)
	const [term, setTerm] = useState<{id: string; name: string} | null>(null)
	const [screen, setScreen] = useState<{id: string; name: string} | null>(null)
	const addRef = useRef<HTMLDivElement>(null)
	const serverGauges = useServerGaugeMetrics()
	const alertsQ = useQuery({
		queryKey: ['swarm.alerts'],
		queryFn: () => query<Alert[]>('swarm.alerts'),
		refetchInterval: 10_000,
		enabled: agents.length > 0,
	})
	const alerts = alertsQ.data ?? []
	useEffect(() => {
		setOpenId(null)
	}, [queryText, filter])
	useEffect(() => {
		if (!addOpen) return
		const onDoc = (e: PointerEvent) => {
			if (!addRef.current?.contains(e.target as Node)) setAddOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setAddOpen(false)
		}
		document.addEventListener('pointerdown', onDoc)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('pointerdown', onDoc)
			document.removeEventListener('keydown', onKey)
		}
	}, [addOpen])
	const machineById = new Map(machines.map((m) => [m.id, m]))
	const containerById = new Map(containers.map((c) => [c.name, c]))
	const agentById = new Map(agents.filter((a) => !isGuestAgent(a) && !isContainerAgent(a)).map((a) => [a.id, a]))
	const listed: (FleetMember & {offline: boolean; online: boolean; health: ManagerHealth})[] = []
	for (const member of members) {
		if (member.kind === 'server') {
			listed.push({
				...member,
				offline: isOffline('server', member.online),
				online: isOnline('server', member.online),
				health: managerHealth({kind: 'server', online: member.online, connectorOnline: true, alert: null, gauges: snaps(serverGauges.metrics)}),
			})
			continue
		}
		if (member.kind === 'computer') {
			const agent = agentById.get(member.id)
			if (!agent) continue
			const alert = worstAlert(alerts.filter((a) => a.agentId === agent.id).map((a) => a.severity))
			listed.push({
				...member,
				offline: isOffline('computer', agent.online),
				online: isOnline('computer', agent.online),
				health: managerHealth({kind: 'computer', online: agent.online, connectorOnline: agent.online, alert, gauges: snaps(agent.metrics)}),
			})
			continue
		}
		if (member.kind === 'container') {
			const c = containerById.get(member.id)
			if (!c) continue
			const state = containerState(c)
			const agent = containerAgent(agents, c.name)
			const connectorOnline = !!agent?.online
			const alert = worstAlert(alerts.filter((a) => agent && a.agentId === agent.id).map((a) => a.severity))
			listed.push({
				...member,
				offline: isOffline('container', c.status === 'running', state),
				online: isOnline('container', c.status === 'running', state),
				health: managerHealth({kind: 'container', online: c.status === 'running', connectorOnline, alert, gauges: connectorOnline ? snaps(agent?.metrics) : []}),
			})
			continue
		}
		const machine = machineById.get(member.id)
		if (!machine) continue
		const agent = guestAgent(agents, machine.id)
		const connectorOnline = !!agent?.online
		const alert = worstAlert(alerts.filter((a) => agent && a.agentId === agent.id).map((a) => a.severity))
		listed.push({
			...member,
			offline: isOffline('guest', machine.state === 'running', machine.state),
			online: isOnline('guest', machine.state === 'running', machine.state),
			health: managerHealth({kind: 'guest', online: machine.state === 'running', connectorOnline, alert, gauges: connectorOnline ? snaps(agent?.metrics) : []}),
		})
	}
	const rows = managerRows(listed, filter, queryText)
	const rowIds = rows.map((row) => row.id)
	const slots = useListMotion(rowIds)
	const byId = new Map(listed.map((row) => [row.id, row]))
	const rowKey = rowIds.join('\0')
	useEffect(() => {
		const matched = rowKey ? rowKey.split('\0') : []
		if (openId && !matched.includes(openId)) setOpenId(null)
	}, [rowKey, openId])
	const toggle = (id: string) => {
		haptic(6)
		setOpenId((cur) => (cur === id ? null : id))
	}
	const status = fleetStatus({shown: rows.length, total, online, filter})
	const statusLine = (
		<p className="subtitle">
			{loading ? (
				'Loading…'
			) : problem ? (
				'Can’t reach your server'
			) : (
				<>
					{status.shown && <span>{status.shown}</span>}
					{status.shown && <span className="mm-status-gap"> · </span>}
					<span>{status.online}</span>
				</>
			)}
		</p>
	)
	const addControl = (
		<div className="mm-add" ref={addRef}>
			<button
				type="button"
				className="btn primary small mm-add-btn"
				aria-label={owner ? 'Add a computer, virtual machine, or container' : 'Create a virtual machine'}
				aria-haspopup={owner ? 'menu' : undefined}
				aria-expanded={owner ? addOpen : undefined}
				onClick={() => {
					haptic(6)
					if (!owner) onCreateVm()
					else setAddOpen((v) => !v)
				}}
			>
				<Icon name="plus" size={18} stroke={2.4} />
			</button>
			{owner && addOpen && (
				<div className="mm-menu glass" role="menu" aria-label="Add">
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setAddOpen(false)
							onAddComputer()
						}}
					>
						Add a computer
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setAddOpen(false)
							onCreateVm()
						}}
					>
						Create a virtual machine
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setAddOpen(false)
							setNewContainer(true)
						}}
					>
						Add a container
					</button>
				</div>
			)}
			{newContainer && <NewContainerSheet onClose={() => setNewContainer(false)} />}
		</div>
	)
	return (
		<div className={lines ? 'mm is-lines' : 'mm'}>
			{lines ? (
				<div className="mm-top">
					{statusLine}
					{addControl}
				</div>
			) : (
				<>
					<div className="mm-top">
						<h1 className="title">Machines</h1>
						{addControl}
					</div>
					{statusLine}
				</>
			)}
			<FilterBar
				query={queryText}
				onQuery={setQueryText}
				queryLabel="Find a machine"
				placeholder="Name"
				slotsLabel="Which machines"
				slots={FILTER_SLOTS.map((slot) => ({id: slot, label: filterLabel(filter, slot), pressed: filterSlot(filter) === slot}))}
				onSlot={(slot) => setFilter(nextFilter(filter, slot))}
			>
				{tip && (
					<div className="mm-tip" role="note">
						<p>Tap again to switch. Physical becomes Virtual, Unhealthy becomes Healthy, and Offline becomes Online.</p>
						<button type="button" aria-label="Dismiss" onClick={() => onDismissTutorial?.(MACHINES_FILTER_TIP)}>
							<Icon name="close" size={14} />
						</button>
					</div>
				)}
			</FilterBar>
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{owner && swarmProblem && !problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{swarmProblem}
				</div>
			)}
			{loading && <div className="skeleton" style={{height: 64, borderRadius: 16, marginTop: 12}} />}
			<div className="mm-list screen-list glass" role={lines ? 'list' : undefined} aria-label={lines ? 'Machines' : undefined}>
				{slots.map((slot) => {
					const member = byId.get(slot.id)
					if (!member) return null
					const open = !lines && slot.phase === 'stay' && openId === member.id
					const selected = selectedKey === `${member.kind}:${member.id}`
					if (member.kind === 'server')
						return (
							<MotionSlot key={slot.id} phase={slot.phase}>
								<ServerRow
									member={member}
									health={member.health}
									owner={owner}
									serverTerminal={serverTerminal}
									open={open}
									lines={lines}
									selected={selected}
									onToggle={() => toggle(member.id)}
									onManage={() => onManage('server', member.id)}
									onTerminal={onServerTerminal}
									onDesktop={onServerDesktop}
								/>
							</MotionSlot>
						)
					if (member.kind === 'computer') {
						const agent = agentById.get(member.id)
						if (!agent) return null
						return (
							<MotionSlot key={slot.id} phase={slot.phase}>
								<ComputerRow
									member={member}
									agent={agent}
									health={member.health}
									open={open}
									lines={lines}
									selected={selected}
									onToggle={() => toggle(member.id)}
									onManage={() => onManage('computer', member.id)}
									onTerminal={() => setTerm({id: agent.id, name: agent.name})}
									onDesktop={() => setScreen({id: agent.id, name: agent.name})}
								/>
							</MotionSlot>
						)
					}
					if (member.kind === 'container') {
						const c = containerById.get(member.id)
						if (!c) return null
						const agent = containerAgent(agents, c.name)
						return (
							<MotionSlot key={slot.id} phase={slot.phase}>
								<ContainerFleetRow
									c={c}
									health={member.health}
									open={open}
									lines={lines}
									selected={selected}
									onToggle={() => toggle(member.id)}
									onManage={() => onManage('container', member.id)}
									onTerminal={agent?.online && agentMay(agent, 'terminal') ? () => setTerm({id: agent.id, name: c.name}) : undefined}
								/>
							</MotionSlot>
						)
					}
					const machine = machineById.get(member.id)
					if (!machine) return null
					return (
						<MotionSlot key={slot.id} phase={slot.phase}>
							<GuestRow
								machine={machine}
								agents={agents}
								health={member.health}
								open={open}
								lines={lines}
								selected={selected}
								onToggle={() => toggle(member.id)}
								onManage={() => onManage('guest', member.id)}
								onTerminal={(agent) => setTerm({id: agent.id, name: machine.name})}
								onDesktop={() => onGuestDesktop(machine.id)}
							/>
						</MotionSlot>
					)
				})}
			</div>
			{!loading && rows.length === 0 && <p className="quiet mm-empty">No machines match.</p>}
			{term && (
				<Suspense fallback={null}>
					<TerminalScreen agent={term} onClose={() => setTerm(null)} />
				</Suspense>
			)}
			{screen && (
				<Suspense fallback={null}>
					<Console machine={{id: `agent-${screen.id}`, name: screen.name, state: 'running'}} onClose={() => setScreen(null)} />
				</Suspense>
			)}
		</div>
	)
}
