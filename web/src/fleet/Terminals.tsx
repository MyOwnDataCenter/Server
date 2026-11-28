// Machines that have granted a direct terminal. The same screen is the phone page and the desktop window.
// One row opens at a time, and the shell draws inside that card.
import {lazy, Suspense, useEffect, useMemo, useRef, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query, type Machine} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useBootstrap, useMachines, useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {isOwner} from '../isOwner'
import {guestAgent, isGuestAgent} from '../swarm/guestLink'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {agentMay, useSwarm, type Agent} from '../swarm/Swarm'
import {FilterBar} from '../FilterBar'
import {StatusPill, haptic} from '../ui'
import {fleetList, guestFleetInput} from './list'
import {Ease, MOTION_MS, MotionSlot, useListMotion} from './MachineManager'
import {
	filterLabel,
	filterSlot,
	fleetStatus,
	healthPill,
	isOffline,
	isOnline,
	managerHealth,
	managerRows,
	nextFilter,
	reachLabel,
	worstAlert,
	type FilterSlot,
	type ManagerFilter,
	type ManagerHealth,
	type ManagerKind,
} from './machineManagerLogic'
import {useServerGaugeMetrics} from './serverGauges'
import {completeMachine, forEachCounts, forEachFinished, forEachShown, startForEach, supportsDirectTerminal, type ForEachPass} from './terminalsLogic'

const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

const FILTER_SLOTS: FilterSlot[] = ['all', 'kind', 'health', 'reach']

type Alert = {agentId: string; severity: 'info' | 'warning' | 'critical'}

type TermRow = {
	id: string
	kind: ManagerKind
	name: string
	offline: boolean
	online: boolean
	health: ManagerHealth
	agentId: string | null
	state?: string
	icon: IconName
	iconBg: string
}

function snaps(metrics: SwarmMetrics | null | undefined) {
	return swarmGaugeItems(metrics).map((g) => ({name: g.k, percent: g.p, ready: g.ready}))
}

function look(kind: ManagerKind): {icon: IconName; iconBg: string} {
	if (kind === 'server') return {icon: 'server', iconBg: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)'}
	if (kind === 'guest') return {icon: 'vm', iconBg: 'linear-gradient(140deg,#3a3a3c,#1c1c1e)'}
	return {icon: 'machine', iconBg: 'linear-gradient(140deg,#3a3a3c,#1c1c1e)'}
}

