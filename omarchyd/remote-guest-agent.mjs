// createQemuAgent's virsh qemu-agent-command, spoken as vm-ga-* on one joined computer.
// `call` is that swarm call, not a shell. Never log guest-exec input.

const LIBVIRT = 'qemu:///session'
const REJECT = 'remote guest agent only accepts qemu-agent-command'

function bad() {
	throw new Error(REJECT)
}

function commandPayload(cmd, args, domain) {
	if (cmd !== 'virsh' || !Array.isArray(args) || args.length !== 5) bad()
	const [flag, uri, verb, name, json] = args
	if (flag !== '-c' || uri !== LIBVIRT || verb !== 'qemu-agent-command' || name !== domain || typeof json !== 'string') bad()
	let payload
	try {
		payload = JSON.parse(json)
	} catch {
		bad()
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) bad()
	return payload
}

function commandArguments(payload) {
	const ga = payload.arguments
	if (!ga || typeof ga !== 'object' || Array.isArray(ga)) return {}
	return ga
}

function readResult(value) {
	if (typeof value === 'string') return JSON.parse(value.trim())
	return value
}

function b64(text) {
	return Buffer.from(typeof text === 'string' ? text : '', 'utf8').toString('base64')
}

function execBody(guestId, ga) {
	const body = {guestId, path: ga.path}
	if ('arg' in ga) body.args = ga.arg
	if (ga['capture-output'] === false) body.capture = false
	if (typeof ga['input-data'] === 'string') body.input = Buffer.from(ga['input-data'], 'base64').toString('utf8')
	return body
}

export function remoteGuestAgentRun({call, guestId}) {
	const domain = `omarchy-${guestId}`
	return async function run(cmd, args) {
		const payload = commandPayload(cmd, args, domain)
		const execute = payload.execute
		const ga = commandArguments(payload)
		if (execute === 'guest-ping') {
			const result = await call('vm-ga-ping', {guestId})
			if (typeof result === 'string') return result
			return JSON.stringify(result ?? null)
		}
		if (execute === 'guest-exec') {
			const parsed = readResult(await call('vm-ga-exec', execBody(guestId, ga)))
			return JSON.stringify({return: {pid: parsed.pid}})
		}
		if (execute === 'guest-exec-status') {
			const parsed = readResult(await call('vm-ga-status', {guestId, pid: String(ga.pid)}))
			return JSON.stringify({
				return: {
					exited: parsed.exited === true,
					exitcode: parsed.exitcode ?? null,
					'out-data': b64(parsed.out),
					'err-data': b64(parsed.err),
				},
			})
		}
		bad()
	}
}
