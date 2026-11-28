// Install the connector into an Incus system container from the host (incus exec),
// pairing it with containerOf. Mirrors guest-install without qemu-ga.
import {connectorKind, guestConnectorExec, guestConnectorPrep, guestReachableUrl} from './guest-install.mjs'
import {RpcError} from './rpc.mjs'

export const LXC_CONNECTOR_ALLOW = ['terminal', 'files', 'manage', 'backup', 'services']

export function lxcConnectorAbilities() {
	return Object.fromEntries(LXC_CONNECTOR_ALLOW.map((k) => [k, true]))
}

export function lxcConnectorAllowList(abilities = {}) {
	return LXC_CONNECTOR_ALLOW.filter((k) => abilities[k] === true).join(',')
}

const USER = /^[a-z_][a-z0-9_-]{0,31}$/

function ensureUserCommand(username) {
	const user = String(username ?? '').trim()
	if (!USER.test(user) || user === 'root') throw new Error('Use a lower-case username')
	return {
		path: 'bash',
		args: [
			'-lc',
			[`id ${user} >/dev/null 2>&1`, `|| useradd -m -s /bin/bash ${user}`, `|| adduser -D -s /bin/ash ${user}`].join(' '),
		],
	}
}

function lxcFlagCommand(username) {
	const user = String(username ?? '').trim()
	return {
		path: 'bash',
		args: [
			'-lc',
			`runuser -u ${user} -- bash -lc 'mkdir -p "$HOME/.local/share/omarchy-connector" && touch "$HOME/.local/share/omarchy-connector/lxc"'`,
		],
	}
}

async function incusExec(run, name, cmd, {timeout = 120_000} = {}) {
	const args = ['exec', name, '--', cmd.path, ...(cmd.args ?? [])]
	try {
		await run(args, cmd.input !== undefined ? {input: cmd.input, timeout} : {timeout})
		return {exitcode: 0}
	} catch (error) {
		return {exitcode: error?.code ?? 1, stderr: error?.stderr ?? error?.message ?? String(error)}
	}
}

/**
 * Pair with containerOf, prepare the guest account, install the connector via incus exec, then
 * wait until swarm.list shows the linked agent.
 */
export async function installLxcConnector({
	name,
	username,
	osId = '',
	run,
	pair,
	listAgents,
	caCertificate,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	enrollTimeoutMs = 10 * 60_000,
	excludeAddresses = [],
} = {}) {
	const n = String(name ?? '')
	const user = String(username ?? '').trim()
	if (!n) throw new RpcError('BAD_REQUEST', 'Name a container')
	if (!USER.test(user) || user === 'root') throw new RpcError('BAD_REQUEST', 'Use a lower-case username')
	const os = connectorKind(osId)
	if (os === 'unsupported') throw new RpcError('PRECONDITION_FAILED', 'This operating system can’t run the connector.')

	const abilities = lxcConnectorAbilities()
	const pairOut = await pair({containerOf: n, ...abilities})
	const url = guestReachableUrl({addresses: pairOut.addresses, port: pairOut.port, exclude: excludeAddresses})
	if (!url) throw new RpcError('PRECONDITION_FAILED', 'This server has no address the container can reach.')

	const ensure = await incusExec(run, n, ensureUserCommand(user))
	if (ensure.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${n} couldn’t prepare an account for the connector.`)

	for (const cmd of guestConnectorPrep({username: user, osId})) {
		const prepared = await incusExec(run, n, cmd)
		if (prepared.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${n} couldn’t prepare the connector installer.`)
	}

	const flag = await incusExec(run, n, lxcFlagCommand(user))
	if (flag.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${n} couldn’t mark itself as an LXC connector.`)

	const caPem = /^https:\/\//i.test(String(pairOut.source ?? '')) ? undefined : await caCertificate?.()
	const exec = guestConnectorExec({
		os,
		osId,
		username: user,
		source: pairOut.source,
		server: url,
		ca: pairOut.ca,
		token: pairOut.token,
		allow: lxcConnectorAllowList(abilities),
		caPem,
	})
	const installed = await incusExec(run, n, exec, {timeout: 10 * 60_000})
	if (installed.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${n} couldn’t install the connector.`)

	const tick = Math.min(1_000, Math.max(25, Math.floor(enrollTimeoutMs / 4)))
	const until = Date.now() + enrollTimeoutMs
	while (Date.now() < until) {
		const agents = await listAgents().catch(() => [])
		if ((Array.isArray(agents) ? agents : []).some((a) => a?.containerOf === n)) return {status: 'ok'}
		await sleep(tick)
	}
	throw new RpcError('PRECONDITION_FAILED', 'The connector didn’t join in time')
}
