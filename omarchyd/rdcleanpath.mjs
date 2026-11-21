// Zero-dependency ASN.1 DER RDCleanPath v3390 WebSocket-to-RDP proxy.
// Wire format matches upstream ironrdp-rdcleanpath (version 3390, EXPLICIT context tags):
//   [0] version             INTEGER (3390)
//   [1] error               RDCleanPathErr SEQUENCE (response only)
//   [2] destination         UTF8String (request)
//   [3] proxyAuth           UTF8String (request)
//   [4] serverAuth          UTF8String (optional, reserved)
//   [5] preconnectionBlob   UTF8String (request)
//   [6] x224ConnectionPdu   OCTET STRING (request & response)
//   [7] serverCertChain     SEQUENCE OF OCTET STRING (response)
//   [9] serverAddr          UTF8String (response)
import net from 'node:net'
import tls from 'node:tls'

export const RDCLEANPATH_VERSION_BASE = 3389
export const RDCLEANPATH_VERSION_1 = 3390
const MAX_DER_LEN = 16 * 1024 * 1024
const WS_HIGH_WATER = 2 * 1024 * 1024

// ---- Minimal ASN.1 DER encoder ---------------------------------------------------------
function derLength(len) {
	if (len < 0x80) return Buffer.from([len])
	const bytes = []
	let n = len
	while (n > 0) {
		bytes.unshift(n & 0xff)
		n = Math.floor(n / 256)
	}
	return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTag(tag, content) {
	return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derInteger(n) {
	if (n === 0) return derTag(0x02, Buffer.from([0]))
	const bytes = []
	let v = n
	while (v > 0) {
		bytes.unshift(v & 0xff)
		v = Math.floor(v / 256)
	}
	if (bytes[0] & 0x80) bytes.unshift(0)
	return derTag(0x02, Buffer.from(bytes))
}

function derUtf8String(str) {
	return derTag(0x0c, Buffer.from(String(str), 'utf8'))
}

function derOctetString(buf) {
	return derTag(0x04, Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
}

function derSequence(parts) {
	return derTag(0x30, Buffer.concat(parts))
}

function derContext(tagNumber, inner) {
	return derTag(0xa0 | (tagNumber & 0x1f), inner)
}

// ---- Minimal ASN.1 DER decoder ---------------------------------------------------------
function readDerElement(buf, offset) {
	if (offset < 0 || offset >= buf.length) throw new Error('Unexpected end of DER data')
	const start = offset
	const tag = buf[offset++]
	if (offset >= buf.length) throw new Error('Truncated DER length')
	const lenByte = buf[offset++]
	let len
	if ((lenByte & 0x80) === 0) {
		len = lenByte
	} else {
		const numBytes = lenByte & 0x7f
		if (numBytes === 0 || numBytes > 4 || offset + numBytes > buf.length) throw new Error('Invalid DER length')
		len = 0
		for (let i = 0; i < numBytes; i++) len = len * 256 + buf[offset++]
	}
	if (len < 0 || len > MAX_DER_LEN || offset + len > buf.length) throw new Error('DER value exceeds buffer')
	const next = offset + len
	if (next <= start) throw new Error('Invalid DER progression')
	return {tag, value: buf.subarray(offset, next), next}
}

function readDerInteger(buf) {
	const el = readDerElement(buf, 0)
	if (el.tag !== 0x02 || el.value.length === 0 || el.value.length > 6) throw new Error('Expected DER INTEGER')
	let n = 0
	for (const b of el.value) n = n * 256 + b
	return n
}

function readDerUtf8(buf) {
	const el = readDerElement(buf, 0)
	if (el.tag !== 0x0c) throw new Error('Expected DER UTF8String')
	return el.value.toString('utf8')
}

function readDerOctet(buf) {
	const el = readDerElement(buf, 0)
	if (el.tag !== 0x04) throw new Error('Expected DER OCTET STRING')
	return Buffer.from(el.value)
}

// ---- RDCleanPath v3390 PDUs (IronRDP tag layout) ---------------------------------------
export function encodeRdcRequest({version = RDCLEANPATH_VERSION_1, destination, proxyAuth = '', serverAuth = '', preconnectionBlob = '', x224ConnectionPdu}) {
	const fields = [derContext(0, derInteger(version))]
	if (destination) fields.push(derContext(2, derUtf8String(destination)))
	if (proxyAuth) fields.push(derContext(3, derUtf8String(proxyAuth)))
	if (serverAuth) fields.push(derContext(4, derUtf8String(serverAuth)))
	if (preconnectionBlob) fields.push(derContext(5, derUtf8String(preconnectionBlob)))
	if (x224ConnectionPdu) fields.push(derContext(6, derOctetString(x224ConnectionPdu)))
	return derSequence(fields)
}

export function decodeRdcRequest(raw) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
	const seq = readDerElement(buf, 0)
	if (seq.tag !== 0x30) throw new Error('RDCleanPath request must be a DER SEQUENCE')
	const out = {version: 0, destination: '', proxyAuth: '', serverAuth: '', preconnectionBlob: '', x224ConnectionPdu: null}
	let pos = 0
	while (pos < seq.value.length) {
		const el = readDerElement(seq.value, pos)
		if (el.next <= pos) throw new Error('Invalid DER loop')
		pos = el.next
		if ((el.tag & 0xe0) !== 0xa0) continue
		const ctx = el.tag & 0x1f
		if (ctx === 0) out.version = readDerInteger(el.value)
		else if (ctx === 2) out.destination = readDerUtf8(el.value)
		else if (ctx === 3) out.proxyAuth = readDerUtf8(el.value)
		else if (ctx === 4) out.serverAuth = readDerUtf8(el.value)
		else if (ctx === 5) out.preconnectionBlob = readDerUtf8(el.value)
		else if (ctx === 6) out.x224ConnectionPdu = readDerOctet(el.value)
	}
	if (out.version !== RDCLEANPATH_VERSION_1) throw new Error(`Unsupported RDCleanPath version ${out.version}`)
	if (!out.x224ConnectionPdu?.length) throw new Error('Missing X.224 Connection Request PDU')
	return out
}

export function encodeRdcResponse({version = RDCLEANPATH_VERSION_1, x224ConnectionPdu, serverCertChain = [], serverAddr = ''}) {
	const fields = [derContext(0, derInteger(version))]
	if (x224ConnectionPdu) fields.push(derContext(6, derOctetString(x224ConnectionPdu)))
	if (serverCertChain.length) {
		fields.push(derContext(7, derSequence(serverCertChain.map((c) => derOctetString(c)))))
	}
	if (serverAddr) fields.push(derContext(9, derUtf8String(serverAddr)))
	return derSequence(fields)
}

export function encodeRdcError({version = RDCLEANPATH_VERSION_1, errorCode = 1, httpStatusCode = null, wsaLastError = null, tlsAlertCode = null}) {
	const errFields = [derContext(0, derInteger(errorCode))]
	if (httpStatusCode != null) errFields.push(derContext(1, derInteger(httpStatusCode)))
	if (wsaLastError != null) errFields.push(derContext(2, derInteger(wsaLastError)))
	if (tlsAlertCode != null) errFields.push(derContext(3, derInteger(tlsAlertCode)))
	return derSequence([derContext(0, derInteger(version)), derContext(1, derSequence(errFields))])
}

export function decodeRdcResponse(raw) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
	const seq = readDerElement(buf, 0)
	if (seq.tag !== 0x30) throw new Error('RDCleanPath response must be a DER SEQUENCE')
	const out = {version: 0, error: null, serverAddr: '', x224ConnectionPdu: null, serverCertChain: []}
	let pos = 0
	while (pos < seq.value.length) {
		const el = readDerElement(seq.value, pos)
		if (el.next <= pos) throw new Error('Invalid DER loop')
		pos = el.next
		if ((el.tag & 0xe0) !== 0xa0) continue
		const ctx = el.tag & 0x1f
		if (ctx === 0) out.version = readDerInteger(el.value)
		else if (ctx === 1) {
			const eseq = readDerElement(el.value, 0)
			if (eseq.tag === 0x30) {
				const err = {}
				let ep = 0
				while (ep < eseq.value.length) {
					const fe = readDerElement(eseq.value, ep)
					if (fe.next <= ep) throw new Error('Invalid DER loop')
					ep = fe.next
					const fc = fe.tag & 0x1f
					if (fc === 0) err.errorCode = readDerInteger(fe.value)
					else if (fc === 1) err.httpStatusCode = readDerInteger(fe.value)
					else if (fc === 2) err.wsaLastError = readDerInteger(fe.value)
					else if (fc === 3) err.tlsAlertCode = readDerInteger(fe.value)
				}
				out.error = err
			}
		} else if (ctx === 6) out.x224ConnectionPdu = readDerOctet(el.value)
		else if (ctx === 7) {
			const cseq = readDerElement(el.value, 0)
			if (cseq.tag === 0x30) {
				let cp = 0
				while (cp < cseq.value.length) {
					const ce = readDerElement(cseq.value, cp)
					if (ce.next <= cp) throw new Error('Invalid DER loop')
					cp = ce.next
					if (ce.tag === 0x04) out.serverCertChain.push(Buffer.from(ce.value))
				}
			}
		} else if (ctx === 9) out.serverAddr = readDerUtf8(el.value)
	}
	return out
}

// Read one complete TPKT frame (version 0x03, reserved 0x00, 16-bit big-endian length).
function readTpkt(socket, timeoutMs) {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0)
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error('Timed out waiting for X.224 response'))
		}, timeoutMs)
		const cleanup = () => {
			clearTimeout(timer)
			socket.off('data', onData)
			socket.off('error', onErr)
			socket.off('close', onClose)
		}
		const onErr = (e) => {
			cleanup()
			reject(e)
		}
		const onClose = () => {
			cleanup()
			reject(new Error('RDP server closed before X.224 confirm'))
		}
		const onData = (chunk) => {
			buf = Buffer.concat([buf, chunk])
			if (buf.length < 4) return
			if (buf[0] !== 0x03) {
				cleanup()
				return reject(new Error('Expected TPKT header (0x03) from RDP server'))
			}
			const total = buf.readUInt16BE(2)
			if (total < 4 || total > 65535) {
				cleanup()
				return reject(new Error('Invalid TPKT length'))
			}
			if (buf.length >= total) {
				cleanup()
				const pkt = buf.subarray(0, total)
				const extra = buf.subarray(total)
				if (extra.length) socket.unshift(extra)
				resolve(pkt)
			}
		}
		socket.on('data', onData)
		socket.once('error', onErr)
		socket.once('close', onClose)
	})
}

