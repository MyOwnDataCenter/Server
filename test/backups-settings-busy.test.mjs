import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// backups.configure replaces include, schedule and keep as whole objects, and customPaths as a whole list.
// The page builds each one from the status it last loaded, so a second change made before the first is
// saved sends the first one's old value back. The controls wait for the save instead.
const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')

test('the what-is-backed-up switches and the folder remove button wait for a save in flight', () => {
	for (const label of ['Apps', 'Pause apps while saving', 'Server settings', 'VM backups']) {
		const line = src.split('\n').find((l) => l.includes(`<Switch label="${label}"`))
		assert.ok(line, label)
		assert.match(line, /disabled=\{save\.isPending\}/, label)
	}
	const remove = src.slice(src.indexOf('aria-label={`Remove ${vp}`}') - 200, src.indexOf('aria-label={`Remove ${vp}`}'))
	assert.match(remove, /disabled=\{save\.isPending\}/)
})

test('the schedule and keep pickers wait for a save in flight', () => {
	assert.match(src, /<ScheduleGroup s=\{s\} busy=\{save\.isPending\}/)
	const group = src.slice(src.indexOf('function ScheduleGroup'), src.indexOf('function computerRowSub'))
	assert.equal((group.match(/<select className="field" disabled=\{busy\}/g) ?? []).length, 3)
	assert.match(group, /const put = .*!busy/)
	assert.match(group, /const keep = .*!busy/)
})
