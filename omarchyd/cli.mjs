#!/usr/bin/env node
// omarchyd serve [--port 2021] [--web-port 7780] [--data DIR]  run the backend (localhost only)
// omarchyd create-owner [--name NAME] [--data DIR]             create the owner account; asks for the password here
// omarchyd has-owner [--data DIR]                             exit 0 if the owner account exists
// omarchyd reset-password [--name NAME] [--data DIR]           set a forgotten password; asks for it here. omarchyd must be stopped
import {connect} from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {fileURLToPath} from 'node:url'

import {openAccounts} from './accounts.mjs'
import {formatDataDirError, parsePort} from './cli-args.mjs'
import {takeLine} from './prompt.mjs'
import {startOmarchyd} from './server.mjs'
import {defaultTlsDir} from './tls.mjs'

const CLI_PATH = fileURLToPath(import.meta.url)
// Same rule as createOwner in accounts.mjs. Checked here so a bad login name fails before the password.
const NAME_OK = /^[\p{L}\p{N} ._-]{1,40}$/u
const cleanedAccountName = (raw) => {
	const cleaned = [...String(raw ?? '')].filter((ch) => /^[\p{L}\p{N} ._-]$/u.test(ch)).join('').slice(0, 40)
	return NAME_OK.test(cleaned) ? cleaned : ''
}
const nameRejected = (name) => `“${name}” can’t be an account name. Use 1-40 letters, numbers, spaces, dots, dashes or underscores, or pass --name.`

const USAGE = `omarchyd: the My Own Data Center backend

  omarchyd serve [--port 2021] [--web-port 7780] [--data <dir>]
  omarchyd create-owner [--name <name>] [--data <dir>]
  omarchyd has-owner [--data <dir>]
  omarchyd reset-password [--name <name>] [--data <dir>] [--port 2021]
  omarchyd -h | --help | help`

let values
let positionals
try {
	const parsed = parseArgs({
		strict: true,
		allowPositionals: true,
		options: {
			port: {type: 'string'},
			'web-port': {type: 'string'},
			data: {type: 'string'},
			name: {type: 'string'},
			help: {type: 'boolean', short: 'h'},
		},
	})
	values = parsed.values
	positionals = parsed.positionals
} catch (error) {
	console.error(`omarchyd: ${error.message}`)
	console.error('Run with --help for usage.')
	process.exit(2)
}

const command = positionals[0] ?? 'serve'
if (values.help || command === 'help') {
	console.log(USAGE)
	process.exit(0)
}
if (positionals.length > 1) {
	console.error(`omarchyd: unexpected argument “${positionals[1]}”`)
	process.exit(2)
}
if (!['serve', 'has-owner', 'create-owner', 'reset-password'].includes(command)) {
	console.error(`Unknown command “${command}”. Use: serve | create-owner | has-owner | reset-password`)
	process.exit(2)
}
const dataDir = values.data !== undefined ? values.data : join(process.env.XDG_DATA_HOME || join(os.homedir(), '.local/share'), 'omarchy-server')
if (!String(dataDir).trim()) {
	console.error('omarchyd: --data cannot be empty')
	process.exit(command === 'has-owner' ? 2 : 1)
}

// Read a password from the terminal without echoing it.
// Typed input that came after an Enter, kept for the next question (a paste of both passwords).
let pending = ''
function askHidden(prompt) {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin
		if (!stdin.isTTY) return reject(new Error('Run this in a terminal so the password can be typed privately'))
		process.stdout.write(prompt)
		stdin.setRawMode(true)
		stdin.setEncoding('utf8')
		let value = ''
		const finish = (r) => {
			stdin.setRawMode(false)
			stdin.pause()
			stdin.off('data', onData)
			process.stdout.write('\n')
			if (r.interrupted) process.exit(130)
			pending = r.rest
			resolve(r.value)
		}
		const onData = (chunk) => {
			const r = takeLine(value, chunk)
			if (r.interrupted || r.done) return finish(r)
			value = r.value
		}
		const first = takeLine('', pending)
		pending = ''
		if (first.done || first.interrupted) {
			stdin.on('data', onData)
			return finish(first)
		}
		value = first.value
		stdin.on('data', onData)
		stdin.resume()
	})
}

