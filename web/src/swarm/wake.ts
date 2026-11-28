// Wake is for a computer that is off. Manage is required, same as restart.
export function wakeOffer(a: {online: boolean; allowed: {manage: boolean}; on: {manage: boolean}; macs?: string[]; info?: {macs?: string[]} | null}) {
	if (a.online || !a.allowed.manage || !a.on.manage) return null
	const macs = a.macs?.length ? a.macs : a.info?.macs
	if (!macs?.length) return {enabled: false, why: 'Wake up isn’t available until this computer has been online once, so its network card can be remembered.'}
	return {enabled: true, why: ''}
}
