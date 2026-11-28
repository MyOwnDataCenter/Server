// The job API port is on the local network and answers before anyone has shown a token. A caller
// that connects and then says nothing (or stops half way through its request) must not keep a
// thread and a connection for ever.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const proxy = fileURLToPath(new URL('../omarchyd/api-proxy', import.meta.url))

const script = [
	'import importlib.machinery, importlib.util, socket, sys, threading',
	'loader = importlib.machinery.SourceFileLoader("api_proxy", sys.argv[1])',
	'spec = importlib.util.spec_from_loader("api_proxy", loader)',
	'mod = importlib.util.module_from_spec(spec)',
	'loader.exec_module(mod)',
	'mod.READ_TIMEOUT = 1',
	'listener = socket.socket()',
	'listener.bind(("127.0.0.1", 0))',
	'listener.listen(1)',
	'theirs = socket.create_connection(listener.getsockname())',
	'ours, _ = listener.accept()',
	'worker = threading.Thread(target=lambda: mod.Door(ours, ("127.0.0.1", 0), None), daemon=True)',
	'worker.start()',
	'theirs.sendall(sys.argv[2].encode())',
	'worker.join(6)',
	'print("held" if worker.is_alive() else "released")',
].join('\n')

const handle = (sent) =>
	spawnSync('python3', ['-I', '-c', script, proxy, sent], {env: {OMARCHY_API_TOKEN: 'abcdef', PATH: process.env.PATH}, encoding: 'utf8', timeout: 15_000}).stdout.trim()

test('a connection that sends nothing, or only part of a request, is let go', () => {
	assert.equal(handle(''), 'released')
	assert.equal(handle('POST /jobs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abcdef\r\nContent-Length: 10\r\n\r\nabc'), 'released')
})
