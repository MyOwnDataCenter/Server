// Offline shell only. API calls are never cached: they always go to your server.
const CACHE = 'omarchy-server-v3'

// A failed navigation must not replace the offline shell. A cache-first /assets/ URL must not
// keep index.html (text/html) under a script or stylesheet name.
function shouldCache(url, response) {
	if (!response || response.ok !== true) return false
	const path = new URL(String(url), 'http://localhost').pathname
	if (!path.startsWith('/assets/')) return true
	const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
	return type !== '' && type !== 'text/html'
}

// Hashed /assets/ files stay in this cache across deploys. Keep only the ones the new index.html names.
function shouldKeepCachedUrl(url, indexHtml) {
	let path = ''
	try {
		path = new URL(String(url), 'http://localhost').pathname
	} catch {
		return false
	}
	if (!path.startsWith('/assets/')) return true
	const refs = new Set()
	for (const match of String(indexHtml ?? '').matchAll(/\/assets\/[^"'<>\s?#)]+/g)) refs.add(match[0])
	return refs.has(path)
}

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.ico', '/favicon-32.png', '/icon-192.png'])).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
	e.waitUntil(
		(async () => {
			const names = await caches.keys()
			await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
			const cache = await caches.open(CACHE)
			const index = await cache.match('/')
			const html = index ? await index.text() : ''
			const keys = await cache.keys()
			await Promise.all(keys.filter((req) => !shouldKeepCachedUrl(req.url, html)).map((req) => cache.delete(req)))
			await self.clients.claim()
		})(),
	)
})
self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url)
	if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
	if (url.pathname.startsWith('/assets/')) {
		e.respondWith(
			caches.match(e.request).then(
				(hit) =>
					hit ||
					fetch(e.request).then((res) => {
						if (shouldCache(e.request.url, res)) {
							const copy = res.clone()
							caches.open(CACHE).then((c) => c.put(e.request, copy))
						}
						return res
					}),
			),
		)
		return
	}
	// Quick-transfer portals (/t/…) are never cached or answered from the app's cache.
	if (new URL(e.request.url).pathname.startsWith('/t/')) return
	if (e.request.mode === 'navigate') {
		e.respondWith(
			fetch(e.request)
				.then((res) => {
					if (shouldCache(e.request.url, res)) {
						const copy = res.clone()
						caches.open(CACHE).then((c) => c.put('/', copy))
					}
					return res
				})
				.catch(() => caches.match('/')),
		)
	}
})
