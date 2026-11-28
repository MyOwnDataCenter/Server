// Files screen helpers: name prompts, keyboard/drag guards,
// upload folder walking, favorites paths, photo sync matching, and readable kind labels.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import * as helpers from '../web/src/filesHelpers.ts'

const filesSource = () => readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')

describe('files screen: #441 new folder NamePrompt submit state', () => {
	test('allows submitting suggested New folder name without editing when requireChange is false', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'New folder', initial: 'New folder', requireChange: false, busy: false}),
			true,
		)
	})

	test('requires a changed trimmed name when requireChange is true', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: ' notes.txt ', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes2.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			true,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: ' notes.txt ', requireChange: true, busy: false}),
			true,
		)
	})

	test('rejects invalid names and busy submissions', () => {
		for (const bad of ['', '   ', 'a/b', '.', '..']) {
			assert.equal(
				helpers.canSubmitNamePrompt({name: bad, initial: 'New folder', requireChange: false, busy: false}),
				false,
				bad,
			)
		}
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'Docs', initial: 'New folder', requireChange: false, busy: true}),
			false,
		)
	})

	test('Files.tsx passes requireChange only for rename and uses canSubmitNamePrompt', async () => {
		const src = await filesSource()
		assert.match(src, /requireChange=\{prompt\.kind === "rename"\}/)
		assert.match(src, /canSubmitNamePrompt\(\{ name, initial, requireChange, busy \}\)/)
		assert.doesNotMatch(src, /disabled=\{!valid \|\| busy \|\| name === initial\}/)
	})
})
describe('files screen: #113 favorites preserve FileEntry metadata', () => {
	test('favoritePath extracts path from both FileEntry objects and strings', () => {
		assert.equal(helpers.favoritePath('/Home/Docs'), '/Home/Docs')
		assert.equal(
			helpers.favoritePath({
				name: 'a.pdf',
				path: '/Home/a.pdf',
				type: 'application/pdf',
				size: 123,
				modified: 1000,
				operations: ['favorite'],
			}),
			'/Home/a.pdf',
		)
	})

	test('Files.tsx queries FavoriteItem[] and keeps FileEntry objects in ::favorites', async () => {
		const src = await filesSource()
		assert.match(src, /query<FavoriteItem\[\]>\("files\.favorites"\)/)
		assert.match(src, /favSet = useMemo\(\(\) => new Set\(\(favorites\.data \?\? \[\]\)\.map\(favoritePath\)\), \[favorites\.data\]\)/)
		assert.match(src, /typeof p === "string" \? \{/)
	})
})

describe('files screen: #189 Enter key on row action buttons', () => {
	test('shouldActivateRowOnKey only activates when Enter originates on the row itself', () => {
		const row = {}
		const childBtn = {}
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: row, currentTarget: row}), true)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: childBtn, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: ' ', target: row, currentTarget: row}), true)
		assert.equal(helpers.shouldActivateRowOnKey({key: ' ', target: childBtn, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Escape', target: row, currentTarget: row}), false)
	})

	test('Files.tsx guards row onKeyDown with shouldActivateRowOnKey', async () => {
		const src = await filesSource()
		assert.equal(src.match(/if \(!shouldActivateRowOnKey\(e\)\) return;\s*e\.preventDefault\(\);\s*activate\(f\);/g)?.length, 2, 'both the tile and the row stop the page scrolling on Space')
	})
})

