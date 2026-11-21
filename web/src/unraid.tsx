// Settings › Move from Unraid: connect over SSH, choose what to bring over, watch it come across.
import {useEffect, useMemo, useState, type CSSProperties, type FormEvent} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type Listing} from './api'
import {Icon, type IconName} from './icons'
import {Field, Group, Row, Segmented, Switch, haptic, useConfirm, useToast} from './ui'
import {defaultSelectedVms, formatBytes, formatTotalSize, isKeyChangedError, itemStatusForView, jobSummary, retryActionState, type UnraidItem as Item, type UnraidJob as Job} from './unraidView'

type ShareConfig = {comment: string; export: string; security: string; useCache: string; splitLevel: string}
type Share = {name: string; size: number | null; kind: 'share' | 'appdata' | 'system' | 'domains' | 'isos'; config?: ShareConfig}
type StoreMatch = {id: string; name: string; icon: string | null}
type Container = {
	id: string
	name: string
	image: string
	running: boolean
	icon: string | null
	web: {port: number} | null
	copies: {from: string; to: string; file?: boolean; volume?: boolean}[]
	namedVolumes?: {name: string; dest: string}[]
	shares: string[]
	notes: string[]
	problems: string[]
	size: number | null
	installed: boolean
	storeMatch?: StoreMatch
}
type StackGroup = {id: string; name: string; kind: 'vpn' | 'compose' | 'network'; members: string[]; memberNames: string[]}
type UserScript = {id: string; name: string; description: string; schedule: string; script: string}
type Vm = {name: string; state: string; cores: number; memoryMb: number; firmware: string; nvram?: string | null; hasTpm?: boolean; disks: {file: string}[]; notes: string[]; problems: string[]; size: number; installed?: boolean}
type Scan = {shares: Share[]; containers: Container[]; stacks?: StackGroup[]; vms: Vm[]; userScripts?: UserScript[]; at: number; skippedShares?: string[]; skippedVms?: string[]}
type Status = {connected: {host: string; port?: number; authMode?: string; version: string; fingerprint: string | null} | null; scanned: boolean; job: Job | null}
type PreflightResult = {
	ok: boolean
	requiredBytes: number
	freeBytes: number | null
	headroomBytes: number | null
	spaceOk: boolean
	spaceWarning: string | null
	portConflicts: {containerId: string; containerName: string; port: number; conflictWith: string; suggestedPort: number}[]
	runningVms: {name: string; state: string}[]
	activeStacks: StackGroup[]
}

const SHARE_NOTE: Record<Share['kind'], string> = {
	share: '',
	appdata: 'Your containers’ files. They come over with each container you choose.',
	system: 'Unraid’s own Docker and VM files. Not needed here.',
	domains: 'VM disks. They come over with each VM you choose.',
	isos: 'Installer images for VMs.',
}

function Check({on}: {on: boolean}) {
	return <Icon name={on ? 'checked' : 'unchecked'} size={20} />
}

