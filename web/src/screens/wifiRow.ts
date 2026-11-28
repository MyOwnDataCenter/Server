// What the Wi-Fi row on the server's page shows as its value. `Off` was wrong: the server cannot tell an idle
// interface from a switched-off one, and it said "Off" on every visit until the first answer arrived.
export function wifiRowValue(wifi: {status: 'connected' | 'disconnected'; ssid?: string} | undefined): string {
	if (!wifi) return ''
	return wifi.status === 'connected' ? (wifi.ssid ?? '') : 'Not connected'
}
