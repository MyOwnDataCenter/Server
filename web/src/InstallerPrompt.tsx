import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query} from './api'
import {Icon} from './icons'
import {openTerminalWith} from './terminalEvent'
import {Sheet, SheetHeader, useToast} from './ui'

type InstallerStatus = {needed: boolean; reasons: string[]; command?: string}

// "Later" lasts until you sign out (or close the tab): the prompt comes back at the next sign-in.
const LATER_KEY = 'omarchy.installerLater'
const later = () => {
	try {
		return sessionStorage.getItem(LATER_KEY) === '1'
	} catch {
		return false
	}
}
const setLater = (on: boolean) => {
	try {
		if (on) sessionStorage.setItem(LATER_KEY, '1')
		else sessionStorage.removeItem(LATER_KEY)
	} catch {}
}
if (typeof window !== 'undefined') window.addEventListener('touch:signed-out', () => setLater(false))

// During beta: when an update in the app needs the installer run again (system packages, the storage
// helper), ask the owner at sign-in. The installer runs in My Own Data Center's own terminal, so sudo asks
// for the password there, on the server; this page never sees it.
export function InstallerPrompt({ready}: {ready: boolean}) {
	const status = useQuery({queryKey: ['system.installerStatus'], queryFn: () => query<InstallerStatus>('system.installerStatus'), staleTime: 60_000, retry: false})
	const [open, setOpen] = useState(false)
	const toast = useToast()
	useEffect(() => {
		if (!ready || !status.data?.needed || later()) return
		const t = window.setTimeout(() => setOpen(true), 600)
		return () => window.clearTimeout(t)
	}, [ready, status.data?.needed])
	const s = status.data
	if (!open || !s?.needed || !s.command) return null
	const close = () => (setLater(true), setOpen(false))
	const run = () => {
		openTerminalWith(s.command!)
		setLater(true)
		setOpen(false)
	}
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(s.command!)
			toast('Copied')
		} catch {
			toast('Couldn’t copy; select the command instead')
		}
	}
	return (
		<Sheet open onClose={close} label="Finish the update">
			<SheetHeader
				icon={
					<span className="sheet-icon" style={{background: 'linear-gradient(135deg, var(--peach), var(--accent))'}}>
						<Icon name="update" size={28} />
					</span>
				}
				title="Finish the update"
				subtitle="The installer needs to run once more"
				onClose={close}
			/>
			<div className="screen installer-prompt">
				<ul className="installer-reasons">
					{s.reasons.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
				<p className="muted">
					The installer gets everything this version needs. It opens in the terminal: press Enter to start, then type your password when it asks (sudo). Your apps,
					files and accounts are kept, and this server restarts when it’s done.
				</p>
				<button className="btn primary block" onClick={run}>
					<Icon name="update" size={18} /> Run the installer
				</button>
				<details className="installer-manual">
					<summary>Run it yourself (over SSH)</summary>
					<code className="installer-command" onClick={copy} title="Copy">
						{s.command}
					</code>
					<button type="button" className="btn small installer-copy" onClick={copy}>
						<Icon name="copy" size={16} /> Copy command
					</button>
				</details>
				<button className="btn block" onClick={close}>
					Later
				</button>
			</div>
		</Sheet>
	)
}
