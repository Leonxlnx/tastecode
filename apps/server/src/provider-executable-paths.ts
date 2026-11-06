import { ACP_AGENTS } from '@harness/adapter-acp/agents'
import { commandOverride, setCommandOverride, windowsCliCommand } from '@harness/proc/cli'
import { resolveProviderExecutable } from './custom-harness-launch.js'
import { assertProviderOffered } from './provider-edition.js'
import { providerCommand } from './provider-commands.js'
import type { Store } from './store.js'

function commandFor(source: string): string | undefined {
  if (source.startsWith('acp:')) {
    return ACP_AGENTS.find((agent) => agent.id === source.slice(4) && !agent.retired)?.command
  }
  return providerCommand(source)
}

/** Restore paths before provider detection or any adapter can launch. */
export function restoreProviderExecutablePaths(store: Store): void {
  for (const [source, executable] of Object.entries(store.providerExecutablePaths())) {
    const command = commandFor(source)
    if (command) setCommandOverride(command, executable)
  }
}

export function updateProviderExecutablePath(store: Store, source: string, entered: string) {
  const command = commandFor(source)
  if (!command) throw new Error('Unknown built-in CLI provider.')
  assertProviderOffered(
    source.startsWith('acp:') ? 'acp' : (source as Parameters<typeof assertProviderOffered>[0]),
  )
  const executable = entered.trim() === '' ? '' : resolveProviderExecutable(entered)
  const paths = store.updateProviderExecutablePath(source, executable)
  setCommandOverride(command, executable || undefined)
  return paths
}

/** Replace only the known CLI at the start of a trusted login/update command. */
export function selectedProviderShellCommand(source: string, commandLine: string): string {
  const command = commandFor(source)
  const selected = command && commandOverride(command)
  if (!command || !selected) return commandLine
  if (commandLine !== command && !commandLine.startsWith(`${command} `)) {
    throw new Error('Update this custom executable using its own installation instructions.')
  }
  const args = commandLine.slice(command.length).trim().split(/\s+/).filter(Boolean)
  if (process.platform === 'win32') {
    return `"${windowsCliCommand(selected, args, /\.(?:cmd|bat)$/i.test(selected))}"`
  }
  const quoted = `'${selected.replaceAll("'", "'\\''")}'`
  return [quoted, ...args].join(' ')
}
