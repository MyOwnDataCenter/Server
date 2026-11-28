import {useDesktop} from '../desktop/Desktop'
import {lazy, Suspense, useEffect, useState, type ReactNode} from 'react'

import {ApiError, mutate, type Machine} from '../api'
import {Icon} from '../icons'
import {useMachineDetails, useStats} from '../machines/api'
import {extraDisks} from '../swarm/gauges'
import {connectorKind, guestAgent, guestPoweredOffAt, guestUptimeSeconds, hostGuestMetrics, linuxConnectorOs} from '../swarm/guestLink'
import {storageRowSub} from '../swarm/storageHint'
import {AddComputer, ConnectorControls, agentMay, useSwarm} from '../swarm/Swarm'
import {Field, Row, Sheet, SheetHeader, bytes, haptic, useToast} from '../ui'
import {MachineSeen} from './MachineSeen'
import {LiveStats} from './StatRegion'
import {MachineActions} from './machineActions'
import {openStore} from './openStore'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))
const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

const pct = (u?: {total: number; used: number}) => (u && u.total ? Math.round((100 * u.used) / u.total) : null)

type ConnectorInstall = {status: 'started' | 'needs-password' | 'needs-agent' | 'unsupported'; message?: string; taskId?: string}

function startFirstError(e: unknown) {
	return e instanceof ApiError && e.code === 'PRECONDITION_FAILED' && /Start the machine first/.test(e.message)
}

/**
 * The computer sections of a virtual machine. Power, USB, and snapshots stay with the host page.
 * Terminal is the connector shell. Desktop is the virtual machine's screen.
 * Files and gauges use the guest's connector when it is installed.
 */
export type GuestSections = {files?: ReactNode; apps?: ReactNode; storage?: ReactNode; backups?: ReactNode; manage?: ReactNode}

