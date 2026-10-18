import * as nodeModule from 'node:module'

/**
 * The environment variable through which the desktop hands its compile cache
 * folder to the server it starts. The server removes it before anything else
 * runs, so terminals and agent CLIs never inherit it.
 */
export const COMPILE_CACHE_ENV = 'HARNESS_COMPILE_CACHE_DIR'

/** The desktop's folder for the cache, inside the app's own data folder. */
export const COMPILE_CACHE_FOLDER = 'node-compile-cache'

/**
 * Written to disk once startup has settled. Node also writes it at a normal
 * exit, but a killed process (a crash, a forced quit, Windows shutting down)
 * never gets there, and would then compile everything again at every launch.
 */
const FLUSH_AFTER_MS = 10_000

type CompileCache = {
  enableCompileCache?: (directory: string) => { status: number }
  flushCompileCache?: () => void
  constants?: { compileCacheStatus?: { ENABLED: number; ALREADY_ENABLED: number } }
}

/**
 * Keep V8's compiled code of every module loaded from now on in `directory`,
 * so the next launch reads it instead of parsing and compiling those modules
 * again. Node keeps one subfolder per Node and V8 version and checks each
 * entry against its source, so an update or an edited file only costs one
 * compile. Returns whether the cache is on; a runtime without it, or a folder
 * that cannot be used, leaves loading exactly as it was.
 */
export function enableCompileCache(
  directory: string,
  runtime: CompileCache = nodeModule as CompileCache,
): boolean {
  try {
    const status = runtime.enableCompileCache?.(directory)?.status
    const statuses = runtime.constants?.compileCacheStatus
    if (status === undefined || !statuses) return false
    if (status !== statuses.ENABLED && status !== statuses.ALREADY_ENABLED) return false
    setTimeout(() => {
      try {
        runtime.flushCompileCache?.()
      } catch {
        // A failed write only costs the next launch a compile.
      }
    }, FLUSH_AFTER_MS).unref()
    return true
  } catch {
    return false
  }
}
