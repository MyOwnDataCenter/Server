// Host ports for tests. The kernel hands 32768–60999 to ordinary outgoing connections,
// and a test that binds one of those loses it at random. 20000–28999 are the private
// ports an app install takes for itself. This band sits between the two, and the check
// listens on every address, the same way an install does.
import net from 'node:net'

const START = 29_000
const END = 32_768

function listenFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.once('error', () => resolve(false))
		server.listen({port, host: '0.0.0.0'}, () => server.close(() => resolve(true)))
	})
}

export async function freePorts(count) {
	let port = START
	while (port + count <= END) {
		let size = 0
		for (; size < count; size++) {
			if (!(await listenFree(port + size))) break
		}
		if (size === count) return Array.from({length: count}, (_, i) => port + i)
		port += size + 1
	}
	throw new Error(`no ${count} free host ports`)
}

export async function freePort() {
	const [port] = await freePorts(1)
	return port
}
