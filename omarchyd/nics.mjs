// Physical NICs a swarm computer has shown while it was on. A missing NIC is forgotten only
// after both 3 later online sessions and 7 days of later online time. Time powered off does not count.

export const FORGET_SESSIONS = 3
export const FORGET_ONLINE_MS = 7 * 24 * 60 * 60 * 1000

function macOf(raw) {
	const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
	if (hex.length !== 12 || hex === '000000000000' || hex === 'ffffffffffff') return ''
	return hex.match(/.{2}/g).join(':')
}

export function updateNics(prev = [], reported = [], {now, session, elapsedOnlineMs = 0} = {}) {
	const seen = new Set(reported.map(macOf).filter(Boolean))
	const byMac = new Map()
	for (const n of prev ?? []) {
		const mac = macOf(n?.mac)
		if (mac) byMac.set(mac, {...n, mac})
	}
	for (const mac of seen) {
		byMac.set(mac, {mac, lastSeen: now, missingSessions: 0, missingOnlineMs: 0, countedSession: session})
	}
	const next = []
	for (const n of byMac.values()) {
		if (seen.has(n.mac)) {
			next.push(n)
			continue
		}
		const missingSessions = n.countedSession === session ? n.missingSessions : (n.missingSessions ?? 0) + 1
		const missingOnlineMs = (n.missingOnlineMs ?? 0) + Math.max(0, elapsedOnlineMs)
		if (missingSessions >= FORGET_SESSIONS && missingOnlineMs >= FORGET_ONLINE_MS) continue
		next.push({...n, missingSessions, missingOnlineMs, countedSession: session})
	}
	return next
}
