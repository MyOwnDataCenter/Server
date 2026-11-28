// A test that deletes its temporary directory can lose the race with a file still being
// written. Node retries ENOTEMPTY when maxRetries is set. Every test import of rm sees this.
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

const RETRY = {maxRetries: 5, retryDelay: 20}

function withRetry(opts) {
	if (!opts || typeof opts !== 'object' || !opts.recursive || opts.maxRetries != null) return opts
	return {...opts, ...RETRY}
}

const rm = fs.promises.rm
fs.promises.rm = (path, opts) => rm.call(fs.promises, path, withRetry(opts))

const rmSync = fs.rmSync
fs.rmSync = (path, opts) => rmSync.call(fs, path, withRetry(opts))
