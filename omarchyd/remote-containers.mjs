// Swarm verbs for Incus on joined computers (lxc-* on the connector).

import {RpcError} from './rpc.mjs'

export const REMOTE_CONTAINER_SETUP = 'machines-add-lxc'

const HOST_ID = /^[0-9a-f]{12}$/

export function normalizeHostId(hostId) {
	const id = String(hostId ?? '').trim() || 'server'
	if (id === 'server') return 'server'
	if (!HOST_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That computer isn’t valid.')
	return id
}

/** Map lxc-status JSON from the connector into containers.hostStatus shape. */
export function readLxcStatus(raw) {
	const s = typeof raw === 'string' ? JSON.parse(raw) : raw
	if (s?.available === true) return {available: true, version: s.version ?? null, project: s.project ?? null}
	const reason = String(s?.reason ?? 'Incus isn’t ready on that computer.')
	return {available: false, reason, setupCommand: String(s?.setupCommand ?? REMOTE_CONTAINER_SETUP)}
}

export function parseRemoteContainerList(raw) {
	const rows = typeof raw === 'string' ? JSON.parse(raw) : raw
	return Array.isArray(rows) ? rows : []
}

export async function remoteContainerCall(connector, hostId, name, args = {}, timeout = 120_000) {
	if (!connector?.call) throw new RpcError('PRECONDITION_FAILED', 'The local swarm isn’t ready yet.')
	try {
		return await connector.call(hostId, name, args, timeout)
	} catch (error) {
		const msg = String(error?.message ?? error)
		if (/offline/i.test(msg)) throw new RpcError('PRECONDITION_FAILED', msg)
		throw new RpcError('BAD_GATEWAY', msg)
	}
}

export function agentMayContainers(agent) {
	return !!(agent?.allowed?.containers && agent?.on?.containers)
}

/** Refuse remote container work when System containers wasn’t granted (or is switched off). */
export function requireContainersGrant(agent) {
	const hostName = agent?.name || 'that computer'
	if (!agentMayContainers(agent)) throw new RpcError('FORBIDDEN', `Pair ${hostName} again with System containers switched on.`)
}

export async function remoteHostStatus({connector, agents, hostId, requireOnline = true}) {
	const agent = (agents ?? []).find((a) => a.id === hostId)
	if (!agent) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
	const hostName = agent.name || 'that computer'
	if (requireOnline && !agent.online) throw new RpcError('PRECONDITION_FAILED', `${hostName} is offline right now`)
	if (!agentMayContainers(agent)) {
		return {
			available: false,
			containersAllowed: false,
			reason: `Pair ${hostName} again with System containers switched on.`,
			setupCommand: REMOTE_CONTAINER_SETUP,
			hostName,
		}
	}
	const raw = await remoteContainerCall(connector, hostId, 'lxc-status', {}, 30_000)
	return {...readLxcStatus(raw), containersAllowed: true, hostName}
}
