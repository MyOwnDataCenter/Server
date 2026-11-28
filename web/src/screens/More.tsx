import {useRef, useState, type CSSProperties} from 'react'
import {serverPower} from '../power'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, query, type Wallpaper} from '../api'
import {resetAssistantTurn} from '../assistantTurn'
import {resetDeskConfig} from '../desktop/config'
import {queryClearsOnSignOut} from '../signOutQueries'
import {useBootstrap, useUser} from '../data'
import {Icon} from '../icons'
import {entrypointHost} from '../entrypointHost'
import {isOwner} from '../isOwner'
import {applyPrefsUpdate, prefsAfterPhotoUpload} from '../photoPrefs'
import {RADIO_SELECTOR, rovingKeyDown, rovingTabIndex} from '../roving'
import {ThemeChooser} from '../ThemeChooser'
import {ACCENTS, Card, KV, Row, VersionTag, customBackgroundUrl, haptic, preparePhoto, useConfirm, useToast, type Prefs, type ThemeId} from '../ui'
import {FactoryReset} from './machineHost'

export function Appearance({prefs, setPrefs, wallpaper, onTheme}: {prefs: Prefs; setPrefs: (p: Prefs) => void; wallpaper?: Wallpaper | null; onTheme?: (id: ThemeId) => void}) {
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const photo = customBackgroundUrl(prefs.backgroundVersion)
	const brand = wallpaper?.brandColorHsl ? `hsl(${wallpaper.brandColorHsl})` : 'hsl(24 90% 50%)'
	const photoBrand = prefs.customBrandHsl ? `hsl(${prefs.customBrandHsl})` : brand
	const accentPreview = prefs.theme === 'custom' ? photoBrand : brand

	const upload = async (file?: File | null) => {
		if (!file) return
		setUploading(true)
		try {
			const {blob, hsl} = await preparePhoto(file)
			const res = await fetch('/api/background', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1'}, body: blob})
			const body = await res.json().catch(() => null)
			if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
			applyPrefsUpdate(setPrefs, (latest) => ({...prefsAfterPhotoUpload(latest, {hsl, backgroundVersion: body.prefs.backgroundVersion ?? null}, {setThemeCustom: true}), pictureTheme: 'custom' as const}))
			onTheme?.('custom')
			toast('Background saved')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
			if (fileRef.current) fileRef.current.value = ''
		}
	}
	return (
		<Card>
			<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
			<ThemeChooser
				prefs={prefs}
				setPrefs={setPrefs}
				wallpaperBrand={brand}
				photo={photo}
				uploading={uploading}
				onPickPhoto={() => fileRef.current?.click()}
				onTheme={onTheme}
			/>
			<div className="section-head" style={{margin: '18px 0 6px'}}>
				<h2>Accent</h2>
			</div>
			<div className="accents" role="radiogroup" aria-label="Accent color" onKeyDown={(e) => rovingKeyDown(e, RADIO_SELECTOR)}>
				{ACCENTS.map((a, ai) => (
					<button
						key={a}
						role="radio"
						aria-checked={prefs.accent === a}
						tabIndex={rovingTabIndex(prefs.accent === a, ai, ACCENTS.includes(prefs.accent))}
						aria-label={a === 'wallpaper' ? 'Match background' : a}
						className={`accent-btn${prefs.accent === a ? ' on' : ''}`}
						style={{background: a === 'wallpaper' ? accentPreview : `var(--${a})`}}
						onClick={() => {
							haptic(6)
							setPrefs({...prefs, accent: a})
						}}
					>
						{a === 'wallpaper' && <Icon name="wallpaper" size={18} />}
					</button>
				))}
			</div>
		</Card>
	)
}

export function More({prefs, setPrefs, onSignedOut, onSettings, onClips, onTerminals}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; onSettings: () => void; onClips?: () => void; onTerminals?: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const owner = isOwner(user.data)
	const update = useQuery({
		queryKey: ['system.checkUpdate'],
		queryFn: () => query<{available: boolean; name: string; version: string}>('system.checkUpdate'),
		staleTime: 30 * 60_000,
		retry: false,
	})

	const power = async (kind: 'restart' | 'shutdown') => {
		await serverPower(kind, confirm, toast)
	}
	const finishSignOut = async () => {
		try {
			await logout()
		} catch (e) {
			toast((e as Error).message, true)
			return
		}
		qc.removeQueries({predicate: (q) => queryClearsOnSignOut(q.queryKey)})
		resetDeskConfig()
		resetAssistantTurn()
		onSignedOut()
	}
	const signOut = async () => {
		const ok = await confirm({title: 'Sign out?', body: 'This device is signed out and removed from your server’s devices.', confirm: 'Sign out', icon: 'signout'})
		if (!ok) return
		await finishSignOut()
	}

	return (
		<div className="stagger">
			<div>
				<h1 className="title">System</h1>
				<p className="subtitle">{boot.server?.device ?? 'server'}</p>
			</div>
			<section>
				<div className="section-head">
					<h2>Your server</h2>
				</div>
				<KV
					rows={[
						['Device', boot.server?.device ?? '–'],
						['Address', entrypointHost(boot.server) || boot.server?.host || '–'],
						['MODC', <VersionTag version={boot.server?.version} info={boot.server} />],
						['Software update', update.data ? (update.data.available ? `${update.data.name} available` : 'Up to date') : '–'],
						['Signed in as', `${user.data?.name ?? '–'}${user.data?.role ? ` (${user.data.role})` : ''}`],
					]}
				/>
				<div className="section-head" style={{marginTop: 18}}>
					<h2>This device</h2>
				</div>
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{onClips && <Row icon="clipboard" color="var(--teal)" label="Clip book" onClick={onClips} />}
					{onTerminals && <Row icon="terminal" color="var(--green)" label="Terminals" onClick={onTerminals} />}
					<Row icon="settings" color="#8e8e93" label="Settings" onClick={onSettings} />
					<Row icon="open" color="var(--blue)" label="Open this server" href={boot.server?.url} />
					<Row icon="signout" color="#8e8e93" label="Sign out of this device" onClick={signOut} />
				</div>
				<div className="section-head" style={{marginTop: 18}}>
					<h2>Server power</h2>
				</div>
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="restart" color="var(--peach)" label="Restart server" onClick={() => power('restart')} />
					<Row icon="power" color="var(--red)" label="Shut down server" onClick={() => power('shutdown')} />
					{owner && (
						<FactoryReset
							onDone={async () => {
								// The reset already ended the session. Logout may answer 401; still leave the signed-in page.
								await logout().catch(() => {})
								qc.removeQueries({predicate: (q) => queryClearsOnSignOut(q.queryKey)})
								resetDeskConfig()
								resetAssistantTurn()
								onSignedOut()
							}}
						/>
					)}
				</div>
			</section>
		</div>
	)
}
