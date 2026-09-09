import path from 'node:path'
import { runCli } from '@harness/proc/cli'
import {
  cliPath,
  latestBrewVersion,
  latestNpmVersion,
  type CliUpdateSource,
} from '@harness/proc/updates'

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