export function UnraidPage({onBack}: {onBack: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const status = useQuery({queryKey: ['unraid.status'], queryFn: () => query<Status>('unraid.status'), retry: false, refetchInterval: (q) => (q.state.data?.job && !q.state.data.job.endedAt ? 1500 : false)})
	const [scan, setScan] = useState<Scan | null>(null)
	const [scanning, setScanning] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// A finished move stays on show until you choose Done (or look again).
	const [dismissed, setDismissed] = useState<string | null>(() => sessionStorage.getItem('omarchy-server:unraid-dismissed'))
	const s = status.data
	const refresh = () => qc.invalidateQueries({queryKey: ['unraid.status']})

	const look = async () => {
		if (scanning) return
		setScanning(true)
		setError(null)
		try {
			setScan(await mutate<Scan>('unraid.scan'))
			if (s?.job) dismiss(s.job.id)
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setScanning(false)
		}
	}
	const running = !!s?.job && !s.job.endedAt
	const showJob = s?.job && (running || s.job.id !== dismissed)
	function dismiss(id: string) {
		sessionStorage.setItem('omarchy-server:unraid-dismissed', id)
		setDismissed(id)
	}
	const disconnect = async () => {
		await mutate('unraid.disconnect').catch(() => {})
		setScan(null)
		setError(null)
		refresh()
	}

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Move from Unraid
				</h1>
			</div>
			{status.isLoading && (
				<div className="glass group">
					<div className="row static">
						<span className="spinner" />
					</div>
				</div>
			)}
			{showJob ? (
				<JobView
					job={s!.job!}
					connected={!!s?.connected}
					scanning={scanning}
					error={error}
					onCancel={async () => {
						const ok = await confirm({title: 'Stop the move?', body: 'What’s being copied right now finishes; the rest is skipped. You can start again later, and copies pick up where they left off.', confirm: 'Stop', danger: true, icon: 'stop'})
						if (ok) await mutate('unraid.cancel').then(refresh)
					}}
					onAgain={look}
					onResync={async () => {
						const ok = await confirm({
							title: 'Sync latest changes from Unraid?',
							body: 'Stops each migrated app here briefly, syncs the latest files from Unraid (overwriting any changes written here since the initial move and removing files deleted on Unraid), then starts the apps again.',
							confirm: 'Sync changes',
							danger: true,
						})
						if (!ok) return
						try {
							await mutate('unraid.resync', {deleteRemoved: true})
							toast('Syncing latest changes from Unraid')
							refresh()
						} catch (e) {
							toast((e as Error).message, true)
						}
					}}
					onDone={() => (dismiss(s!.job!.id), disconnect())}
				/>
			) : !s?.connected ? (
				<ConnectCard onConnected={() => (refresh(), look())} />
			) : scanning || !scan ? (
				<div className="glass card bk-status">
					<div className="bk-status-line">
						{scanning ? <span className="spinner" /> : <Icon name="server" size={18} />}
						<b>{scanning ? `Looking at ${s.connected.host}…` : `Connected to ${s.connected.host}`}</b>
					</div>
					<p className="muted bk-next">{scanning ? 'Measuring shares, containers, VMs, and user scripts. Big shares take a minute or two.' : `Unraid ${s.connected.version}`}</p>
					{error && <p className="bk-err">{error}</p>}
					{!scanning && (
						<button className="btn primary" onClick={look}>
							Look again
						</button>
					)}
				</div>
			) : (
				<Choose
					scan={scan}
					host={s.connected.host}
					fingerprint={s.connected.fingerprint}
					version={s.connected.version}
					onStart={async (input) => {
						try {
							await mutate('unraid.start', input)
							toast('Moving from Unraid')
							refresh()
						} catch (e) {
							toast((e as Error).message, true)
						}
					}}
					onDisconnect={disconnect}
				/>
			)}
		</div>
	)
}

