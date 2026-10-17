import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cliPath,
  latestBrewVersion,
  latestNpmVersion,
  vendorInstallCommand,
  type CliUpdateSource,
} from '@harness/proc/updates'

/**
 * Anthropic's native installer, as https://code.claude.com/docs/en/setup runs
 * it. It needs no Node or npm, and it puts `claude` in ~/.local/bin, which the
 * desktop PATH already searches. `claude update` then updates that install.
 */
export function claudeInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return vendorInstallCommand(
    { windows: 'https://claude.ai/install.ps1', posix: 'https://claude.ai/install.sh' },
    platform,
  )
}

async function releaseChannel(): Promise<'stable' | 'latest'> {
  try {
    const directory = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')
    const settings: unknown = JSON.parse(
      await readFile(path.join(directory, 'settings.json'), 'utf8'),
    )
    return settings &&
      typeof settings === 'object' &&
      'autoUpdatesChannel' in settings &&
      settings.autoUpdatesChannel === 'stable'
      ? 'stable'
      : 'latest'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'latest'
    throw new Error('Could not read the Claude Code update channel.')
  }
}

export const CLAUDE_UPDATES: CliUpdateSource = {
  command: 'claude',
  url: 'https://code.claude.com/docs/en/setup#update-claude-code',
  async check() {
    const executable = await cliPath('claude')
    const parts = executable?.split(path.sep) ?? []
    const cask = parts.includes('Caskroom')
    if (cask) {
      const name = parts.includes('claude-code@latest') ? 'claude-code@latest' : 'claude-code'
      return {
        latestVersion: await latestBrewVersion(name),
        command: `brew upgrade --cask ${name}`,
      }
    }
    const channel = await releaseChannel()
    const latestVersion = await latestNpmVersion('@anthropic-ai/claude-code', channel)
    if (parts.some((part) => part.startsWith('Anthropic.ClaudeCode_'))) {
      return { latestVersion, command: 'winget upgrade --id Anthropic.ClaudeCode --exact' }
    }
    const native =
      parts.includes('versions') ||
      parts.includes('node_modules') ||
      (process.platform === 'win32' &&
        executable === path.join(os.homedir(), '.local', 'bin', 'claude.exe'))
    return { latestVersion, command: native ? 'claude update' : undefined }
  },
}
