// The compact page for one virtual machine. This server and a joined computer use the same frame.
import {useEffect, useRef, useState} from 'react'

import {useDesktop} from '../desktop/Desktop'
import {GuestLive} from '../fleet/GuestLive'
import {SERVER_FLEET_ID} from '../fleet/list'
import {PinButton} from '../fleet/PinButton'
import {SheetGroup} from '../fleet/sheetGroup'
import {openStore} from '../fleet/openStore'
import {Icon, type IconName} from '../icons'
import {osLook} from '../osLook'
import {StoragePage} from '../screens/Storage'
import {haptic, machineStatus, StatusPill} from '../ui'
import {type Machine} from '../api'
import {useMachineDetails, useNode} from './api'
import {PortForwarding} from './PortForwarding'
import {DevicesPanel} from '../usb'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from './panels'
import {DetailFrame} from './detailFrame'
import {GuestClips} from '../clips/GuestClips'

export function VmView({m, physicalName, hostname, panel, setPanel, onGone, onBack, backLabel}: {m: Machine; physicalName: string; hostname?: string | null; panel: PanelId; setPanel: (p: PanelId) => void; onGone: () => void; onBack?: () => void; backLabel?: string}) {
	const details = useMachineDetails(m.id)
	const serverNode = useNode()
	const shownHostname = hostname === undefined ? serverNode.data?.hostname : (hostname ?? undefined)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const desk = useDesktop()
	const [menu, setMenu] = useState<'shutdown' | 'more' | null>(null)
	const [storage, setStorage] = useState<{agentId: string; name: string} | null>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!menu) return
		const off = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null)
		window.addEventListener('pointerdown', off)
		return () => window.removeEventListener('pointerdown', off)
	}, [menu])
	const os = osLook(m.osId)
	const busy = !['running', 'stopped', 'suspended', 'hibernated', 'error'].includes(m.state) || power.pending
	const item = (icon: IconName, label: string, onClick: () => void, disabled = false, danger = false) => (
		<button type="button" role="menuitem" className={danger ? 'danger' : ''} disabled={disabled} onClick={() => (setMenu(null), onClick())}>
			<Icon name={icon} size={15} /> {label}
		</button>
	)
	const panels = PANELS.filter((p) => p.id !== 'cloudinit' || d?.cloudInit)
	return (
		<DetailFrame
			name={`${m.name} on ${physicalName}`}
			facts={[...(m.vmid != null ? [{label: 'Virtual machine ID', value: String(m.vmid)}] : []), ...(shownHostname ? [{label: 'Hostname', value: shownHostname}] : [])]}
			icon={os.icon}
			iconBg={os.bg}
			status={<StatusPill {...machineStatus(m.state)} />}
			extra={m.state === 'installing' && m.installProgress !== undefined ? <span className="muted">{m.installProgress}%</span> : null}
			onBack={onBack}
			backLabel={backLabel}
			navLabel={`${m.name} settings`}
			sections={panels}
			section={panel}
			onSection={(id) => {
				setStorage(null)
				setPanel(id as PanelId)
			}}
			store={
				<button type="button" className="btn small" title={`Installs on ${m.name}`} onClick={() => (haptic(6), openStore({id: m.id, kind: 'guest', name: m.name}))}>
					<Icon name="store" size={14} /> App Store
				</button>
			}
			toolbar={
				<div className="pve-toolbar" ref={menuRef}>
					<button type="button" className="btn small" disabled={!power.canStart || busy} onClick={power.paused ? power.resume : power.start}>
						<Icon name="play" size={14} /> {m.state === 'hibernated' ? 'Resume' : 'Start'}
					</button>
					<span className="pve-split">
						<button type="button" className="btn small" disabled={!power.on || busy} onClick={power.shutdown}>
							<Icon name="power" size={14} /> Shutdown
						</button>
						<button type="button" className="btn small" aria-label="More power options" aria-haspopup="menu" aria-expanded={menu === 'shutdown'} disabled={!power.on || busy} onClick={() => setMenu(menu === 'shutdown' ? null : 'shutdown')}>
							<Icon name="chevron-down" size={13} />
						</button>
						{menu === 'shutdown' && (
							<div className="pve-menu" role="menu">
								{item('restart', 'Reboot', power.reboot, m.state !== 'running')}
								{item('stop', 'Stop', power.stop, false, true)}
								{power.paused ? item('play', 'Resume', power.resume) : item('pulse', 'Pause', power.pause, m.state !== 'running')}
								{item('download', 'Hibernate', power.hibernate, m.state !== 'running')}
							</div>
						)}
					</span>
					<span className="pve-split">
						<button type="button" className="btn small" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>
							More <Icon name="chevron-down" size={13} />
						</button>
						{menu === 'more' && (
							<div className="pve-menu right" role="menu">
								{item('copy', 'Clone', power.clone, !power.canStart || m.state === 'error')}
								{item('save', 'Backup now', () => setPanel('backups'))}
								{item('trash', 'Remove', () => power.remove(onGone), busy, true)}
							</div>
						)}
					</span>
				</div>
			}
		>
			{!d ? (
						<div className="win-empty">{details.error ? (details.error as Error).message : <span className="spinner" />}</div>
					) : storage ? (
						<StoragePage target={storage} />
					) : panel === 'summary' ? (
						<>
							<GuestLive
								machine={m}
								pin={<PinButton pin={{kind: 'vm', id: m.id, computer: SERVER_FLEET_ID}} name={m.name} />}
								onOpenDesktop={() => desk?.openConsole(m.id)}
								onOpenStorage={setStorage}
								onBackups={() => setPanel('backups')}
								tabs={(sections) => (
									<>
										{(sections.storage || sections.backups) && (
											<SheetGroup title="Storage">
												{sections.storage}
												{sections.backups}
											</SheetGroup>
										)}
										{sections.files}
										{sections.apps && <SheetGroup title="Apps">{sections.apps}</SheetGroup>}
										{sections.manage}
									</>
								)}
							/>
							<SummaryPanel d={d} />
						</>
					) : panel === 'hardware' ? (
						<HardwarePanel d={d} />
					) : panel === 'cloudinit' ? (
						<CloudInitPanel d={d} />
					) : panel === 'options' ? (
						<OptionsPanel d={d} />
					) : panel === 'network' ? (
						<div className="mx-panel">
							<PortForwarding machine={m} />
						</div>
					) : panel === 'usb' ? (
						<div className="mx-panel">
							<DevicesPanel guest={{kind: 'machine', id: m.id, name: m.name}} />
						</div>
					) : panel === 'clips' ? (
						<GuestClips machine={m} />
					) : panel === 'snapshots' ? (
						<SnapshotsPanel d={d} />
					) : panel === 'backups' ? (
						<BackupsPanel d={d} />
					) : panel === 'history' ? (
						<HistoryPanel d={d} />
					) : (
						<MonitorPanel d={d} />
					)}
		</DetailFrame>
	)
}
