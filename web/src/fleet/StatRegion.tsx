// The stats region. A tap cycles the account's saved view. Home's aggregate gauges do not use this.
import {createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject} from 'react'

import {Icon} from '../icons'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {Ring, StatChip, haptic, levelColor, type Prefs} from '../ui'
import {formatTemp, machineTemperatures, sortTemps, tempIsShown, tempUnitOf, toggleTempPick, type TempProbe, type TempSensor, type TempUnit} from './temperatures'
import {STAT_VIEW_NAME, gaugeCaption, nextStatView, readingFace, statIsShown, statReadings, statViewOf, toggleStatPick, type PostureSummary, type StatReading, type StatView} from './statView'

type StatViewApi = {
	view: StatView
	cycle: () => void
	statPicks: Prefs['statPicks']
	setStatPicks: (next: Prefs['statPicks']) => void
	tempPicks: Prefs['tempPicks']
	setTempPicks: (next: Prefs['tempPicks']) => void
	tempUnit: TempUnit
	setTempUnit: (unit: TempUnit) => void
}

const StatViewContext = createContext<StatViewApi | null>(null)

export function StatViewProvider({prefs, setPrefs, children}: {prefs: Prefs; setPrefs: (next: Prefs | ((current: Prefs) => Prefs)) => void; children: ReactNode}) {
	const view = statViewOf(prefs.statView)
	const [note, setNote] = useState('')
	const cycle = () => {
		haptic(8)
		let name = ''
		setPrefs((current) => {
			const next = nextStatView(statViewOf(current.statView))
			name = STAT_VIEW_NAME[next]
			return {...current, statView: next}
		})
		setNote(name ? `Stats shown as ${name}` : '')
	}
	const setStatPicks = (next: Prefs['statPicks']) => {
		setPrefs((current) => ({...current, statPicks: next ?? null}))
	}
	const setTempPicks = (next: Prefs['tempPicks']) => {
		setPrefs((current) => ({...current, tempPicks: next ?? null}))
	}
	const setTempUnit = (unit: TempUnit) => {
		setPrefs((current) => ({...current, tempUnit: unit === 'f' ? 'f' : null}))
	}
	return (
		<StatViewContext.Provider value={{view, cycle, statPicks: prefs.statPicks ?? null, setStatPicks, tempPicks: prefs.tempPicks ?? null, setTempPicks, tempUnit: tempUnitOf(prefs.tempUnit), setTempUnit}}>
			{children}
			<div className="sr-only" role="status" aria-live="polite">
				{note}
			</div>
		</StatViewContext.Provider>
	)
}

export function useStatView(): StatViewApi {
	const api = useContext(StatViewContext)
	if (!api) throw new Error('StatViewProvider missing')
	return api
}

export function LiveStats({
	metrics,
	temp = null,
	sensors = null,
	diskSizeGb = null,
	posture = null,
	machineName,
	empty = null,
}: {
	metrics: SwarmMetrics | null | undefined
	temp?: number | null
	sensors?: readonly TempProbe[] | null
	diskSizeGb?: number | null
	posture?: PostureSummary
	machineName?: string
	empty?: ReactNode
}) {
	const {statPicks, tempPicks, tempUnit} = useStatView()
	const temps = machineTemperatures({temp, sensors, gpus: metrics?.gpus})
	const gauges = swarmGaugeItems(metrics)
	const choices = statReadings({gauges, temp: null, diskSizeGb, posture})
	const readings = statReadings({gauges, temp: null, diskSizeGb, posture, temps, tempPicks, tempUnit, statPicks})
	if (!choices.length && !temps.length) return <>{empty}</>
	return <StatRegion readings={readings} choices={choices} temps={temps} machineName={machineName} />
}

function ValueFace({text, color}: {text: string; color?: string}) {
	const size = 84
	const stroke = 8
	const r = (size - stroke) / 2
	return (
		<div className="ring" style={{width: size, height: size, color: color ?? 'var(--fg)'}}>
			<svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
				<circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
			</svg>
			<div className="center">
				<span className={text.length > 4 ? 'pct compact' : 'pct'}>{text}</span>
			</div>
		</div>
	)
}

function useDialogDismiss(dialogRef: RefObject<HTMLDialogElement | null>, active: boolean) {
	useEffect(() => {
		if (!active) return
		const dialog = dialogRef.current
		if (!dialog) return
		dialog.setAttribute('closedby', 'any')
		if ('closedBy' in HTMLDialogElement.prototype) return
		let pressedOutside = false
		const outside = (event: PointerEvent) => {
			const rect = dialog.getBoundingClientRect()
			return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
		}
		const down = (event: PointerEvent) => {
			pressedOutside = outside(event)
		}
		const up = (event: PointerEvent) => {
			if (pressedOutside && outside(event)) dialog.close()
		}
		dialog.addEventListener('pointerdown', down)
		dialog.addEventListener('pointerup', up)
		return () => {
			dialog.removeEventListener('pointerdown', down)
			dialog.removeEventListener('pointerup', up)
		}
	}, [dialogRef, active])
}

const nativeSwitch = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype

/** Celsius or Fahrenheit. Off is Celsius. The native switch attribute is Safari-only, so other browsers get the same pill. */
function TempUnitSwitch({fahrenheit, onChange}: {fahrenheit: boolean; onChange: (on: boolean) => void}) {
	return (
		<div className="temp-unit">
			<span className={fahrenheit ? undefined : 'on'} aria-hidden="true">
				°C
			</span>
			<label>
				<input
					type="checkbox"
					className={nativeSwitch ? 'temp-unit-box' : 'temp-unit-box fallback'}
					checked={fahrenheit}
					aria-label="Fahrenheit"
					ref={(node) => {
						if (!node) return
						node.setAttribute('switch', '')
						if (!nativeSwitch) node.setAttribute('role', 'switch')
					}}
					onChange={(event) => {
						haptic(5)
						onChange(event.target.checked)
					}}
				/>
			</label>
			<span className={fahrenheit ? 'on' : undefined} aria-hidden="true">
				°F
			</span>
		</div>
	)
}

