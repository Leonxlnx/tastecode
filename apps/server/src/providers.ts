import { codexLoginStatus } from '@harness/adapter-codex/auth'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex/capabilities'
import { GROK_CAPABILITIES } from '@harness/adapter-grok/capabilities'
import { CODEX_UPDATES } from '@harness/adapter-codex/updates'
import { CLAUDE_UPDATES } from '@harness/adapter-claude-code/updates'
import { GROK_UPDATES } from '@harness/adapter-grok/updates'
import type { CliUpdateSource } from '@harness/proc/updates'
import type { ProviderSetup, ProviderStatus } from '@harness/contracts'
import { commandVersion, isInstalled } from '@harness/proc/cli'

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
  updater?: CliUpdateSource
  supportedVersion?: string
  /** Interactive sign-in command, for providers whose login lives in their own CLI. */
  loginCommand?: string
  /** Set when the adapter does not exist yet, in words we can show the user. */
  unbuilt?: string
}

const PROBES: Probe[] = [
  {
    id: 'codex',
    updater: CODEX_UPDATES,
    displayName: 'Codex',
    command: 'codex',
    capabilities: CODEX_CAPABILITIES,
    setup: {
      installUrl: 'https://developers.openai.com/codex/cli',
      installCommand: 'npm install -g @openai/codex',
      login: 'provider',
      loginOpensBrowser: true,
    },
    loginCommand: 'codex login',
  },
  {
    id: 'claude-code',
    updater: CLAUDE_UPDATES,
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    setup: {
      installUrl: 'https://code.claude.com/docs/en/getting-started',
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      login: 'provider',
      loginOpensBrowser: true,
    },
    loginCommand: 'claude auth login',
  },
  {
    id: 'grok',
    updater: GROK_UPDATES,
    displayName: 'Grok',
    command: 'grok',
    capabilities: GROK_CAPABILITIES,
    setup: {
      installUrl: 'https://x.ai/cli',
      login: 'provider',
      loginOpensBrowser: false,
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
  auth(provider: ProviderStatus['id']): Promise<ProviderStatus['auth']>
}

const REAL_SYSTEM: SystemProbe = {
  isInstalled,
  version: commandVersion,
  auth: (provider) =>
    provider === 'codex' ? codexLoginStatus() : Promise.resolve<ProviderStatus['auth']>('unknown'),
}

export function providerUpdateSources() {
  return PROBES.flatMap((entry) =>
    entry.updater
      ? [{ provider: entry.id, displayName: entry.displayName, updater: entry.updater }]
      : [],
  )
}

/**
 * The install command for a provider or ACP agent, from the tables above and
 * nowhere else. The renderer names a target; it never sends command text —
 * that is what keeps `providers.install` from being a remote shell.
 */
export async function installCommandFor(
  provider: ProviderStatus['id'],
  agent?: string,
): Promise<string> {
  const target =
    provider === 'acp'
      ? await (async () => {
          const { findAgentSpec } = await import('@harness/adapter-acp/agents')
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
export async function launchCommandFor(
  provider: ProviderStatus['id'],
  agent?: string,
): Promise<string> {
  if (provider === 'acp') {
    const { findAgentSpec } = await import('@harness/adapter-acp/agents')
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
const PROVIDER_PREWARM_TTL_MS = 30_000
const prewarmedProviderDetections = new WeakMap<
  SystemProbe,
  { detection: Promise<ProviderStatus[]>; expiresAt: number }
>()

/**
 * Start one provider scan before the renderer asks for it. The resolved result
 * is consumed once, so later refreshes still observe installs and login changes.
 */
export function prewarmProviders(system: SystemProbe = REAL_SYSTEM): Promise<ProviderStatus[]> {
  const current = prewarmedProviderDetections.get(system)
  if (current) return current.detection

  const detection = scanProviders(system)
  prewarmedProviderDetections.set(system, {
    detection,
    expiresAt: Date.now() + PROVIDER_PREWARM_TTL_MS,
  })
  void detection.catch(() => {
    if (prewarmedProviderDetections.get(system)?.detection === detection) {
      prewarmedProviderDetections.delete(system)
    }
  })
  return detection
}

export function detectProviders(system: SystemProbe = REAL_SYSTEM): Promise<ProviderStatus[]> {
  const prewarmed = prewarmedProviderDetections.get(system)
  if (prewarmed) {
    prewarmedProviderDetections.delete(system)
    if (prewarmed.expiresAt >= Date.now()) return prewarmed.detection
  }

  return scanProviders(system)
}

function scanProviders(system: SystemProbe): Promise<ProviderStatus[]> {
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

  const [version, auth] = await Promise.all([system.version(entry.command), system.auth(entry.id)])
  const unsupported = version && entry.supportedVersion && !version.includes(entry.supportedVersion)
  return {
    id: entry.id,
    displayName: entry.displayName,
    installed: true,
    auth,
    setup: entry.setup,
    ...(version ? { version } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    ...(unsupported
      ? {
          problem: `Adapter supports ${entry.supportedVersion}.x; installed version is ${version}`,
        }
      : {}),
  }
}
