/**
 * Packaged Linux installs are replaced under the running process by the
 * package manager. Native bindings live in app.asar.unpacked, so a lazily
 * required .node can be gone (or swapped for an incompatible one) by the time
 * a terminal or credential call first needs it. The raw ENOENT/module-load
 * error reads like a broken dependency or a missing system keyring — neither
 * is true. Say what actually happened and what fixes it.
 */

/** True when this module itself was loaded from inside an app.asar archive. */
export function isAsarRuntime(moduleUrl: string): boolean {
  return moduleUrl.includes('.asar/')
}

/**
 * Rethrow a native-binding require failure as an actionable error when the
 * packaged install is the likely cause; outside a packaged runtime the
 * original error is the honest one (missing dev dependency, etc.).
 */
export function rethrowNativeBindingFailure(
  error: unknown,
  binding: string,
  packaged: boolean,
): never {
  if (packaged) {
    throw new Error(
      `${binding} could not be loaded; the installation on disk changed or is incomplete. ` +
        'Restart the app, and reinstall it if the problem persists.',
      { cause: error },
    )
  }
  throw error
}
