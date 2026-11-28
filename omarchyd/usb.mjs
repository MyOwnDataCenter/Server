// Host USB enumerator and passthrough RPCs for omarchyd.
import {readdir as fsReaddir, readFile as fsReadFile, realpath as fsRealpath} from 'node:fs/promises'
import {join} from 'node:path'
import YAML from 'yaml'

import {RpcError} from './rpc.mjs'

const USB_DEV = /^[0-9]+-[0-9.]+$/
// usb_id builds ID_SERIAL from manufacturer and product: whitespace runs become
// one '_', then anything outside udev's devnode allow-list becomes '_'. Each
// field is copied into a 63-byte buffer (vendor_str / model_str).
const UDEV_DEVNODE = /[A-Za-z0-9#+.:=\@_-]/

function udevEncode(value) {
	const src = String(value ?? '')
	const len = Math.min(src.length, 63)
	let i = 0
	while (i < len && /\s/.test(src[i])) i++
	let collapsed = ''
	let spaced = false
	for (; i < len && collapsed.length < 63; i++) {
		if (/\s/.test(src[i])) {
			spaced = true
			continue
		}
		if (spaced) {
			if (collapsed.length + 1 >= 63) break
			collapsed += '_'
			spaced = false
		}
		collapsed += src[i]
	}
	let out = ''
	for (const ch of collapsed) {
		if (ch.codePointAt(0) > 0x7f || UDEV_DEVNODE.test(ch)) out += ch
		else out += '_'
	}
	return out
}

const hex = (s, n) => {
	const t = String(s ?? '').trim().toLowerCase()
	return t ? t.padStart(n, '0').slice(-n) : ''
}

async function isExcluded(sysfs, name, read, readdir) {
	const dir = join(sysfs, name)
	const deviceClass = hex(await read(join(dir, 'bDeviceClass')), 2)
	if (deviceClass === '09' || deviceClass === '08') return true
	const names = await readdir(sysfs).catch(() => [])
	const kids = await readdir(dir).catch(() => [])
	const ifaceDirs = [
		...names.filter((n) => n.startsWith(`${name}:`)).map((n) => join(sysfs, n)),
		...kids.filter((k) => k.includes(':')).map((k) => join(dir, k)),
	]
	for (const iface of ifaceDirs) {
		const cls = hex(await read(join(iface, 'bInterfaceClass')), 2)
		if (cls === '08' || cls === '09') return true
		const sub = hex(await read(join(iface, 'bInterfaceSubClass')), 2)
		const proto = hex(await read(join(iface, 'bInterfaceProtocol')), 2)
		if (cls === '03' && sub === '01' && (proto === '01' || proto === '02')) return true
	}
	return false
}

export async function listHostUsb({
	readdir = fsReaddir,
	readFile = fsReadFile,
	realpath = fsRealpath,
	sysfs = '/sys/bus/usb/devices',
	serialById = '/dev/serial/by-id',
} = {}) {
	const read = (p) => readFile(p, 'utf8').catch(() => '')
	const names = await readdir(sysfs).catch(() => [])
	const devices = []
	for (const name of names) {
		if (!USB_DEV.test(name)) continue
		if (await isExcluded(sysfs, name, read, readdir)) continue
		const dir = join(sysfs, name)
		const vendorId = hex(await read(join(dir, 'idVendor')), 4)
		const productId = hex(await read(join(dir, 'idProduct')), 4)
		if (!vendorId || !productId) continue
		const serial = (await read(join(dir, 'serial'))).trim() || null
		const manufacturer = (await read(join(dir, 'manufacturer'))).trim()
		const product = (await read(join(dir, 'product'))).trim()
		devices.push({
			vendorId,
			productId,
			serial,
			manufacturer,
			product,
			name: product || [manufacturer, product].filter(Boolean).join(' ') || `${vendorId}:${productId}`,
			path: null,
			node: null,
			id: null,
		})
	}
	const links = await readdir(serialById).catch(() => [])
	for (const link of links) {
		if (!link.startsWith('usb-')) continue
		const target = await realpath(join(serialById, link)).catch(() => null)
		const stem = link.replace(/-if\d+.*$/, '')
		const bySerial = devices.filter((d) => d.serial && (stem.endsWith(`_${d.serial}`) || stem.endsWith(`-${d.serial}`)))
		// A single serial match keeps the old pairing. Several devices can report the same
		// placeholder serial; the link's usb-<maker>_<product>_ prefix names the real one.
		const named =
			bySerial.length > 1
				? bySerial.filter((d) => {
						const vendor = udevEncode(d.manufacturer)
						const model = udevEncode(d.product)
						return vendor && model && link.startsWith(`usb-${vendor}_${model}_`)
					})
				: []
		const pool = named.length ? named : bySerial
		const match =
			pool.reduce((best, d) => (best && best.serial.length >= d.serial.length ? best : d), null) ||
			devices.find((d) => link.toLowerCase().includes(`${d.vendorId}_${d.productId}`))
		if (!match) continue
		match.path = `/dev/serial/by-id/${link}`
		match.node = target
		match.id = link
	}
	return devices.map(({manufacturer: _manufacturer, product: _product, ...d}) => ({
		...d,
		id: d.id || (d.serial ? `${d.vendorId}-${d.productId}-${d.serial}` : `${d.vendorId}-${d.productId}`),
	}))
}

const USB_SERIAL = /^[A-Za-z0-9._:-]{1,128}$/
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])

