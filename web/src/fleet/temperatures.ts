// Temperature readings for the stats region. Each kind has its own scale:
// a processor runs hotter than the air in the case, and a video card hotter still.
// The account stores which ids to force on or off. A sensor that was never chosen
// follows its own default, and a stuck sensor stays off until someone checks it.

export const TEMP_KINDS = ['processor', 'video', 'case', 'drive', 'board', 'other'] as const
export type TempKind = (typeof TEMP_KINDS)[number]

export type TempScale = {max: number; warn: number; danger: number}

// Full-scale degrees for the arc, then where the colour leaves normal.
// Processor uses the same warm and hot lines the server already reports (80 and 90).
const SCALE: Record<TempKind, TempScale> = {
	processor: {max: 100, warn: 80, danger: 90},
	video: {max: 110, warn: 85, danger: 95},
	case: {max: 60, warn: 42, danger: 52},
	drive: {max: 85, warn: 60, danger: 70},
	board: {max: 105, warn: 85, danger: 100},
	other: {max: 100, warn: 75, danger: 90},
}

const KIND_ORDER = new Map(TEMP_KINDS.map((kind, index) => [kind, index]))

export type TempSensor = {
	id: string
	label: string
	kind: TempKind
	celsius: number
	stuck: boolean
	defaultOn: boolean
}

export type TempPicks = {on: string[]; off: string[]} | null

export type TempProbe = {
	id?: string
	label?: string
	kind?: string
	celsius?: number
	stuck?: boolean
	defaultOn?: boolean
}

const ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/

export function tempScale(kind: TempKind): TempScale {
	return SCALE[kind]
}

export function tempLevel(celsius: number, kind: TempKind): 'ok' | 'warning' | 'danger' {
	const band = SCALE[kind]
	if (celsius >= band.danger) return 'danger'
	if (celsius >= band.warn) return 'warning'
	return 'ok'
}

export function tempColor(celsius: number, kind: TempKind): string {
	const level = tempLevel(celsius, kind)
	if (level === 'danger') return 'var(--red)'
	if (level === 'warning') return 'var(--yellow)'
	return 'var(--green)'
}

/** How far around the ring the temperature reaches, on that kind's scale. */
export function tempArc(celsius: number, kind: TempKind): number {
	const span = SCALE[kind].max
	if (!Number.isFinite(celsius) || span <= 0) return 0
	return Math.max(0, Math.min(100, (celsius / span) * 100))
}

export type TempUnit = 'c' | 'f'

/** Celsius unless the account has chosen Fahrenheit. */
export function tempUnitOf(value: unknown): TempUnit {
	return value === 'f' ? 'f' : 'c'
}

/** Degrees in the account's unit. Colour and the arc stay on the Celsius scale. */
export function tempDegrees(celsius: number, unit: TempUnit): number {
	return unit === 'f' ? (celsius * 9) / 5 + 32 : celsius
}

export function formatTemp(celsius: number, unit: TempUnit): string {
	return `${Math.round(tempDegrees(celsius, unit))}°${unit === 'f' ? 'F' : 'C'}`
}

export function cleanTempPicks(value: unknown): TempPicks {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
	const body = value as {on?: unknown; off?: unknown}
	const on = cleanIds(body.on)
	const off = cleanIds(body.off).filter((id) => !on.includes(id))
	if (!on.length && !off.length) return null
	return {on, off}
}

function cleanIds(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const out: string[] = []
	for (const id of value) {
		if (typeof id !== 'string' || !ID_RE.test(id) || out.includes(id)) continue
		out.push(id)
		if (out.length >= 40) break
	}
	return out
}

export function tempIsShown(sensor: TempSensor, picks: TempPicks): boolean {
	if (picks?.on.includes(sensor.id)) return true
	if (picks?.off.includes(sensor.id)) return false
	return sensor.defaultOn && !sensor.stuck
}

/** Check or uncheck one sensor. Untouched sensors on other machines keep their default. */
export function toggleTempPick(picks: TempPicks, sensor: TempSensor, on: boolean): TempPicks {
	const prev = picks ?? {on: [], off: []}
	const nextOn = prev.on.filter((id) => id !== sensor.id)
	const nextOff = prev.off.filter((id) => id !== sensor.id)
	const auto = sensor.defaultOn && !sensor.stuck
	if (on !== auto) {
		if (on) nextOn.push(sensor.id)
		else nextOff.push(sensor.id)
	}
	if (!nextOn.length && !nextOff.length) return null
	return {on: nextOn, off: nextOff}
}

function asKind(value: unknown): TempKind | null {
	return typeof value === 'string' && (TEMP_KINDS as readonly string[]).includes(value) ? (value as TempKind) : null
}

function asSensor(raw: TempProbe): TempSensor | null {
	const kind = asKind(raw.kind)
	const celsius = Number(raw.celsius)
	if (!kind || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
	if (!Number.isFinite(celsius) || celsius <= 0 || celsius >= 125) return null
	const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 48) : raw.id
	return {id: raw.id, label, kind, celsius, stuck: raw.stuck === true, defaultOn: raw.defaultOn !== false}
}

function videoLabel(index: number, many: boolean): string {
	return many ? `Video card ${index + 1}` : 'Video card'
}

export function sortTemps(sensors: readonly TempSensor[]): TempSensor[] {
	return [...sensors].sort((a, b) => {
		const kind = (KIND_ORDER.get(a.kind) ?? 9) - (KIND_ORDER.get(b.kind) ?? 9)
		if (kind) return kind
		// The headline reading (Processor, Case, Drive) stays ahead of its parts.
		const head = Number(a.id.includes(':')) - Number(b.id.includes(':'))
		if (head) return head
		return a.label.localeCompare(b.label, undefined, {numeric: true})
	})
}

/**
 * Sensors the machine is reporting. A daemon list wins. Video-card temperatures
 * still come from the GPU readings, and a lone processor temperature fills in
 * when the list has no processor.
 */
export function machineTemperatures(input: {
	temp?: number | null
	sensors?: readonly TempProbe[] | null
	gpus?: readonly {index?: number; temp?: number | null}[] | null
}): TempSensor[] {
	const out: TempSensor[] = []
	const seen = new Set<string>()
	const add = (sensor: TempSensor | null) => {
		if (!sensor || seen.has(sensor.id)) return
		seen.add(sensor.id)
		out.push(sensor)
	}
	for (const raw of input.sensors ?? []) add(asSensor(raw))
	const videos = (input.gpus ?? []).filter((gpu) => gpu.temp != null && Number.isFinite(gpu.temp) && gpu.temp > 0 && gpu.temp < 125)
	const many = videos.length > 1
	for (const gpu of videos) {
		const index = Number.isFinite(gpu.index) ? Math.max(0, Math.round(gpu.index as number)) : out.filter((s) => s.kind === 'video').length
		add({id: `video:${index}`, label: videoLabel(index, many), kind: 'video', celsius: gpu.temp as number, stuck: false, defaultOn: true})
	}
	const hasProcessor = out.some((sensor) => sensor.kind === 'processor' && sensor.id === 'processor')
	if (!hasProcessor && input.temp != null && Number.isFinite(input.temp)) {
		add({id: 'processor', label: 'Processor', kind: 'processor', celsius: input.temp, stuck: false, defaultOn: true})
	}
	return sortTemps(out)
}