if (command === 'serve') {
	if (process.getuid?.() === 0 && process.env.OMARCHYD_ALLOW_ROOT !== '1') {
		console.error('omarchyd runs as your own user, not root. Start it without sudo.')
		process.exit(1)
	}
	let port
	let webPort
	try {
		port = parsePort(values.port, undefined, {flag: '--port', fallback: 2021})
		webPort = parsePort(values['web-port'], undefined, {flag: '--web-port', fallback: 7780})
	} catch (error) {
		console.error(`omarchyd: ${error.message}`)
		process.exit(1)
	}
	// The same certificate folder as the web server (server/cli.mjs), so both use one certificate.
	let server
	try {
		server = await startOmarchyd({port, webPort, dataDir, tlsDir: defaultTlsDir()})
	} catch (error) {
		console.error(`omarchyd: ${formatDataDirError(dataDir, error)}`)
		process.exit(1)
	}
	console.log(`omarchyd listening on ${server.url} (data in ${dataDir})`)
	if (!server.accounts.hasOwner()) console.log(`No owner yet. Create one with: node ${CLI_PATH} create-owner --data ${dataDir}`)
} else if (command === 'has-owner') {
	// Exit 0 if an owner account exists (used by the installer).
	let accounts
	try {
		accounts = await openAccounts(dataDir, {create: false})
	} catch (error) {
		console.error(`omarchyd: ${formatDataDirError(dataDir, error)}`)
		process.exit(2)
	}
	console.log(accounts.hasOwner() ? 'yes' : 'no')
	process.exit(accounts.hasOwner() ? 0 : 1)
} else if (command === 'create-owner') {
	let existing
	try {
		existing = await openAccounts(dataDir, {create: false})
	} catch (error) {
		console.error(`omarchyd: ${formatDataDirError(dataDir, error)}`)
		process.exit(1)
	}
	if (existing.hasOwner()) {
		console.error('An owner account already exists.')
		process.exit(1)
	}
	if (values.name !== undefined && !NAME_OK.test(values.name)) {
		console.error(nameRejected(values.name))
		process.exit(1)
	}
	if (!process.stdin.isTTY) {
		console.error('Run this in a terminal so the password can be typed privately')
		process.exit(1)
	}
	let accounts
	try {
		accounts = await openAccounts(dataDir)
	} catch (error) {
		console.error(`omarchyd: ${formatDataDirError(dataDir, error)}`)
		process.exit(1)
	}
	let name = values.name ?? os.userInfo().username
	if (!NAME_OK.test(name)) {
		console.error(nameRejected(name))
		const cleaned = cleanedAccountName(name)
		if (cleaned) {
			console.error(`Using “${cleaned}” instead.`)
			name = cleaned
		} else {
			process.stdout.write('Account name: ')
			const entered = (await new Promise((resolve) => {
				const stdin = process.stdin
				stdin.setEncoding('utf8')
				let buf = ''
				const onData = (chunk) => {
					buf += chunk
					const at = buf.search(/\r|\n/)
					if (at < 0) return
					stdin.pause()
					stdin.off('data', onData)
					resolve(buf.slice(0, at).trim())
				}
				stdin.on('data', onData)
				stdin.resume()
			}))
			if (!NAME_OK.test(entered)) {
				console.error('Use 1-40 letters, numbers, spaces, dots, dashes or underscores for the name. Pass --name to set it.')
				process.exit(1)
			}
			name = entered
		}
	}
	try {
		const password = await askHidden(`Password for ${name}: `)
		const again = await askHidden('Again: ')
		if (password !== again) {
			console.error('The passwords don’t match.')
			process.exit(1)
		}
		await accounts.createOwner({name, password})
		console.log(`Created the owner account “${name}”. Sign in with that name and password.`)
	} catch (e) {
		console.error(e.message)
		process.exit(1)
	}
} else if (command === 'reset-password') {
	// The running omarchyd keeps the accounts in memory and would write the old password back.
	let port
	try {
		port = parsePort(values.port, undefined, {flag: '--port', fallback: 2021})
	} catch (error) {
		console.error(`omarchyd: ${error.message}`)
		process.exit(1)
	}
	const listening = await new Promise((resolve) => {
		const socket = connect({host: '127.0.0.1', port})
		const done = (up) => (socket.destroy(), resolve(up))
		socket.once('connect', () => done(true))
		socket.once('error', () => done(false))
		socket.setTimeout(1000, () => done(false))
	})
	if (listening) {
		console.error('omarchyd is running. Use “omarchy-server reset-password”, which stops it first, or run “systemctl --user stop omarchyd” and try again.')
		process.exit(1)
	}
	if (values.name !== undefined && !NAME_OK.test(values.name)) {
		console.error(nameRejected(values.name))
		process.exit(1)
	}
	let accounts
	try {
		accounts = await openAccounts(dataDir, {create: false})
	} catch (error) {
		console.error(`omarchyd: ${formatDataDirError(dataDir, error)}`)
		process.exit(1)
	}
	if (!accounts.hasOwner()) {
		console.error(`There is no owner account yet. Create one with: node ${CLI_PATH} create-owner --data ${dataDir}`)
		process.exit(1)
	}
	if (!process.stdin.isTTY) {
		console.error('Run this in a terminal so the password can be typed privately')
		process.exit(1)
	}
	try {
		const who = values.name ?? accounts.listAccounts().find((a) => a.role === 'owner')?.name ?? 'the owner'
		const password = await askHidden(`Password for ${who}: `)
		const again = await askHidden('Again: ')
		if (password !== again) {
			console.error('The passwords don’t match.')
			process.exit(1)
		}
		const {name, twoFactor} = await accounts.resetPassword({name: values.name, newPassword: password})
		console.log(`The password for “${name}” is set, and every session is signed out. Sign in with “${name}” and the new password.`)
		if (twoFactor) console.log('Two-factor sign-in is still on: you will also need the code from your authenticator app.')
	} catch (e) {
		console.error(e.message)
		process.exit(1)
	}
}
