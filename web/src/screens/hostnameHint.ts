// The address a device name will answer at: the same scheme and port as the page that is open now (the web app is
// on port 7780 by default, not 80), so the hint is an address that works.
export function hostnameAddress(name: string, page: {protocol: string; port: string} = location): string {
	return `${page.protocol}//${name}.local${page.port ? `:${page.port}` : ''}`
}
