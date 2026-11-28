// What the phone chrome and sign-in card show next to the device name. Prefer a hostname or LAN
// address; only fall back to loopback, and then label it so it does not look like the wrong machine.

export type EntrypointServer = {host?: string | null; local?: boolean} | null | undefined

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i

export function isLoopbackHost(host: string | null | undefined): boolean {
	return !!host && LOOPBACK.test(host.trim())
}

/** Address for the entrypoint pill: non-loopback host first, else a clear local label. */
export function entrypointHost(server: EntrypointServer, pageHost: string = typeof location !== 'undefined' ? location.hostname : ''): string {
	const fromServer = server?.host?.trim() || ''
	const fromPage = pageHost.trim()
	for (const candidate of [fromServer, fromPage]) {
		if (candidate && !isLoopbackHost(candidate)) return candidate
	}
	if (fromServer || fromPage || server?.local) return 'local'
	return fromServer
}
