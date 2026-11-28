import {useEffect, useState, type CSSProperties} from 'react'

import {useInstallReview} from './data'
import {Icon} from './icons'
import {AppIcon, Field, Switch, bytes, haptic, useConfirm, useToast} from './ui'
import {folderKey, folderPathOk, reviewInstallInput, type ReviewInstallInput} from './installReview'

// The store's "Before you install" body. The store sheet and the assistant both use this,
// so an install from chat asks for the same access, folders, and one-time setup.
export function BeforeInstall({
	appId,
	appName,
	machineName,
	installSize,
	pending,
	cancelLabel,
	onInstall,
	onCancel,
	openTerminal,
}: {
	appId: string
	appName: string
	/** The machine this install will land on. The assistant omits it and says "your server". */
	machineName?: string
	installSize?: number
	pending?: boolean
	cancelLabel: string
	onInstall: (input: ReviewInstallInput) => void
	onCancel: () => void
	openTerminal?: (command: string) => void
}) {
	const review = useInstallReview(appId)
	const toast = useToast()
	const confirm = useConfirm()
	const [allowed, setAllowed] = useState(false)
	const [placed, setPlaced] = useState<Record<string, string | null>>({})
	const [enableOidc, setEnableOidc] = useState(false)
	const setOidcWithConfirm = async (on: boolean) => {
		if (on) {
			const ok = await confirm({
				title: `Let ${appName} use your accounts?`,
				body: 'People will sign into this app with accounts on this server, including two-factor. Only turn this on for an app you trust with those sign-ins.',
				confirm: 'Share sign-in',
				danger: true,
				icon: 'key',
			})
			if (!ok) return
		}
		setEnableOidc(on)
	}
	useEffect(() => setAllowed(false), [appId])
	useEffect(() => setPlaced({}), [appId])
	// Never auto-enable OIDC from defaultOn — sharing accounts needs the same confirm as flipping the switch.
	useEffect(() => setEnableOidc(false), [appId])
	const data = review.data
	const access = data?.permissions ?? []
	const setup = data?.setup ?? []
	const folders = data?.folders ?? []
	const home = data?.home ?? ''
	const choice = data ? reviewInstallInput(data, allowed, placed, enableOidc) : null
	const copy = (text: string) =>
		navigator.clipboard?.writeText(text).then(
			() => toast('Copied'),
			() => toast('Couldn’t copy here: select the command and copy it', true),
		)
	const install = () => {
		if (!choice) return
		haptic(12)
		onInstall(choice)
	}
	return (
		<div className="screen">
			<h3 style={{margin: '0 0 6px', fontSize: 18, fontWeight: 680}}>Before you install</h3>
			<p className="prose" style={{margin: '0 0 16px'}}>
				{appName} will be installed on {machineName || 'your server'}{installSize ? ` (${bytes(installSize)} download)` : ''}.
			</p>
			{review.isLoading && (
				<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
					<span className="spinner" /> Checking what it needs…
				</div>
			)}
			{review.error && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(review.error as Error).message}
				</div>
			)}
			{(data?.alsoInstalls?.length ?? 0) > 0 && (
				<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
					<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
						Also installs (it needs {data!.alsoInstalls!.length > 1 ? 'these' : 'this'})
					</div>
					{data!.alsoInstalls!.map((d) => (
						<div className="perm" key={d.id}>
							<AppIcon src={d.icon} name={d.name} size={34} />
							<span className="main">
								<b>{d.name}</b>
								<span>installed first</span>
							</span>
						</div>
					))}
				</div>
			)}
			{data && (data.requiredFolders.length > 0 || data.gpuAccess) && (
				<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
					<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
						It will have access to
					</div>
					{data.requiredFolders.map((f) => (
						<div className="perm" key={f.id}>
							<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
								<Icon name="folder" size={18} />
							</span>
							<span className="main">
								<b>
									{f.name}
									{f.readOnly ? ' · read-only' : ''}
								</b>
								<span>{f.defaultSourcePath}</span>
							</span>
						</div>
					))}
					{data.gpuAccess && (
						<div className="perm">
							<span className="row-ico" style={{'--c': 'var(--peach)'} as CSSProperties}>
								<Icon name="bolt" size={18} />
							</span>
							<span className="main">
								<b>Graphics card</b>
								<span>hardware acceleration</span>
							</span>
						</div>
					)}
				</div>
			)}
			{access.length > 0 && (
				<div className="access-ask">
					<div className="access-head">
						<Icon name="alert" size={18} />
						<b>{appName} asks for extra access</b>
					</div>
					{access.map((p) => (
						<div className="access-item" key={`${p.appId}-${p.id}`}>
							<b>
								{p.label}
								{access.some((x) => x.appId !== appId) ? ` · ${p.appName}` : ''}
							</b>
							<span>{p.detail}</span>
							{['low-ports', 'devices', 'host-files', 'system', 'system-software', 'refused'].includes(p.id) && p.what?.length ? <span className="access-what">{p.what.join(', ')}</span> : null}
						</div>
					))}
					{access.some((p) => p.id === 'refused') ? (
						<p className="access-refused">{appName} asks for folders this server never gives an app (your whole home, its hidden folders, or system folders), so it can’t be installed.</p>
					) : (
						<label className="access-allow">
							<input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
							<span>I understand. Allow this for {appName}.</span>
						</label>
					)}
				</div>
			)}
			{folders.map((f) => {
				const k = folderKey(f)
				const value = placed[k]
				return (
					<div key={k} className="glass card" style={{marginBottom: 16, borderRadius: 18}}>
						<div style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6}}>
							<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
								<Icon name="folder" size={18} />
							</span>
							<b style={{fontSize: 15}}>{f.label}</b>
						</div>
						{f.detail && <p className="prose" style={{margin: '0 0 10px', fontSize: 14}}>{f.detail}</p>}
						<label style={{display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', fontSize: 14.5}}>
							<input type="radio" name={`folder-${k}`} checked={value == null} onChange={() => setPlaced((p) => ({...p, [k]: null}))} />
							<span>
								Inside {f.appName}
								<small className="muted" style={{display: 'block'}}>Only {f.appName} sees them. Uninstalling with its data deletes them.</small>
							</span>
						</label>
						<label style={{display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', fontSize: 14.5}}>
							<input type="radio" name={`folder-${k}`} checked={value != null} onChange={() => setPlaced((p) => ({...p, [k]: f.suggest ?? `${home}/`}))} />
							<span>
								A folder in your home
								<small className="muted" style={{display: 'block'}}>You can open them from Files and the desktop too, and they stay if you uninstall.</small>
							</span>
						</label>
						{value != null && (
							<div style={{marginTop: 6}}>
								<Field
									label={`Folder for ${f.label}`}
									labelHidden
									value={value}
									spellCheck={false}
									autoCapitalize="off"
									autoCorrect="off"
									onChange={(e) => setPlaced((p) => ({...p, [k]: e.target.value}))}
									error={!folderPathOk(value, home) ? `Pick a folder inside ${home} (not a hidden one).` : undefined}
								/>
							</div>
						)}
					</div>
				)
			})}
			{setup.map((s) => (
				<div key={s.appId} className="glass card" style={{marginBottom: 16, borderRadius: 18}}>
					<div style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8}}>
						<span className="row-ico" style={{'--c': 'var(--yellow)'} as CSSProperties}>
							<Icon name="terminal" size={18} />
						</span>
						<b style={{fontSize: 15}}>One-time setup for {s.appName}</b>
					</div>
					<p className="prose" style={{margin: '0 0 10px', fontSize: 14}}>
						Run this once in a terminal on the server. It installs {s.appName} the way Omarchy’s menu does, and asks for your password itself. This page notices when it’s done.
					</p>
					<pre style={{whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all', fontSize: 12.5, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,.25)', margin: '0 0 10px'}}>{s.command}</pre>
					<div style={{display: 'flex', gap: 8}}>
						{openTerminal && (
							<button className="btn" onClick={() => openTerminal(s.command)}>
								<Icon name="terminal" size={18} /> Open Terminal
							</button>
						)}
						<button className="btn ghost" onClick={() => copy(s.command)}>
							Copy
						</button>
					</div>
					<p className="muted" style={{display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '10px 0 0'}}>
						<span className="spinner" /> Waiting for the setup…
					</p>
				</div>
			))}
			{data?.oidc?.supported && (
				<div className="glass card" style={{marginBottom: 16, borderRadius: 18}}>
					<div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
						<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
							<Icon name="key" size={18} />
						</span>
						<span style={{flex: 1, minWidth: 0}}>
							<b style={{fontSize: 15, display: 'block'}}>Sign in with My Own Data Center</b>
							<small className="muted">
								{data.oidc.mode === 'auto'
									? 'Automatically configures OIDC SSO using your My Own Data Center accounts + 2FA.'
									: 'Pre-registers an OIDC client so you can paste credentials after install.'}
								{data.oidc.defaultOn && !enableOidc ? ' This app recommends sharing sign-in; turn it on only if you trust it.' : ''}
							</small>
						</span>
						<Switch on={enableOidc} label="Sign in with My Own Data Center" onChange={(on) => void setOidcWithConfirm(on)} />
					</div>
					{enableOidc && data.oidc.note && (
						<p className="prose" style={{margin: '10px 0 0', fontSize: 13.5}}>
							{data.oidc.note}
						</p>
					)}
				</div>
			)}
			{data && !data.requiredFolders.length && !data.gpuAccess && !access.length && !setup.length && !folders.length && !data.oidc?.supported && (
				<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
					<span className="row-ico" style={{'--c': 'var(--green)'} as CSSProperties}>
						<Icon name="shield" size={18} />
					</span>
					<span style={{fontSize: 14.5}}>No access to your files or hardware needed.</span>
				</div>
			)}
			<div className="stack">
				<button className="btn primary block" onClick={install} disabled={!data || !!pending || choice == null}>
					<Icon name="download" size={20} />
					{data?.alsoInstalls?.length ? `Install all ${data.alsoInstalls.length + 1}${machineName ? ` on ${machineName}` : ''}` : `Install ${appName}${machineName ? ` on ${machineName}` : ''}`}
				</button>
				<button className="btn block ghost" onClick={onCancel}>
					{cancelLabel}
				</button>
			</div>
		</div>
	)
}
