// Where an App Store install can go.
// The main store asks. A store opened from a machine is already aimed at that machine.
// This server can take an install. Another machine can take one only while its connector is online.
// A virtual machine’s connector has to be online and the machine has to be running.
// Machines that cannot take an install are left out of the list.

export type InstallKind = 'server' | 'computer' | 'guest'
export type InstallAbility = 'ready' | 'offline' | 'refused' | 'needs-connector'

export type InstallTarget = {
	id: string
	kind: InstallKind
	name: string
	ability: InstallAbility
	/** Empty when the install can proceed. */
	reason: string
}

export const SERVER_INSTALL_ID = 'server'

/** Id to send, or null when that machine can no longer take the install. Never substitute this server. */
export function confirmInstallTarget(chosen: {id: string; ability: InstallAbility} | null): string | null {
	if (!chosen || chosen.ability !== 'ready') return null
	return chosen.id
}

export type ComputerInstallInput = {
	id: string
	name: string
	online: boolean
}

export type GuestInstallInput = {
	id: string
	name: string
	state: string
	connector: boolean
}

const byName = (a: {name: string}, b: {name: string}) => a.name.localeCompare(b.name)

export function computerInstallInput(row: {id: string; name: string; online: boolean}): ComputerInstallInput {
	return {id: row.id, name: row.name, online: row.online}
}

export function guestInstallInput(row: {id: string; name: string; state: string; connector?: boolean}): GuestInstallInput {
	return {id: row.id, name: row.name, state: row.state, connector: !!row.connector}
}

function readyComputer(row: ComputerInstallInput): InstallTarget {
	return {id: row.id, kind: 'computer', name: row.name, ability: 'ready', reason: ''}
}

function readyGuest(row: GuestInstallInput): InstallTarget {
	return {id: row.id, kind: 'guest', name: row.name, ability: 'ready', reason: ''}
}

/** Ready install destinations only. Offline connectors and VMs without an online connector are omitted. */
export function installTargets(input: {serverName: string; computers: readonly ComputerInstallInput[]; guests: readonly GuestInstallInput[]}): InstallTarget[] {
	const server: InstallTarget = {id: SERVER_INSTALL_ID, kind: 'server', name: input.serverName || 'This server', ability: 'ready', reason: ''}
	// Offline connectors never appear — installs need a live connector.
	const computers = input.computers.filter((row) => row.online).sort(byName).map(readyComputer)
	// A guest needs its own connector online and the VM running; a host alone is not enough.
	const guests = input.guests.filter((row) => row.connector && row.state === 'running').sort(byName).map(readyGuest)
	return [server, ...computers, ...guests]
}

export function installKindLabel(kind: InstallKind): string {
	if (kind === 'server') return 'This server'
	if (kind === 'computer') return 'Computer'
	return 'Virtual machine'
}

/** A count is shown only when the same app is installed on more than one machine. */
export function machineCountLabel(count: number): string | null {
	return count > 1 ? String(count) : null
}

export function installsOf(appId: string, places: readonly {appIds: readonly string[]}[]): number {
	return places.reduce((n, place) => n + (place.appIds.includes(appId) ? 1 : 0), 0)
}