export function Terminals() {
	const boot = useBootstrap()
	const machines = useMachines()
	const swarm = useSwarm()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(machines, browserOnline)
	const swarmProblem = queryProblem(swarm, browserOnline)
	const serverShell = isOwner(useUser().data)
	const serverName = boot.server?.device || 'This server'
	const list = machines.data ?? []
	const agents = swarm.data ?? []
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: agents.filter((a) => !isGuestAgent(a)).map((a) => ({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on})),
				guests: list.map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state, connector: !!guestAgent(agents, m.id)})),
			}),
		[serverName, agents, list],
	)
	const serverGauges = useServerGaugeMetrics()
	const alertsQ = useQuery({
		queryKey: ['swarm.alerts'],
		queryFn: () => query<Alert[]>('swarm.alerts'),
		refetchInterval: 10_000,
		enabled: agents.length > 0,
	})
	const alerts = alertsQ.data ?? []
	const machineById = new Map(list.map((m) => [m.id, m]))
	const agentById = new Map(agents.filter((a) => !isGuestAgent(a)).map((a) => [a.id, a]))
	const capable = terminalRows({members, agents, machineById, agentById, alerts, serverShell, serverMetrics: serverGauges.metrics})

	const [queryText, setQueryText] = useState('')
	const [filter, setFilter] = useState<ManagerFilter>('all')
	const [openId, setOpenId] = useState<string | null>(null)
	const [menuOpen, setMenuOpen] = useState(false)
	const [pass, setPass] = useState<ForEachPass | null>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	const menuItem = useRef<HTMLButtonElement>(null)
	const endBtn = useRef<HTMLButtonElement>(null)
	const endTimer = useRef(0)
	const passWas = useRef(false)

	const filtered = managerRows(capable, filter, queryText)
	const shownIds = pass ? forEachShown(pass, capable.map((row) => row.id)) : filtered.map((row) => row.id)
	const shownKey = shownIds.join('\0')
	const slots = useListMotion(shownIds)
	const byId = new Map(capable.map((row) => [row.id, row]))
	const counts = pass ? forEachCounts(pass) : null
	const online = capable.filter((row) => row.online).length
	const status = fleetStatus({shown: filtered.length, total: capable.length, online, filter})

	useEffect(() => {
		setOpenId(null)
	}, [queryText, filter])
	useEffect(() => {
		const ids = shownKey ? shownKey.split('\0') : []
		if (openId && !ids.includes(openId)) setOpenId(null)
	}, [shownKey, openId])
	useEffect(() => () => window.clearTimeout(endTimer.current), [])
	useEffect(() => {
		if (pass && !passWas.current) endBtn.current?.focus()
		passWas.current = !!pass
	}, [pass])
	useEffect(() => {
		if (!menuOpen) return
		menuItem.current?.focus()
		const onDoc = (e: PointerEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setMenuOpen(false)
				menuRef.current?.querySelector('button')?.focus()
			}
		}
		document.addEventListener('pointerdown', onDoc)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('pointerdown', onDoc)
			document.removeEventListener('keydown', onKey)
		}
	}, [menuOpen])

	const toggle = (id: string) => {
		haptic(8)
		setOpenId((cur) => (cur === id ? null : id))
	}
	const begin = () => {
		setMenuOpen(false)
		const ids = filtered.map((row) => row.id)
		if (!ids.length) return
		window.clearTimeout(endTimer.current)
		setPass(startForEach(ids))
	}
	const end = () => {
		window.clearTimeout(endTimer.current)
		setPass(null)
	}
	const complete = (id: string) => {
		if (!pass || pass.done.includes(id)) return
		haptic(6)
		const next = completeMachine(pass, id)
		setOpenId((cur) => (cur === id ? null : cur))
		setPass(next)
		if (!forEachFinished(next)) return
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		window.clearTimeout(endTimer.current)
		endTimer.current = window.setTimeout(() => setPass(null), reduced ? 0 : MOTION_MS + 40)
	}

	return (
		<div className="mm tm">
			<div className="mm-top">
				<h1 className="title">Terminals</h1>
				<div className="mm-add" ref={menuRef}>
					{pass ? (
						<button ref={endBtn} type="button" className="btn small mm-add-btn" aria-label="End for-each mode" onClick={end}>
							<Icon name="close" size={18} />
						</button>
					) : (
						<>
							<button
								type="button"
								className="btn small mm-add-btn"
								aria-label="More"
								aria-haspopup="menu"
								aria-expanded={menuOpen}
								aria-controls="tm-menu"
								onClick={() => {
									haptic(6)
									setMenuOpen((v) => !v)
								}}
							>
								<Icon name="dots" size={18} />
							</button>
							{menuOpen && (
								<div id="tm-menu" className="mm-menu glass" role="menu" aria-label="More">
									<button ref={menuItem} type="button" role="menuitem" disabled={!filtered.length} onClick={begin}>
										For-Each
									</button>
								</div>
							)}
						</>
					)}
				</div>
			</div>
			<p className="subtitle">
				{machines.isLoading ? (
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
			<div className="mm-tools">
				{pass && counts ? (
					<p className="tm-pass" role="status">
						For-Each Mode: {counts.done} of {counts.total} machines complete
					</p>
				) : (
					<FilterBar
						query={queryText}
						onQuery={setQueryText}
						queryLabel="Find a machine"
						placeholder="Name"
						slotsLabel="Which machines"
						slots={FILTER_SLOTS.map((slot) => ({id: slot, label: filterLabel(filter, slot), pressed: filterSlot(filter) === slot}))}
						onSlot={(slot) => setFilter((cur) => nextFilter(cur, slot))}
					/>
				)}
			</div>
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{serverShell && swarmProblem && !problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{swarmProblem}
				</div>
			)}
			{machines.isLoading && <div className="skeleton" style={{height: 64, borderRadius: 16, marginTop: 12}} />}
			<div className="mm-list screen-list glass">
				{slots.map((slot) => {
					const row = byId.get(slot.id)
					if (!row) return null
					const open = slot.phase === 'stay' && openId === row.id
					const done = !!pass?.done.includes(row.id)
					const reach = reachLabel(row.kind, row.online, row.state)
					const health = healthPill(row.health)
					return (
						<MotionSlot key={slot.id} phase={slot.phase}>
							<article className={open ? 'mm-row is-open' : 'mm-row'}>
								<div className="tm-line">
									{pass && (
										<label className="tm-check">
											<input type="checkbox" checked={done} aria-label={`Mark ${row.name} complete`} onChange={() => complete(row.id)} />
										</label>
									)}
									<button
										type="button"
										className="mm-head"
										aria-expanded={open}
										aria-label={open ? `Close terminal on ${row.name}, ${reach.label}, ${health.label}` : `Open terminal on ${row.name}, ${reach.label}, ${health.label}`}
										onClick={() => toggle(row.id)}
									>
										<span className="vm-os mm-ico" style={{background: row.iconBg}}>
											<Icon name={row.icon} size={22} />
										</span>
										<span className="mm-name">{row.name}</span>
										<span className="mm-pills">
											<StatusPill {...reach} />
											<StatusPill {...health} />
										</span>
										<Icon name={open ? 'chevron-down' : 'chevron'} size={18} className="mm-chev" />
									</button>
								</div>
								<Ease open={open}>
									<div className="tm-card">
										{open && (
											<Suspense fallback={<div className="tm-wait"><span className="spinner" aria-label="Opening terminal" /></div>}>
												<TerminalScreen inline agent={row.agentId ? {id: row.agentId, name: row.name} : undefined} machine={row.name} onClose={() => setOpenId((cur) => (cur === row.id ? null : cur))} />
											</Suspense>
										)}
									</div>
								</Ease>
							</article>
						</MotionSlot>
					)
				})}
			</div>
			{!machines.isLoading && !pass && shownIds.length === 0 && <p className="quiet mm-empty">No machines match.</p>}
		</div>
	)
}

