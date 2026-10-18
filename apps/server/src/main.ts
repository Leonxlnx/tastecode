// The server process itself (start, then stop on a signal or the parent's
// request) lives in server-process.ts. This entry only decides how it is
// loaded, before any of the server's modules are.
await import('./server-process.js')