export function GuestLive({machine, onOpenStore, onOpenDesktop, onOpenStorage, onBackups, onOpenTerminal, pin, tabs}: {machine: Machine; onOpenStore?: () => void; onOpenDesktop?: () => void; onOpenStorage: (target: {agentId: string; name: string}) => void; onBackups?: () => void; onOpenTerminal?: (agent: {id: string; name: string}, input?: string) => void; pin?: ReactNode; tabs: (sections: GuestSections) => ReactNode}) {
	const swarm = useSwarm()
	const agent = guestAgent(swarm.data ?? [], machine.id)
	const toast = useToast()
	const [install, setInstall] = useState(false)
	const [busy, setBusy] = useState(false)
	const [taskId, setTaskId] = useState<string | null>(null)
	const [askPassword, setAskPassword] = useState(false)
	const [sudoPassword, setSudoPassword] = useState('')
	const [terminal, setTerminal] = useState<{input?: string} | null>(null)
	const [desktop, setDesktop] = useState(false)
	const desk = useDesktop()
	const [storageNote, setStorageNote] = useState(false)
	const live = machine.state === 'running' && !!agent?.online
	const running = machine.state === 'running'
	const stopped = machine.state === 'stopped'
	const metrics = agent?.online ? agent.metrics : null
	const stats = useStats(machine.id, (running && !metrics) || stopped)
	const host = !metrics && running ? hostGuestMetrics(stats.data?.last, machine.memoryMb ?? (machine.memoryGb ? machine.memoryGb * 1024 : 0), machine.cores ?? 0) : null
	const linux = linuxConnectorOs(machine.osId)
	const canInstall = connectorKind(machine.osId) !== 'unsupported'
	const details = useMachineDetails(!agent && canInstall ? machine.id : null)
	const autoTrying = (details.data?.tasks ?? []).some((t) => t.type === 'connector' && t.status === 'running')
	const trying = busy || autoTrying
	useEffect(() => {
		if (!agent) return
		setBusy(false)
		setAskPassword(false)
		setInstall(false)
	}, [agent])
	useEffect(() => {
		if (!busy || agent || taskId === '') return
		const tasks = details.data?.tasks ?? []
		const task = taskId ? tasks.find((t) => t.id === taskId && t.type === 'connector') : tasks.find((t) => t.type === 'connector')
		if (task?.status === 'error') {
			toast(task.message ?? 'Install failed', true)
			setBusy(false)
		}
	}, [agent, busy, details.data, taskId, toast])
	const runInstall = (password?: string) => {
		haptic(6)
		setBusy(true)
		// Empty until this attempt has a task id, so an older connector error does not clear the spinner.
		setTaskId('')
		setAskPassword(false)
		const input = password ? {id: machine.id, sudoPassword: password} : {id: machine.id}
		void mutate<ConnectorInstall>('machines.installConnector', input)
			.then((out) => {
				if (out.status === 'started') {
					setTaskId(out.taskId ?? null)
					return
				}
				if (out.status === 'needs-agent') setInstall(true)
				else if (out.status === 'needs-password') setAskPassword(true)
				setBusy(false)
			})
			.catch((e) => {
				toast(e instanceof Error ? e.message : 'Install failed', true)
				if (!startFirstError(e) && !guestAgent(swarm.data ?? [], machine.id)) setInstall(true)
				setBusy(false)
			})
	}
	const canStorage = !!(agent?.online && agentMay(agent, 'storage'))
	const storageSub = !linux
		? 'The connector runs on Linux with systemd or Alpine OpenRC. It can’t manage drives here.'
		: !agent
			? 'Install the connector and allow Storage.'
			: !agent.online
				? 'Offline.'
				: storageRowSub(agent.allowed.storage, agent.on.storage)
	const openTerminal = (input?: string) => {
		if (onOpenTerminal && agent) {
			onOpenTerminal({id: agent.id, name: machine.name}, input)
			return
		}
		setTerminal({input})
	}
	const hostScreen = !!onOpenDesktop && machine.state === 'running'
	const connectorDesktop = live && !!agent && agentMay(agent, 'desktop') && agent.info?.desktop?.ok !== false
	return (
		<>
			<MachineActions terminal={live && !!agent && agentMay(agent, 'terminal')} desktop={hostScreen || connectorDesktop} onTerminal={() => openTerminal()} onDesktop={() => (onOpenDesktop && machine.state === 'running' ? onOpenDesktop() : desk && agent ? desk.openConsole(`agent-${agent.id}`, machine.name) : setDesktop(true))} pin={pin} />
			{swarm.isFetched && !agent && canInstall && (
				<div className="primary-row">
					<button type="button" className="btn primary" disabled={trying} onClick={() => runInstall()}>
						{trying ? <span className="spinner" /> : <Icon name="plus" size={20} />} Install connector
					</button>
					<span className="primary-row-spacer" aria-hidden="true" />
					<span className="btn small primary-row-pin-slot" aria-hidden="true">
						<Icon name="pin" size={16} /> Pin
					</span>
				</div>
			)}
{swarm.isFetched && !agent && !canInstall && <p className="quiet">This operating system can’t run the connector. It runs on Linux with systemd or Alpine OpenRC.</p>}
			{(metrics || host || machine.diskSizeGb) && <LiveStats metrics={metrics ?? host} temp={typeof metrics?.temp === 'number' ? metrics.temp : null} diskSizeGb={machine.diskSizeGb ?? null} machineName={machine.name} />}
			<MachineSeen
				online={running}
				offline={stopped}
				uptime={running ? (metrics?.uptime != null && Number.isFinite(metrics.uptime) ? metrics.uptime : guestUptimeSeconds(details.data?.tasks, Date.now())) : null}
				lastSeen={agent?.lastSeen ?? guestPoweredOffAt(details.data?.tasks) ?? (stopped && stats.data?.last?.t != null && stats.data.last.t > 0 ? stats.data.last.t : null)}
			/>
			{extraDisks(metrics?.disks).length > 0 && (
				<div className="glass group machine-extra">
					{extraDisks(metrics?.disks).map((d) => (
						<Row key={d.mount} icon="disk" color="#f0a020" label={d.mount} sub={`${bytes(d.used)} of ${bytes(d.total)}`} trailing={<b>{pct(d)}%</b>} />
					))}
				</div>
			)}
			{tabs({
				files:
					live && agent && agentMay(agent, 'files') ? (
						<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
							<MachineFiles scope={{kind: 'computer', id: agent.id, name: machine.name}} windowId={`guest:${machine.id}`} />
						</Suspense>
					) : undefined,
				apps: live ? (
					<Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${machine.name}`} onClick={() => (haptic(6), onOpenStore ? onOpenStore() : openStore({id: machine.id, kind: 'guest', name: machine.name}))} />
				) : undefined,
				storage: <Row icon="disk" color="var(--teal)" label="Storage" sub={storageSub} onClick={() => (haptic(8), canStorage && agent ? onOpenStorage({agentId: agent.id, name: machine.name}) : setStorageNote(true))} />,
				backups: onBackups ? <Row icon="history" color="var(--green)" label="Backups" sub="Back up this virtual machine" onClick={() => (haptic(8), onBackups())} /> : undefined,
				manage: agent ? <ConnectorControls a={agent} onTerminal={openTerminal} /> : undefined,
			})}
			{storageNote && (
				<Sheet open onClose={() => setStorageNote(false)} label="Storage">
					<SheetHeader title="Storage" subtitle={machine.name} onClose={() => setStorageNote(false)} />
					<p className="prose" style={{fontSize: 14.5}}>
						{storageSub}
					</p>
					{!agent && linux && (
						<button type="button" className="btn primary" onClick={() => (setStorageNote(false), runInstall())}>
							<Icon name="plus" size={18} /> Install connector
						</button>
					)}
				</Sheet>
			)}
			{askPassword && (
				<Sheet open onClose={() => (setAskPassword(false), setSudoPassword(''))} label="Password">
					<SheetHeader title="Password" subtitle={machine.name} onClose={() => (setAskPassword(false), setSudoPassword(''))} />
					<form
						onSubmit={(e) => {
							e.preventDefault()
							const password = sudoPassword
							setSudoPassword('')
							runInstall(password)
						}}
					>
						<Field id="guest-sudo" label="Password in the machine" type="password" autoComplete="off" value={sudoPassword} onChange={(e) => setSudoPassword(e.target.value)} hint="Used once so the installer can finish. It isn’t saved." autoFocus required />
						<button type="submit" className="btn primary" disabled={busy || !sudoPassword} style={{width: '100%', marginTop: 12}}>
							{busy ? <><span className="spinner" /><span className="sr-only">Install connector</span></> : 'Install connector'}
						</button>
					</form>
				</Sheet>
			)}
			{install && (
				<AddComputer
					guest={{id: machine.id, name: machine.name, osId: machine.osId}}
					before={(swarm.data ?? []).map((a) => a.id)}
					onClose={() => setInstall(false)}
					onJoined={() => setInstall(false)}
				/>
			)}
			{terminal && !onOpenTerminal && agent && (
				<Suspense fallback={null}>
					<TerminalScreen agent={{id: agent.id, name: machine.name}} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
			)}
			{desktop && agent && (
				<Suspense fallback={null}>
					<Console machine={{id: `agent-${agent.id}`, name: machine.name, state: 'running'}} onClose={() => setDesktop(false)} />
				</Suspense>
			)}
		</>
	)
}
