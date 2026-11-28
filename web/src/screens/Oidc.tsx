// This server as an OpenID Connect provider. It lives in Settings, with account and sign-in.
import {useEffect, useState, type FormEvent} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Field, Group, Row, Sheet, SheetHeader, Switch, useConfirm, useToast} from '../ui'

type OidcPreset = {
	id: string
	name: string
	requirePkce: boolean
	defaultPaths: string[]
	note: string
}

type OidcStatus = {
	issuerUrl: string
	keyId: string
	clientCount: number
	presets: OidcPreset[]
}

type OidcClient = {
	id: string
	name: string
	managedAppId?: string
	publicClient: boolean
	requirePkce: boolean
	redirectUris: string[]
	scopes: string[]
	createdAt: number
}

export function OidcSheet({onClose}: {onClose: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const qc = useQueryClient()
	const status = useQuery({queryKey: ['oidc.status'], queryFn: () => query<OidcStatus>('oidc.status'), retry: false})
	const clients = useQuery({queryKey: ['oidc.clients'], queryFn: () => query<OidcClient[]>('oidc.clients'), retry: false})

	const [issuerInput, setIssuerInput] = useState('')
	const [name, setName] = useState('')
	const [redirectUris, setRedirectUris] = useState('')
	const [publicClient, setPublicClient] = useState(false)
	const [requirePkce, setRequirePkce] = useState(true)
	const [selectedPresetNote, setSelectedPresetNote] = useState('')
	const [revealed, setRevealed] = useState<{id: string; name: string; secret: string | null} | null>(null)
	const [editingId, setEditingId] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const issuerKey = status.data?.issuerUrl ?? ''
	useEffect(() => {
		setIssuerInput(issuerKey)
	}, [issuerKey])

	const effectiveIssuer = status.data?.issuerUrl || location.origin
	const discoveryUrl = `${effectiveIssuer}/.well-known/openid-configuration`

	const copyText = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text)
			toast(`${label} copied`)
		} catch {
			toast(`Couldn’t copy ${label.toLowerCase()}`, true)
		}
	}

	const saveIssuer = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		try {
			await mutate('oidc.setConfig', {issuerUrl: issuerInput.trim()})
			toast(issuerInput.trim() ? 'Issuer URL saved' : 'Using the address of this visit')
			await qc.invalidateQueries({queryKey: ['oidc.status']})
		} catch (err) {
			toast((err as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const useThisAddress = async () => {
		setBusy(true)
		try {
			await mutate('oidc.setConfig', {issuerUrl: location.origin})
			toast(`Issuer URL set to ${location.origin}`)
			await qc.invalidateQueries({queryKey: ['oidc.status']})
		} catch (err) {
			toast((err as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const applyPreset = (p: OidcPreset) => {
		setEditingId(null)
		setName(p.name)
		setRedirectUris(p.defaultPaths.map((path) => (path.startsWith('/') ? `https://<app-host>${path}` : path)).join('\n'))
		setPublicClient(false)
		setRequirePkce(p.requirePkce)
		setSelectedPresetNote(p.note)
	}

	const startEdit = (c: OidcClient) => {
		setEditingId(c.id)
		setName(c.name)
		setRedirectUris(c.redirectUris.join('\n'))
		setPublicClient(c.publicClient)
		setRequirePkce(c.requirePkce)
		setSelectedPresetNote('')
	}

	const resetForm = () => {
		setEditingId(null)
		setName('')
		setRedirectUris('')
		setPublicClient(false)
		setRequirePkce(true)
		setSelectedPresetNote('')
	}

	const submitClient = async (e: FormEvent) => {
		e.preventDefault()
		const uris = redirectUris
			.split(/[\n,]+/)
			.map((s) => s.trim())
			.filter(Boolean)
		if (!name.trim() || uris.length === 0) {
			toast('Enter an app name and at least one redirect address', true)
			return
		}
		if (uris.some((u) => u.includes('<app-host>'))) {
			toast('Replace <app-host> with the app’s real hostname or IP', true)
			return
		}
		setBusy(true)
		try {
			if (editingId) {
				await mutate('oidc.updateClient', {id: editingId, name: name.trim(), redirectUris: uris, requirePkce})
				toast('App updated')
				resetForm()
			} else {
				const res = await mutate<{client: OidcClient; clientSecret: string | null}>('oidc.createClient', {
					name: name.trim(),
					redirectUris: uris,
					publicClient,
					requirePkce,
					...(!status.data?.issuerUrl ? {issuerUrl: issuerInput.trim() || location.origin} : {}),
				})
				setRevealed({id: res.client.id, name: res.client.name, secret: res.clientSecret})
				toast(`${res.client.name} added`)
				resetForm()
			}
			await qc.invalidateQueries({queryKey: ['oidc.clients']})
			await qc.invalidateQueries({queryKey: ['oidc.status']})
		} catch (err) {
			toast((err as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const rotateSecret = async (c: OidcClient) => {
		const ok = await confirm({
			title: `Rotate the secret for ${c.name}?`,
			body: 'The previous client secret stops working immediately. Update it in the app after rotating.',
			confirm: 'Rotate secret',
			danger: true,
		})
		if (!ok) return
		setBusy(true)
		try {
			const res = await mutate<{id: string; clientSecret: string}>('oidc.rotateSecret', {id: c.id})
			setRevealed({id: c.id, name: c.name, secret: res.clientSecret})
			toast('Client secret rotated')
		} catch (err) {
			toast((err as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const deleteClient = async (c: OidcClient) => {
		const ok = await confirm({
			title: `Remove ${c.name}?`,
			body: 'That app can no longer sign in with accounts on this server. Its current tokens stop working.',
			confirm: 'Remove app',
			danger: true,
		})
		if (!ok) return
		if (editingId === c.id) resetForm()
		if (revealed?.id === c.id) setRevealed(null)
		setBusy(true)
		try {
			await mutate('oidc.deleteClient', {id: c.id})
			toast(`${c.name} removed`)
			await qc.invalidateQueries({queryKey: ['oidc.clients']})
			await qc.invalidateQueries({queryKey: ['oidc.status']})
		} catch (err) {
			toast((err as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet open onClose={onClose} label="Sign-in for apps" tall>
			<SheetHeader title="Sign-in for apps" subtitle="Other apps sign in with accounts on this server, including two-factor" onClose={onClose} />

			{revealed && (
				<Group title={`Credentials for ${revealed.name}`} footer={revealed.secret ? 'Save this client secret now. It is stored as a hash and will not be shown again.' : 'This app uses PKCE and has no client secret.'}>
					<Row
						icon="key"
						color="var(--green)"
						label="Client ID"
						sub={revealed.id}
						trailing={
							<button type="button" className="btn small" onClick={() => copyText(revealed.id, 'Client ID')}>
								Copy
							</button>
						}
					/>
					{revealed.secret && (
						<Row
							icon="shield"
							color="var(--orange, #f59e0b)"
							label="Client secret, shown once"
							sub={revealed.secret}
							trailing={
								<button type="button" className="btn primary small" onClick={() => copyText(revealed.secret!, 'Client secret')}>
									Copy
								</button>
							}
						/>
					)}
					<div className="row static">
						<button type="button" className="btn small" onClick={() => setRevealed(null)}>
							I’ve saved these
						</button>
					</div>
				</Group>
			)}

			<Group title="Addresses" footer="Paste the discovery address into an app that supports OpenID Connect. Scopes are openid, profile, email, and groups. The email is a name on this server, not a mailbox, and it is not verified.">
				{status.data && !status.data.issuerUrl && (
					<Row
						icon="alert"
						color="var(--orange, #f59e0b)"
						label="Issuer follows this visit"
						sub="Save the address people use to reach this server, so every app agrees on who issued the token."
						trailing={
							<button type="button" className="btn small" disabled={busy} onClick={useThisAddress}>
								Use this address
							</button>
						}
					/>
				)}
				<Row
					icon="link"
					color="var(--blue)"
					label="Issuer"
					sub={effectiveIssuer}
					trailing={
						<button type="button" className="btn small" onClick={() => copyText(effectiveIssuer, 'Issuer')}>
							Copy
						</button>
					}
				/>
				<Row
					icon="networking"
					color="var(--teal)"
					label="Discovery"
					sub={discoveryUrl}
					trailing={
						<button type="button" className="btn small" onClick={() => copyText(discoveryUrl, 'Discovery address')}>
							Copy
						</button>
					}
				/>
				<form onSubmit={saveIssuer} style={{padding: '10px 14px'}}>
					<Field id="oidc-issuer" label="Issuer address" type="url" placeholder={`This visit (${location.origin})`} value={issuerInput} onChange={(e) => setIssuerInput(e.target.value)} autoCapitalize="off" autoCorrect="off" />
					<button className="btn small" disabled={busy} style={{marginTop: 6}}>
						Save issuer
					</button>
				</form>
			</Group>

			<Group title={editingId ? 'Edit app' : 'Add an app'} footer={selectedPresetNote || 'A redirect address has to match exactly. Wildcards are rejected.'}>
				{!editingId && (status.data?.presets.length ?? 0) > 0 && (
					<div className="row static" style={{flexWrap: 'wrap', gap: 6, paddingBlock: 10}}>
						{status.data!.presets.map((p) => (
							<button key={p.id} type="button" className="btn small" onClick={() => applyPreset(p)}>
								{p.name}
							</button>
						))}
					</div>
				)}
				<form onSubmit={submitClient} style={{padding: '10px 14px'}}>
					<Field id="oidc-name" label="App name" placeholder="Immich" value={name} onChange={(e) => setName(e.target.value)} />
					<div className="field" style={{marginBottom: 10}}>
						<label htmlFor="oidc-redirects">Redirect addresses, one per line</label>
						<textarea id="oidc-redirects" rows={3} placeholder="https://immich.example.com/auth/login" value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} style={{width: '100%', resize: 'vertical'}} />
					</div>
					{!editingId && (
						<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}>
							<span>Public client, PKCE only</span>
							<Switch on={publicClient} label="Public client" onChange={(v) => (setPublicClient(v), v && setRequirePkce(true))} />
						</div>
					)}
					<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
						<span>Require PKCE</span>
						<Switch on={publicClient ? true : requirePkce} disabled={publicClient} label="Require PKCE" onChange={setRequirePkce} />
					</div>
					<div style={{display: 'flex', gap: 8}}>
						<button className="btn primary" style={{flex: 1}} disabled={busy}>
							{editingId ? 'Save changes' : 'Add app'}
						</button>
						{editingId && (
							<button type="button" className="btn" onClick={resetForm}>
								Cancel
							</button>
						)}
					</div>
				</form>
			</Group>

			<Group title={`Apps (${clients.data?.length ?? 0})`}>
				{(clients.data ?? []).map((c) => (
					<div className="row static" key={c.id} style={{flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBlock: 12}}>
						<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8}}>
							<span className="main">
								<b style={{fontWeight: 600}}>{c.name}</b>
								<span>
									{c.id} · {c.publicClient ? 'Public' : c.requirePkce ? 'Secret and PKCE' : 'Secret'}
								</span>
							</span>
							<button type="button" className="btn small" onClick={() => copyText(c.id, 'Client ID')}>
								Copy ID
							</button>
						</div>
						<div className="muted" style={{wordBreak: 'break-all'}}>
							{c.redirectUris.join(' · ')}
						</div>
						<div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
							{c.managedAppId ? (
								<span className="muted">Managed by App Store ({c.managedAppId}): change SSO in that app’s sheet.</span>
							) : (
								<>
									<button type="button" className="btn small" onClick={() => startEdit(c)}>
										Edit
									</button>
									{!c.publicClient && (
										<button type="button" className="btn small" disabled={busy} onClick={() => rotateSecret(c)}>
											Rotate secret
										</button>
									)}
									<button type="button" className="btn small" style={{color: 'var(--red)'}} disabled={busy} onClick={() => deleteClient(c)}>
										Remove
									</button>
								</>
							)}
						</div>
					</div>
				))}
				{clients.isSuccess && (clients.data?.length ?? 0) === 0 && <div className="row static muted">No apps yet.</div>}
				{clients.isError && <div className="row static muted">{(clients.error as Error).message}</div>}
			</Group>
		</Sheet>
	)
}
