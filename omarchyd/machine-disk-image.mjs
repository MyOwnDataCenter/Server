import {open, stat} from 'node:fs/promises'
import {extname} from 'node:path'

import {RpcError} from './rpc.mjs'

// Inspect a standalone image before handing it to QEMU. In particular, do not let an uploaded
// QCOW2 refer to backing images, external data files or encrypted storage on this server.
export async function inspectDiskImage(file, run) {
	const format = extname(file).toLowerCase() === '.qcow2' ? 'qcow2' : /\.(raw|img)$/i.test(file) ? 'raw' : null
	if (!format) throw new RpcError('BAD_REQUEST', 'Choose a RAW (.raw or .img) or QCOW2 disk image')
	const handle = await open(file, 'r')
	try {
		const st = await handle.stat()
		if (!st.isFile() || st.size < 512) throw new RpcError('BAD_REQUEST', 'Choose a non-empty disk image file')
		const header = Buffer.alloc(104)
		const {bytesRead} = await handle.read(header, 0, header.length, 0)
		const qcow = header.readUInt32BE(0) === 0x514649fb
		if (qcow !== (format === 'qcow2')) throw new RpcError('BAD_REQUEST', 'The image format does not match its file extension')
		if (qcow) {
			const version = header.readUInt32BE(4)
			if (bytesRead < 72 || ![2, 3].includes(version) || (version === 3 && bytesRead < 104)) throw new RpcError('BAD_REQUEST', 'That QCOW2 image has an invalid header')
			if (header.readBigUInt64BE(8) || header.readUInt32BE(16)) throw new RpcError('BAD_REQUEST', 'Backing files are not supported. Export a standalone disk image first.')
			if (header.readUInt32BE(32) || (version === 3 && (header.readBigUInt64BE(72) & 4n))) throw new RpcError('BAD_REQUEST', 'Encrypted QCOW2 images and external data files are not supported')
		}
	} finally {
		await handle.close()
	}
	let info
	try {
		info = JSON.parse(await run('qemu-img', ['info', '--output=json', '-f', format, file], {timeout: 20_000}))
	} catch {
		throw new RpcError('BAD_REQUEST', 'That disk image could not be read')
	}
	if (info.format !== format || info['backing-filename'] || info['full-backing-filename'] || info.encrypted || info['format-specific']?.data?.['data-file']) throw new RpcError('BAD_REQUEST', 'Choose a standalone, unencrypted RAW or QCOW2 image')
	const size = info['virtual-size']
	if (!Number.isSafeInteger(size) || size < 512 || size > 4096 * 1024 ** 3) throw new RpcError('BAD_REQUEST', 'The image must be no larger than 4096 GB')
	return {format, virtualSize: size, size: (await stat(file)).size}
}
