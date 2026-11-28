// Talk to a running guest through virsh qemu-agent-command. `run` is the transport
// so tests and a later swarm caller can swap it without this module knowing about machines.

const LIBVIRT = 'qemu:///session'

function decodeOutput(value) {
	if (!value) return ''
	return Buffer.from(value, 'base64').toString('utf8')
}

export function createQemuAgent({run, domain}) {
	async function agentCommand(payload) {
		const json = JSON.stringify(payload)
		const stdout = await run('virsh', ['-c', LIBVIRT, 'qemu-agent-command', domain, json])
		const text = String(stdout ?? '').trim()
		if (!text) return {}
		return JSON.parse(text)
	}

	return {
		async ping() {
			await agentCommand({execute: 'guest-ping'})
		},
		async interfaces() {
			const reply = await agentCommand({execute: 'guest-network-get-interfaces'})
			return Array.isArray(reply.return) ? reply.return : []
		},
		async routes() {
			const reply = await agentCommand({execute: 'guest-network-get-route'})
			return Array.isArray(reply.return) ? reply.return : []
		},
		async exec({path, args, input, capture} = {}) {
			const ga = {path}
			if (args !== undefined) ga.arg = args
			if (capture !== false) ga['capture-output'] = true
			if (typeof input === 'string') ga['input-data'] = Buffer.from(input, 'utf8').toString('base64')
			const reply = await agentCommand({execute: 'guest-exec', arguments: ga})
			return {pid: reply.return.pid}
		},
		async status(pid) {
			const reply = await agentCommand({execute: 'guest-exec-status', arguments: {pid}})
			const result = reply.return ?? {}
			return {
				exited: result.exited,
				exitcode: result.exitcode,
				out: decodeOutput(result['out-data']),
				err: decodeOutput(result['err-data']),
			}
		},
	}
}