/** One button for the whole region. Its name is the readings, so each machine stays distinct. */
export function StatRegion({readings, choices = readings, temps = [], machineName}: {readings: readonly StatReading[]; choices?: readonly StatReading[]; temps?: readonly TempSensor[]; machineName?: string}) {
	const {view, cycle, statPicks, setStatPicks, tempPicks, setTempPicks, tempUnit, setTempUnit} = useStatView()
	const dialogRef = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const listed = sortTemps(temps)
	const choosing = choices.length > 0 || listed.length > 0
	useDialogDismiss(dialogRef, choosing)
	if (!readings.length && !choosing) return null
	const summary = readings.length ? `${readings.map((r) => `${r.label} ${r.text}`).join(', ')}. Shown as ${STAT_VIEW_NAME[view]}.` : `No stats shown. Shown as ${STAT_VIEW_NAME[view]}.`
	const openStats = () => {
		const dialog = dialogRef.current
		if (!dialog || dialog.open) return
		// The list stays mounted while the dialog is closed, so the checkbox has to
		// carry the attribute at the moment showModal runs or the close button takes focus.
		dialog.querySelector('input.temp-pick-box')?.setAttribute('autofocus', '')
		dialog.showModal()
	}
	return (
		<div className={`stat-hold stat-${view}`}>
			<button
				type="button"
				className={`stat-region stat-${view}`}
				onClick={(e) => {
					e.stopPropagation()
					cycle()
				}}
			>
				<span className="sr-only">{summary}</span>
				{readings.length === 0 && <span className="stat-none">No stats shown</span>}
				{readings.length > 0 && view === 'line' && (
					<span className="specs" aria-hidden="true">
						{readings.map((r) => (
							<StatChip key={r.id} icon={r.icon} label={r.label}>
								<span style={r.color ? {color: r.color} : undefined}>{r.text}</span>
							</StatChip>
						))}
					</span>
				)}
				{readings.length > 0 && view === 'blocks' && (
					<span className="mm-squares" aria-hidden="true">
						{readings.map((r) => (
							<span className="mm-square" key={r.id}>
								<Icon name={r.icon} size={16} />
								<b style={r.color ? {color: r.color} : undefined}>{r.text}</b>
								<span>{r.label}</span>
							</span>
						))}
					</span>
				)}
				{readings.length > 0 && view === 'gauges' && (
					<span className="glass gauges" data-n={readings.length} aria-hidden="true">
						{readings.map((r) => {
							const caption = gaugeCaption(r)
							return (
								<span className="gauge" key={r.id}>
									{readingFace(r) === 'arc' && r.percent != null ? (
										<Ring value={r.percent} color={r.color ?? levelColor(r.percent)} label={`${r.label} ${r.text}`} now={r.meter?.now} max={r.meter?.max}>
											<span className="pct">
												{r.meter ? Math.round(r.meter.now) : Math.round(r.percent)}
												<small>{r.meter ? (r.meter.unit ?? '°C') : '%'}</small>
											</span>
										</Ring>
									) : (
										<ValueFace text={r.text} color={r.color} />
									)}
									<span className="k">{r.label}</span>
									{caption ? <span className="sub">{caption}</span> : null}
								</span>
							)
						})}
					</span>
				)}
			</button>
			{choosing && (
				<button type="button" className="stat-pencil" aria-label="Choose stats" onClick={openStats}>
					<Icon name="pencil" size={15} />
				</button>
			)}
			{choosing && (
				<dialog ref={dialogRef} className="temp-dialog" aria-labelledby={titleId}>
					<div className="temp-dialog-head">
						<h1 id={titleId}>Stats</h1>
						<form method="dialog">
							<button className="icon-btn" aria-label="Close">
								<Icon name="close" size={18} />
							</button>
						</form>
					</div>
					<p className="temp-dialog-where">{machineName ? `On ${machineName}.` : 'On this machine.'} These are the readings right now.</p>
					<div className="temp-picks">
						{choices.map((reading) => (
							<label className="temp-pick" key={reading.id}>
								<input
									type="checkbox"
									className="temp-pick-box"
									checked={statIsShown(reading.id, statPicks ?? null)}
									onChange={(event) => setStatPicks(toggleStatPick(statPicks ?? null, reading.id, event.target.checked))}
								/>
								<span className="temp-pick-name">{reading.label}</span>
								<b>{reading.text}</b>
							</label>
						))}
						{listed.length > 0 && choices.length > 0 && <h2 className="temp-dialog-sub">Temperatures</h2>}
						{listed.length > 0 && <TempUnitSwitch fahrenheit={tempUnit === 'f'} onChange={(on) => setTempUnit(on ? 'f' : 'c')} />}
						{listed.map((sensor) => (
							<label className="temp-pick" key={sensor.id}>
								<input
									type="checkbox"
									className="temp-pick-box"
									checked={tempIsShown(sensor, tempPicks ?? null)}
									onChange={(event) => setTempPicks(toggleTempPick(tempPicks ?? null, sensor, event.target.checked))}
								/>
								<span className="temp-pick-name">
									{sensor.label}
									{sensor.stuck ? <small>Not changing</small> : null}
								</span>
								<b>{formatTemp(sensor.celsius, tempUnit)}</b>
							</label>
						))}
					</div>
				</dialog>
			)}
		</div>
	)
}