describe('files screen: #195 ShareSheet access radios stay mounted and grouped', () => {
	test('ShareAccessChoice lives at module scope with a shared radio name from useId()', async () => {
		const src = await filesSource()
		const shareStart = src.indexOf('export function ShareSheet(')
		assert.ok(shareStart > 0)
		const beforeShare = src.slice(0, shareStart)
		const insideShare = src.slice(shareStart)

		assert.match(beforeShare, /function ShareAccessChoice\(/)
		assert.match(beforeShare, /<input type="radio" name=\{name\}/)
		assert.doesNotMatch(insideShare, /const Choice\s*=/)
		assert.match(insideShare, /const accessRadioName = useId\(\)/)
		const matches = insideShare.match(/<ShareAccessChoice[\s\S]*?name=\{accessRadioName\}/g) ?? []
		assert.equal(matches.length, 2)
	})
})

describe('files screen: #196 ShareSheet password error and retry', () => {
	test('sharePasswordLabel shows Tap to show, loading ellipsis, password, or error with retry hint', () => {
		assert.equal(helpers.sharePasswordLabel({data: undefined, isFetching: false, error: null}), 'Tap to show')
		assert.equal(helpers.sharePasswordLabel({data: undefined, isFetching: true, error: new Error('old')}), '…')
		assert.equal(helpers.sharePasswordLabel({data: 's3cr3t', isFetching: false, error: null}), 's3cr3t')
		assert.equal(
			helpers.sharePasswordLabel({data: undefined, isFetching: false, error: new Error('Helper unavailable')}),
			'Helper unavailable · Tap to retry',
		)
		assert.equal(
			helpers.sharePasswordLabel({data: undefined, isFetching: false, error: new Error('')}),
			'Couldn’t load password · Tap to retry',
		)
	})

	test('sharePasswordAction copies when loaded, refetches when already revealed, and reveals first time', () => {
		assert.equal(helpers.sharePasswordAction({data: 'pw', reveal: true}), 'copy')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: true, isFetching: false}), 'refetch')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: true, isFetching: true}), 'noop')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: false, isFetching: false}), 'reveal')
	})

	test('Files.tsx uses sharePasswordAction, pw.refetch(), and sharePasswordLabel in ShareSheet', async () => {
		const src = await filesSource()
		assert.match(src, /sharePasswordAction\(\{ data: pw\.data, reveal, isFetching: pw\.isFetching \}\)/)
		assert.match(src, /!pw\.data && pw\.error && !pw\.isFetching/)
		assert.match(src, /pw\.refetch\(\)/)
		assert.match(src, /sharePasswordLabel\(\{ data: pw\.data, isFetching: pw\.isFetching, error: pw\.error \}\)/)
	})
})

describe('files screen: #197 refresh Recents after uploads', () => {
	test('UPLOAD_REFRESH_KEYS invalidates both files.list and files.recents', () => {
		assert.deepEqual(helpers.UPLOAD_REFRESH_KEYS, [['files.list'], ['files.recents']])
	})

	test('Files.tsx invalidates UPLOAD_REFRESH_KEYS when uploads finish', async () => {
		const src = await filesSource()
		assert.match(src, /for \(const key of UPLOAD_REFRESH_KEYS\)\s*qc\.invalidateQueries\(\{ queryKey: \[...key\] \}\)/)
	})
})

