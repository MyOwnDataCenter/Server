import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createThermalWatch, readThermalProbes, sensorsFromProbes} from '../omarchyd/thermal.mjs'

const laptop = [
	{chip: 'acpitz', label: '', index: 1, celsius: 25, zone: false},
	{chip: 'nvme', label: 'Composite', index: 1, celsius: 54.85, zone: false},
	{chip: 'nvme', label: 'Sensor 1', index: 2, celsius: 54.85, zone: false},
	{chip: 'nvme', label: 'Sensor 2', index: 3, celsius: 57.85, zone: false},
	{chip: 'pch_skylake', label: '', index: 1, celsius: 72, zone: false},
	{chip: 'dell_smm', label: '', index: 1, celsius: 82, zone: false},
	{chip: 'dell_smm', label: '', index: 2, celsius: 52, zone: false},
	{chip: 'coretemp', label: 'Package id 0', index: 1, celsius: 83, zone: false},
	{chip: 'coretemp', label: 'Core 0', index: 2, celsius: 81, zone: false},
	{chip: 'coretemp', label: 'Core 1', index: 3, celsius: 83, zone: false},
	{chip: 'ath10k_hwmon', label: '', index: 1, celsius: 69, zone: false},
	{chip: 'amdgpu', label: 'edge', index: 1, celsius: 48, zone: false},
	{chip: 'thermal', label: 'INT3400 Thermal', index: 4, celsius: 20, zone: true},
	{chip: 'thermal', label: 'x86_pkg_temp', index: 8, celsius: 83, zone: true},
	{chip: 'thermal', label: 'acpitz', index: 0, celsius: 25, zone: true},
]

test('sensors keep one processor, the case, and the drive, and skip echoes', () => {
	const sensors = sensorsFromProbes(laptop)
	const byId = Object.fromEntries(sensors.map((sensor) => [sensor.id, sensor]))
	assert.equal(byId.processor.label, 'Processor')
	assert.equal(byId.processor.defaultOn, true)
	assert.equal(byId.processor.celsius, 83)
	assert.equal(byId['processor:core-0'].defaultOn, false)
	assert.equal(byId['processor:core-1'].defaultOn, false)
	assert.equal(byId.case.label, 'Case')
	assert.equal(byId.case.defaultOn, true)
	assert.equal(byId.drive.label, 'Drive')
	assert.equal(byId.drive.defaultOn, true)
	assert.equal(byId['drive:sensor-2'].defaultOn, false)
	assert.equal(byId['board:pch'].label, 'Chipset')
	assert.equal(byId['board:pch'].defaultOn, false)
	assert.equal(byId['other:wireless'].label, 'Wireless')
	assert.equal(byId['board:dell-smm-2'].celsius, 52)
	assert.equal(byId['board:dell-smm-1'], undefined)
	assert.equal(sensors.some((sensor) => sensor.kind === 'video'), false)
	assert.equal(sensors.some((sensor) => /INT3400/i.test(sensor.label)), false)
})

test('a flat case sensor is stuck once another sensor has moved', () => {
	const watch = createThermalWatch({need: 3})
	const sample = (cpu, air) => [
		{id: 'processor', kind: 'processor', celsius: cpu, stuck: false, defaultOn: true, label: 'Processor'},
		{id: 'case', kind: 'case', celsius: air, stuck: false, defaultOn: true, label: 'Case'},
	]
	assert.equal(watch.observe(sample(80, 25))[1].stuck, false)
	assert.equal(watch.observe(sample(81, 25))[1].stuck, false)
	const third = watch.observe(sample(83, 25))
	assert.equal(third.find((sensor) => sensor.id === 'case').stuck, true)
	assert.equal(third.find((sensor) => sensor.id === 'processor').stuck, false)
})

test('nothing is stuck when every sensor is holding still', () => {
	const watch = createThermalWatch({need: 2})
	const sample = [
		{id: 'processor', kind: 'processor', celsius: 52, stuck: false, defaultOn: true, label: 'Processor'},
		{id: 'case', kind: 'case', celsius: 25, stuck: false, defaultOn: true, label: 'Case'},
	]
	watch.observe(sample)
	const next = watch.observe(sample)
	assert.equal(next.every((sensor) => sensor.stuck === false), true)
})

test('probes are read from hwmon labels and thermal zones', async () => {
	const files = {
		'/sys/class/hwmon': ['hwmon0'],
		'/sys/class/hwmon/hwmon0/name': 'coretemp',
		'/sys/class/hwmon/hwmon0': ['temp1_input', 'temp1_label'],
		'/sys/class/hwmon/hwmon0/temp1_input': '52000',
		'/sys/class/hwmon/hwmon0/temp1_label': 'Package id 0',
		'/sys/class/thermal': ['thermal_zone0'],
		'/sys/class/thermal/thermal_zone0/type': 'acpitz',
		'/sys/class/thermal/thermal_zone0/temp': '30000',
	}
	const list = async (dir) => files[dir] ?? []
	const read = async (file) => (typeof files[file] === 'string' ? files[file] : '')
	const probes = await readThermalProbes({list, read})
	const sensors = sensorsFromProbes(probes)
	assert.deepEqual(
		sensors.map((sensor) => [sensor.id, sensor.celsius]),
		[
			['processor', 52],
			['case', 30],
		],
	)
})
