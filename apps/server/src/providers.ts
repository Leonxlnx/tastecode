import { ANTIGRAVITY_CAPABILITIES } from '@harness/adapter-antigravity'
import { CURSOR_CAPABILITIES } from '@harness/adapter-cursor'
import { OPENCODE_CAPABILITIES } from '@harness/adapter-opencode'
import { PI_CAPABILITIES } from '@harness/adapter-pi'
import { codexLoginStatus } from '@harness/adapter-codex/auth'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex/capabilities'
import { GROK_CAPABILITIES } from '@harness/adapter-grok/capabilities'
import { CODEX_UPDATES, codexInstallCommand } from '@harness/adapter-codex/updates'
import { CLAUDE_UPDATES, claudeInstallCommand } from '@harness/adapter-claude-code/updates'
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
 * A probe may declare a short sign-in check that reads its CLI's public output
 * (Codex does); every other provider is answered later by its account read.
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
  /** Interactive sign-in command, for providers whose login lives in their own CLI. */
  loginCommand?: string
  /**
   * A short sign-in check the scan runs for an installed CLI, from that CLI's
   * public output. Without one the scan reports `unknown` and the account read
   * decides later.
   */
  auth?: () => Promise<ProviderStatus['auth']>
  /**
   * False when the scan must never start the CLI to ask its version: finding
   * the binary is enough to call it installed, and the version stays unknown.
   */
  readsVersion?: false
  /** Set when the adapter does not exist yet, in words we can show the user. */
  unbuilt?: string
}

/**
 * The order here is the order `providers.list` reports, and the renderer
 * builds its catalog, first-run choice and update list from that answer.
 * Claude Code leads, then Codex and Grok, then the other CLIs. ACP is one
 * entry over many agents and `scanProviders` appends it after these.
 */
const PROBES: Probe[] = [
  {
    id: 'claude-code',
    updater: CLAUDE_UPDATES,
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    setup: {
      installUrl: 'https://code.claude.com/docs/en/getting-started',
      installCommand: claudeInstallCommand(),
      login: 'provider',
      loginOpensBrowser: true,
    },
    loginCommand: 'claude auth login',
  },
  {
    id: 'codex',
    updater: CODEX_UPDATES,
    displayName: 'Codex',
    command: 'codex',
    capabilities: CODEX_CAPABILITIES,
    setup: {
      installUrl: 'https://developers.openai.com/codex/cli',
      installCommand: codexInstallCommand(),
      login: 'provider',
      loginOpensBrowser: true,
    },
    loginCommand: 'codex login',
    auth: () => codexLoginStatus(),
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
  {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'cursor-agent',
    capabilities: CURSOR_CAPABILITIES,
    // No version gate: cursor-agent updates itself to a new date-stamped build
    // every month, and a gate blocked each working one. A changed wire still
    // fails the turn, through the stream's ProtocolFrameError.
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
    loginCommand: 'opencode auth login',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    command: 'agy',
    capabilities: ANTIGRAVITY_CAPABILITIES,
    setup: {
      installUrl: 'https://antigravity.google/docs/cli',
      login: 'provider',
    },
    // First interactive run signs in with the user's Google account; there is
    // no separate login subcommand as of agy 1.4.0.
    loginCommand: 'agy',
    // Every agy start launches its language server and may launch its
    // self-updater, which replaces agy.exe in place. A scan that started it
    // for `--version` (12.8 s cold, minutes right after an update) and killed
    // it at the time limit could stop that updater mid-swap and leave no
    // binary behind. Finding agy is all the scan needs.
    readsVersion: false,
  },
  {
    id: 'pi',
    displayName: 'Pi',
    command: 'pi',
    capabilities: PI_CAPABILITIES,
    setup: {
      installUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
      login: 'provider',
    },
    loginCommand: 'pi',
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
  auth(provider: ProviderStatus['id']): Promise<ProviderStatus['auth']>
  acpAgents(): Promise<Array<{ name: string; installed: boolean }>>
}

const REAL_SYSTEM: SystemProbe = {
  isInstalled,
  version: commandVersion,
  acpAgents: async () => (await import('@harness/adapter-acp/agents')).detectAgents(),
  auth: (provider) => installTimeAuth(provider),
}

/** The sign-in check a provider's probe declares, or `unknown` when it has none. */
export function installTimeAuth(provider: ProviderStatus['id']): Promise<ProviderStatus['auth']> {
  return PROBES.find((entry) => entry.id === provider)?.auth?.() ?? Promise.resolve('unknown')
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

  const detection = Promise.all([
    Promise.all(PROBES.map((entry) => probe(entry, system))),
    acpStatus(system),
  ]).then(([direct, acp]) => [...direct, acp])
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

  const [version, auth] = await Promise.all([
    entry.readsVersion === false ? undefined : system.version(entry.command),
    system.auth(entry.id),
  ])
  return {
    id: entry.id,
    displayName: entry.displayName,
    installed: true,
    auth,
    setup: entry.setup,
    ...(version ? { version } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
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
