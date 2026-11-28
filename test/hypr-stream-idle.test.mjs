// A still screen is not a failed capture. Hyprland renders only when something changes, so on an empty
// desktop or an idle window no new frame arrives; the capture worker used to count each wait as a
// failure and end the stream after 15 of them ("Target window or monitor closed"), and the viewer
// reconnected over and over (issue #1111).
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {dirname, join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const STREAM_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'omarchyd', 'hypr-stream.py')

const run = (body) =>
	execFileSync('python3', ['-c', `
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("hs", ${JSON.stringify(STREAM_PY)})
hs = importlib.util.module_from_spec(spec); spec.loader.exec_module(hs)
class FakeWl:
    def __init__(self, events): self.events, self.handlers, self.next = list(events), {}, 100
    def alloc_id(self): self.next += 1; return self.next
    def send(self, *a): pass
    def read_once(self, t):
        if self.events:
            op, payload = self.events.pop(0)
            for h in list(self.handlers.values()): h(op, payload)
        else: time.sleep(t)
${body}
`], {encoding: 'utf8'}).trim()

test('no new frame in time is idle, not a failure', () => {
	const out = run(`
t = time.monotonic()
res, _ = hs.capture_once(FakeWl([]), 1, 2, 3, "output", 4, 0, None, timeout=0.1)
print("idle" if res is hs.IDLE else repr(res), round(time.monotonic() - t, 1))
`)
	assert.equal(out, 'idle 0.1')
})

test('the compositor saying the capture failed is still a failure', () => {
	const out = run(`
res, _ = hs.capture_once(FakeWl([(3, b"")]), 1, 2, 3, "output", 4, 0, None, timeout=1.0)
print("none" if res is None else "other")
`)
	assert.equal(out, 'none')
})
