export const OPEN_FLEET = 'omarchy-open-fleet'

export type FleetOpen = {kind: 'server' | 'computer' | 'guest' | 'container'; id: string}

let pending: FleetOpen | null = null

export function openFleetMember(member: FleetOpen) {
	pending = member
	window.dispatchEvent(new CustomEvent<FleetOpen>(OPEN_FLEET, {detail: member}))
}

export function takePendingFleet(): FleetOpen | null {
	const member = pending
	pending = null
	return member
}
