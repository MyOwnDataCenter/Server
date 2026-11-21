// Offline shell only. API calls are never cached: they always go to your server.
const CACHE = 'omarchy-server-v2'

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

// Web Push notifications (RFC 8291/8292 from omarchyd/alerts.mjs).
self.addEventListener('push', (e) => {
	let data = {title: 'Omarchy Server', body: 'A server alert needs attention.', tag: 'omarchy-alert', url: '/'}
	try {
		const parsed = e.data?.json()
		if (parsed && typeof parsed === 'object') data = {...data, ...parsed}
	} catch {
		const text = e.data?.text?.()
		if (text) data.body = text
	}
	e.waitUntil(
		self.registration.showNotification(String(data.title || 'Omarchy Server'), {
			body: String(data.body || ''),
			tag: String(data.tag || 'omarchy-alert'),
			icon: '/icon-192.png',
			badge: '/favicon-64.png',
			data: {url: String(data.url || '/')},
		}),
	)
})

self.addEventListener('notificationclick', (e) => {
	e.notification.close()
	const target = e.notification.data?.url || '/'
	e.waitUntil(
		self.clients.matchAll({type: 'window', includeUncontrolled: true}).then((list) => {
			for (const client of list) {
				if ('focus' in client) return client.focus()
			}
			return self.clients.openWindow(target)
		}),
	)
})
