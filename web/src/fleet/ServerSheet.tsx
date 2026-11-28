import {lazy, Suspense, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query, type Machine, type UserApp} from '../api'
import {useAction} from '../data'
import {Icon} from '../icons'
import {MachineActions} from './machineActions'
import {MachineShell, MachineTabs} from './MachineTabs'
import {PinButton} from './PinButton'
import {ServerRings, useServerGaugeMetrics} from './serverGauges'
import {SheetGroup} from './sheetGroup'
import {themeAction} from '../theme/themeAction'
import {ThemePicker} from '../theme/ThemePicker'
import {Row, SheetHeader, StatusPill, haptic} from '../ui'
import {MachineSeen} from './MachineSeen'
import {openStore} from './openStore'
import {MachineApps} from './MachineApps'
import {SERVER_FLEET_ID} from './list'
import {StoragePage, StoragePanel} from '../screens/Storage'
import {useNode} from '../machines/api'
import {DetailFrame, type DetailSection} from '../machines/detailFrame'
import {BackupsPage} from '../backups'
import {ServerLogs, ServerNetwork} from '../screens/machineHost'
import {ContainersPanel} from '../containers/Containers'
import {ClipBook} from '../clips/ClipBook'
import {serverHere} from '../clips/view'

const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

export function ServerSheet({
	name,
	owner,
	vms,
	onClose,
	onDesktop,
	onTerminal,
	onOpenVm,
	onCreateVm,
	onOpenApp,
	bare,
	layout = 'page',
}: {
	name: string
	owner: boolean
	vms: Machine[]
	onClose: () => void
	onDesktop: () => void
	onTerminal?: () => void
	onOpenVm: (id: string) => void
	onCreateVm: () => void
	onOpenApp?: (app: UserApp) => void
	/** Desktop Machines window: the page sits in the split, not over the screen. */
	bare?: boolean
	/** Compact Machines: the same header and side list as a virtual machine. */
	layout?: 'page' | 'nav'
}) {
	const node = useNode()
	const {uptime} = useServerGaugeMetrics()
	const themes = useQuery({
		queryKey: ['omarchy.themes'],
		queryFn: () => query<{installed: {slug: string; name: string; current: boolean}[]}>('omarchy.themes'),
		enabled: owner,
	})
	const installed = themes.data?.installed ?? []
	const action = useAction()
	const currentTheme = installed.find((t) => t.current)?.name ?? ''
	const [tab, setTab] = useState(layout === 'nav' ? 'summary' : 'files')
	const [more, setMore] = useState<'storage' | 'backups' | null>(null)
	if (more === 'storage') return <StoragePanel bare={bare} target="host" onClose={() => setMore(null)} />
	if (more === 'backups') return <BackupsPage onBack={() => setMore(null)} />
	const tabs = [
		{
			id: 'files',
			label: 'Files',
			body: (
				<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
					<MachineFiles scope={{kind: 'server' as const}} windowId="machine:server" />
				</Suspense>
			),
		},
		{
			id: 'clips',
			label: 'Clip book',
			body: <ClipBook here={serverHere(name)} readings />,
		},
		{
			id: 'apps',
			label: 'Apps',
			body: <Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${name}`} onClick={() => (haptic(6), onClose(), openStore({id: SERVER_FLEET_ID, kind: 'server', name}))} />,
		},
		...(owner
			? [
					{id: 'storage', label: 'Storage', body: <Row icon="disk" color="var(--teal)" label="Storage" sub="Drives, pools, and drive sleep" onClick={() => (haptic(6), setMore('storage'))} />},
					{id: 'backups', label: 'Backups', body: <Row icon="history" color="var(--green)" label="Backups" sub="Apps, settings, and this server’s machines" onClick={() => (haptic(6), setMore('backups'))} />},
				]
			: []),
		{
			id: 'machines',
			label: 'Virtual machines',
			body: (
				<>
					{vms.length === 0 ? <p className="quiet">No virtual machines on {name}.</p> : vms.map((vm) => <Row key={vm.id} icon="machine" label={vm.name} sub="Virtual machine" onClick={() => (haptic(6), onOpenVm(vm.id))} />)}
					<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), onCreateVm())}>
						<Icon name="plus" size={15} /> Create VM
					</button>
				</>
			),
		},
		...(owner ? [{id: 'containers', label: 'LXC containers', body: <ContainersPanel serverName={name} />}] : []),
		...(owner
			? [
					{id: 'network', label: 'Network', body: <ServerNetwork />},
					{id: 'logs', label: 'Logs', body: <ServerLogs />},
					{
						id: 'manage',
						label: 'Manage',
						body: (
							<Row
								icon="palette"
								color="#a855f7"
								label="Theme"
								trailing={
									<ThemePicker
										themes={installed.map((t) => t.name)}
										theme={currentTheme}
										disabled={action.isPending || !installed.length}
										onPick={(picked) => {
											const slug = installed.find((t) => t.name === picked)?.slug
											if (!slug) return
											const call = themeAction({kind: 'server', slug})
											if ('path' in call) action.mutate({path: call.path, input: call.input, done: `Setting ${picked} on ${name}…`})
										}}
									/>
								}
							/>
						),
					},
				]
			: []),
	]
	if (layout === 'nav') {
		const n = node.data
		const sections: DetailSection[] = [
			{id: 'summary', label: 'Summary', icon: 'activity'},
			{id: 'files', label: 'Files', icon: 'folder'},
			{id: 'clips', label: 'Clip book', icon: 'clipboard'},
			{id: 'apps', label: 'Apps', icon: 'store'},
			...(owner
				? [
						{id: 'storage', label: 'Storage', icon: 'disk' as const},
						{id: 'backups', label: 'Backups', icon: 'save' as const},
					]
				: []),
			{id: 'machines', label: 'Virtual machines', icon: 'machine'},
			...(owner ? [{id: 'containers', label: 'LXC containers', icon: 'category' as const}] : []),
			...(owner
				? [
						{id: 'network', label: 'Network', icon: 'networking' as const},
						{id: 'logs', label: 'Logs', icon: 'logs' as const},
						{id: 'manage', label: 'Manage', icon: 'settings' as const},
					]
				: []),
		]
		const current = sections.some((item) => item.id === tab) ? tab : 'summary'
		return (
			<DetailFrame
				name={name}
				facts={n?.hostname ? [{label: 'Hostname', value: n.hostname}] : []}
				icon="server"
				iconBg="linear-gradient(140deg,#2b2b2b,#0b0b0b)"
				status={<StatusPill kind={node.isError ? 'stopped' : 'running'} label={node.isError ? 'Offline' : 'Online'} />}
				navLabel={`${name} sections`}
				sections={sections}
				section={current}
				onSection={setTab}
				store={
					<button type="button" className="btn small" title={`Installs on ${name}`} onClick={() => (haptic(6), openStore({id: SERVER_FLEET_ID, kind: 'server', name}))}>
						<Icon name="store" size={14} /> App Store
					</button>
				}
			>
				{current === 'summary' ? (
					<>
						<MachineActions terminal={!!onTerminal} desktop={owner} onTerminal={() => onTerminal?.()} onDesktop={onDesktop} pin={<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={name} />} />
						{n?.performanceWarning && (
							<div className="error" role="alert">
								<Icon name="alert" size={18} />
								{n.performanceWarning}
							</div>
						)}
						<ServerRings name={name} />
						<MachineSeen online={!node.isError} uptime={uptime} />
						<SheetGroup title="Status">
							<Row icon="cpu" color="var(--accent)" label="CPU" sub={n ? `${n.threads} × ${n.cpuModel}` : '–'} />
							<Row icon="activity" color="var(--accent)" label="Load average" trailing={n ? <b>{n.loadAverage.map((x) => x.toFixed(2)).join(', ')}</b> : undefined} />
							<Row icon="machine" color="#8e8e93" label="Virtualization" sub={n ? `${n.kvmAvailable ? 'KVM' : 'Software only (slow)'} · libvirt ${n.libvirtVersion ?? '?'} · QEMU ${n.qemuVersion ?? '?'}` : '–'} />
							<Row icon="machine" color="var(--accent)" label="Machines" trailing={n ? <b>{`${n.counts.running} of ${n.counts.total} online`}</b> : undefined} />
						</SheetGroup>
					</>
				) : current === 'storage' ? (
					<StoragePage target="host" />
				) : current === 'backups' ? (
					<BackupsPage />
				) : current === 'apps' ? (
					<MachineApps computerId={SERVER_FLEET_ID} name={name} onOpenApp={onOpenApp} />
				) : (
					tabs.find((item) => item.id === current)?.body
				)}
			</DetailFrame>
		)
	}
	return (
		<MachineShell bare={bare} label={name} onClose={onClose}>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)'}}>
						<Icon name="server" size={32} />
					</span>
				}
				title={name}
				subtitle="Computer · entrypoint · online"
				onClose={onClose}
			/>
			<MachineActions terminal={!!onTerminal} desktop={owner} onTerminal={() => onTerminal?.()} onDesktop={onDesktop} pin={<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={name} />} />
			<ServerRings name={name} />
			<MachineSeen online={!node.isError} uptime={uptime} />
			<MachineTabs label={`${name} sections`} tabs={tabs} tab={tab} onTab={setTab} />
		</MachineShell>
	)
}
