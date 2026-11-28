import assert from 'node:assert/strict'
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {
	BUILTIN_APP_OIDC,
	buildAppRedirectUris,
	buildOidcCaBundle,
	expandOidcTemplates,
	oidcComposeOverlay,
	oidcSummaryForStore,
	oidcVarsFor,
	parseManifestOidc,
	resolveAppOidcSpec,
} from '../omarchyd/app-oidc.mjs'
import {createApps} from '../omarchyd/apps.mjs'
import {createOidc} from '../omarchyd/oidc.mjs'

test('parseManifestOidc validates manifest blocks and rejects unsafe env keys or redirect paths', () => {
	const ok = parseManifestOidc({
		redirectPaths: ['/oauth/callback', 'myapp://callback'],
		requirePkce: true,
		service: 'web',
		env: {OAUTH_CLIENT_ID: '${OIDC_CLIENT_ID}', OAUTH_CLIENT_SECRET: '${OIDC_CLIENT_SECRET}'},
		note: 'Works automatically',
	})
	assert.equal(ok.mode, 'auto')
	assert.equal(ok.requirePkce, true)
	assert.equal(ok.service, 'web')
	assert.deepEqual(ok.redirectPaths, ['/oauth/callback', 'myapp://callback'])

	// Assisted mode when no env vars are declared
	const assisted = parseManifestOidc({redirectPaths: ['/cb']})
	assert.equal(assisted.mode, 'assisted')

	// Rejects dangerous env keys, email account linking, wildcard paths, javascript: scheme, protocol-relative paths
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], env: {LD_PRELOAD: '/tmp/evil.so'}}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], env: {SSL_CERT_FILE: '/tmp/bad'}}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], env: {OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING: 'true'}}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], env: {OAUTH_MERGE_ACCOUNTS_BY_EMAIL: 'true'}}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['/*']}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['//evil.com/cb']}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['javascript:alert(1)']}), null)
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], service: '../bad'}), null)
	// Manifest cannot disable PKCE
	assert.equal(parseManifestOidc({redirectPaths: ['/cb'], requirePkce: false}).requirePkce, true)
})

test('resolveAppOidcSpec resolves built-in adapters, aliases, and manifest overrides', () => {
	assert.equal(resolveAppOidcSpec('open-webui').mode, 'auto')
	assert.equal(resolveAppOidcSpec('paperless').requirePkce, true)
	assert.equal(JSON.parse(resolveAppOidcSpec('paperless').env.PAPERLESS_SOCIALACCOUNT_PROVIDERS).openid_connect.OAUTH_PKCE_ENABLED, true)
	assert.equal(resolveAppOidcSpec('immich-app').mode, 'assisted')
	assert.equal(resolveAppOidcSpec('unknown-app'), null)
	assert.deepEqual(oidcSummaryForStore('grafana')?.mode, 'auto')

	// Every built-in adapter keeps PKCE on and never links accounts by email
	for (const [id, spec] of Object.entries(BUILTIN_APP_OIDC)) {
		assert.equal(spec.requirePkce, true, `${id} must keep PKCE on`)
		assert.equal(spec.env.OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING, undefined, `${id} must not allow email account linking`)
		assert.equal(spec.env.OAUTH_MERGE_ACCOUNTS_BY_EMAIL, undefined, `${id} must not merge accounts by email`)
	}

	// Manifest override wins over built-in
	const override = resolveAppOidcSpec('immich', {redirectPaths: ['/custom/cb'], env: {IMMICH_OIDC_ID: '${OIDC_CLIENT_ID}'}})
	assert.equal(override.mode, 'auto')
	assert.deepEqual(override.redirectPaths, ['/custom/cb'])
})

