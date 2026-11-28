import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const atLeast = (range) => range.match(/>=\s*(\d+)(?:\.(\d+))?/).slice(1).map((n) => Number(n ?? 0))

// Working on the project (npm test, the PDF viewer library) needs a newer Node than running the installed
// server, which install.sh still checks for on its own.
test('CONTRIBUTING asks for a Node version the tests and the PDF library can run on', async () => {
	const pdf = JSON.parse(await read('node_modules/pdfjs-dist/package.json'))
	const [pdfMajor, pdfMinor] = atLeast(pdf.engines.node)
	const contributing = await read('CONTRIBUTING.md')
	const asked = /You need Node\.js (\d+)\.(\d+) or newer/.exec(contributing)
	assert.ok(asked, 'CONTRIBUTING.md names a Node.js version with a minor number')
	const [major, minor] = asked.slice(1).map(Number)
	// pdfjs-dist asks for >=22.13 (or 24+); --experimental-strip-types arrived in 22.6.
	assert.ok(major > pdfMajor || (major === pdfMajor && minor >= pdfMinor), `CONTRIBUTING asks for ${major}.${minor}, lower than pdfjs-dist ${pdf.engines.node}`)
	assert.ok(major > 22 || (major === 22 && minor >= 6), 'the version must have --experimental-strip-types')
})
