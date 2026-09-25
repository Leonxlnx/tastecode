/** Official Cursor CLI installer. https://cursor.com/docs/cli/overview */
export function cursorInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const script = `$ErrorActionPreference = 'Stop'; irm 'https://cursor.com/install?win32=true' | iex`
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  // The installer is bash. Fetch it completely before executing so a curl failure
  // cannot look like a successful install.
  return `/bin/sh -c 'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 https://cursor.com/install) && printf "%s" "$installer" | /usr/bin/env bash'`
}