function ConnectCard({onConnected}: {onConnected: () => void}) {
	const toast = useToast()
	const [host, setHost] = useState('tower.local')
	const [port, setPort] = useState('22')
	const [authMode, setAuthMode] = useState<'password' | 'key' | 'hostKey'>('password')
	const [password, setPassword] = useState('')
	const [privateKey, setPrivateKey] = useState('')
	const [passphrase, setPassphrase] = useState('')
	const [busy, setBusy] = useState(false)
	const [forgetting, setForgetting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const canSubmit = !!host && (authMode === 'hostKey' || (authMode === 'password' ? !!password : !!privateKey.trim()))
	const go = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const parsedPort = Number(port) || 22
			await mutate('unraid.connect', {
				host,
				...(parsedPort !== 22 ? {port: parsedPort} : {}),
				authMode,
				...(authMode === 'password' ? {password} : {}),
				...(authMode === 'key' ? {privateKey, ...(passphrase ? {passphrase} : {})} : {}),
			})
			setPassword('')
			setPrivateKey('')
			setPassphrase('')
			onConnected()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	const forget = async () => {
		setForgetting(true)
		try {
			await mutate('unraid.forgetHost', {host, ...(Number(port) && Number(port) !== 22 ? {port: Number(port)} : {})})
			setError(null)
			toast('Forgot this server’s key. Connect again.')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setForgetting(false)
		}
	}
	return (
		<>
			<div className="glass empty bk-hero">
				<span className="big">
					<Icon name="move" size={30} />
				</span>
				<b>Bring your Unraid server over</b>
				<p className="muted" style={{margin: 0, fontSize: 14.5, lineHeight: 1.45}}>
					Your shares and files, your Docker containers (as apps or VPN/Compose stacks, with their GPU settings, volumes, icons, and data), and your VMs (with UEFI NVRAM). Unraid keeps running and isn’t changed.
				</p>
			</div>
			<form onSubmit={go} style={{marginTop: 14}}>
				<Field id="ur-host" label="Unraid server" hint="Its name or address, like tower.local or 192.168.1.10." value={host} onChange={(e) => setHost(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
				<Field id="ur-port" label="SSH port" placeholder="22" value={port} onChange={(e) => setPort(e.target.value)} autoCapitalize="off" autoCorrect="off" />
				<div style={{marginBottom: 12}}>
					<Segmented<'password' | 'key' | 'hostKey'>
						label="Authentication"
						value={authMode}
						onChange={setAuthMode}
						options={[
							{id: 'password', label: 'Password'},
							{id: 'key', label: 'SSH key'},
							{id: 'hostKey', label: 'Server key'},
						]}
					/>
				</div>
				{authMode === 'password' && (
					<Field id="ur-pass" label="Root password" type="password" hint="The one you sign in to Unraid with. Used only for this move and never saved. SSH must be on in Unraid (Settings › Management Access)." value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
				)}
				{authMode === 'key' && (
					<>
						<div className="field" style={{marginBottom: 10}}>
							<label htmlFor="ur-key">SSH private key (PEM / OpenSSH)</label>
							<textarea
								id="ur-key"
								rows={5}
								className="mono"
								style={{width: '100%', fontSize: 12, padding: 10, borderRadius: 10, background: 'var(--field-bg, rgba(127,127,127,0.12))', color: 'inherit', border: '1px solid var(--border, rgba(127,127,127,0.25))'}}
								placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
								value={privateKey}
								onChange={(e) => setPrivateKey(e.target.value)}
								required
							/>
							<span className="hint">Kept only while connected (mode 0600) and deleted automatically on disconnect.</span>
						</div>
						<Field id="ur-passphrase" label="Key passphrase (optional)" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
					</>
				)}
				{authMode === 'hostKey' && (
					<p className="muted" style={{fontSize: 13.5, margin: '4px 4px 12px'}}>
						Uses this Omarchy Server’s existing SSH key (~/.ssh/id_ed25519 or id_rsa). Make sure its public key is in /root/.ssh/authorized_keys on Unraid.
					</p>
				)}
				{error && (
					<div className="error">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				{isKeyChangedError(error) && (
					<button type="button" className="btn block" disabled={busy || forgetting || !host} onClick={forget} style={{marginBottom: 8}}>
						{forgetting && <span className="spinner" />}
						Forget this server’s key
					</button>
				)}
				<button className="btn block primary" disabled={busy || forgetting || !canSubmit} style={{marginTop: 6}}>
					{busy && <span className="spinner" />}
					Connect
				</button>
			</form>
		</>
	)
}

function Choose({scan, host, fingerprint, version, onStart, onDisconnect}: {scan: Scan; host: string; fingerprint: string | null; version: string; onStart: (input: Record<string, unknown>) => Promise<void>; onDisconnect: () => void}) {
	const toast = useToast()
	const [shares, setShares] = useState<Set<string>>(() => new Set(scan.shares.filter((x) => x.kind === 'share').map((x) => x.name)))
	const [containers, setContainers] = useState<Set<string>>(() => new Set(scan.containers.filter((c) => !c.installed && !c.problems.length).map((c) => c.id)))
	const [vms, setVms] = useState<Set<string>>(() => new Set(defaultSelectedVms(scan.vms)))
	const [shareOnNetwork, setShareOnNetwork] = useState(true)
	const [pauseContainers, setPauseContainers] = useState(true)
	const [preserveSettings, setPreserveSettings] = useState(true)
	const [groupStacks, setGroupStacks] = useState(() => (scan.stacks?.length ?? 0) > 0)
	const [shutdownRunningVms, setShutdownRunningVms] = useState(false)
	const [verifyChecksum, setVerifyChecksum] = useState(false)
	const [bwlimitMbps, setBwlimitMbps] = useState('')
	const [excludesText, setExcludesText] = useState('.DS_Store, Thumbs.db, @eaDir')
	const [portOverrides, setPortOverrides] = useState<Record<string, number>>({})
	const [destination, setDestination] = useState('/Home/Unraid')
	const [open, setOpen] = useState<string | null>(null)
	const [openScript, setOpenScript] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [preflight, setPreflight] = useState<PreflightResult | null>(null)
	const pools = useQuery({queryKey: ['files.list', '/Home/Pools'], queryFn: () => query<Listing>('files.list', {path: '/Home/Pools'}), retry: false, staleTime: 60_000})
	const places = ['/Home/Unraid', ...(pools.data?.files ?? []).filter((f) => f.type === 'directory').map((f) => `${f.path}/Unraid`)]
	const flip = (set: Set<string>, put: (s: Set<string>) => void, key: string) => {
		haptic(5)
		const n = new Set(set)
		if (n.has(key)) n.delete(key)
		else n.add(key)
		put(n)
	}
	const shareList = useMemo(() => [...shares], [shares])
	const containerList = useMemo(() => [...containers], [containers])
	const vmList = useMemo(() => [...vms], [vms])
	const count = shareList.length + containerList.length + vmList.length

	// Run live pre-flight space + port-conflict checks whenever selection changes
	useEffect(() => {
		if (!count) {
			setPreflight(null)
			return
		}
		let active = true
		const t = setTimeout(() => {
			mutate<PreflightResult>('unraid.preflight', {
				shares: shareList,
				containers: containerList,
				vms: vmList,
				destination,
				portOverrides,
				preserveSettings,
				shutdownRunningVms,
			})
				.then((r) => active && setPreflight(r))
				.catch(() => active && setPreflight(null))
		}, 250)
		return () => {
			active = false
			clearTimeout(t)
		}
	}, [shareList, containerList, vmList, destination, portOverrides, shutdownRunningVms, count])

	const totalLabel = useMemo(
		() =>
			formatTotalSize([
				...scan.shares.filter((x) => shares.has(x.name)).map((x) => x.size),
				...scan.containers.filter((c) => containers.has(c.id)).map((c) => c.size),
				...scan.vms.filter((v) => vms.has(v.name)).map((v) => v.size),
			]),
		[scan, shares, containers, vms],
	)
	const unsupported = (names: string[]) =>
		names.map((name) => (
			<div key={name} className="row static" style={{minHeight: 56}}>
				<span className="row-ico" style={{'--c': '#8e8e93'} as CSSProperties}>
					<Icon name="alert" size={18} />
				</span>
				<span className="main">
					<b style={{fontWeight: 550}}>{name}</b>
					<span>Not supported yet</span>
				</span>
			</div>
		))
	return (
		<>
			<div className="glass card bk-status">
				<div className="bk-status-line">
					<span className="bk-dot" style={{'--c': 'var(--green)'} as CSSProperties}>
						<Icon name="check" size={16} />
					</span>
					<b>
						{host} · Unraid {version}
					</b>
				</div>
				{fingerprint && <p className="muted bk-next" style={{fontSize: 12.5, wordBreak: 'break-all'}}>Its key: {fingerprint}. Verify on Unraid with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</p>}
			</div>

			<Group title="Shares" footer="Each share is copied into a folder here and shared on your network again. The network name follows the folder, and may be shorter than on Unraid.">
				{scan.shares.map((x) => {
					const choosable = x.kind === 'share' || x.kind === 'isos'
					const cfgMeta = [x.config?.comment, x.config?.security && x.config.security !== 'public' ? `Unraid: ${x.config.security}` : ''].filter(Boolean).join(' · ')
					return (
						<button key={x.name} type="button" className="row" style={{minHeight: 56}} disabled={!choosable} onClick={() => choosable && flip(shares, setShares, x.name)}>
							<span className="row-ico" style={{'--c': shares.has(x.name) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
								{choosable ? <Check on={shares.has(x.name)} /> : <Icon name="folder" size={18} />}
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>{x.name}</b>
								<span>{[formatBytes(x.size), SHARE_NOTE[x.kind], cfgMeta].filter(Boolean).join(' · ')}</span>
							</span>
						</button>
					)
				})}
				{unsupported(scan.skippedShares ?? [])}
			</Group>

			{scan.containers.length > 0 && (
				<Group title="Docker containers" footer="Each one becomes an app here: the same image, settings, GPU/shared-memory/volumes, icons, and ports. Folders it uses from your shares point at where those shares are copied.">
					{scan.containers.map((c) => {
						const override = portOverrides[c.id]
						const volCount = c.namedVolumes?.length ?? 0
						return (
							<div key={c.id}>
								<button type="button" className="row" style={{minHeight: 60}} disabled={c.installed} onClick={() => flip(containers, setContainers, c.id)}>
									<span className="row-ico" style={{'--c': containers.has(c.id) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
										<Check on={containers.has(c.id)} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>
											{c.name}
											{override ? ` (port ${override})` : ''}
										</b>
										<span>
											{c.installed
												? 'Already here'
												: [
														c.image,
														formatBytes(c.size),
														volCount ? `${volCount} Docker volume${volCount === 1 ? '' : 's'}` : '',
														c.storeMatch ? `Also in App Store as ${c.storeMatch.name}` : '',
														c.notes.length ? `${c.notes.length} note${c.notes.length === 1 ? '' : 's'}` : '',
													]
														.filter(Boolean)
														.join(' · ')}
										</span>
									</span>
								</button>
								{c.notes.length > 0 && (
									<button type="button" className="row bk-item" onClick={() => setOpen(open === c.id ? null : c.id)}>
										<Icon name="info" size={15} />
										<span className="main">
											<span>{open === c.id ? c.notes.join(' ') : 'What’s different here'}</span>
										</span>
									</button>
								)}
							</div>
						)
					})}
				</Group>
			)}

			{(scan.vms.length > 0 || (scan.skippedVms ?? []).length > 0) && (
				<Group title="VMs" footer="Disks and UEFI NVRAM firmware settings are copied over. Turn on graceful shutdown below to automatically stop running VMs before copying.">
					{scan.vms.map((v) => {
						const off = v.state === 'shut off'
						return (
							<div key={v.name}>
								<button type="button" className="row" style={{minHeight: 60}} disabled={!!v.installed || !!v.problems.length} onClick={() => flip(vms, setVms, v.name)}>
									<span className="row-ico" style={{'--c': vms.has(v.name) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
										<Check on={vms.has(v.name)} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>{v.name}</b>
										<span>
											{v.installed ? 'Already here' : (v.problems[0] ??
													[
														`${v.cores} cores`,
														`${Math.round(v.memoryMb / 1024)} GB`,
														formatBytes(v.size),
														v.nvram ? 'UEFI NVRAM' : '',
														off ? '' : shutdownRunningVms ? `${v.state} — will shut down gracefully` : `${v.state} on Unraid: shut it down first`,
													]
														.filter(Boolean)
														.join(' · '))}
										</span>
									</span>
								</button>
								{v.notes.length > 0 && (
									<div className="row static bk-item">
										<Icon name="info" size={15} />
										<span className="main">
											<span>{v.notes.join(' ')}</span>
										</span>
									</div>
								)}
							</div>
						)
					})}
					{unsupported(scan.skippedVms ?? [])}
				</Group>
			)}

			{preflight && (
				<Group title="Pre-flight check">
					<Row
						icon={preflight.spaceOk ? 'check' : 'alert'}
						color={preflight.spaceOk ? (preflight.spaceWarning ? 'var(--orange, #f59e0b)' : 'var(--green)') : 'var(--red)'}
						label="Destination space"
						value={preflight.freeBytes != null ? `${formatBytes(preflight.freeBytes)} free` : 'Unknown'}
						sub={preflight.spaceWarning || `Needs ${formatBytes(preflight.requiredBytes)}`}
					/>
					{preflight.portConflicts.map((pc) => (
						<Row
							key={pc.containerId}
							icon="alert"
							color="var(--orange, #f59e0b)"
							label={`${pc.containerName}: port ${pc.port} in use`}
							sub={`Conflicts with ${pc.conflictWith}`}
							trailing={
								<button
									type="button"
									className="btn small primary"
									onClick={() => setPortOverrides({...portOverrides, [pc.containerId]: pc.suggestedPort})}
								>
									Use {pc.suggestedPort}
								</button>
							}
						/>
					))}
					{preflight.activeStacks.map((st) => (
						<Row
							key={st.id}
							icon="apps"
							color="var(--blue)"
							label={`${st.name} (${st.kind === 'vpn' ? 'VPN routed' : st.kind === 'compose' ? 'Compose' : 'Shared network'})`}
							sub={st.memberNames.join(', ')}
						/>
					))}
				</Group>
			)}

			<Group title="Where and how">
				<div className="row static bk-pick">
					<label>
						<span>Copy shares to</span>
						<select className="field" value={destination} onChange={(e) => setDestination(e.target.value)}>
							{places.map((p) => (
								<option key={p} value={p}>
									{p.replace(/^\/Home/, 'Home').replace(/\//g, ' › ')}
								</option>
							))}
						</select>
					</label>
				</div>
				<Row icon="folder-share" color="var(--teal)" label="Share on the network" sub="The network name follows the folder" trailing={<Switch label="Share on the network" on={shareOnNetwork} onChange={setShareOnNetwork} />} />
				<Row icon="stop" color="#8e8e93" label="Pause for the last copy" sub="Each container pauses on Unraid for a moment, so its databases come over whole, then starts again." trailing={<Switch label="Pause each container on Unraid for its last copy" on={pauseContainers} onChange={setPauseContainers} />} />
				<Row icon="apps" color="var(--blue)" label="Preserve GPU, shared memory & Docker volumes" sub="Brings over /dev/dri, NVIDIA GPUs, shm_size, tmpfs, DNS, limits, custom entrypoints, and named volume data." trailing={<Switch label="Preserve GPU, shared memory and named Docker volumes" on={preserveSettings} onChange={setPreserveSettings} />} />
				{(scan.stacks?.length ?? 0) > 0 && (
					<Row icon="network" color="var(--purple)" label="Bundle VPN & shared-network stacks" sub="Keeps Gluetun/VPN dependents and multi-container stacks together in one Compose app." trailing={<Switch label="Bundle VPN and shared-network stacks" on={groupStacks} onChange={setGroupStacks} />} />
				)}
				{scan.vms.some((v) => v.state !== 'shut off') && (
					<Row icon="power" color="var(--orange, #f59e0b)" label="Shut down running VMs on Unraid" sub="Sends a clean ACPI shutdown (virsh shutdown) before copying disks and UEFI NVRAM." trailing={<Switch label="Shut down running VMs on Unraid" on={shutdownRunningVms} onChange={setShutdownRunningVms} />} />
				)}
				<Row icon="shield" color="var(--green)" label="Verify checksums" sub="Compare file checksums during copy (slower, extra thorough)." trailing={<Switch label="Verify checksums" on={verifyChecksum} onChange={setVerifyChecksum} />} />
				<div style={{padding: '10px 14px'}}>
					<Field id="ur-bw" label="Bandwidth limit (MB/s, optional)" placeholder="Unlimited" value={bwlimitMbps} onChange={(e) => setBwlimitMbps(e.target.value)} />
					<Field id="ur-exc" label="Exclude patterns (comma-separated)" placeholder=".DS_Store, Thumbs.db, @eaDir" value={excludesText} onChange={(e) => setExcludesText(e.target.value)} />
				</div>
			</Group>

			{(scan.userScripts?.length ?? 0) > 0 && (
				<Group title="Unraid User Scripts checklist" footer="Custom cron and maintenance scripts found on Unraid. Copy any you still need into systemd user timers or cron here.">
					{(scan.userScripts ?? []).map((sc) => (
						<div key={sc.id}>
							<Row
								icon="logs"
								color="var(--teal)"
								label={sc.name}
								sub={[sc.schedule ? `Schedule: ${sc.schedule}` : 'Manual', sc.description].filter(Boolean).join(' · ')}
								onClick={() => setOpenScript(openScript === sc.id ? null : sc.id)}
								trailing={
									<button
										type="button"
										className="btn small"
										onClick={async (e) => {
											e.stopPropagation()
											try {
												await navigator.clipboard.writeText(sc.script)
												toast(`Copied ${sc.name}`)
											} catch {
												toast('Couldn’t copy script', true)
											}
										}}
									>
										Copy
									</button>
								}
							/>
							{openScript === sc.id && sc.script && (
								<pre className="mono" style={{margin: '0 14px 12px', padding: 10, fontSize: 11.5, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', borderRadius: 8, background: 'rgba(0,0,0,0.2)'}}>
									{sc.script}
								</pre>
							)}
						</div>
					))}
				</Group>
			)}

			<button
				className="btn block primary"
				style={{marginTop: 16}}
				disabled={busy || !count || (preflight !== null && !preflight.spaceOk)}
				onClick={async () => {
					setBusy(true)
					const excludes = excludesText
						.split(',')
						.map((x) => x.trim())
						.filter(Boolean)
					await onStart({
						shares: shareList,
						containers: containerList,
						vms: vmList,
						destination,
						shareOnNetwork,
						pauseContainers,
						preserveSettings,
						groupStacks,
						shutdownRunningVms,
						verifyChecksum,
						...(Number(bwlimitMbps) > 0 ? {bwlimitMbps: Number(bwlimitMbps)} : {}),
						excludes,
						portOverrides,
					})
					setBusy(false)
				}}
			>
				{busy && <span className="spinner" />}
				Bring {count} thing{count === 1 ? '' : 's'} over · {totalLabel}
			</button>
			<button className="btn block ghost" style={{marginTop: 8}} onClick={onDisconnect}>
				Disconnect
			</button>
		</>
	)
}

const STATUS_ICON: Record<Item['status'], IconName> = {waiting: 'clock', running: 'clock', done: 'check', failed: 'alert', skipped: 'stop'}
const KIND_LABEL: Record<Item['kind'], string> = {share: 'Share', container: 'App', vm: 'VM'}

function JobView({job, connected, scanning, error, onCancel, onAgain, onResync, onDone}: {job: Job; connected: boolean; scanning: boolean; error: string | null; onCancel: () => void; onAgain: () => void; onResync: () => void; onDone: () => void}) {
	const summary = jobSummary(job, connected)
	const retry = retryActionState(scanning)
	const canResync = !summary.running && connected && job.items.some((i) => i.status === 'done' && (i.kind === 'share' || i.kind === 'container'))
	useEffect(() => {
		if (!summary.running) haptic(summary.incomplete ? [20, 40, 20] : 12)
	}, [summary.running, summary.incomplete])
	return (
		<>
			<div className="glass card bk-status">
				<div className="bk-status-line">
					{summary.running ? (
						<span className="spinner" />
					) : (
						<span className="bk-dot" style={{'--c': summary.incomplete ? 'var(--orange, #f59e0b)' : 'var(--green)'} as CSSProperties}>
							<Icon name={summary.incomplete ? 'alert' : 'check'} size={16} />
						</span>
					)}
					<b>{summary.heading}</b>
				</div>
				{job.stopped && <p className="bk-err">{job.stopped}</p>}
				{error && <p className="bk-err">{error}</p>}
				{summary.running ? (
					<button className="btn" onClick={onCancel} disabled={job.cancelled}>
						{job.cancelled ? 'Stopping…' : 'Stop'}
					</button>
				) : (
					<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
						{summary.canRetry && (
							<button className="btn primary" style={{flex: 1}} disabled={retry.disabled} onClick={onAgain}>
								{retry.showSpinner && <span className="spinner" />}
								{retry.label}
							</button>
						)}
						{canResync && (
							<button className="btn" style={{flex: 1}} onClick={onResync}>
								Sync changes again
							</button>
						)}
						<button className={`btn ${summary.canRetry ? '' : 'primary'}`} style={{flex: 1}} onClick={onDone}>
							Done
						</button>
					</div>
				)}
			</div>
			<Group title="Progress" footer={summary.running ? 'You can leave this page: the move carries on, and copies pick up where they left off if anything stops them.' : undefined}>
				{job.items.map((i) => {
					const st = itemStatusForView(i, summary.running)
					return (
						<div key={`${i.kind}-${i.key}`}>
							<div className="row static" style={{minHeight: 60}}>
								<span className="row-ico" style={{'--c': st === 'done' ? 'var(--green)' : st === 'failed' ? 'var(--red)' : st === 'running' ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
									{st === 'running' ? <span className="spinner" /> : <Icon name={STATUS_ICON[st]} size={18} />}
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>
										{KIND_LABEL[i.kind]} · {i.name}
									</b>
									<span>
										{st === 'running'
											? `${i.step ?? 'Starting'}${i.progress ? ` · ${Math.round(i.progress * 100)}%` : ''}`
											: st === 'failed'
												? i.error || 'Stopped'
												: st === 'done'
													? i.path
														? i.path.replace(/^\/Home/, 'Home').replace(/\//g, ' › ')
														: 'Here now'
													: st === 'skipped'
														? 'Skipped'
														: formatBytes(i.size)}
									</span>
								</span>
							</div>
							{summary.running && st === 'running' && (
								<div className="row static" style={{minHeight: 0, paddingTop: 0}}>
									<div className="bk-bar" style={{flex: 1}}>
										<span style={{width: `${Math.max(3, Math.round((i.progress ?? 0) * 100))}%`}} />
									</div>
								</div>
							)}
							{i.note && (
								<div className="row static bk-item">
									<Icon name="info" size={15} />
									<span className="main">
										<span>{i.note}</span>
									</span>
								</div>
							)}
						</div>
					)
				})}
			</Group>
		</>
	)
}
