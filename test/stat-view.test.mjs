import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cleanStatPicks, gaugeCaption, nextStatView, readingFace, statReadings, statViewOf, toggleStatPick} from '../web/src/fleet/statView.ts'

test('stat view cycles one line, three lines, then gauges', () => {
	assert.equal(statViewOf(undefined), 'line')
	assert.equal(statViewOf(null), 'line')
	assert.equal(statViewOf('dials'), 'line')
	assert.equal(nextStatView('line'), 'blocks')
	assert.equal(nextStatView('blocks'), 'gauges')
	assert.equal(nextStatView('gauges'), 'line')
	assert.equal(nextStatView(statViewOf('nope')), 'blocks')
})

test('every view is given the same readings, including temperature and a size-only disk', () => {
	const readings = statReadings({
		gauges: [
			{k: 'CPU', icon: 'cpu', p: 12.4, ready: true, sub: '12%'},
			{k: 'Memory', icon: 'memory', p: 40, ready: true, sub: '1 GB of 4 GB'},
			{k: 'GPU', icon: 'gpu', p: 0, ready: false, key: 'gpu0', sub: '–'},
			{k: 'Battery', icon: 'battery', p: 80, ready: true, sub: '80%', color: 'var(--green)'},
		],
		temp: 61.2,
		diskSizeGb: 120,
	})
	assert.deepEqual(
		readings.map((r) => r.id),
		['CPU', 'Memory', 'gpu0', 'Battery', 'disk-size', 'temp:processor'],
	)
	assert.deepEqual(
		readings.map((r) => r.text),
		['12%', '40%', '–', '80%', '? of 120 GB', '61°C'],
	)
	// The list does not depend on which drawing is showing. A temperature draws an arc on its own scale.
	assert.deepEqual(readings.map(readingFace), ['arc', 'arc', 'value', 'arc', 'value', 'arc'])
	assert.equal(gaugeCaption(readings[0]), null)
	assert.equal(gaugeCaption(readings[1]), '1 GB of 4 GB')
	const temp = readings.find((r) => r.id === 'temp:processor')
	assert.equal(temp.label, 'Processor')
	assert.equal(temp.color, 'var(--green)')
	assert.equal(temp.meter.now, 61)
	assert.equal(temp.meter.max, 100)
	assert.equal(temp.meter.unit, '°C')
	const fahrenheit = statReadings({gauges: [], temp: 61.2, diskSizeGb: null, tempUnit: 'f'})
	const hot = fahrenheit.find((r) => r.id === 'temp:processor')
	assert.equal(hot.text, '142°F')
	assert.equal(hot.meter.now, 142)
	assert.equal(hot.meter.max, 212)
	assert.equal(hot.meter.unit, '°F')
	assert.equal(hot.percent, temp.percent)
	assert.equal(gaugeCaption(temp), null)
	assert.equal(readings.find((r) => r.id === 'Battery').color, 'var(--green)')
})

test('hiding a stat keeps the rest, and a temperature choice stays separate', () => {
	const gauges = [
		{k: 'CPU', icon: 'cpu', p: 12, ready: true, sub: '12%'},
		{k: 'Memory', icon: 'memory', p: 40, ready: true, sub: '1 GB of 4 GB'},
		{k: 'Storage', icon: 'disk', p: 50, ready: true, sub: '1 GB of 2 GB'},
	]
	const hidden = toggleStatPick(null, 'CPU', false)
	assert.deepEqual(hidden, {on: [], off: ['CPU']})
	const readings = statReadings({gauges, temp: 40, diskSizeGb: null, statPicks: hidden})
	assert.deepEqual(
		readings.map((r) => r.id),
		['Memory', 'Storage', 'temp:processor'],
	)
	assert.equal(toggleStatPick(hidden, 'CPU', true), null)
	assert.deepEqual(cleanStatPicks({on: [], off: ['CPU', 'CPU', 'nope id']}), {on: [], off: ['CPU']})
	assert.equal(cleanStatPicks({on: [], off: []}), null)
	const ports = statReadings({
		gauges,
		temp: null,
		diskSizeGb: null,
		posture: {listeningPorts: [{port: 22, proto: 'tcp', addr: '0.0.0.0'}]},
		statPicks: {on: [], off: ['ports']},
	})
	assert.equal(ports.some((r) => r.id === 'ports'), false)
	assert.equal(ports.some((r) => r.id === 'CPU'), true)
})

test('a storage gauge already covers the disk, so the size-only reading is not added', () => {
	const readings = statReadings({
		gauges: [{k: 'Storage', icon: 'disk', p: 50, ready: true, sub: '1 GB of 2 GB'}],
		temp: null,
		diskSizeGb: 120,
	})
	assert.deepEqual(
		readings.map((r) => r.id),
		['Storage'],
	)
	assert.equal(readingFace(readings[0]), 'arc')
	assert.equal(gaugeCaption(readings[0]), '1 GB of 2 GB')
})

test('host posture values appear as readings on the computer gauges only when present', () => {
	const healthy = statReadings({
		gauges: [{k: 'CPU', icon: 'cpu', p: 10, ready: true, sub: '10%'}],
		temp: null,
		diskSizeGb: null,
		posture: {rebootRequired: false, securityUpdates: 0, failedUnits: 0, listeningPorts: []},
	})
	assert.deepEqual(
		healthy.map((r) => r.id),
		['CPU'],
	)

	const warned = statReadings({
		gauges: [{k: 'CPU', icon: 'cpu', p: 10, ready: true, sub: '10%'}],
		temp: null,
		diskSizeGb: null,
		posture: {
			rebootRequired: true,
			rebootReason: 'Kernel updated',
			securityUpdates: 3,
			failedUnits: 1,
			listeningPorts: [
				{port: 22, proto: 'tcp', addr: '0.0.0.0'},
				{port: 80, proto: 'tcp', addr: '0.0.0.0'},
			],
		},
	})
	assert.deepEqual(
		warned.map((r) => r.id),
		['CPU', 'reboot', 'security', 'failed', 'ports'],
	)
	assert.deepEqual(
		warned.slice(1).map((r) => ({id: r.id, text: r.text, face: readingFace(r), color: r.color})),
		[
			{id: 'reboot', text: 'Needed', face: 'value', color: 'var(--yellow)'},
			{id: 'security', text: '3', face: 'value', color: 'var(--yellow)'},
			{id: 'failed', text: '1', face: 'value', color: 'var(--red)'},
			{id: 'ports', text: '2', face: 'value', color: undefined},
		],
	)
})
