// A request header can hold any byte. A token or gateway key with a character outside ASCII is
// simply wrong: the door answers it with 401, it does not raise and drop the connection.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const proxy = fileURLToPath(new URL('../omarchyd/api-proxy', import.meta.url))

const ask = (header, mode) =>
	execFileSync(
		'python3',
		[
			'-I',
			'-c',
			[
				'import importlib.machinery, importlib.util, sys',
				'loader = importlib.machinery.SourceFileLoader("api_proxy", sys.argv[1])',
				'spec = importlib.util.spec_from_loader("api_proxy", loader)',
				'mod = importlib.util.module_from_spec(spec)',
				'loader.exec_module(mod)',
				'print(mod.authorized({"authorization": sys.argv[2]}, sys.argv[3]))',
			].join('\n'),
			proxy,
			header,
			mode,
		],
		{env: {OMARCHY_API_TOKEN: 'abcdef', APP_GATEWAY_KEY: 'gatekey', PATH: process.env.PATH}, encoding: 'utf8', timeout: 20_000},
	).trim()

test('the right token is accepted and a wrong one is refused, ASCII or not', () => {
	assert.equal(ask('Bearer abcdef', 'api'), 'True')
	assert.equal(ask('Bearer abcdeg', 'api'), 'False')
	assert.equal(ask('Bearer abcdéf', 'api'), 'False')
	assert.equal(ask('Bearer abcdé', 'api'), 'False')
})
