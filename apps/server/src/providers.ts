import { detectAgents, findAgentSpec } from '@harness/adapter-acp'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex'
import { GROK_CAPABILITIES } from '@harness/adapter-grok'
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
  /** Interactive sign-in command, for providers whose login lives in their own CLI. */
  loginCommand?: string
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
    id: 'grok',
    displayName: 'Grok',
    command: 'grok',
    capabilities: GROK_CAPABILITIES,
    setup: {
      installUrl: 'https://x.ai/',
      login: 'provider',
    },
    // Device flow in the CLI's own terminal, same shape as `kimi login`.
    loginCommand: 'grok login',
  },
]

/**
 * The public beta ships exactly three subscription plans: Codex, Claude Code
 * and Grok (Leon's release scope, 2026-08-07). The Cursor, OpenCode,
 * Antigravity and ACP adapters stay in the repo fully working and return to
 * this roster after the beta — docs/dashboard.html tracks that list.
 */

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

/**
 * The install command for a provider or ACP agent, from the tables above and
 * nowhere else. The renderer names a target; it never sends command text —
 * that is what keeps `providers.install` from being a remote shell.
 */
export function installCommandFor(provider: ProviderStatus['id'], agent?: string): string {
  const target =
    provider === 'acp'
      ? (() => {
          const spec = agent ? findAgentSpec(agent) : undefined
          return spec ? { name: spec.name, setup: spec.setup } : undefined
        })()
      : (() => {
          const entry = PROBES.find((candidate) => candidate.id === provider)
          return entry ? { name: entry.displayName, setup: entry.setup } : undefined
        })()
  if (!target) throw new Error(`unknown install target: ${agent ?? provider}`)
  if (!target.setup.installCommand) {
    throw new Error(`${target.name} has no scripted install; use its setup page`)
  }
  return target.setup.installCommand
}

/**
 * The interactive sign-in command for a provider whose login lives in its own
 * CLI (`setup.login === 'provider'`). Same boundary as `installCommandFor`:
 * the renderer names a target and the command comes from these tables only.
 * ACP agents sign in inside their ordinary interactive CLI, so the launch is
 * the bare binary; direct providers name an explicit login command.
 */
export function launchCommandFor(provider: ProviderStatus['id'], agent?: string): string {
  if (provider === 'acp') {
    const spec = agent ? findAgentSpec(agent) : undefined
    if (!spec) throw new Error(`unknown launch target: ${agent ?? provider}`)
    if (spec.setup.login !== 'provider') {
      throw new Error(`${spec.name} signs in through the app, not its own CLI`)
    }
    return spec.command
  }
  const entry = PROBES.find((candidate) => candidate.id === provider)
  if (!entry) throw new Error(`unknown launch target: ${provider}`)
  if (entry.setup.login !== 'provider' || !entry.loginCommand) {
    throw new Error(`${entry.displayName} signs in through the app, not its own CLI`)
  }
  return entry.loginCommand
}

const providerDetections = new WeakMap<SystemProbe, Promise<ProviderStatus[]>>()

export function detectProviders(system: SystemProbe = REAL_SYSTEM): Promise<ProviderStatus[]> {
  const current = providerDetections.get(system)
  if (current) return current

  // Beta roster: direct probes only. The ACP aggregate row returns together
  // with the parked adapters after the beta.
  const detection = Promise.all(PROBES.map((entry) => probe(entry, system)))
  providerDetections.set(system, detection)
  const clear = () => {
    if (providerDetections.get(system) === detection) providerDetections.delete(system)
  }
  void detection.then(clear, clear)
  return detection
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