// libvirt matches the serial text exactly, so any plain printable serial is written as it is (a space or
// a + is common). Only text that XML would have to escape is left out.
const hostdevSerial = (serial) => typeof serial === 'string' && /^[\x21-\x7e]([\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(serial) && !/[<>&'"]/.test(serial)

export function hostdevXml({vendorId, productId, serial}) {
	const ser = hostdevSerial(serial) ? `<serial>${xml(serial)}</serial>` : ''
	return `<hostdev mode='subsystem' type='usb' managed='yes'><source startupPolicy='optional'><vendor id='0x${vendorId}'/><product id='0x${productId}'/>${ser}</source></hostdev>`
}

export function parseUsbLive(xmlText, devices = []) {
	const entries = []
	for (const match of String(xmlText ?? '').matchAll(/<hostdev\b([^>]*)>([\s\S]*?)<\/hostdev>/gi)) {
		if (!/\btype\s*=\s*['"]usb['"]/i.test(match[1])) continue
		const body = match[2]
		const vendor = /<vendor\b[^>]*\bid\s*=\s*['"]0x([0-9a-fA-F]+)['"]/i.exec(body)?.[1]?.toLowerCase()
		const product = /<product\b[^>]*\bid\s*=\s*['"]0x([0-9a-fA-F]+)['"]/i.exec(body)?.[1]?.toLowerCase()
		const serial = /<serial>([^<]*)<\/serial>/i.exec(body)?.[1]?.trim() || null
		if (vendor && product) entries.push({vendor, product, serial})
	}
	const live = []
	for (const d of devices) {
		const vendor = String(d.vendorId ?? '').toLowerCase()
		const product = String(d.productId ?? '').toLowerCase()
		const serial = d.serial ? String(d.serial).trim() : ''
		if (entries.some((e) => e.vendor === vendor && e.product === product && (!serial || e.serial === serial))) live.push(d.id)
	}
	return live
}

const SERIAL_PATH = /^\/dev\/(serial\/by-id\/usb-[A-Za-z0-9._+-]+|ttyUSB[0-9]+|ttyACM[0-9]+)$/
const TTY_NODE = /^\/dev\/tty(?:USB|ACM)[0-9]+$/
// udev by-id names may contain ":" "=" "@" "#". Those must not be written as HOST:CONTAINER.
// The name stays one path segment, so a bind cannot climb out of by-id.
const BY_ID_PATH = /^\/dev\/serial\/by-id\/usb-[A-Za-z0-9._+:@=#-]+$/

function usbDeviceBind(device) {
	const path = typeof device?.path === 'string' ? device.path : ''
	const node = typeof device?.node === 'string' ? device.node : ''
	if (SERIAL_PATH.test(path)) return `${path}:${path}`
	if (!BY_ID_PATH.test(path)) return null
	if (TTY_NODE.test(node)) return `${node}:${node}`
	return {source: path, target: path, permissions: 'rwm'}
}

export function usbComposeOverlay(serviceNames, devices) {
	const binds = []
	for (const device of devices ?? []) {
		const bind = usbDeviceBind(device)
		if (bind) binds.push(bind)
	}
	if (!binds.length) return ''
	const services = Object.fromEntries(serviceNames.map((name) => [name, {devices: binds}]))
	return YAML.stringify({services})
}

function boundOf(g) {
	return {kind: g.kind, id: g.id, name: g.name}
}

function decorate(h, g) {
	return {
		...h,
		bound: g ? boundOf(g) : null,
		needsRestart: !!(g?.running && !(g.liveIds ?? []).includes(h.id)),
	}
}

export function createUsb({enumerate = listHostUsb, guests = {bindings: () => []}, helper = async () => 'ok'} = {}) {
	const liveAttach = guests.liveAttach ?? (async () => false)
	const liveDetach = guests.liveDetach ?? (async () => false)
	async function list() {
		const host = await enumerate()
		const bindings = await guests.bindings()
		const byDevice = new Map()
		for (const g of bindings) for (const d of g.devices ?? []) byDevice.set(d.id, g)
		const seen = new Set()
		const devices = []
		for (const h of host) {
			seen.add(h.id)
			devices.push(decorate({...h, present: true}, byDevice.get(h.id)))
		}
		for (const g of bindings) {
			for (const d of g.devices ?? []) {
				if (seen.has(d.id)) continue
				seen.add(d.id)
				devices.push(decorate({id: d.id, name: d.name ?? d.id, vendorId: d.vendorId ?? '', productId: d.productId ?? '', serial: d.serial ?? null, path: null, node: null, present: false}, g))
			}
		}
		return {devices}
	}
	async function attach(input) {
		const deviceId = String(input?.deviceId ?? '')
		if (!deviceId) throw new RpcError('BAD_REQUEST', 'Choose a USB device')
		const kind = input?.guest?.kind
		const id = String(input?.guest?.id ?? '')
		if ((kind !== 'machine' && kind !== 'app') || !id) throw new RpcError('BAD_REQUEST', 'Choose a machine or an app')
		const rec = (await enumerate()).find((d) => d.id === deviceId)
		if (!rec) throw new RpcError('PRECONDITION_FAILED', 'Plug that stick in, then try again')
		const bindings = await guests.bindings()
		const current = bindings.find((g) => (g.devices ?? []).some((d) => d.id === deviceId))
		if (current && current.kind === kind && current.id === id) return {needsRestart: false}
		if (current) throw new RpcError('CONFLICT', `That stick is already used by ${current.name}`)
		const guest = {kind, id}
		await guests.bind(guest, {id: rec.id, vendorId: rec.vendorId, productId: rec.productId, serial: rec.serial, path: rec.path, name: rec.name})
		const after = (await guests.bindings()).find((g) => g.kind === kind && g.id === id)
		const running = !!after?.running
		const liveResult = running ? await liveAttach(guest, rec) : true
		const live = liveResult === true
		if (rec.serial && USB_SERIAL.test(rec.serial)) await helper('usb-allow', [rec.serial]).catch(() => {})
		const needsRestart = running && !live
		const qemu = typeof liveResult === 'string' ? liveResult : ''
		return {needsRestart, ...(needsRestart ? {message: `Restart ${after.name} to use this stick.${qemu ? ` ${qemu}` : ''}`} : {})}
	}
	async function detach(input) {
		const deviceId = String(input?.deviceId ?? '')
		if (!deviceId) throw new RpcError('BAD_REQUEST', 'Choose a USB device')
		const bindings = await guests.bindings()
		const current = bindings.find((g) => (g.devices ?? []).some((d) => d.id === deviceId))
		if (!current) return {needsRestart: false}
		const rec = current.devices.find((d) => d.id === deviceId)
		const guest = {kind: current.kind, id: current.id}
		const running = !!current.running
		const live = running ? await liveDetach(guest, rec) : false
		await guests.unbind(guest, deviceId)
		const leftover = (await guests.bindings()).some((g) => (g.devices ?? []).some((d) => d.serial && d.serial === rec.serial))
		if (rec.serial && USB_SERIAL.test(rec.serial) && !leftover) await helper('usb-forget', [rec.serial]).catch(() => {})
		const needsRestart = running && !live
		return {needsRestart, ...(needsRestart ? {message: `Restart ${current.name} to apply`} : {})}
	}
	// An app or a machine was removed with sticks attached: take their udev rules out too, unless
	// another guest still holds a stick with the same serial.
	async function release(devices) {
		const held = new Set((await guests.bindings()).flatMap((g) => (g.devices ?? []).map((d) => d.serial).filter(Boolean)))
		for (const serial of new Set((devices ?? []).map((d) => d?.serial))) {
			if (serial && USB_SERIAL.test(serial) && !held.has(serial)) await helper('usb-forget', [serial]).catch(() => {})
		}
	}
	return {
		release,
		procedures: {
			'usb.list': {kind: 'query', run: list},
			'usb.attach': {kind: 'mutation', run: attach},
			'usb.detach': {kind: 'mutation', run: detach},
		},
	}
}
