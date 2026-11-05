import { ACP_AGENTS } from '@harness/adapter-acp/agents'
import { setCommandOverride } from '@harness/proc/cli'
import { resolveProviderExecutable } from './custom-harness-launch.js'
import { assertProviderOffered } from './provider-edition.js'
import type { Store } from './store.js'

const DIRECT_COMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  antigravity: 'agy',
  pi: 'pi',
}

function commandFor(source: string): string | undefined {
  if (source.startsWith('acp:')) {
    return ACP_AGENTS.find((agent) => agent.id === source.slice(4) && !agent.retired)?.command
  }
  return DIRECT_COMMANDS[source]
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
  const executable = entered.trim() === '' ? '' : resolveProviderExecutable(entered.trim())
  const paths = store.updateProviderExecutablePath(source, executable)
  setCommandOverride(command, executable || undefined)
  return paths
}
