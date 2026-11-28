// One account-wide way to show a machine's readings. Every view lists the same readings.
import {managerStats, type ManagerStat} from './machineManagerLogic.ts'
import {formatTemp, tempArc, tempColor, tempDegrees, tempIsShown, tempScale, type TempPicks, type TempSensor, type TempUnit} from './temperatures.ts'

export const STAT_VIEWS = ['line', 'blocks', 'gauges'] as const
export type StatView = (typeof STAT_VIEWS)[number]

export const STAT_VIEW_NAME: Record<StatView, string> = {
	line: 'one line',
	blocks: 'three lines',
	gauges: 'gauges',
}

export function statViewOf(value: unknown): StatView {
	return value === 'line' || value === 'blocks' || value === 'gauges' ? value : 'line'
}

/** line → three-line blocks → gauges → line. */
export function nextStatView(current: StatView): StatView {
	return STAT_VIEWS[(STAT_VIEWS.indexOf(current) + 1) % STAT_VIEWS.length]
}

export type PostureSummary = {
	rebootRequired?: boolean
	rebootReason?: string
	securityUpdates?: number | null
	listeningPorts?: {port: number; proto: string; addr: string}[]
	failedUnits?: number
} | null

export type StatReading = {
	id: string
	label: string
	icon: ManagerStat['icon'] | 'restart' | 'update' | 'alert' | 'network'
	/** The value, the same words on the line, the block, and a gauge that has no percent. */
	text: string
	/** How far around the ring to draw. A size-only disk stays null. A temperature uses its own scale. */
	percent: number | null
	/** Longer caption under a percent gauge, when it says more than `text`. */
	sub: string
	color?: string
	/** When set, the ring is a temperature: the arc is `percent`, and the meter reports degrees. */
	meter?: {now: number; max: number; unit?: string}
}

export type StatGauge = {k: string; icon: string; p: number; ready: boolean; key?: string; sub?: string; color?: string}

/** Which readings this account shows, apart from temperatures. Null means every reading stays shown. */
export type StatPicks = {on: string[]; off: string[]} | null

const STAT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/

export function cleanStatPicks(value: unknown): StatPicks {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
	const body = value as {on?: unknown; off?: unknown}
	const on = cleanStatIds(body.on)
	const off = cleanStatIds(body.off).filter((id) => !on.includes(id))
	if (!on.length && !off.length) return null
	return {on, off}
}

function cleanStatIds(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const out: string[] = []
	for (const id of value) {
		if (typeof id !== 'string' || !STAT_ID.test(id) || out.includes(id)) continue
		out.push(id)
		if (out.length >= 40) break
	}
	return out
}

/** A reading stays shown until this account turns it off. */
export function statIsShown(id: string, picks: StatPicks): boolean {
	if (picks?.on.includes(id)) return true
	if (picks?.off.includes(id)) return false
	return true
}

/** Check or uncheck one reading. Readings this account has not touched stay shown. */
export function toggleStatPick(picks: StatPicks, id: string, on: boolean): StatPicks {
	const prev = picks ?? {on: [], off: []}
	const nextOn = prev.on.filter((item) => item !== id)
	const nextOff = prev.off.filter((item) => item !== id)
	if (!on) nextOff.push(id)
	if (!nextOn.length && !nextOff.length) return null
	return {on: nextOn, off: nextOff}
}

/** A percent ring, or the value alone. A missing percent is not drawn as an empty arc. */
export function readingFace(reading: StatReading): 'arc' | 'value' {
	return reading.percent == null ? 'value' : 'arc'
}

/** Caption under a gauge. Omitted when it only repeats the value. */
export function gaugeCaption(reading: StatReading): string | null {
	if (readingFace(reading) !== 'arc') return null
	if (!reading.sub || reading.sub === reading.text || reading.sub === '–') return null
	return reading.sub
}

