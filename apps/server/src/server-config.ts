export const DEFAULT_PORT = 4311

/**
 * Strict port parse shared by the server entry points. `source` names the
 * knob (`HARNESS_PORT`, `--port`) so the error tells the user what to fix.
 */
export function parsePort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${source} must be a whole port number.`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be between 1 and 65535.`)
  }
  return port
}
