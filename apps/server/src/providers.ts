import { detectAgents } from '@harness/adapter-acp'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex'
import { CURSOR_CAPABILITIES, CURSOR_SUPPORTED_VERSION } from '@harness/adapter-cursor'
import { OPENCODE_CAPABILITIES } from '@harness/adapter-opencode'
import type { ProviderSetup, ProviderStatus } from '@harness/contracts'
import { commandVersion, isInstalled } from '@harness/proc'

/**
 * What this machine can actually run.
 *
 * Detection is by looking for the binary and asking it its version. We never
 * inspect a credential file to decide whether someone is signed in — that is
 * the line in rules/security.md, and it is why `auth` is mostly `unknown` here.
 * The one provider that can tell us is Codex, which answers over its own
 * protocol, and that answer is fetched on demand rather than on every listing.
 *
 * A provider we have not built stays in the list with a `problem` explaining
 * why. Silently omitting it would leave the user unable to tell "not supported"
 * from "not installed".
 */

type Probe = {
  id: ProviderStatus['id']
  displayName: string
  command?: string
  capabilities?: ProviderStatus['capabilities']
  setup: ProviderSetup
  supportedVersion?: string
  /** Set when the adapter does not exist yet, in words we can show the user. */
  unbuilt?: string
}

const PROBES: Probe[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    capabilities: CODEX_CAPABILITIES,
    setup: {
      installUrl: 'https://help.openai.com/en/articles/11096431',
      installCommand: 'npm install -g @openai/codex',
      login: 'app',
    },
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    setup: {
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      login: 'app',
    },
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'cursor-agent',
    capabilities: CURSOR_CAPABILITIES,
    supportedVersion: CURSOR_SUPPORTED_VERSION,
    setup: {
      installUrl: 'https://docs.cursor.com/en/cli/installation',
      login: 'app',
    },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    capabilities: OPENCODE_CAPABILITIES,
    setup: {
      installUrl: 'https://opencode.ai/en/docs',
      installCommand: 'npm install -g opencode-ai',
      login: 'provider',
    },
  },
]

/**
 * The machine, as far as this file is concerned.
 *
 * Injected so the reporting logic can be tested without a real PATH — the
 * interesting part is what we say about what we found, and that should not
 * depend on which agents happen to be installed on the machine running CI.
 */
export type SystemProbe = {
  isInstalled(command: string): Promise<boolean>
  version(command: string): Promise<string | undefined>
  acpAgents(): Promise<Array<{ name: string; installed: boolean }>>
}

const REAL_SYSTEM: SystemProbe = {
  isInstalled,
  version: commandVersion,
  acpAgents: detectAgents,
}

export async function detectProviders(
  system: SystemProbe = REAL_SYSTEM,
): Promise<ProviderStatus[]> {
  const direct = await Promise.all(PROBES.map((entry) => probe(entry, system)))
  return [...direct, await acpStatus(system)]
}

async function probe(entry: Probe, system: SystemProbe): Promise<ProviderStatus> {
  if (!entry.command) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      installed: false,
      auth: 'unknown',
      setup: entry.setup,
      ...(entry.unbuilt ? { problem: entry.unbuilt } : {}),
    }
  }

  const installed = await system.isInstalled(entry.command)
  if (!installed) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      installed: false,
      auth: 'unknown',
      setup: entry.setup,
      problem: `${entry.command} is not on PATH`,
    }
  }

  const version = await system.version(entry.command)
  const unsupported = version && entry.supportedVersion && !version.includes(entry.supportedVersion)
  return {
    id: entry.id,
    displayName: entry.displayName,
    installed: true,
    auth: 'unknown',
    setup: entry.setup,
    ...(version ? { version } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    ...(unsupported
      ? { problem: `Adapter supports ${entry.supportedVersion}.x; installed version is ${version}` }
      : {}),
  }
}

/**
 * ACP is one integration over many agents, so "installed" means at least one
 * of them is present, and the names of those go in the version field — there is
 * no single binary whose version would mean anything here.
 */
async function acpStatus(system: SystemProbe): Promise<ProviderStatus> {
  const agents = await system.acpAgents()
  const present = agents.filter((agent) => agent.installed)

  return {
    id: 'acp',
    displayName: 'ACP agents',
    installed: present.length > 0,
    auth: 'unknown',
    ...(present.length > 0 ? { version: present.map((agent) => agent.name).join(', ') } : {}),
    ...(present.length === 0 ? { problem: 'No ACP agent found on PATH' } : {}),
  }
}
