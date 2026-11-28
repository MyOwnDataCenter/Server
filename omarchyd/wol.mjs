// Wake-on-LAN: a magic packet on each physical IPv4 subnet this machine is on.
// Limited broadcast (255.255.255.255) often leaves only the default-route NIC.

const VIRTUAL = /^(lo|docker|podman|veth|virbr|br-|cni|tailscale|wg|tun|tap|dummy|flannel|cali|kube|zt)/

export function magicPacket(mac) {
	const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
	if (hex.length !== 12) throw new Error('Bad MAC address')
	const bytes = Buffer.from(hex, 'hex')
	return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({length: 16}, () => bytes)])
}

function ipToInt(ip) {
	return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}

function intToIp(n) {
	return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
}

export function directedBroadcasts(interfaces = {}) {
	const out = new Set()
	for (const [name, list] of Object.entries(interfaces)) {
		if (VIRTUAL.test(name)) continue
		for (const i of list ?? []) {
			if (i.internal || i.family !== 'IPv4') continue
			const mask = ipToInt(i.netmask)
			if (mask === 0xffffffff || mask === 0xfffffffe) continue
			out.add(intToIp((ipToInt(i.address) & mask) | (~mask >>> 0)))
		}
	}
	return [...out]
}

// This server plus every other computer that is on. The sleeping machine is not asked.
// An old connector that does not know the action is skipped. One successful send is enough.
export async function fanoutWake({macs, selfId, onlineIds = [], sendLocal, sendRemote}) {
	if (!macs?.length) throw new Error('No network address remembered yet')
	let local = false
	try {
		await sendLocal(macs)
		local = true
	} catch {
		local = false
	}
	const remote = await Promise.all(
		onlineIds.filter((id) => id !== selfId).map((id) => sendRemote(id, macs).then(() => true, () => false)),
	)
	const from = (local ? 1 : 0) + remote.filter(Boolean).length
	if (!from) throw new Error('Couldn’t send a wake packet')
	return {sent: true, from}
}
