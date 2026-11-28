import {useEffect, useState, type CSSProperties, type FormEvent, type ReactNode} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {Field, Row, Segmented, Sheet, SheetHeader, useConfirm, useToast} from '../ui'
import {hostnameAddress} from './hostnameHint'
import {TailscaleSheet} from './Tailscale'
import {wifiRowValue} from './wifiRow'

function useQ<T>(path: string, input?: unknown, opts: {enabled?: boolean; refetchInterval?: number | false} = {}) {
	return useQuery({queryKey: [path, input], queryFn: () => query<T>(path, input), retry: false, staleTime: 15_000, ...opts})
}

function useSave() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string; refresh?: string[]}) => mutate(a.path, a.input),
		onSuccess: (_, a) => {
			if (a.done) toast(a.done)
		},
		onError: (e: Error) => toast(e.message, true),
		onSettled: (_, __, a) => {
			for (const key of a.refresh ?? []) qc.invalidateQueries({queryKey: [key]})
		},
	})
}

function FormSheet({open, title, subtitle, onClose, onSubmit, busy, submit, danger, children, disabled}: {
	open: boolean
	title: string
	subtitle?: string
	onClose: () => void
	onSubmit: () => void
	busy?: boolean
	submit: string
	danger?: boolean
	disabled?: boolean
	children: ReactNode
}) {
	const go = (e: FormEvent) => {
		e.preventDefault()
		onSubmit()
	}
	return (
		<Sheet open={open} onClose={onClose} label={title}>
			<SheetHeader title={title} subtitle={subtitle} onClose={onClose} />
			<form onSubmit={go}>
				{children}
				<button className={`btn block ${danger ? 'danger solid' : 'primary'}`} disabled={busy || disabled} style={{marginTop: 6}}>
					{busy && <span className="spinner" />}
					{submit}
				</button>
			</form>
		</Sheet>
	)
}

function HostnameSheet({open, current, onClose}: {open: boolean; current: string; onClose: () => void}) {
	const save = useSave()
	const [name, setName] = useState(current)
	useEffect(() => setName(current), [current, open])
	const valid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name.trim().toLowerCase())
	return (
		<FormSheet
			open={open}
			title="Device name"
			subtitle="How your server appears on your network"
			onClose={onClose}
			submit="Save"
			busy={save.isPending}
			disabled={!valid || name.trim().toLowerCase() === current}
			onSubmit={() => save.mutate({path: 'system.setHostname', input: {hostname: name.trim().toLowerCase()}, done: 'Device name changed', refresh: ['system.getHostname']}, {onSuccess: onClose})}
		>
			<Field
				id="host"
				label="Name"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				value={name}
				onChange={(e) => setName(e.target.value)}
				hint={valid ? `Reachable at ${hostnameAddress(name.trim().toLowerCase())}` : undefined}
				error={!valid ? 'Letters, numbers and dashes only.' : undefined}
				autoFocus
			/>
		</FormSheet>
	)
}

