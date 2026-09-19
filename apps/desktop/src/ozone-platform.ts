import { existsSync } from 'node:fs'
import path from 'node:path'

export type LinuxOzonePlatform = 'wayland' | 'x11'

/** The environment signals that describe which display protocol is reachable. */
export interface LinuxDisplayEnv {
  readonly waylandDisplay: string | undefined
  readonly display: string | undefined
  readonly xdgSessionType: string | undefined
  /** ${XDG_RUNTIME_DIR}/wayland-0 exists: Wayland is reachable even when
   *  WAYLAND_DISPLAY itself was dropped from the environment. */
  readonly hasWaylandSocket: boolean
}

/**
 * The Ozone platform with a reachable display in this environment, or
 * undefined when neither protocol can be reached.
 *
 * Chromium resolves the platform in `ui::SetOzonePlatformForLinuxIfNeeded`
 * before this script runs: it honors `XDG_SESSION_TYPE=wayland` and otherwise
 * forces x11, which exits with "Missing X server or $DISPLAY" when DISPLAY is
 * absent. A launcher that strips session variables but keeps WAYLAND_DISPLAY
 * (SSH, cron, systemd units, `env -i`) was previously covered by
 * `--ozone-platform-hint=auto`; the switch no longer exists upstream, so the
 * probe is recreated here. The session hint wins when it names a reachable
 * display; otherwise a reachable display wins, Wayland preferred — the
 * compositor is the session's native protocol while DISPLAY only implies
 * XWayland.
 */
export function ozonePlatformForLinux(env: LinuxDisplayEnv): LinuxOzonePlatform | undefined {
  const waylandReachable = Boolean(env.waylandDisplay) || env.hasWaylandSocket
  const x11Reachable = Boolean(env.display)
  if (env.xdgSessionType === 'wayland' && waylandReachable) return 'wayland'
  if (env.xdgSessionType === 'x11' && x11Reachable) return 'x11'
  if (waylandReachable) return 'wayland'
  if (x11Reachable) return 'x11'
  return undefined
}

/** Collects the display environment, probing for the default Wayland socket. */
export function linuxDisplayEnv(environment: NodeJS.ProcessEnv = process.env): LinuxDisplayEnv {
  const xdgRuntimeDir = environment['XDG_RUNTIME_DIR']
  return {
    waylandDisplay: environment['WAYLAND_DISPLAY'],
    display: environment['DISPLAY'],
    xdgSessionType: environment['XDG_SESSION_TYPE'],
    hasWaylandSocket:
      typeof xdgRuntimeDir === 'string' &&
      xdgRuntimeDir.length > 0 &&
      existsSync(path.join(xdgRuntimeDir, 'wayland-0')),
  }
}

/**
 * True when argv already carries --ozone-platform. An explicit flag wins over
 * the environment probe — and the flag the relaunch injects is what stops the
 * second hop.
 */
export function argvSpecifiesOzonePlatform(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))
}
