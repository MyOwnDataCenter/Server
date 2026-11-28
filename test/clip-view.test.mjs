import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
	batchPlan,
	clipWord,
	computerHere,
	copyPlan,
	displayMachine,
	fileClipInput,
	filterClips,
	formatClipWhen,
	guestHere,
	joinClipText,
	matchesClip,
	nextStatus,
	nextType,
	sendKind,
	sendTargets,
	serverHere,
	statusLabel,
	statusMark,
	typeLabel,
} from '../web/src/clips/view.ts'

const row = (over) => ({
	id: 'a',
	kind: 'text',
	at: 1,
	label: 'Hello',
	name: 'Hello.txt',
	preview: 'Hello there',
	machine: 'This server',
	availability: 'available',
	...over,
})

test('the kind and status cycles start at the first word and then advance', () => {
	assert.equal(nextType(null), 'text')
	assert.equal(nextType('text'), 'picture')
	assert.equal(nextType('picture'), 'file')
	assert.equal(nextType('file'), 'folder')
	assert.equal(nextType('folder'), 'text')
	assert.equal(nextStatus(null), 'missing')
	assert.equal(nextStatus('missing'), 'offline')
	assert.equal(nextStatus('offline'), 'available')
	assert.equal(nextStatus('available'), 'missing')
	assert.equal(typeLabel(null), 'Text')
	assert.equal(typeLabel('picture'), 'Picture')
	assert.equal(statusLabel(null), 'Missing')
	assert.equal(statusLabel('available'), 'Available')
})

test('a folder, a picture, and a file each have their own word', () => {
	assert.equal(clipWord({kind: 'file', dir: true}), 'Folder')
	assert.equal(clipWord({kind: 'image'}), 'Picture')
	assert.equal(clipWord({kind: 'file'}), 'File')
	assert.equal(clipWord({kind: 'stats'}), 'Stats')
	assert.equal(clipWord({kind: 'text'}), 'Text')
})

test('All is both sides clear, and search matches the name, the preview, and the machine', () => {
	const clips = [
		row({id: '1', label: 'Notes', preview: 'alpha', machine: 'nix'}),
		row({id: '2', kind: 'image', label: 'Shot', preview: 'Screenshot', machine: 'This server'}),
		row({id: '3', kind: 'file', dir: true, label: 'Documents', preview: 'Documents', machine: 'Dev', availability: 'missing'}),
	]
	const all = {text: '', type: null, status: null}
	assert.equal(matchesClip(clips[0], all), true)
	assert.equal(matchesClip(clips[1], {...all, type: 'picture'}), true)
	assert.equal(matchesClip(clips[0], {...all, type: 'picture'}), false)
	assert.equal(matchesClip(clips[2], {...all, type: 'folder', status: 'missing'}), true)
	assert.equal(matchesClip(clips[2], {...all, type: 'folder', status: 'offline'}), false)
	assert.equal(matchesClip(clips[0], {...all, text: 'ALPHA'}), true)
	assert.equal(matchesClip(clips[0], {...all, text: 'nix'}), true)
	assert.equal(matchesClip(clips[1], {...all, text: 'notes'}), false)
	assert.equal(displayMachine('This server', 'Quito'), 'Quito')
	assert.equal(matchesClip(clips[1], {...all, text: 'quito'}, 'Quito'), true)
})

test('the list is newest first', () => {
	const clips = [row({id: 'old', at: 1, preview: 'old'}), row({id: 'new', at: 3, preview: 'new'}), row({id: 'mid', at: 2, preview: 'mid'})]
	assert.deepEqual(filterClips(clips, {text: '', type: null, status: null}).map((clip) => clip.id), ['new', 'mid', 'old'])
})

test('Missing and Offline are marks, and Available is not', () => {
	assert.equal(statusMark('missing'), 'Missing')
	assert.equal(statusMark('offline'), 'Offline')
	assert.equal(statusMark('available'), null)
	assert.equal(formatClipWhen(1_000, 1_000 + 10_000), 'Just now')
	assert.equal(formatClipWhen(1_000, 1_000 + 3 * 60_000), '3 min ago')
})

test('Copy uses the device clipboard, and a gone file cannot be copied', () => {
	assert.equal(copyPlan({kind: 'text', availability: 'available'}), 'text')
	assert.equal(copyPlan({kind: 'stats', availability: 'available'}), 'text')
	assert.equal(copyPlan({kind: 'image', availability: 'available'}), 'image')
	assert.equal(copyPlan({kind: 'file', availability: 'available'}), 'path')
	assert.equal(copyPlan({kind: 'file', availability: 'missing'}), 'unavailable')
	assert.equal(copyPlan({kind: 'file', availability: 'offline'}), 'unavailable')
	assert.equal(copyPlan({kind: 'text', availability: 'missing'}), 'unavailable')
})

