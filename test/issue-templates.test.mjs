// The GitHub issue forms offer the dropdown choices their authors wrote, with commas inside a choice kept (#363).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {parse} from 'yaml'

for (const file of ['bug.yml', 'idea.yml']) {
	test(`${file}: every dropdown option is one whole choice`, () => {
		const form = parse(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), 'utf8'))
		for (const field of form.body.filter((f) => f.type === 'dropdown')) {
			for (const option of field.attributes.options) {
				assert.equal(typeof option, 'string')
				// A comma ends a plain scalar inside [ ], which cuts "The server itself (install, services)" in two.
				assert.equal((option.match(/\(/g) ?? []).length, (option.match(/\)/g) ?? []).length, `${field.id}: "${option}" is cut in the middle of brackets`)
			}
		}
	})
}

test('bug.yml: "Where" offers the server itself as one choice', () => {
	const form = parse(readFileSync(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url), 'utf8'))
	const where = form.body.find((f) => f.id === 'where')
	assert.deepEqual(where.attributes.options, ['Phone or tablet layout', 'Desktop layout', 'The server itself (install, services)', 'Not sure'])
})
