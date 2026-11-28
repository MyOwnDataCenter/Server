import {ApiError, mutate, query} from './api.ts'

// Image and template uploads use Downloads even on a fresh server without desktop folders.
export async function uploadDirectory(): Promise<string> {
	const path = '/Home/Downloads'
	const check = () => query('files.list', {path, limit: 1})
	try {
		await check()
	} catch (e) {
		if (!(e instanceof ApiError) || e.code !== 'NOT_FOUND') throw e
		await mutate('files.createDirectory', {path}).catch((e) => {
			// Another upload may have created it while this one was checking.
			if (!(e instanceof ApiError) || e.code !== 'CONFLICT') throw e
		})
		// Check through Files again: an existing file or unsafe link is not an upload folder.
		await check()
	}
	return path
}
