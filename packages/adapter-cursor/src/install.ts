import { vendorInstallCommand } from '@harness/proc/updates'

/**
 * Cursor's installer, as https://cursor.com/docs/cli/installation runs it. On
 * Windows it installs to %LOCALAPPDATA%\cursor-agent and on macOS and Linux it
 * links ~/.local/bin/cursor-agent; the desktop PATH searches both. Newer
 * installers also add an `agent` command, but `cursor-agent` is still created,
 * and it is the name detection and the launcher use.
 */
export function cursorInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return vendorInstallCommand(
    { windows: 'https://cursor.com/install?win32=true', posix: 'https://cursor.com/install' },
    platform,
  )
}