describe('files screen: #489 Sync photos recognizes keep-both copies', () => {
	test('stripCopySuffix strips (2)+ before the extension or end of name', () => {
		assert.equal(helpers.stripCopySuffix('IMG_0001 (2).jpg'), 'IMG_0001.jpg')
		assert.equal(helpers.stripCopySuffix('IMG_0001 (12).HEIC'), 'IMG_0001.HEIC')
		assert.equal(helpers.stripCopySuffix('Photo (2)'), 'Photo')
		assert.equal(helpers.stripCopySuffix('clip (final) (3).mp4'), 'clip (final).mp4')
		assert.equal(helpers.stripCopySuffix('IMG_0001 (1).jpg'), 'IMG_0001 (1).jpg')
		assert.equal(helpers.stripCopySuffix('IMG_0001.jpg'), 'IMG_0001.jpg')
	})

	test('filterUnsyncedPhotos treats keep-both copies with matching size as already synced', () => {
		const existing = [
			{name: 'IMG_0001.jpg', path: '/Home/Photos/IMG_0001.jpg', type: 'image/jpeg', size: 1000, modified: 1, operations: []},
			{name: 'IMG_0001 (2).jpg', path: '/Home/Photos/IMG_0001 (2).jpg', type: 'image/jpeg', size: 2000, modified: 2, operations: []},
			{name: 'Album', path: '/Home/Photos/Album', type: 'directory', modified: 3, operations: []},
		]
		assert.deepEqual(helpers.filterUnsyncedPhotos([{name: 'IMG_0001.jpg', size: 2000}], existing), [])
		assert.deepEqual(helpers.filterUnsyncedPhotos([{name: 'IMG_0001 (2).jpg', size: 2000}], existing), [])
		const brandNew = {name: 'IMG_0001.jpg', size: 3000}
		assert.deepEqual(helpers.filterUnsyncedPhotos([brandNew], existing), [brandNew])
	})

	test('Files.tsx uses filterUnsyncedPhotos in photoInput onChange', async () => {
		const src = await filesSource()
		assert.match(src, /const fresh = filterUnsyncedPhotos\(picked, existing\);/)
		assert.match(src, /existing = await photosAlreadyThere\(listing\.data,/)
	})

	test('photosAlreadyThere reads the whole folder when the listing is only the first page', async () => {
		const page = [{name: 'a.jpg', path: '/Home/Photos/a.jpg', type: 'image/jpeg', size: 1, modified: 1, operations: []}]
		const all = [...page, {name: 'z.jpg', path: '/Home/Photos/z.jpg', type: 'image/jpeg', size: 2, modified: 2, operations: []}]
		let loads = 0
		const loadAll = async () => (loads++, {files: all})
		assert.deepEqual(await helpers.photosAlreadyThere({files: page, hasMore: true}, loadAll), all)
		assert.equal(loads, 1)
		assert.deepEqual(await helpers.photosAlreadyThere({files: page}, loadAll), page)
		assert.equal(loads, 1)
		assert.deepEqual(await helpers.photosAlreadyThere(undefined, loadAll), all)
	})
})

describe('files screen: #492 prevent file drop navigation in non-uploadable views', () => {
	const makeDragEvent = (types) => {
		let prevented = false
		return {
			types,
			get prevented() {
				return prevented
			},
			event: {
				preventDefault() {
					prevented = true
				},
				dataTransfer: {
					types,
					dropEffect: 'copy',
				},
			},
		}
	}

	test('drag enter, drag over, and drop prevent default for file drags even when canUpload is false', () => {
		for (const fn of ['handleFileDragEnter', 'handleFileDragOver', 'handleFileDrop']) {
			const disallowed = makeDragEvent(['Files'])
			assert.equal(helpers[fn](disallowed.event, false), false, fn)
			assert.equal(disallowed.prevented, true, fn)
			if (fn === 'handleFileDragOver') assert.equal(disallowed.event.dataTransfer.dropEffect, 'none')

			const allowed = makeDragEvent(['Files'])
			assert.equal(helpers[fn](allowed.event, true), true, fn)
			assert.equal(allowed.prevented, true, fn)
			if (fn === 'handleFileDragOver') assert.equal(allowed.event.dataTransfer.dropEffect, 'copy')

			const nonFile = makeDragEvent(['text/plain'])
			assert.equal(helpers[fn](nonFile.event, true), false, fn)
			assert.equal(nonFile.prevented, false, fn)
		}
	})

	test('Files.tsx uses handleFileDragEnter, handleFileDragOver, and handleFileDrop', async () => {
		const src = await filesSource()
		assert.match(src, /handleFileDragEnter\(e, canUpload\)/)
		assert.match(src, /handleFileDragOver\(e, canUpload\)/)
		assert.match(src, /handleFileDrop\(e, canUpload && !!uploadDir\)/)
	})
})

describe('files screen: #493 create empty folders on folder drop or pick', () => {
	const fakeFile = (name, size = 4) => ({name, size})

	const mockFileEntry = (name) => ({
		name,
		isFile: true,
		isDirectory: false,
		file: (ok) => ok(fakeFile(name)),
	})

	const mockDirEntry = (name, children) => ({
		name,
		isFile: false,
		isDirectory: true,
		createReader: () => {
			let sent = false
			return {
				readEntries: (ok) => {
					if (sent) return ok([])
					sent = true
					ok(children)
				},
			}
		},
	})

	test('collectUploadDirs includes empty subfolders and sorts shallowest-first', () => {
		const dirs = helpers.collectUploadDirs(
			[{file: fakeFile('a.txt'), rel: 'proj/src/a.txt'}],
			['proj/empty/deep', 'proj/logs'],
		)
		assert.deepEqual(dirs, ['proj', 'proj/src', 'proj/empty', 'proj/logs', 'proj/empty/deep'])
	})

	test('readDroppedEntries collects empty subdirectories and completely empty dropped folders', async () => {
		const proj = mockDirEntry('proj', [
			mockFileEntry('a.txt'),
			mockDirEntry('logs', []),
			mockDirEntry('tmp', [mockDirEntry('sub', [])]),
		])
		const batch = await helpers.readDroppedEntries([proj])
		assert.deepEqual(batch.files.map((f) => f.rel), ['proj/a.txt'])
		assert.deepEqual(batch.dirs, ['proj', 'proj/logs', 'proj/tmp', 'proj/tmp/sub'])

		const emptyOnly = await helpers.readDroppedEntries([mockDirEntry('empty', [])])
		assert.equal(emptyOnly.files.length, 0)
		assert.deepEqual(emptyOnly.dirs, ['empty'])
	})

	test('readDirectoryHandle collects files and empty subdirectories', async () => {
		const mockFileHandle = (name) => ({
			kind: 'file',
			name,
			getFile: async () => fakeFile(name),
		})
		const mockDirHandle = (name, children) => ({
			kind: 'directory',
			name,
			async *values() {
				for (const c of children) yield c
			},
		})
		const root = mockDirHandle('root', [
			mockFileHandle('readme.txt'),
			mockDirHandle('emptyA', []),
			mockDirHandle('nested', [mockDirHandle('emptyB', [])]),
		])
		const batch = await helpers.readDirectoryHandle(root)
		assert.deepEqual(batch.files.map((f) => f.rel), ['root/readme.txt'])
		assert.deepEqual(batch.dirs, ['root', 'root/emptyA', 'root/nested', 'root/nested/emptyB'])
	})

	test('Files.tsx wires readDroppedEntries, readDirectoryHandle, collectUploadDirs, and empty-folder uploads', async () => {
		const src = await filesSource()
		assert.match(src, /readDroppedEntries/)
		assert.match(src, /readDirectoryHandle/)
		assert.match(src, /collectUploadDirs\(items, extraDirs\)/)
		assert.match(src, /if \(!items\.length && !dirs\.length\) return;/)
		assert.match(src, /showDirectoryPicker/)
		assert.match(src, /pickDirectoryFromWindow\(win\)/)
	})

	test('pickDirectoryFromWindow preserves window as this receiver', async () => {
		const expectedHandle = {kind: 'directory', name: 'root', async *values() {}}
		const fakeWin = {
			async showDirectoryPicker() {
				if (this !== fakeWin) throw new TypeError('Illegal invocation')
				return expectedHandle
			},
		}
		assert.equal(await helpers.pickDirectoryFromWindow(fakeWin), expectedHandle)
		assert.equal(helpers.pickDirectoryFromWindow({}), null)
	})
})

describe('files screen: #494 human-readable Kind label in ItemSheet', () => {
	test('fileKindLabel maps MIME types and extensions to plain-English labels', () => {
		const cases = [
			[{name: 'report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}, 'Word document'],
			[{name: 'budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}, 'Excel spreadsheet'],
			[{name: 'slides.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'}, 'PowerPoint presentation'],
			[{name: 'omarchy.iso', type: 'application/x-iso9660-image'}, 'Disk image (ISO)'],
			[{name: 'notes.md', type: 'text/markdown'}, 'Markdown document'],
			[{name: 'deploy.sh', type: 'text/x-shellscript'}, 'Shell script'],
			[{name: 'notes.txt', type: 'text/plain'}, 'Text file'],
			[{name: 'photo.png', type: 'image/png'}, 'PNG image'],
			[{name: 'clip.mp4', type: 'video/mp4'}, 'MP4 video'],
			[{name: 'song.mp3', type: 'audio/mpeg'}, 'MP3 audio'],
			[{name: 'inter.woff2', type: 'font/woff2'}, 'WOFF2 font'],
			[{name: 'README', type: 'text/plain'}, 'Text file'],
			[{name: 'data', type: 'application/octet-stream'}, 'Unknown file'],
			[{name: 'firmware.bin', type: 'application/octet-stream'}, 'BIN file'],
			[{name: 'Docs', type: 'directory'}, 'Folder'],
		]
		for (const [entry, expected] of cases) {
			const label = helpers.fileKindLabel(entry)
			assert.equal(label, expected, entry.name)
			assert.doesNotMatch(label, /vnd\.|octet-stream|x-iso9660-image|x-shellscript|\bplain\b/)
		}
	})

	test('Files.tsx renders fileKindLabel(f) in ItemSheet instead of raw MIME subtype', async () => {
		const src = await filesSource()
		assert.match(src, /<span className="v">\{fileKindLabel\(f\)\}<\/span>/)
		assert.doesNotMatch(src, /f\.type\.split\("\/"\)\.pop\(\)/)
	})
})

describe('files screen: folder empty state, upload errors, and unserved roots', () => {
	test('showFolderEmpty is only a successful listing with no rows', () => {
		assert.equal(helpers.showFolderEmpty({error: null, count: 0}), true)
		assert.equal(helpers.showFolderEmpty({error: undefined, count: 0}), true)
		assert.equal(helpers.showFolderEmpty({error: new Error('[permission]'), count: 0}), false)
		assert.equal(helpers.showFolderEmpty({error: new Error('offline'), count: 3}), false)
		assert.equal(helpers.showFolderEmpty({error: null, count: 2}), false)
		assert.equal(helpers.showFolderEmpty({error: null, count: 0, suppress: true}), false)
	})

	test('Files.tsx uses showFolderEmpty so an error is not also an empty folder', async () => {
		const src = await filesSource()
		assert.match(src, /showFolderEmpty\(/)
		assert.match(src, /listing\.error/)
	})

	test('mkdir failures other than already-exists stop that folder once', () => {
		const start = {failed: [], shown: false}
		const exists = helpers.reduceUploadMkdir(start, 'photos', '[already-exists]')
		assert.equal(exists.skip, false)
		assert.deepEqual(exists.failed, [])
		assert.equal(exists.toast, null)
		const sameName = helpers.reduceUploadMkdir(start, 'photos', '[destination-already-exists]')
		assert.deepEqual(sameName.failed, [])
		const denied = helpers.reduceUploadMkdir(start, 'photos', '[permission]')
		assert.deepEqual(denied.failed, ['photos'])
		assert.equal(denied.toast, '[permission]')
		assert.equal(denied.shown, true)
		const child = helpers.reduceUploadMkdir(denied, 'photos/raw', '[does-not-exist]')
		assert.equal(child.skip, true)
		assert.equal(child.toast, null)
		assert.deepEqual(child.failed, ['photos'])
		const again = helpers.reduceUploadMkdir(denied, 'other', '[read-only]')
		assert.equal(again.toast, null)
		assert.deepEqual(again.failed, ['photos', 'other'])
		assert.equal(helpers.uploadRelBlocked('photos/a.jpg', denied.failed), true)
		assert.equal(helpers.uploadRelBlocked('photos/raw/b.jpg', denied.failed), true)
		assert.equal(helpers.uploadRelBlocked('photos2/a.jpg', denied.failed), false)
		assert.equal(helpers.uploadRelBlocked(undefined, denied.failed), false)
		assert.equal(helpers.uploadRelBlocked('other/c.jpg', again.failed), true)
	})

	test('Files.tsx skips files under a failed upload folder instead of reporting them missing', async () => {
		const src = await filesSource()
		assert.match(src, /reduceUploadMkdir\(/)
		assert.match(src, /uploadRelBlocked\(/)
		assert.doesNotMatch(src, /if \(msg === "\[already-exists\]"/)
	})

	test('App data, Drives, and Network stay hidden until the backend serves them', () => {
		assert.equal(helpers.isServedFilePlace('/Home'), true)
		assert.equal(helpers.isServedFilePlace('/Home/Photos'), true)
		assert.equal(helpers.isServedFilePlace('/Trash'), true)
		assert.equal(helpers.isServedFilePlace('::recents'), true)
		assert.equal(helpers.isServedFilePlace('/Apps'), false)
		assert.equal(helpers.isServedFilePlace('/External'), true)
		assert.equal(helpers.isServedFilePlace('/Network'), false)
		assert.deepEqual(helpers.folderPickerRoots(), ['/Home', '/External'])
	})

	test('Files.tsx filters places and picker chips through the helpers', async () => {
		const src = await filesSource()
		assert.match(src, /isServedFilePlace\(/)
		assert.match(src, /folderPickerRoots\(/)
	})
})

describe('files screen: #515 multi-select is reachable without a long press and exposes its state', () => {
	test('the item sheet has a Select action and selected rows and tiles carry aria-pressed', async () => {
		const src = await filesSource()
		assert.match(src, /id: "select",\s*label: "Select"/)
		assert.match(src, /onSelect=\{\(\) => \(setOpen\(null\), rowApi\.current\.long\(open\)\)\}/)
		assert.equal(src.match(/aria-pressed=\{selecting \? selected : undefined\}/g)?.length, 2)
	})
})