function WifiSheet({onClose, connected}: {onClose: () => void; connected?: string}) {
	const save = useSave()
	const confirm = useConfirm()
	const networks = useQ<{ssid: string; signal: number; authenticated: boolean; active: boolean}[]>('wifi.networks', undefined, {refetchInterval: 10_000})
	const [target, setTarget] = useState<{ssid: string; authenticated: boolean} | null>(null)
	const [password, setPassword] = useState('')
	const connect = (ssid: string, pw?: string) =>
		save.mutate({path: 'wifi.connect', input: {ssid, ...(pw ? {password: pw} : {})}, done: `Connected to ${ssid}`, refresh: ['wifi.connected', 'wifi.networks']}, {onSuccess: () => setTarget(null)})
	return (
		<Sheet open onClose={onClose} label="Wi-Fi">
			<SheetHeader title="Wi-Fi" subtitle={connected ? `Connected to ${connected}` : 'Not connected'} onClose={onClose} />
			{target ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						connect(target.ssid, password)
					}}
				>
					<Field id="wifi-pw" label={`Password for ${target.ssid}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
					<div className="stack">
						<button className="btn primary block" disabled={save.isPending || !password}>
							{save.isPending && <span className="spinner" />}
							Join
						</button>
						<button type="button" className="btn block ghost" onClick={() => setTarget(null)}>
							Back
						</button>
					</div>
				</form>
			) : (
				<>
					<div className="glass group" style={{borderRadius: 18, '--inset': '62px'} as CSSProperties}>
						{networks.isLoading && (
							<div className="row static">
								<span className="spinner" /> Looking for networks…
							</div>
						)}
						{(networks.data ?? []).map((n) => (
							<button key={n.ssid} className="row" style={{minHeight: 56}} disabled={n.active || save.isPending} onClick={() => (n.authenticated ? (setPassword(''), setTarget(n)) : connect(n.ssid))}>
								<span className="row-ico" style={{'--c': n.active ? 'var(--green)' : 'var(--blue)'} as CSSProperties}>
									<Icon name="wifi" size={18} />
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>{n.ssid}</b>
									<span>{n.active ? 'Connected' : `${n.signal}% signal${n.authenticated ? ' · secured' : ''}`}</span>
								</span>
							</button>
						))}
						{networks.data?.length === 0 && <div className="row static muted">No networks found.</div>}
					</div>
					{connected && (
						<button
							className="btn danger block"
							style={{marginTop: 14}}
							onClick={async () => {
								if (await confirm({title: 'Turn off Wi-Fi?', body: 'If Wi-Fi is how your server connects, you’ll lose access until it’s wired in.', confirm: 'Disconnect', danger: true}))
									save.mutate({path: 'wifi.disconnect', done: 'Wi-Fi disconnected', refresh: ['wifi.connected']})
							}}
						>
							Disconnect
						</button>
					)}
				</>
			)}
		</Sheet>
	)
}

function ResetSheet({open, onClose, onDone}: {open: boolean; onClose: () => void; onDone: () => void}) {
	const save = useSave()
	const [password, setPassword] = useState('')
	const [typed, setTyped] = useState('')
	useEffect(() => {
		setPassword('')
		setTyped('')
	}, [open])
	return (
		<FormSheet
			open={open}
			title="Factory reset"
			subtitle="Erases this server’s apps, machines and accounts"
			onClose={onClose}
			submit="Reset My Own Data Center"
			danger
			busy={save.isPending}
			disabled={!password || typed !== 'RESET'}
			onSubmit={() => save.mutate({path: 'system.factoryReset', input: {password}, done: 'Your server is resetting'}, {onSuccess: onDone})}
		>
			<div className="error" role="alert" style={{marginBottom: 16}}>
				<Icon name="alert" size={18} />
				Every app and its data, every machine and its disks, and all My Own Data Center accounts and settings are permanently deleted. Afterwards you make the first account again in a Terminal on the server; the sign-in page shows the command. This can’t be undone. Your own files, storage pools and the Omarchy desktop are left as they are.
			</div>
			<Field id="reset-pw" label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
			<Field id="reset-type" label="Type RESET to confirm" autoCapitalize="characters" autoCorrect="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
		</FormSheet>
	)
}

/** This server’s name, address, and Wi-Fi. They belong on the server machine, not in Settings. */
export function ServerNetwork() {
	const hostname = useQ<string>('system.getHostname')
	const ips = useQ<string[]>('system.getIpAddresses')
	const wifiSupported = useQ<boolean>('wifi.supported')
	const wifi = useQ<{status: 'connected' | 'disconnected'; ssid?: string}>('wifi.connected', undefined, {enabled: !!wifiSupported.data})
	const tailscale = useQ<{available: boolean; backendState: string; self: {ips: string[]} | null}>('tailscale.status', undefined, {refetchInterval: 30_000})
	const ts = tailscale.data
	const tsValue = tailscale.isError ? 'Unavailable' : !ts ? '' : !ts.available ? 'Not running' : ts.backendState === 'Running' ? (ts.self?.ips.find((ip) => ip.includes('.')) ?? ts.self?.ips[0] ?? 'Connected') : ts.backendState === 'NeedsLogin' ? 'Sign in' : ts.backendState
	const [sheet, setSheet] = useState<null | 'hostname' | 'wifi' | 'tailscale'>(null)
	return (
		<>
			<div className="glass group">
				<Row icon="network" color="var(--teal)" label="Device name" value={hostname.data ? `${hostname.data}.local` : ''} onClick={() => setSheet('hostname')} />
				<Row icon="networking" color="var(--blue)" label="IP address" value={(ips.data ?? []).join(', ') || '–'} />
				{wifiSupported.data && <Row icon="wifi" color="var(--blue)" label="Wi-Fi" value={wifiRowValue(wifi.data)} onClick={() => setSheet('wifi')} />}
				<Row icon="networking" color="var(--purple, #8b5cf6)" label="Tailscale" value={tsValue} onClick={() => setSheet('tailscale')} />
			</div>
			<HostnameSheet open={sheet === 'hostname'} current={hostname.data ?? ''} onClose={() => setSheet(null)} />
			{sheet === 'wifi' && <WifiSheet onClose={() => setSheet(null)} connected={wifi.data?.status === 'connected' ? wifi.data.ssid : undefined} />}
			{sheet === 'tailscale' && <TailscaleSheet onClose={() => setSheet(null)} />}
		</>
	)
}

/** This server’s logs, on the server machine. Not a second sheet over the page. */
export function ServerLogs() {
	const [type, setType] = useState<'server' | 'system'>('server')
	const logs = useQ<string>('system.logs', {type, lines: 1500, maxOutputBytes: 400_000})
	const [el, setEl] = useState<HTMLPreElement | null>(null)
	useEffect(() => {
		if (el) el.scrollTop = el.scrollHeight
	}, [el, logs.data])
	return (
		<>
			<Segmented
				label="Log"
				value={type}
				onChange={setType}
				options={[
					{id: 'server', label: 'MODC'},
					{id: 'system', label: 'System'},
				]}
			/>
			<pre className="logs" ref={setEl}>
				{logs.isLoading ? 'Loading…' : logs.error ? (logs.error as Error).message : logs.data?.trim() || 'No log output.'}
			</pre>
		</>
	)
}

/** Factory reset lives on System. It erases the product, not one machine’s disks. */
export function FactoryReset({onDone}: {onDone: () => void}) {
	const [open, setOpen] = useState(false)
	return (
		<>
			<Row icon="danger" color="var(--red)" label="Factory reset" onClick={() => setOpen(true)} />
			<ResetSheet open={open} onClose={() => setOpen(false)} onDone={onDone} />
		</>
	)
}
