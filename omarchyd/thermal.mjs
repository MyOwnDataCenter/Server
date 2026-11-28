// Hardware temperature sensors. The headline processor reading stays on
// cpuTemperature. This list is the other sensors a person can show, and a
// case sensor that sits still while the rest of the machine moves is stuck.

export function sensorKind(chip, label) {
	const name = String(chip ?? '').toLowerCase()
	const text = String(label ?? '').toLowerCase()
	if (/nvme|drivetemp/.test(name)) return 'drive'
	if (/coretemp|k10temp|k8temp|zenpower|x86_pkg|\bcpu\b|\bsoc\b/.test(name) || /package id|^core \d|tctl|tdie|x86_pkg/.test(text)) return 'processor'
	if (/amdgpu|radeon|nouveau|nvidia/.test(name)) return 'video'
	if (/acpitz/.test(name) || /acpitz|ambient|systin|chassis|inlet|^case$/.test(text)) return 'case'
	if (/pch/.test(name) || /\bpch\b/.test(text)) return 'board'
	if (/ath|wifi|wlan|iwlwifi/.test(name)) return 'other'
	return 'board'
}

function slug(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48)
}

function round1(n) {
	return Math.round(n * 10) / 10
}

function sane(celsius) {
	return Number.isFinite(celsius) && celsius > 0 && celsius < 125
}

function describe(probe) {
	const kind = sensorKind(probe.chip, probe.label)
	const celsius = round1(probe.celsius)
	if (kind === 'processor') {
		const core = /core\s+(\d+)/i.exec(probe.label ?? '')
		if (core) return {id: `processor:core-${core[1]}`, label: `Core ${core[1]}`, kind, celsius, defaultOn: false}
		return {id: 'processor', label: 'Processor', kind, celsius, defaultOn: true}
	}
	if (kind === 'case') return {id: 'case', label: 'Case', kind, celsius, defaultOn: true}
	if (kind === 'drive') {
		if (!probe.label || /composite/i.test(probe.label)) return {id: 'drive', label: 'Drive', kind, celsius, defaultOn: true}
		return {id: `drive:${slug(probe.label)}`, label: `Drive ${probe.label}`, kind, celsius, defaultOn: false}
	}
	if (kind === 'video') return null
	if (kind === 'other') return {id: 'other:wireless', label: 'Wireless', kind, celsius, defaultOn: false}
	if (/pch/i.test(probe.chip)) return {id: 'board:pch', label: 'Chipset', kind, celsius, defaultOn: false}
	const index = Number.isFinite(probe.index) ? probe.index : 0
	const id = `board:${slug(probe.chip) || 'sensor'}-${index}`
	const label = probe.label && !/^temp\d+$/i.test(probe.label) ? probe.label : `Board ${index}`
	return {id, label, kind, celsius, defaultOn: false}
}

/**
 * Sensors a person can pick. Video cards are left out because those
 * temperatures already ride on the GPU readings. A thermal zone that repeats
 * an hwmon value is dropped, and so is the INT3400 placeholder.
 */
export function sensorsFromProbes(probes) {
	const hw = []
	const zones = []
	for (const probe of probes ?? []) {
		if (!sane(probe?.celsius)) continue
		if (probe.zone) zones.push(probe)
		else hw.push(probe)
	}
	const kept = []
	const seen = new Set()
	const push = (sensor) => {
		if (!sensor) return
		let next = sensor
		if (seen.has(next.id)) {
			let n = 2
			while (seen.has(`${sensor.id}:${n}`)) n += 1
			next = {...sensor, id: `${sensor.id}:${n}`, label: sensor.label === 'Drive' || sensor.label === 'Processor' ? `${sensor.label} ${n}` : sensor.label}
		}
		seen.add(next.id)
		kept.push({...next, stuck: false})
	}
	for (const probe of hw) {
		if (/amdgpu|radeon|nouveau|nvidia/i.test(probe.chip ?? '')) continue
		if (sensorKind(probe.chip, probe.label) === 'drive' && /^sensor\s+\d+$/i.test(probe.label ?? '')) {
			const composite = hw.find((other) => other.chip === probe.chip && /composite/i.test(other.label ?? ''))
			if (composite && Math.abs(composite.celsius - probe.celsius) < 1) continue
		}
		push(describe(probe))
	}
	const listed = kept.filter((sensor) => sensor.kind !== 'board' || !kept.some((cpu) => cpu.kind === 'processor' && Math.abs(cpu.celsius - sensor.celsius) <= 2))
	for (const zone of zones) {
		if (/int3400/i.test(zone.label ?? '')) continue
		if (listed.some((sensor) => Math.abs(sensor.celsius - zone.celsius) <= 1)) continue
		const sensor = describe({...zone, chip: 'thermal'})
		if (!sensor || listed.some((other) => other.id === sensor.id)) continue
		listed.push({...sensor, stuck: false})
	}
	return listed
}

/**
 * A case sensor that does not move while another sensor does is treated as
 * unplugged. A processor or a drive may sit still and still be real.
 * `need` samples have to agree before a sensor is stuck.
 */
export function createThermalWatch({need = 6} = {}) {
	const history = new Map()
	return {
		observe(sensors) {
			for (const sensor of sensors ?? []) {
				const samples = history.get(sensor.id) ?? []
				samples.push(sensor.celsius)
				while (samples.length > need) samples.shift()
				history.set(sensor.id, samples)
			}
			const moved = (sensors ?? []).some((sensor) => {
				const samples = history.get(sensor.id) ?? []
				return samples.length >= 2 && Math.max(...samples) - Math.min(...samples) >= 1
			})
			return (sensors ?? []).map((sensor) => {
				const samples = history.get(sensor.id) ?? []
				const flat = samples.length >= need && Math.max(...samples) - Math.min(...samples) < 0.5
				const sentinel = sensor.celsius <= 1 || sensor.celsius >= 120
				const stuck = flat && moved && (sensor.kind === 'case' || sentinel)
				return {...sensor, stuck}
			})
		},
	}
}

async function tempsIn(dir, list, read) {
	const names = await list(dir).catch(() => [])
	const out = []
	for (const file of names) {
		const match = /^temp(\d+)_input$/.exec(file)
		if (!match) continue
		const raw = Number(await read(`${dir}/${file}`))
		if (!Number.isFinite(raw)) continue
		const label = String(await read(`${dir}/temp${match[1]}_label`)).trim()
		out.push({index: Number(match[1]), celsius: raw / 1000, label, raw})
	}
	return out
}

/** Read hwmon and thermal zones. Callers decide which of those to keep. */
export async function readThermalProbes({list, read} = {}) {
	if (!list || !read) return []
	const probes = []
	for (const hw of await list('/sys/class/hwmon').catch(() => [])) {
		const dir = `/sys/class/hwmon/${hw}`
		const chip = String(await read(`${dir}/name`)).trim()
		let found = await tempsIn(dir, list, read)
		if (!found.length) found = await tempsIn(`${dir}/device`, list, read)
		for (const temp of found) probes.push({...temp, chip, zone: false})
	}
	for (const zone of await list('/sys/class/thermal').catch(() => [])) {
		if (!String(zone).startsWith('thermal_zone')) continue
		const type = String(await read(`/sys/class/thermal/${zone}/type`)).trim()
		const raw = Number(await read(`/sys/class/thermal/${zone}/temp`))
		if (!Number.isFinite(raw)) continue
		probes.push({chip: 'thermal', label: type, index: Number(String(zone).replace('thermal_zone', '')) || 0, celsius: raw / 1000, raw, zone: true})
	}
	return probes
}
