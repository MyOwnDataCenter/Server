import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// unraid.preflight adds each container's Docker volume size to the space it needs when preserveSettings is on.
// The pre-flight check also gates the Bring over button, so it has to run again when that switch changes.
test('the pre-flight check runs again when "Preserve GPU, shared memory & Docker volumes" changes', async () => {
	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	const start = src.indexOf("mutate<PreflightResult>('unraid.preflight'")
	const end = src.indexOf('}, [', start)
	const body = src.slice(start, end)
	const deps = src.slice(end, src.indexOf('\n', end))
	const sent = [...body.matchAll(/^\t{4}(\w+),?$/gm)].map((m) => m[1])
	assert.ok(sent.includes('preserveSettings') && sent.includes('shutdownRunningVms') && sent.includes('destination'))
	for (const name of sent) assert.ok(new RegExp(`\\b${name}\\b|\\b${name.replace(/s$/, '')}List\\b`).test(deps), `${name} is sent but is not in the effect's dependencies: ${deps}`)
})
