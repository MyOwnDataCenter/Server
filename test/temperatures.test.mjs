import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cleanTempPicks, formatTemp, machineTemperatures, tempArc, tempColor, tempDegrees, tempIsShown, tempLevel, tempUnitOf, toggleTempPick} from '../web/src/fleet/temperatures.ts'

test('each temperature kind uses its own scale and colour', () => {
	assert.equal(tempLevel(79, 'processor'), 'ok')
	assert.equal(tempLevel(80, 'processor'), 'warning')
	assert.equal(tempLevel(90, 'processor'), 'danger')
	assert.equal(tempColor(52, 'processor'), 'var(--green)')
	assert.equal(tempColor(85, 'processor'), 'var(--yellow)')
	assert.equal(tempColor(92, 'processor'), 'var(--red)')
	assert.equal(tempLevel(41, 'case'), 'ok')
	assert.equal(tempLevel(42, 'case'), 'warning')
	assert.equal(tempLevel(52, 'case'), 'danger')
	assert.equal(tempLevel(84, 'video'), 'ok')
	assert.equal(tempLevel(85, 'video'), 'warning')
	assert.equal(tempLevel(95, 'video'), 'danger')
	assert.equal(Math.round(tempArc(52, 'processor')), 52)
	assert.equal(Math.round(tempArc(39, 'video')), 35)
	assert.equal(Math.round(tempArc(25, 'case')), 42)
	assert.equal(tempArc(200, 'processor'), 100)
	assert.equal(tempUnitOf(null), 'c')
	assert.equal(tempUnitOf('f'), 'f')
	assert.equal(formatTemp(52, 'c'), '52°C')
	assert.equal(formatTemp(52, 'f'), '126°F')
	assert.equal(formatTemp(0, 'f'), '32°F')
	assert.equal(Math.round(tempDegrees(100, 'f')), 212)
	assert.equal(tempColor(90, 'processor'), 'var(--red)')
})

test('a lone processor temperature and each video card are offered', () => {
	const sensors = machineTemperatures({
		temp: 52,
		gpus: [
			{index: 0, temp: 39},
			{index: 1, temp: 36},
		],
	})
	assert.deepEqual(
		sensors.map((sensor) => [sensor.id, sensor.label, Math.round(sensor.celsius), sensor.defaultOn]),
		[
			['processor', 'Processor', 52, true],
			['video:0', 'Video card 1', 39, true],
			['video:1', 'Video card 2', 36, true],
		],
	)
})

test('a daemon list is kept, and a video card is not added twice', () => {
	const sensors = machineTemperatures({
		temp: 83,
		sensors: [
			{id: 'processor', label: 'Processor', kind: 'processor', celsius: 83, defaultOn: true},
			{id: 'processor:core-0', label: 'Core 0', kind: 'processor', celsius: 81, defaultOn: false},
			{id: 'case', label: 'Case', kind: 'case', celsius: 25, stuck: true, defaultOn: true},
			{id: 'nope', label: 'Broken', kind: 'case', celsius: 0},
		],
		gpus: [{index: 0, temp: 70}],
	})
	assert.deepEqual(
		sensors.map((sensor) => sensor.id),
		['processor', 'processor:core-0', 'video:0', 'case'],
	)
	assert.equal(sensors.find((sensor) => sensor.id === 'case').stuck, true)
})

test('choices are global and leave untouched sensors on their default', () => {
	const processor = {id: 'processor', label: 'Processor', kind: 'processor', celsius: 52, stuck: false, defaultOn: true}
	const video = {id: 'video:1', label: 'Video card 2', kind: 'video', celsius: 36, stuck: false, defaultOn: true}
	const core = {id: 'processor:core-0', label: 'Core 0', kind: 'processor', celsius: 80, stuck: false, defaultOn: false}
	assert.equal(tempIsShown(processor, null), true)
	assert.equal(tempIsShown(core, null), false)
	const hidden = toggleTempPick(null, video, false)
	assert.deepEqual(hidden, {on: [], off: ['video:1']})
	assert.equal(tempIsShown(video, hidden), false)
	assert.equal(tempIsShown(processor, hidden), true)
	const shown = toggleTempPick(hidden, core, true)
	assert.deepEqual(shown, {on: ['processor:core-0'], off: ['video:1']})
	assert.equal(tempIsShown(core, shown), true)
	assert.deepEqual(toggleTempPick(shown, core, false), hidden)
	assert.deepEqual(cleanTempPicks({on: ['processor', 'processor'], off: ['video:1', 'not an id']}), {on: ['processor'], off: ['video:1']})
	assert.equal(cleanTempPicks({on: [], off: []}), null)
	assert.equal(cleanTempPicks(null), null)
})