function postureReadings(posture: PostureSummary | undefined): StatReading[] {
	if (!posture) return []
	const out: StatReading[] = []
	if (posture.rebootRequired) {
		out.push({
			id: 'reboot',
			label: 'Restart',
			icon: 'restart',
			text: 'Needed',
			percent: null,
			sub: posture.rebootReason || 'Restart needed',
			color: 'var(--yellow)',
		})
	}
	if (typeof posture.securityUpdates === 'number' && posture.securityUpdates > 0) {
		const n = Math.round(posture.securityUpdates)
		out.push({
			id: 'security',
			label: 'Security',
			icon: 'update',
			text: String(n),
			percent: null,
			sub: `${n} security update${n === 1 ? '' : 's'}`,
			color: 'var(--yellow)',
		})
	}
	if (typeof posture.failedUnits === 'number' && posture.failedUnits > 0) {
		const n = Math.round(posture.failedUnits)
		out.push({
			id: 'failed',
			label: 'Failed',
			icon: 'alert',
			text: String(n),
			percent: null,
			sub: `${n} failed service${n === 1 ? '' : 's'}`,
			color: 'var(--red)',
		})
	}
	if (Array.isArray(posture.listeningPorts) && posture.listeningPorts.length > 0) {
		const n = posture.listeningPorts.length
		out.push({
			id: 'ports',
			label: 'Ports',
			icon: 'network',
			text: String(n),
			percent: null,
			sub: posture.listeningPorts
				.slice(0, 6)
				.map((p) => `${p.port}/${p.proto}`)
				.join(', '),
		})
	}
	return out
}

function temperatureReading(sensor: TempSensor, unit: TempUnit): StatReading {
	const text = formatTemp(sensor.celsius, unit)
	return {
		id: `temp:${sensor.id}`,
		label: sensor.label,
		icon: 'thermo',
		text,
		percent: tempArc(sensor.celsius, sensor.kind),
		sub: text,
		color: tempColor(sensor.celsius, sensor.kind),
		meter: {now: Math.round(tempDegrees(sensor.celsius, unit)), max: Math.round(tempDegrees(tempScale(sensor.kind).max, unit)), unit: unit === 'f' ? '°F' : '°C'},
	}
}

/**
 * The readings every view shows, in one order: the usage gauges, then a size-only disk, then temperatures, then host posture readings.
 * `diskSizeGb` is used only when no storage gauge is present.
 * Pass `temps` for the machine's sensors. A lone `temp` number is the processor.
 */
export function statReadings(input: {gauges: readonly StatGauge[]; temp: number | null; diskSizeGb: number | null; posture?: PostureSummary; temps?: readonly TempSensor[]; tempPicks?: TempPicks; tempUnit?: TempUnit; statPicks?: StatPicks}): StatReading[] {
	const stats = managerStats({gauges: input.gauges, temp: null, diskSizeGb: input.diskSizeGb})
	const extra = new Map(input.gauges.map((g) => [g.key ?? g.k, g]))
	const picks = input.statPicks ?? null
	const base: StatReading[] = stats
		.map((s) => {
			const g = extra.get(s.id)
			return {
				id: s.id,
				label: s.label,
				icon: s.icon,
				text: s.text,
				percent: s.percent,
				sub: g?.sub && g.sub !== '–' ? g.sub : s.text,
				color: g?.color,
			}
		})
		.filter((reading) => statIsShown(reading.id, picks))
	const sensors = input.temps ?? (input.temp != null && Number.isFinite(input.temp) ? [{id: 'processor', label: 'Processor', kind: 'processor' as const, celsius: input.temp, stuck: false, defaultOn: true}] : [])
	const unit = input.tempUnit === 'f' ? 'f' : 'c'
	const temperatures = sensors.filter((sensor) => tempIsShown(sensor, input.tempPicks ?? null)).map((sensor) => temperatureReading(sensor, unit))
	return [...base, ...temperatures, ...postureReadings(input.posture).filter((reading) => statIsShown(reading.id, picks))]
}
