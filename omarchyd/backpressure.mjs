// Keep a viewer's stream flowing at the speed the browser reads it.
//
// A remote screen sends big bursts as a matter of course: the whole picture after signing in, a
// window opening full screen, a full refresh. Over Wi-Fi or a phone network that burst can sit in
// the send buffer for a moment. Cutting the viewer off when the buffer passes a size made the screen
// reconnect, get the whole picture again, and be cut off again (connecting and disconnecting in a
// loop right after signing in to a virtual machine). Instead the source is paused while the browser
// catches up (VNC is built for that: the server just sends fewer updates), and only a viewer that
// reads nothing for a long time is let go, so a frozen tab still can't make the server hold every
// frame in memory.

const OPEN = 1

export const VIEWER_HIGH_WATER = 2 * 1024 * 1024
export const VIEWER_LOW_WATER = 512 * 1024
export const VIEWER_STALL_MS = 30_000

/**
 * @param {{bufferedAmount: number, readyState: number}} dest the browser's WebSocket
 * @param {{pause: () => void, resume: () => void}} source what feeds it (a socket or a WebSocket)
 * @param {() => void} onStall called once if the browser reads nothing for `stallMs`
 */
export function viewerBackpressure(dest, source, onStall, {high = VIEWER_HIGH_WATER, low = VIEWER_LOW_WATER, stallMs = VIEWER_STALL_MS, every = 50, now = Date.now} = {}) {
	let timer = null
	let since = 0
	let lastBuffered = 0
	const stop = () => {
		if (timer) clearInterval(timer)
		timer = null
	}
	const check = () => {
		if (timer || dest.bufferedAmount <= high) return
		try {
			source.pause()
		} catch {
			return
		}
		since = now()
		lastBuffered = dest.bufferedAmount
		timer = setInterval(() => {
			if (dest.readyState !== OPEN) return stop()
			const buffered = dest.bufferedAmount
			if (buffered <= low) {
				stop()
				try {
					source.resume()
				} catch {
					/* closed meanwhile */
				}
				return
			}
			// Still reading, only slowly: that's progress, not a stall.
			if (buffered < lastBuffered) {
				lastBuffered = buffered
				since = now()
				return
			}
			if (now() - since > stallMs) {
				stop()
				onStall()
			}
		}, every)
		timer.unref?.()
	}
	return {check, stop, get paused() {
		return timer !== null
	}}
}