function terminalRows(input: {
	members: ReturnType<typeof fleetList>
	agents: readonly Agent[]
	machineById: Map<string, Machine>
	agentById: Map<string, Agent>
	alerts: readonly Alert[]
	serverShell: boolean
	serverMetrics: SwarmMetrics | null | undefined
}): TermRow[] {
	const rows: TermRow[] = []
	for (const member of input.members) {
		const art = look(member.kind)
		if (member.kind === 'server') {
			if (!supportsDirectTerminal({kind: 'server', granted: true, serverShell: input.serverShell})) continue
			rows.push({
				id: member.id,
				kind: 'server',
				name: member.name,
				offline: isOffline('server', member.online),
				online: isOnline('server', member.online),
				health: managerHealth({kind: 'server', online: member.online, connectorOnline: true, alert: null, gauges: snaps(input.serverMetrics)}),
				agentId: null,
				...art,
			})
			continue
		}
		if (member.kind === 'computer') {
			const agent = input.agentById.get(member.id)
			if (!agent || !supportsDirectTerminal({kind: 'computer', granted: agentMay(agent, 'terminal'), serverShell: input.serverShell})) continue
			const alert = worstAlert(input.alerts.filter((a) => a.agentId === agent.id).map((a) => a.severity))
			rows.push({
				id: member.id,
				kind: 'computer',
				name: member.name,
				offline: isOffline('computer', agent.online),
				online: isOnline('computer', agent.online),
				health: managerHealth({kind: 'computer', online: agent.online, connectorOnline: agent.online, alert, gauges: snaps(agent.metrics)}),
				agentId: agent.id,
				...art,
			})
			continue
		}
		const machine = input.machineById.get(member.id)
		if (!machine) continue
		const agent = guestAgent(input.agents, machine.id)
		if (!agent || !supportsDirectTerminal({kind: 'guest', granted: agentMay(agent, 'terminal'), serverShell: input.serverShell})) continue
		const connectorOnline = !!agent.online
		const alert = worstAlert(input.alerts.filter((a) => a.agentId === agent.id).map((a) => a.severity))
		const running = machine.state === 'running'
		rows.push({
			id: member.id,
			kind: 'guest',
			name: member.name,
			offline: isOffline('guest', running, machine.state),
			online: isOnline('guest', running, machine.state),
			health: managerHealth({kind: 'guest', online: running, connectorOnline, alert, gauges: connectorOnline ? snaps(agent.metrics) : []}),
			agentId: agent.id,
			state: machine.state,
			...art,
		})
	}
	return rows
}