function collectCertChain(tlsSocket) {
	const chain = []
	const seen = new Set()
	let cert = tlsSocket.getPeerCertificate(true)
	while (cert && cert.raw && chain.length < 8) {
		const fp = cert.fingerprint256 || cert.raw.toString('hex')
		if (seen.has(fp)) break
		seen.add(fp)
		chain.push(Buffer.from(cert.raw))
		if (!cert.issuerCertificate || cert.issuerCertificate === cert) break
		cert = cert.issuerCertificate
	}
	return chain
}

export function attachRdcCleanPathBridge(ws, {host, port = 3389, serverName = '', timeoutMs = 15_000, onClose = null}) {
	let stage = 'init'
	let activeRaw = null
	let rdpSocket = null
	let closed = false

	const cleanup = () => {
		if (closed) {
			try {
				rdpSocket?.destroy()
			} catch {}
			try {
				activeRaw?.destroy()
			} catch {}
			return
		}
		closed = true
		clearTimeout(initTimer)
		try {
			rdpSocket?.destroy()
		} catch {}
		try {
			activeRaw?.destroy()
		} catch {}
		onClose?.()
	}

	const sendErrorAndClose = (errorCode, opts = {}) => {
		try {
			if (ws.readyState === ws.OPEN) ws.send(encodeRdcError({errorCode, ...opts}), {binary: true})
			ws.close(1000)
		} catch {}
		cleanup()
	}

	const initTimer = setTimeout(() => {
		if (stage === 'init') sendErrorAndClose(1, {httpStatusCode: 408})
	}, timeoutMs)

	ws.on('message', async (data) => {
		if (closed) return
		if (stage === 'relay') {
			if (rdpSocket && !rdpSocket.destroyed) {
				if (!rdpSocket.write(Buffer.from(data))) {
					ws.pause?.()
					rdpSocket.once('drain', () => !closed && ws.resume?.())
				}
			}
			return
		}
		if (stage !== 'init') return
		stage = 'connecting'
		clearTimeout(initTimer)
		let req
		try {
			req = decodeRdcRequest(data)
		} catch {
			return sendErrorAndClose(1, {httpStatusCode: 400})
		}

		let rawSock
		try {
			rawSock = await new Promise((resolve, reject) => {
				const s = net.connect({host, port})
				activeRaw = s
				const t = setTimeout(() => {
					s.destroy()
					reject(new Error('TCP connect timeout'))
				}, timeoutMs)
				s.once('connect', () => {
					clearTimeout(t)
					resolve(s)
				})
				s.once('error', (e) => {
					clearTimeout(t)
					reject(e)
				})
			})
		} catch {
			return sendErrorAndClose(1, {httpStatusCode: 502})
		}
		if (closed) {
			rawSock.destroy()
			return
		}

		try {
			rawSock.write(req.x224ConnectionPdu)
			const x224Confirm = await readTpkt(rawSock, timeoutMs)
			if (closed) {
				rawSock.destroy()
				return
			}

			const tlsSock = await new Promise((resolve, reject) => {
				const s = tls.connect({
					socket: rawSock,
					rejectUnauthorized: false,
					servername: net.isIP(serverName || host) ? undefined : serverName || host,
				})
				rdpSocket = s
				const t = setTimeout(() => {
					s.destroy()
					reject(new Error('TLS handshake timeout'))
				}, timeoutMs)
				s.once('secureConnect', () => {
					clearTimeout(t)
					resolve(s)
				})
				s.once('error', (e) => {
					clearTimeout(t)
					reject(e)
				})
			})

			if (closed || ws.readyState !== ws.OPEN) {
				tlsSock.destroy()
				cleanup()
				return
			}

			const serverCertChain = collectCertChain(tlsSock)
			const response = encodeRdcResponse({
				serverAddr: `${host}:${port}`,
				x224ConnectionPdu: x224Confirm,
				serverCertChain,
			})
			ws.send(response, {binary: true})
			stage = 'relay'

			tlsSock.on('data', (chunk) => {
				if (ws.readyState !== ws.OPEN) return
				if (ws.bufferedAmount > WS_HIGH_WATER) {
					tlsSock.pause()
					const check = setInterval(() => {
						if (closed || ws.readyState !== ws.OPEN) {
							clearInterval(check)
							return
						}
						if (ws.bufferedAmount < WS_HIGH_WATER / 2) {
							clearInterval(check)
							tlsSock.resume()
						}
					}, 50)
					check.unref?.()
				}
				ws.send(chunk, {binary: true})
			})
			tlsSock.on('close', () => {
				if (ws.readyState === ws.OPEN) ws.close(1000)
				cleanup()
			})
			tlsSock.on('error', () => {
				if (ws.readyState === ws.OPEN) ws.close(1011)
				cleanup()
			})
		} catch {
			try {
				rawSock.destroy()
			} catch {}
			return sendErrorAndClose(1, {httpStatusCode: 502})
		}
	})

	ws.on('close', cleanup)
	ws.on('error', cleanup)
}
