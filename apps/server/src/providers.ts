import { ANTIGRAVITY_CAPABILITIES, antigravityInstallCommand } from '@harness/adapter-antigravity'
import { CURSOR_CAPABILITIES, cursorInstallCommand } from '@harness/adapter-cursor'
import { OPENCODE_CAPABILITIES } from '@harness/adapter-opencode'
import { PI_CAPABILITIES } from '@harness/adapter-pi'
import { codexLoginStatus } from '@harness/adapter-codex/auth'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex/capabilities'
import { GROK_CAPABILITIES } from '@harness/adapter-grok/capabilities'
import { CODEX_UPDATES, codexInstallCommand } from '@harness/adapter-codex/updates'
import { CLAUDE_UPDATES, claudeInstallCommand } from '@harness/adapter-claude-code/updates'
import { GROK_UPDATES, grokInstallCommand } from '@harness/adapter-grok/updates'
import type { CliUpdateSource } from '@harness/proc/updates'
import type { ProviderSetup, ProviderSourceShape, ProviderStatus } from '@harness/contracts'
import { refreshWindowsPath } from '@harness/proc/desktop-path'
import { cliProbe } from './cli-probe.js'

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
  /** What its chat sources must name. Absent means `DIRECT_SOURCE`. */
  source?: ProviderSourceShape
}

/** A CLI that answers for itself; a custom harness may stand in for it. */
const DIRECT_SOURCE: ProviderSourceShape = { agent: 'optional', connection: false, direct: true }
/** One integration over many agents, so the agent is what the user talks to. */
const ACP_SOURCE: ProviderSourceShape = { agent: 'required', connection: false, direct: false }

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
      installCommand: grokInstallCommand(),
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
      installUrl: 'https://cursor.com/docs/cli/installation',
      installCommand: cursorInstallCommand(),
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
      installCommand: antigravityInstallCommand(),
      login: 'provider',
    },
    // The installer does not sign in. agy's first interactive run asks for
    // the Google account; there is no login subcommand as of agy 1.4.0.
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
    // Every Pi chat runs through a named harness.
    source: { agent: 'required', connection: false, direct: true },
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
  /** Pick up PATH changes made since launch, such as an installer's new folder. */
  refreshPath?(): Promise<void>
}

/**
 * The model catalog waits for providers.list, so a listing waits only briefly
 * for a `--version` read; a slow one finishes in the background and the next
 * listing reports it.
 */
const LISTING_VERSION_WAIT_MS = 250
/**
 * The same bound for a sign-in check. `codex login status` took 2.9-11.3 s on
 * a busy machine, and Send waited for all of it. A check that is still running
 * reports its last answer, or `unknown`, which the account read settles.
 */
const LISTING_AUTH_WAIT_MS = 250

type AuthStatus = ProviderStatus['auth']

/**
 * Install-time sign-in checks that answer a listing within `waitMs`. A check
 * that takes longer goes on, and a later listing gets its answer; one check
 * per provider runs at a time.
 */
export class SignInChecks {
  #checks = new Map<ProviderStatus['id'], { last?: AuthStatus; running?: Promise<AuthStatus> }>()

  constructor(
    private readonly check: (provider: ProviderStatus['id']) => Promise<AuthStatus>,
    private readonly waitMs: number,
  ) {}

  read(provider: ProviderStatus['id']): Promise<AuthStatus> {
    let entry = this.#checks.get(provider)
    if (!entry) {
      entry = {}
      this.#checks.set(provider, entry)
    }
    const current = entry
    if (!current.running) {
      const running = this.check(provider).then(
        (value) => value,
        (): AuthStatus => 'unknown',
      )
      current.running = running
      void running.then((value) => {
        current.last = value
        if (current.running === running) current.running = undefined
      })
    }
    const running = current.running
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(current.last ?? 'unknown'), this.waitMs)
      void running.then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }
}

const signInChecks = new SignInChecks((provider) => installTimeAuth(provider), LISTING_AUTH_WAIT_MS)

const REAL_SYSTEM: SystemProbe = {
  isInstalled: (command) => cliProbe.installed(command),
  version: (command) => cliProbe.version(command, { waitMs: LISTING_VERSION_WAIT_MS }),
  acpAgents: async () => (await import('@harness/adapter-acp/agents')).detectAgents(),
  refreshPath: () => refreshWindowsPath(),
  auth: (provider) => signInChecks.read(provider),
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

/**
 * Start one provider scan before the renderer asks for it, so the version
 * reads it needs are under way. The first listing joins it while it runs.
 */
export function prewarmProviders(system: SystemProbe = REAL_SYSTEM): Promise<ProviderStatus[]> {
  return scanProviders(system)
}

/**
 * Every listing scans again, so installs and sign-ins show up. The scan is
 * cheap: lookups run in process and versions come from the shared probe.
 */
export function detectProviders(system: SystemProbe = REAL_SYSTEM): Promise<ProviderStatus[]> {
  return scanProviders(system)
}

function scanProviders(system: SystemProbe): Promise<ProviderStatus[]> {
  const current = providerDetections.get(system)
  if (current) return current

  const scan = () =>
    Promise.all([Promise.all(PROBES.map((entry) => probe(entry, system))), acpStatus(system)])
  const pathRefresh = system.refreshPath?.()
  const detection = (pathRefresh ? pathRefresh.then(scan) : scan()).then(([direct, acp]) => [
    ...direct,
    acp,
  ])
  providerDetections.set(system, detection)
  const clear = () => {
    if (providerDetections.get(system) === detection) providerDetections.delete(system)
  }
  void detection.then(clear, clear)
  return detection
}

async function probe(entry: Probe, system: SystemProbe): Promise<ProviderStatus> {
  const source = entry.source ?? DIRECT_SOURCE
  if (!entry.command) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      installed: false,
      auth: 'unknown',
      setup: entry.setup,
      source,
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
      source,
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
    source,
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
    source: ACP_SOURCE,
    ...(present.length > 0 ? { version: present.map((agent) => agent.name).join(', ') } : {}),
    ...(present.length === 0 ? { problem: 'No ACP agent found on PATH' } : {}),
  }
}
