import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {App} from './App'
import {ApiError} from './api'
import {Providers, applyPrefs, readPrefs, watchKeyboardViewport} from './ui'
import './styles.css'
import './theme-chronara-studio.css'

applyPrefs(readPrefs())
watchKeyboardViewport()

const noRetry = (error: unknown) =>
	error instanceof ApiError &&
	((error.status >= 400 && error.status < 500) || error.code === 'TIMEOUT' || error.code === 'OFFLINE' || error.code === 'ABORTED')

const client = new QueryClient({
	defaultOptions: {
		queries: {
			// Don't hammer omarchyd with retries for auth/permission errors or requests that already timed out or are offline.
			retry: (count, error) => !noRetry(error) && count < 2,
			refetchOnWindowFocus: true,
			staleTime: 2000,
		},
		mutations: {
			// Let actions fail immediately instead of queueing silently while the browser is offline.
			networkMode: 'always',
		},
	},
})

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={client}>
			<Providers>
				<App />
			</Providers>
		</QueryClientProvider>
	</StrictMode>,
)

// A home-screen app on iPhone can stay alive for days and keep running an old build after Touch updates.
// When the page comes back to the foreground, ask the server which version it runs and reload if it's newer.
async function reloadIfUpdated() {
	try {
		const r = await fetch('/api/bootstrap', {credentials: 'same-origin', cache: 'no-store'})
		const v = (await r.json())?.touch?.version
		if (!v || v === __TOUCH_BUILD__) return
		const key = `touch.reloadedFor.${v}`
		if (sessionStorage.getItem(key)) return
		sessionStorage.setItem(key, '1')
		location.reload()
	} catch {}
}
// Screens load when first opened. If the server was updated while this page stayed open, the old
// build's files are gone: reload once to pick up the new build instead of showing a blank page.
window.addEventListener('vite:preloadError', (e) => {
	const key = 'touch.reloadedForStaleChunk'
	const last = Number(sessionStorage.getItem(key) ?? 0)
	if (Date.now() - last < 30_000) return // just reloaded for this: let the error show, don't loop
	e.preventDefault()
	sessionStorage.setItem(key, String(Date.now()))
	location.reload()
})
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void reloadIfUpdated())
window.addEventListener('pageshow', (e) => e.persisted && void reloadIfUpdated())
void reloadIfUpdated()

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
	window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
