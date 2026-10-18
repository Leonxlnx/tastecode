import { COMPILE_CACHE_ENV, enableCompileCache } from '@harness/proc/compile-cache'

// Every launch parsed and compiled the server's modules again. With a folder
// from the desktop, V8 keeps that work between launches. The variable goes
// first: every terminal and agent CLI inherits this environment. A server
// started without it (dev, tests, by hand) loads exactly as before.
const compileCache = process.env[COMPILE_CACHE_ENV]
delete process.env[COMPILE_CACHE_ENV]
if (compileCache) enableCompileCache(compileCache)

// The server process itself (start, then stop on a signal or the parent's
// request) lives in server-process.ts. It is imported only now, so that its
// modules load with the cache.
await import('./server-process.js')
