import { config } from 'zod'

// Zod probes `new Function` once, when the first object schema is built, to
// decide whether it may compile fast parsers. The renderer's CSP has no
// 'unsafe-eval', so the probe always fails and Chromium logs a CSP violation
// on every start. Jitless skips the probe; parsing is unchanged, because the
// compiled path is never available under this CSP. Imported first by main.tsx
// so it runs before any schema module.
config({ jitless: true })