test('buildAppRedirectUris, CA bundle, and oidcComposeOverlay generate safe overlays', async () => {
	const uris = buildAppRedirectUris({
		port: 3000,
		redirectPaths: ['/oauth/oidc/callback', 'app.immich:///oauth-callback'],
		issuerUrl: 'https://omarchy.example.com',
		hostname: 'omarchy-2',
		ips: ['10.0.1.8'],
		tailscaleDns: 'omarchy-2.tail8dd7d.ts.net.',
		tailscaleIps: ['100.68.115.94'],
	})
	assert.ok(uris.includes('app.immich:///oauth-callback'))
	assert.ok(uris.includes('https://omarchy.example.com:3000/oauth/oidc/callback'))
	assert.ok(uris.includes('https://omarchy-2.tail8dd7d.ts.net:3000/oauth/oidc/callback'))
	assert.ok(uris.includes('https://10.0.1.8:3000/oauth/oidc/callback'))
	assert.ok(uris.length <= 20)

	const vars = oidcVarsFor('https://omarchy.example.com', 'oidc_abc', 'omarchy_oidc_sec')
	const expanded = expandOidcTemplates({A: '${OIDC_DISCOVERY_URL}', B: '${OTHER_VAR}'}, vars)
	assert.equal(expanded.A, 'https://omarchy.example.com/.well-known/openid-configuration')
	assert.equal(expanded.B, '${OTHER_VAR}')

	const dir = await mkdtemp(join(tmpdir(), 'omarchy-app-oidc-'))
	try {
		const fakeCa = join(dir, 'ca.crt')
		const fakeSys = join(dir, 'sys.crt')
		await writeFile(fakeCa, '-----BEGIN CERTIFICATE-----\nOMARCHY\n-----END CERTIFICATE-----\n')
		await writeFile(fakeSys, '-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n')
		const {caPath, bundlePath} = await buildOidcCaBundle({caCertPath: fakeCa, outDir: dir, systemBundlePath: fakeSys})
		assert.ok(caPath && bundlePath)
		const combined = await readFile(bundlePath, 'utf8')
		assert.ok(combined.includes('SYSTEM') && combined.includes('OMARCHY'))

		const composeText = YAML.stringify({
			services: {
				db: {image: 'postgres:16'},
				web: {image: 'ghcr.io/open-webui/open-webui:main', ports: ['127.0.0.1:21234:8080']},
			},
		})
		const overlayText = oidcComposeOverlay({
			composeText,
			app: {internalPort: 21234},
			spec: resolveAppOidcSpec('open-webui'),
			oidcVars: vars,
			caPath,
			bundlePath,
			issuerUrl: 'https://omarchy.example.com',
		})
		const overlay = YAML.parse(overlayText)
		assert.ok(overlay.services.web)
		assert.equal(overlay.services.db, undefined)
		assert.equal(overlay.services.web.environment.OPENID_PROVIDER_URL, 'https://omarchy.example.com/.well-known/openid-configuration')
		assert.equal(overlay.services.web.environment.OAUTH_CLIENT_ID, 'oidc_abc')
		assert.equal(overlay.services.web.environment.OAUTH_CLIENT_SECRET, 'omarchy_oidc_sec')
		assert.equal(overlay.services.web.environment.NODE_EXTRA_CA_CERTS, '/etc/omarchy-ca.crt')
		assert.equal(overlay.services.web.environment.SSL_CERT_FILE, '/etc/omarchy-ca-bundle.pem')
		assert.deepEqual(overlay.services.web.extra_hosts, ['omarchy.example.com:host-gateway'])

		// Host-network and shared network_mode services must NOT receive extra_hosts; prototype keys ignored; $ escaped to $$
		const hostCompose = YAML.stringify({services: {app: {image: 'test', network_mode: 'service:vpn'}}})
		const hostOverlay = YAML.parse(
			oidcComposeOverlay({
				composeText: hostCompose,
				app: {port: 3000},
				spec: {
					...resolveAppOidcSpec('open-webui'),
					service: 'constructor',
					env: {LITERAL_DOLLAR: 'a$b${OTHER}', GRAFANA_URL: '${OIDC_APP_URL}'},
				},
				oidcVars: oidcVarsFor('https://omarchy.example.com', 'oidc_abc', 'omarchy_oidc_sec', 3000),
				issuerUrl: 'https://omarchy.example.com',
			}),
		)
		assert.equal(hostOverlay.services.app.extra_hosts, undefined)
		assert.equal(Object.hasOwn(hostOverlay.services, 'constructor'), false)
		assert.deepEqual(Object.keys(hostOverlay.services), ['app'])
		assert.equal(hostOverlay.services.app.environment.LITERAL_DOLLAR, 'a$$b$${OTHER}')
		assert.equal(hostOverlay.services.app.environment.GRAFANA_URL, 'https://omarchy.example.com:3000')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('App Store install, setOidc toggle, issuer resync, and uninstall manage OIDC clients & compose.oidc.yml', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'omarchy-store-oidc-'))
	const dataDir = join(dir, 'data')
	const homeDir = join(dir, 'home')
	const storeDir = join(dir, 'store')
	await mkdir(homeDir, {recursive: true})
	await mkdir(join(storeDir, 'open-webui'), {recursive: true})
	await mkdir(join(storeDir, 'custom-sso'), {recursive: true})

	await writeFile(join(storeDir, 'omarchy-app-store.yml'), YAML.stringify({id: 'test-store', name: 'Test Store'}))
	await writeFile(
		join(storeDir, 'open-webui', 'omarchy-app.yml'),
		YAML.stringify({id: 'open-webui', name: 'Open WebUI', version: '0.5.0', port: 3456, category: 'ai', tagline: 'Local AI'}),
	)
	await writeFile(
		join(storeDir, 'open-webui', 'docker-compose.yml'),
		YAML.stringify({
			services: {
				app_proxy: {environment: {APP_HOST: 'open-webui_web_1', APP_PORT: 8080}},
				web: {image: 'ghcr.io/open-webui/open-webui:main'},
			},
		}),
	)
	await writeFile(
		join(storeDir, 'custom-sso', 'omarchy-app.yml'),
		YAML.stringify({
			id: 'custom-sso',
			name: 'Custom SSO App',
			version: '1.0.0',
			port: 3457,
			category: 'utilities',
			oidc: {
				redirectPaths: ['/auth/cb'],
				requirePkce: true,
				env: {MY_OIDC_URL: '${OIDC_DISCOVERY_URL}', MY_CLIENT_ID: '${OIDC_CLIENT_ID}', MY_SECRET: '${OIDC_CLIENT_SECRET}'},
				note: 'Custom manifest SSO',
			},
		}),
	)
	await writeFile(
		join(storeDir, 'custom-sso', 'docker-compose.yml'),
		YAML.stringify({
			services: {
				app_proxy: {environment: {APP_HOST: 'custom-sso_web_1', APP_PORT: 8000}},
				web: {image: 'nginx:alpine'},
			},
		}),
	)

	const fakeSock = join(dir, 'podman.sock')
	await writeFile(fakeSock, '')
	const prevDockerHost = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${fakeSock}`

	const accounts = await openAccounts(dataDir)
	await accounts.createOwner({name: 'Nate', password: 'super-secret-password'})
	const oidc = createOidc({dataDir, accounts})
	const composeCalls = []
	const apps = createApps({
		dataDir,
		home: homeDir,
		gatewayHost: '127.0.0.1',
		firewall: {open: async () => {}, close: async () => {}},
		allowFileStores: true,
		defaultStores: [{url: `file://${storeDir}`}],
		oidc,
		getTailscaleStatus: async () => ({available: true, self: {dnsName: 'omarchy-2.tail.ts.net', ips: ['100.68.115.94']}}),
		run: async (cmd, args) => {
			if (cmd === 'git' && args[0] === 'clone') {
				const dest = args.at(-1)
				await cp(storeDir, dest, {recursive: true})
				return ''
			}
			if (cmd === 'podman' && args[0] === 'ps') return '[]'
			if (cmd === 'podman' && args[0] === 'info') return JSON.stringify({host: {ociRuntime: {name: 'crun'}}})
			if (cmd === 'docker-compose') {
				composeCalls.push(args)
				return ''
			}
			return ''
		},
	})

	try {
		await apps.ready
		// Registry exposes OIDC badge for both built-in adapter and manifest-declared app
		const reg = await apps.procedures['appStore.registry'].run()
		const list = reg[0].apps
		const ow = list.find((a) => a.id === 'open-webui')
		const cs = list.find((a) => a.id === 'custom-sso')
		assert.equal(ow.oidc?.supported, true)
		assert.equal(ow.oidc?.mode, 'auto')
		assert.equal(cs.oidc?.supported, true)
		assert.equal(cs.oidc?.note, 'Custom manifest SSO')

		// installReview includes OIDC option
		const rev = await apps.procedures['apps.installReview'].run({appId: 'open-webui'})
		assert.equal(rev.oidc?.supported, true)
		assert.equal(rev.oidc?.defaultOn, true)

		// Install with oidc: true (and loopback hint) must NOT pollute global oidc.issuerUrl or use localhost
		await apps.procedures['apps.install'].run({appId: 'open-webui', oidc: true, oidcIssuerUrl: 'http://localhost:7780'})
		let settledApp = null
		for (let i = 0; i < 400; i++) {
			const installed = await apps.procedures['apps.list'].run()
			const a = installed.find((x) => x.id === 'open-webui')
			if (a && a.state !== 'installing') {
				settledApp = a
				break
			}
			await new Promise((r) => setTimeout(r, 25))
		}
		assert.ok(settledApp && settledApp.state !== 'installing', `open-webui install did not finish: ${settledApp?.state ?? 'missing'}`)
		assert.equal(settledApp.error, undefined)

		// Global oidc.issuerUrl stays automatic (blank) and app issuer is non-loopback
		assert.equal((await oidc.procedures['oidc.status'].run()).issuerUrl, '')
		const status = await apps.procedures['apps.oidcStatus'].run({appId: 'open-webui'})
		assert.equal(status.supported, true)
		assert.equal(status.enabled, true)
		assert.ok(status.issuerUrl && !status.issuerUrl.includes('localhost') && !status.issuerUrl.includes('127.0.0.1'))
		assert.ok(status.clientId.startsWith('oidc_'))
		assert.equal(status.clientSecret, null, 'oidcStatus must not return plaintext secret from oidc.json')
		assert.ok(status.redirectUris.includes('https://omarchy-2.tail.ts.net:3456/oauth/oidc/callback'))

		const overlayPath = join(dataDir, 'apps', 'installed', 'open-webui', 'compose.oidc.yml')
		const overlay = YAML.parse(await readFile(overlayPath, 'utf8'))
		const composeSecret = overlay.services.web.environment.OAUTH_CLIENT_SECRET
		assert.equal(overlay.services.web.environment.OAUTH_CLIENT_ID, status.clientId)
		assert.ok(composeSecret.startsWith('omarchy_oidc_'))
		assert.ok(composeCalls.some((a) => a.includes('up') && a.includes(overlayPath)))

		// Raw secret lives ONLY in compose.oidc.yml, NEVER in apps.json or oidc.json!
		const appsJsonText = await readFile(join(dataDir, 'apps', 'apps.json'), 'utf8')
		assert.equal(appsJsonText.includes(composeSecret), false)
		assert.equal(appsJsonText.includes('_oidcVars'), false)
		const oidcJsonText = await readFile(join(dataDir, 'oidc.json'), 'utf8')
		assert.equal(oidcJsonText.includes(composeSecret), false, 'oidc.json must NEVER store plaintext client secrets')
		assert.equal(oidcJsonText.includes('managedSecret'), false, 'oidc.json must NEVER store managedSecret')

		const oidcClients = await oidc.procedures['oidc.clients'].run()
		assert.equal(oidcClients.length, 1)
		assert.equal(oidcClients[0].managedAppId, 'open-webui')
		assert.equal('managedSecret' in oidcClients[0], false)

		// Settings RPCs refuse edit/rotate/delete on App Store managed clients
		await assert.rejects(oidc.procedures['oidc.updateClient'].run({id: status.clientId, name: 'Hacked'}), /managed by the App Store/)
		await assert.rejects(oidc.procedures['oidc.rotateSecret'].run({id: status.clientId}), /managed by the App Store/)
		await assert.rejects(oidc.procedures['oidc.deleteClient'].run({id: status.clientId}), /managed by the App Store/)

		// Issuer URL change resyncs redirect URIs & compose.oidc.yml while preserving existing secret (no unwanted rotation)
		await oidc.procedures['oidc.setConfig'].run({issuerUrl: 'https://sso2.example.com'})
		await apps.resyncOidcClients()
		const afterSync = await apps.procedures['apps.oidcStatus'].run({appId: 'open-webui'})
		assert.equal(afterSync.issuerUrl, 'https://sso2.example.com')
		assert.ok(afterSync.redirectUris.includes('https://sso2.example.com:3456/oauth/oidc/callback'))
		const overlayAfterSync = YAML.parse(await readFile(overlayPath, 'utf8'))
		assert.equal(overlayAfterSync.services.web.environment.OAUTH_CLIENT_SECRET, composeSecret, 'resync preserves valid compose secret without storing it in oidc.json')

		// Clearing global issuerUrl back to automatic stays blank even after resync
		await oidc.procedures['oidc.setConfig'].run({issuerUrl: ''})
		await apps.resyncOidcClients()
		assert.equal((await oidc.procedures['oidc.status'].run()).issuerUrl, '')

		// Disable OIDC removes client & overlay; re-enable creates fresh client
		const disabled = await apps.procedures['apps.setOidc'].run({appId: 'open-webui', enabled: false})
		assert.equal(disabled.enabled, false)
		assert.equal((await oidc.procedures['oidc.clients'].run()).length, 0)
		await assert.rejects(readFile(overlayPath, 'utf8'))

		const reenabled = await apps.procedures['apps.setOidc'].run({appId: 'open-webui', enabled: true})
		assert.equal(reenabled.enabled, true)
		assert.equal((await oidc.procedures['oidc.clients'].run()).length, 1)

		// Uninstall cleans up the managed OIDC client
		await apps.procedures['apps.uninstall'].run({appId: 'open-webui'})
		assert.equal((await oidc.procedures['oidc.clients'].run()).length, 0)
	} finally {
		if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDockerHost
		await apps.close?.()
		await rm(dir, {recursive: true, force: true, maxRetries: 3})
	}
})
