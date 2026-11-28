// Add an ISO or a container template to this server: download it from a link, or upload it from
// this device. Either way it lands in Downloads, where the VM and container forms find it.
import {useRef, useState, type ReactNode} from 'react'

import {mutate} from './api'
import {Icon} from './icons'
import {uploadOne} from './screens/Files'
import {haptic, useToast} from './ui'
import {uploadDirectory} from './uploadDirectory'

export type Download = {name: string; received: number; total: number | null; error: string | null}

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)

export function AddFileCard({title, children}: {title: string; children: ReactNode}) {
	return (
		<div className="glass" style={{padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0, borderRadius: 18}}>
			<b style={{fontWeight: 600}}>{title}</b>
			{children}
		</div>
	)
}

export function AddFile({accept, linkProcedure, linkPlaceholder, downloads, onAdded, what, children}: {accept: string; linkProcedure: string; linkPlaceholder: string; downloads: Download[]; onAdded: () => void; what: string; children?: ReactNode}) {
	const toast = useToast()
	const input = useRef<HTMLInputElement>(null)
	const [link, setLink] = useState('')
	const [busy, setBusy] = useState(false)
	const [upload, setUpload] = useState<{name: string; loaded: number; total: number} | null>(null)
	const start = async () => {
		setBusy(true)
		try {
			const r = await mutate<{name: string}>(linkProcedure, {url: link.trim()})
			toast(`Downloading ${r.name} into Downloads`)
			setLink('')
			onAdded()
		} catch (e) {
			toast((e as Error).message.replace(/^[A-Z_]+: /, ''), true)
		} finally {
			setBusy(false)
		}
	}
	const send = async (file: File) => {
		setUpload({name: file.name, loaded: 0, total: file.size})
		try {
			await uploadOne({file}, await uploadDirectory(), (loaded) => setUpload({name: file.name, loaded, total: file.size}))
			toast(`Uploaded ${file.name} to Downloads`)
			onAdded()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUpload(null)
		}
	}
	return (
		<AddFileCard title={`Add ${what}`}>
			<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end'}}>
				<div className="field" style={{flex: '1 1 200px', minWidth: 0, margin: 0}}>
					<label htmlFor={`add-${linkProcedure}`}>From a link</label>
					<input id={`add-${linkProcedure}`} style={{width: '100%', minWidth: 0, boxSizing: 'border-box'}} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={linkPlaceholder} value={link} onChange={(e) => setLink(e.target.value)} />
				</div>
				<button type="button" className="btn small" disabled={busy || !/^https?:\/\//i.test(link.trim())} onClick={() => (haptic(6), start())}>
					{busy ? <span className="spinner" /> : <Icon name="download" size={14} />} Download
				</button>
			</div>
			<input ref={input} type="file" accept={accept} hidden onChange={(e) => (e.target.files?.[0] && send(e.target.files[0]), (e.target.value = ''))} />
			<button type="button" className="btn small" style={{justifySelf: 'start'}} disabled={!!upload} onClick={() => (haptic(6), input.current?.click())}>
				<Icon name="upload" size={14} /> {upload ? `Uploading ${upload.name}: ${Math.floor((upload.loaded / Math.max(1, upload.total)) * 100)}%` : 'Upload from this device'}
			</button>
			{downloads.map((d) => (
				<span key={d.name} className={d.error ? 'quiet error-text' : 'quiet'} style={{overflowWrap: 'anywhere'}}>
					{d.error ? `${d.name}: ${d.error}` : `Downloading ${d.name}: ${d.total ? `${Math.floor((d.received / d.total) * 100)}% of ${mb(d.total)}` : mb(d.received)}`}
				</span>
			))}
			<span className="quiet" style={{fontSize: 13}}>
				It’s saved in Downloads and appears here when it’s complete. Big files keep downloading if you leave this page.
			</span>
			{children}
		</AddFileCard>
	)
}
