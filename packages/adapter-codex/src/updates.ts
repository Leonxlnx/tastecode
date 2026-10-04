import path from 'node:path'
import { runCli } from '@harness/proc/cli'
import {
  cliPath,
  latestBrewVersion,
  latestNpmVersion,
  type CliUpdateSource,
} from '@harness/proc/updates'

/** Official standalone installers work on fresh desktops without Node or npm.
 * https://developers.openai.com/codex/cli */
export function codexInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const script = `$ErrorActionPreference = 'Stop'; $env:CODEX_NON_INTERACTIVE = '1'; Invoke-RestMethod 'https://chatgpt.com/codex/install.ps1' | Invoke-Expression`
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  // Fetch completely before executing; curl failure must not look like a successful install.
  return `/bin/sh -c 'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 https://chatgpt.com/codex/install.sh) && printf "%s" "$installer" | CODEX_NON_INTERACTIVE=1 /bin/sh'`
}

export const CODEX_UPDATES: CliUpdateSource = {
  command: 'codex',
  url: 'https://developers.openai.com/codex/cli',
  async check(currentVersion) {
    const tag = currentVersion.includes('-alpha') ? 'alpha' : 'latest'
    const executable = await cliPath('codex')
    const parts = executable?.split(path.sep) ?? []
    if (parts.includes('Caskroom'))
      return {
        latestVersion: await latestBrewVersion('codex'),
        command: 'brew upgrade --cask codex',
      }
    const latestVersion = await latestNpmVersion('@openai/codex', tag)
    if (parts.includes('.pnpm')) {
      return { latestVersion, command: `pnpm add -g @openai/codex@${tag}` }
    }
    if (parts.includes('.bun')) {
      return { latestVersion, command: `bun add -g @openai/codex@${tag}` }
    }
    if (parts.includes('yarn')) {
      return { latestVersion, command: `yarn global add @openai/codex@${tag}` }
    }
    if (parts.includes('node_modules')) {
      return { latestVersion, command: `npm install -g @openai/codex@${tag}` }
    }
    // Older Codex releases did not have the native updater.
    const help = await runCli('codex', ['update', '--help'])
    return {
      latestVersion,
      command: help.code === 0 && /codex update/.test(help.stdout) ? 'codex update' : undefined,
    }
  },
}
