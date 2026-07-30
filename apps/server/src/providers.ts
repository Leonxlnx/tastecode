import { detectAgents } from '@harness/adapter-acp'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex'
import type { ProviderStatus } from '@harness/contracts'
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
  /** Set when the adapter does not exist yet, in words we can show the user. */
  unbuilt?: string
}

const PROBES: Probe[] = [
  { id: 'codex', displayName: 'Codex', command: 'codex', capabilities: CODEX_CAPABILITIES },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
  },
  { id: 'cursor', displayName: 'Cursor', unbuilt: 'Not supported yet' },
  { id: 'opencode', displayName: 'OpenCode', unbuilt: 'Not supported yet' },
]

export async function detectProviders(): Promise<ProviderStatus[]> {
  const direct = await Promise.all(PROBES.map(probe))
  return [...direct, await acpStatus()]
}

async function probe(entry: Probe): Promise<ProviderStatus> {
  if (!entry.command) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      installed: false,
      auth: 'unknown',
      ...(entry.unbuilt ? { problem: entry.unbuilt } : {}),
    }
  }

  const installed = await isInstalled(entry.command)
  if (!installed) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      installed: false,
      auth: 'unknown',
      problem: `${entry.command} is not on PATH`,
    }
  }

  const version = await commandVersion(entry.command)
  return {
    id: entry.id,
    displayName: entry.displayName,
    installed: true,
    auth: 'unknown',
    ...(version ? { version } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
  }
}

/**
 * ACP is one integration over many agents, so "installed" means at least one
 * of them is present, and the names of those go in the version field — there is
 * no single binary whose version would mean anything here.
 */
async function acpStatus(): Promise<ProviderStatus> {
  const agents = await detectAgents()
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