test('Send to this machine is offered only when that machine can take the clip', () => {
	const server = serverHere('Quito')
	const online = computerHere({id: 'computer0001', name: 'nix', online: true, allowed: {files: true}, on: {files: true}})
	const offline = computerHere({id: 'computer0001', name: 'nix', online: false, allowed: {files: true}, on: {files: true}})
	const guest = guestHere({id: 'abcd1234', name: 'Dev'}, {id: 'agent00000001', name: 'connector', online: true, allowed: {files: true}, on: {files: true}})
	const bare = guestHere({id: 'abcd1234', name: 'Dev'}, null)
	assert.equal(server.clipboard, true)
	assert.equal(server.files, true)
	assert.equal(online.files, true)
	assert.equal(online.clipboard, false)
	assert.equal(offline.files, false)
	assert.equal(guest.files, true)
	assert.equal(guest.name, 'Dev')
	assert.equal(guest.id, 'agent00000001')
	assert.equal(bare.files, false)
	assert.equal(sendKind({kind: 'text'}), 'clipboard')
	assert.equal(sendKind({kind: 'image'}), 'folder')
	assert.equal(sendKind({kind: 'file'}), 'folder')
	const targets = sendTargets({
		serverName: 'Quito',
		computers: [
			{id: 'computer0001', name: 'nix', online: true, allowed: {files: true}, on: {files: true}},
			{id: 'agent00000001', name: 'connector', online: true, guestOf: 'abcd1234', allowed: {files: true}, on: {files: true}},
			{id: 'agent00000002', name: 'down', online: false, guestOf: 'ffff0000', allowed: {files: true}, on: {files: true}},
		],
		machines: [
			{id: 'abcd1234', name: 'Dev'},
			{id: 'ffff0000', name: 'Bare'},
			{id: '11111111', name: 'No connector'},
		],
	})
	assert.deepEqual(targets.map((item) => item.name), ['Quito', 'nix', 'Dev'])
})

test('several selected paths are one clip, and Trash is left out', () => {
	const one = fileClipInput('server', undefined, ['/Home/a.txt'])
	assert.equal(one.path, '/Home/a.txt')
	assert.equal(one.paths, undefined)
	const many = fileClipInput('server', undefined, ['/Home/a.txt', '/Trash/b.txt', '/Home/c.txt'], true)
	assert.deepEqual(many.paths, ['/Home/a.txt', '/Home/c.txt'])
	assert.equal(many.cut, true)
	assert.equal(many.path, undefined)
	const remote = fileClipInput('swarm', 'computer0001', ['docs/a.txt'])
	assert.equal(remote.id, 'computer0001')
	assert.equal(remote.path, 'docs/a.txt')
	assert.equal(fileClipInput('server', undefined, []), null)
	assert.equal(fileClipInput('server', undefined, ['/Trash/only.txt']), null)
})

test('a batch is text joined together, or files and pictures into one folder, and not both', () => {
	const text = row({id: 't', kind: 'text'})
	const stats = row({id: 's', kind: 'stats', preview: 'CPU 4%'})
	const file = row({id: 'f', kind: 'file'})
	const picture = row({id: 'p', kind: 'image'})
	const folder = row({id: 'd', kind: 'file', dir: true})
	const server = serverHere('Quito')
	const computer = computerHere({id: 'computer0001', name: 'nix', online: true, allowed: {files: true}, on: {files: true}})
	const textPlan = batchPlan([text, stats], [server, computer])
	assert.equal(textPlan.kind, 'clipboard')
	assert.deepEqual(textPlan.targets.map((item) => item.name), ['Quito'])
	assert.equal(textPlan.problem, null)
	assert.equal(joinClipText(['  Hello  ', '', 'CPU 4%']), 'Hello\n\nCPU 4%')
	const files = batchPlan([file, picture, folder], [server, computer])
	assert.equal(files.kind, 'folder')
	assert.deepEqual(files.targets.map((item) => item.name), ['Quito'])
	assert.equal(files.problem, null)
	const picturesOnly = batchPlan([picture, file], [server, computer])
	assert.deepEqual(picturesOnly.targets.map((item) => item.id), ['server', 'computer0001'])
	const mixed = batchPlan([text, file], [server])
	assert.equal(mixed.kind, 'mixed')
	assert.deepEqual(mixed.targets, [])
	assert.equal(mixed.problem, 'Text and files go to different places.')
	const gone = batchPlan([file, row({id: 'm', kind: 'file', availability: 'missing'})], [server])
	assert.equal(gone.problem, 'One of these is gone.')
	const quiet = batchPlan([file, row({id: 'o', kind: 'file', availability: 'offline'})], [server])
	assert.equal(quiet.problem, 'One of these isn’t answering.')
	const noClipboard = batchPlan([text], [computer])
	assert.equal(noClipboard.problem, 'This machine can’t take text on its own clipboard yet.')
	const folderAway = batchPlan([folder], [computer])
	assert.equal(folderAway.problem, 'A folder can be saved on this server. Another computer can’t take a whole folder yet.')
	const remoteFolder = batchPlan([row({id: 'r', kind: 'file', dir: true, scope: 'swarm'})], [server, computer])
	assert.deepEqual(remoteFolder.targets, [])
	assert.equal(remoteFolder.problem, 'This server can’t take a whole folder from another computer yet.')
	assert.equal(batchPlan([], [server]).kind, 'empty')
})
