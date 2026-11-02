import { vendorInstallCommand } from '@harness/proc/updates'

/**
 * Google's Antigravity CLI installer, as
 * https://antigravity.google/docs/getting-started?tab=cli runs it. It puts
 * `agy` in %LOCALAPPDATA%\agy\bin on Windows and ~/.local/bin elsewhere, both
 * on the desktop PATH. It does not sign in: agy asks for the Google account
 * on its first interactive run, which is what Sign in launches.
 */
export function antigravityInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return vendorInstallCommand(
    {
      windows: 'https://antigravity.google/cli/install.ps1',
      posix: 'https://antigravity.google/cli/install.sh',
    },
    platform,
  )
}
