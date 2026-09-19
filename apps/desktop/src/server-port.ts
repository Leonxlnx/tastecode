/**
 * Resolves which loopback port the owned core server should use.
 *
 * The shell resolves HARNESS_PORT once and hands the result to every hop that
 * needs it: the spawned server's environment, the renderer's `harnessPort`
 * page-query parameter (read in apps/web/src/server-url.ts), and indirectly the
 * port-conflict probe, which follows the port the server itself reports.
 *
 * Values below 1024 are rejected rather than passed through: they are
 * privileged on Linux/macOS, and the dialog that sends users here should never
 * trade one startup failure for another. Invalid input falls back to the
 * shared default instead of failing — the app still starts and the port it
 * actually uses is the one the user sees in logs and dialogs.
 */

// Mirrors apps/server/src/server-config.ts#DEFAULT_PORT — the web renderer
// keeps the same literal because it cannot import the server package.
const DEFAULT_SERVER_PORT = 4311
const MIN_SERVER_PORT = 1024
const MAX_SERVER_PORT = 65_535

/** Strict parse: whole digits inside the unprivileged range, else undefined. */
export function parseServerPort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return port >= MIN_SERVER_PORT && port <= MAX_SERVER_PORT ? port : undefined
}

/** The configured port, or the shared default when unset or unusable. */
export function resolveServerPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVER_PORT
  return parseServerPort(value) ?? DEFAULT_SERVER_PORT
}
