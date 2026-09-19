/**
 * Where the renderer finds the local core server.
 *
 * `import.meta.env.VITE_HARNESS_SERVER_URL` is baked at build time and cannot
 * see a runtime HARNESS_PORT, so the desktop shell also passes its resolved
 * port as a `harnessPort` page-query parameter (apps/desktop/src/main.ts).
 * An explicit build-time URL wins — it is the deliberate override used for
 * remote or instrumented builds.
 */

// Mirrors apps/server/src/server-config.ts#DEFAULT_PORT; the renderer cannot
// import the server package, so the default keeps a literal here.
const DEFAULT_SERVER_PORT = 4311

/**
 * The port the shell put on the page URL, if it is usable. Mirrors the same
 * unprivileged range the desktop enforces (apps/desktop/src/server-port.ts).
 */
export function runtimeServerPort(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('harnessPort')
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const port = Number(raw)
  return port >= 1024 && port <= 65_535 ? port : undefined
}

export function serverBaseUrl(envUrl: string | undefined, runtimePort?: number): string {
  return envUrl ?? `ws://127.0.0.1:${runtimePort ?? DEFAULT_SERVER_PORT}`
}
