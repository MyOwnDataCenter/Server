import {useRef, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {query} from './api'
import {useAction, useCpu, useMachines, useMemory} from './data'
import {Icon} from './icons'
import {MachineStepper} from './MachineStepper'
import {defaultCores, hostMaxMemoryGb, nextDiskGb} from './machineForm'
import {osLook} from './osLook'
import {uploadOne} from './screens/Files'
import {bytes, Field, haptic} from './ui'
import {uploadDirectory} from './uploadDirectory'

type DiskImage = {name: string; path: string}
type DiskInfo = {format: 'raw' | 'qcow2'; virtualSize: number; size: number}

export function ImportDiskImage({onBack, onDone}: {onBack: () => void; onDone: () => void}) {
	const cpu = useCpu()
	const memory = useMemory()
	if (cpu.isPending || memory.isPending) {
		return (
			<div style={{overflowY: 'auto', flex: 1, margin: '0 -20px', padding: '8px 20px'}}>
				<div className="skeleton" style={{height: 64, margin: '8px 0'}} />
				<div className="skeleton" style={{height: 160, margin: '8px 0'}} />
			</div>
		)
	}
	return <ImportDiskImageForm onBack={onBack} onDone={onDone} threads={cpu.data?.threads ?? 1} maxMemoryGb={hostMaxMemoryGb(memory.data ?? null)} />
}

function ImportDiskImageForm({onBack, onDone, threads, maxMemoryGb}: {onBack: () => void; onDone: () => void; threads: number; maxMemoryGb: number}) {
	const qc = useQueryClient()
	const action = useAction()
	const machines = useMachines()
	const uploadInput = useRef<HTMLInputElement>(null)
	const [path, setPath] = useState('')
	const [name, setName] = useState('')
	const [cores, setCores] = useState(defaultCores({cores: 2, minCores: 1}, threads))
	const [memoryGb, setMemoryGb] = useState(Math.min(4, maxMemoryGb))
	const [diskSizeGb, setDiskSizeGb] = useState(32)
	const [firmware, setFirmware] = useState('efi')
	const [error, setError] = useState('')
	const [upload, setUpload] = useState<number | null>(null)
	const images = useQuery({queryKey: ['machines.localDiskImages'], queryFn: () => query<DiskImage[]>('machines.localDiskImages')})
	const info = useQuery({queryKey: ['machines.inspectDiskImage', path], queryFn: () => query<DiskInfo>('machines.inspectDiskImage', {path}), enabled: !!path, retry: false})
	const minimumDisk = Math.max(1, Math.ceil((info.data?.virtualSize ?? 0) / 1024 ** 3))
	const disk = {min: minimumDisk, max: 4096}
	const capacityGb = Math.max(diskSizeGb, minimumDisk)
	const nameTaken = (machines.data ?? []).some((m) => m.name.toLowerCase() === name.trim().toLowerCase())
	const canImport = !!info.data && !info.isFetching && !info.error && !!name.trim() && !nameTaken && upload === null && !action.isPending
	const look = osLook('imported')
	const send = async (file: File) => {
		setError('')
		setUpload(0)
		try {
			await uploadOne({file}, await uploadDirectory(), (loaded) => setUpload(Math.floor(100 * loaded / Math.max(file.size, 1))))
			await qc.invalidateQueries({queryKey: ['machines.localDiskImages']})
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setUpload(null)
		}
	}
	const start = async () => {
		setError('')
		haptic(12)
		try {
			await action.mutateAsync({path: 'machines.importDiskImage', input: {path, name: name.trim(), cores, memoryGb, diskSizeGb: capacityGb, firmware}, done: `${name.trim()} is being imported`})
			onDone()
		} catch (e) {
			setError((e as Error).message)
		}
	}
	return (
		<>
			<div className="sheet-head">
				<button className="icon-btn" style={{alignSelf: 'center'}} aria-label="Back" onClick={onBack}>
					<Icon name="back" size={18} stroke={2.2} />
				</button>
				<span className="vm-os" style={{width: 46, height: 46, borderRadius: 13, background: look.bg}}>
					<Icon name="disk" size={24} />
				</span>
				<div className="main">
					<h3>Import disk image</h3>
					<p>RAW or QCOW2</p>
				</div>
			</div>
			<div style={{overflowY: 'auto', flex: 1, margin: '0 -20px', padding: '0 20px 8px'}}>
				{(error || images.error || info.error) && (
					<div className="error shake" role="alert">
						<Icon name="alert" size={18} />
						{error || (images.error as Error)?.message || (info.error as Error)?.message}
					</div>
				)}
				<div className="field">
					<label htmlFor="import-disk-image">Disk image</label>
					<select id="import-disk-image" value={path} onChange={(e) => {setPath(e.target.value); setName(e.target.value.split('/').at(-1)?.replace(/\.(raw|img|qcow2)$/i, '') ?? '')}}>
						<option value="">Choose an uploaded image</option>
						{(images.data ?? []).map((image) => <option key={image.path} value={image.path}>{image.path}</option>)}
					</select>
				</div>
				<input ref={uploadInput} type="file" accept=".raw,.img,.qcow2" hidden onChange={(e) => {if (e.target.files?.[0]) send(e.target.files[0]); e.target.value = ''}} />
				<button type="button" className="btn small" disabled={upload !== null} onClick={() => uploadInput.current?.click()}><Icon name="upload" size={14} /> {upload !== null ? `Uploading: ${upload}%` : 'Upload a new image'}</button>
				<p className="hint" style={{margin: '8px 4px 14px', color: 'var(--muted)', fontSize: 13}}>
					{info.data ? `${info.data.format.toUpperCase()} · ${bytes(info.data.virtualSize)} disk · ${bytes(info.data.size)} file` : 'Choose an uploaded image, or upload a new one.'}
				</p>
				<Field id="vm-name" label="Name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} error={nameTaken ? 'You already have a machine with this name.' : undefined} />
				<div className="glass group" style={{borderRadius: 18, marginBottom: 16, '--inset': '16px'} as React.CSSProperties}>
					<MachineStepper label="CPU cores" value={cores} unit={cores === 1 ? 'core' : 'cores'} min={1} max={threads} onChange={setCores} />
					<MachineStepper label="Memory" value={memoryGb} unit="GB" min={1} max={maxMemoryGb} onChange={setMemoryGb} />
					<MachineStepper label="Disk" value={capacityGb} unit="GB" min={disk.min} max={disk.max} next={(v, d) => nextDiskGb(v, d, disk)} onChange={setDiskSizeGb} />
				</div>
				<div className="field">
					<label htmlFor="import-firmware">Firmware</label>
					<select id="import-firmware" value={firmware} onChange={(e) => setFirmware(e.target.value)}>
						<option value="efi">UEFI</option>
						<option value="bios">BIOS</option>
					</select>
				</div>
				<p className="hint" style={{margin: '0 4px 14px', color: 'var(--muted)', fontSize: 13}}>
					Choose the firmware the image was installed with. Its accounts and settings are kept. The original file stays unchanged; start the imported machine when you’re ready.
				</p>
			</div>
			<button className="btn primary block" disabled={!canImport} onClick={start}>
				{action.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={20} />}
				{action.isPending ? 'Importing…' : 'Import machine'}
			</button>
		</>
	)
}
