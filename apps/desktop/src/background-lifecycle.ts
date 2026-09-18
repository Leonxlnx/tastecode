export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  appIsQuitting: boolean,
  hasTray = false,
): boolean {
  // Windows always owns a tray. Linux gets one only where the desktop runs a
  // StatusNotifier host (KDE, COSMIC, GNOME with AppIndicator) — without it a
  // hidden window would have no way back, so the close still destroys it.
  return (platform === 'win32' || (platform === 'linux' && hasTray)) && !appIsQuitting
}

const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher'

/**
 * Whether a D-Bus name listing shows a StatusNotifierWatcher. Accepts both
 * shapes the probe produces: `busctl --user list` table rows and the
 * `string "org.kde.StatusNotifierWatcher"` entries from dbus-send ListNames.
 */
export function dbusNamesIncludeStatusNotifierWatcher(output: string): boolean {
  return output.split(/[\s"',;:()[\]{}|]+/).includes(STATUS_NOTIFIER_WATCHER)
}

export type LinuxTrayHostProbeRun = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

const trayHostProbeAttempts: ReadonlyArray<readonly [string, string[]]> = [
  ['busctl', ['--user', 'list', '--no-pager']],
  [
    'dbus-send',
    [
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/',
      'org.freedesktop.DBus.ListNames',
    ],
  ],
]

/**
 * Whether the session D-Bus has a StatusNotifierWatcher — the only condition
 * under which an Electron tray icon is actually visible on Linux. The `Tray`
 * constructor alone is not proof: on desktops without a host it succeeds and
 * the icon is simply never shown, which would turn close-to-tray into a ghost
 * process. Any failure (no bus, missing tools, timeout) answers "no tray".
 */
export async function probeLinuxTrayHost(
  options: { run?: LinuxTrayHostProbeRun; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1500
  const run: LinuxTrayHostProbeRun =
    options.run ??
    ((command, args, timeout) =>
      import('@harness/proc/cli').then(({ runCli }) => runCli(command, args, timeout)))
  for (const [command, args] of trayHostProbeAttempts) {
    try {
      const result = await run(command, args, timeoutMs)
      if (result.code === 0 && dbusNamesIncludeStatusNotifierWatcher(result.stdout)) {
        return true
      }
    } catch {
      // Missing binary or a dead session bus — try the next listing tool.
    }
  }
  return false
}

/**
 * Ubuntu 23.10+ can restrict unprivileged user namespaces behind
 * `kernel.apparmor_restrict_unprivileged_userns`. An AppImage cannot ship a
 * setuid chrome-sandbox inside its FUSE mount, so with the sysctl at 1 the
 * renderer sandbox cannot start. A missing file means the restriction does
 * not exist on this kernel — the AppImage is fine.
 */
export function appImageUserNamespaceBlocked(sysctlContents: string | undefined): boolean {
  return sysctlContents?.trim() === '1'
}
