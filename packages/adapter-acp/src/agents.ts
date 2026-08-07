import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account, Model, ProviderSetup } from '@harness/contracts'
import { isInstalled, killTree, spawnCli } from '@harness/proc'

/**
 * Agents we know how to launch in ACP mode.
 *
 * This is a list of launch commands, not a list of integrations. Every entry
 * goes through the same adapter — that is the entire argument for supporting
 * ACP at all. Adding an agent is a row here.
 *
 * `verified` marks the ones whose frames were actually captured and read while
 * writing the adapter. The rest are launched on the strength of their own
 * documentation, so they are offered but labelled honestly rather than
 * presented as tested.
 */

export type AcpAgentSpec = {
  id: string
  name: string
  /** Executable, resolved on PATH. May be an npm shim on Windows. */
  command: string
  args: string[]
  /** True when frames from this agent were captured and read by us. */
  verified: boolean
  /** Wire version captured while verifying this agent. */
  supportedVersion?: string
  /** Shown when the binary is missing, so the user knows what to install. */
  install?: string
  setup: ProviderSetup
  /** Why sign-in or use is impaired right now, in words shown to the user. */
  problem?: string
  /** CLI flag used to select a model before the ACP handshake. */
  modelArg?: string
  /** ACP config option used to select a model after creating a session. */
  modelConfigId?: string
  /**
   * No longer offered anywhere in the product. The spec itself must remain:
   * resuming a persisted session still needs the launch command, and deleting
   * the row would turn old threads into a crash instead of a session.
   */
  retired?: boolean
  /**
   * File whose existence marks a completed provider login, relative to the
   * user's home directory. Existence only — the content is the provider's
   * credential and is never read. Absent when the CLI gives us no way to
   * tell, in which case sign-in state stays unknown.
   */
  credentialProbe?: string
}

export const ACP_AGENTS: AcpAgentSpec[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    verified: true,
    modelArg: '--model',
    install: 'npm i -g @google/gemini-cli',
    setup: {
      installUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md',
      installCommand: 'npm install -g @google/gemini-cli',
      login: 'provider',
    },
    // Google discontinued Gemini Code Assist for individuals on 2026-06-18
    // and Antigravity is the direct provider that replaced it, so the row is
    // retired from every listing (decided 2026-08-07). Existing gemini
    // threads still resume through this spec.
    retired: true,
    problem:
      'Google ended individual sign-in (June 2026) — use an organization account or set GEMINI_API_KEY.',
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    verified: true,
    supportedVersion: '0.29',
    modelConfigId: 'model',
    // kimi-code 0.29.1 has no auth-status command (`kimi --help` offers only
    // login/provider/doctor), and the ACP initialize response advertises auth
    // *methods* regardless of state. Its config.toml keys `oauth/kimi-code`
    // into this credentials store, so the file's existence is the one signal
    // a completed device-code login leaves behind. Captured 2026-08-07.
    credentialProbe: join('.kimi-code', 'credentials', 'kimi-code.json'),
    install: 'npm install -g @moonshot-ai/kimi-code',
    setup: {
      installUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started.html',
      installCommand: 'npm install -g @moonshot-ai/kimi-code',
      login: 'provider',
    },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    args: ['--experimental-acp'],
    // A Gemini CLI fork, so the same flag and very likely the same frames.
    // Not claimed as verified until someone has actually run it.
    verified: false,
    modelArg: '--model',
    install: 'npm i -g @qwen-code/qwen-code',
    setup: {
      installUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
      installCommand: 'npm install -g @qwen-code/qwen-code@latest',
      login: 'provider',
    },
    // Dropped from the roster on Leon's call (2026-08-08); existing qwen
    // threads still resume through this spec, same as gemini.
    retired: true,
  },
]

/** The agents offered in listings — retirement hides an agent everywhere new. */
export const LISTED_AGENTS: AcpAgentSpec[] = ACP_AGENTS.filter((agent) => !agent.retired)

/** Resolves retired agents too: resume must outlive the listing. */
export function findAgentSpec(id: string): AcpAgentSpec | undefined {
  return ACP_AGENTS.find((agent) => agent.id === id)
}

export async function detectAgents(): Promise<Array<AcpAgentSpec & { installed: boolean }>> {
  return Promise.all(
    LISTED_AGENTS.map(async (agent) => ({ ...agent, installed: await isInstalled(agent.command) })),
  )
}

/**
 * Sign-in state as far as the agent's CLI lets us observe it. Agents declare
 * the file a completed login leaves behind (`credentialProbe`); we check that
 * it exists and nothing more — reading it would cross the credential
 * boundary in rules/security.md. Without a probe the state is unknown and
 * reported as signed-out, which keeps the sign-in flow reachable.
 */
export function acpAccount(agentId: string, home = homedir()): Account {
  const spec = findAgentSpec(agentId)
  if (!spec?.credentialProbe) return { signedIn: false }
  return { signedIn: existsSync(join(home, spec.credentialProbe)) }
}

/**
 * Sign out by removing the credential the login left behind — the CLIs
 * offer no logout command, and deleting the file is exactly what one would
 * do. The file is removed, never read. Throws for agents without a probe so
 * the UI knows not to offer the action.
 */
export function acpSignOut(agentId: string, home = homedir()): void {
  const spec = findAgentSpec(agentId)
  if (!spec?.credentialProbe) {
    throw new Error(`${spec?.name ?? agentId} does not support signing out from here`)
  }
  rmSync(join(home, spec.credentialProbe), { force: true })
}

/**
 * Model choices exposed by the agent's own stable surface.
 *
 * The Gemini ids are the concrete names `--model` accepts, taken from
 * gemini-cli-core's VALID_GEMINI_MODELS (verified against gemini-cli 0.21.x),
 * plus the `auto` routing alias. Concrete names are what people recognise from
 * Google's own docs; `auto` stays the default because routing is the CLI's
 * recommended mode.
 */
export async function discoverAgentModels(agentId: string): Promise<Model[]> {
  if (agentId === 'gemini') {
    return [
      model('gemini-3-pro-preview', 'Gemini 3 Pro (Preview)', 'Most capable Gemini model', true),
      model('gemini-3-flash-preview', 'Gemini 3 Flash (Preview)', 'Fast Gemini 3 model'),
      model('gemini-2.5-pro', 'Gemini 2.5 Pro', 'Stable Pro model'),
      model('gemini-2.5-flash', 'Gemini 2.5 Flash', 'Stable fast model'),
      model('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite', 'Lightest and cheapest model'),
    ]
  }
  if (agentId !== 'kimi') return []
  return parseKimiModels(await captureCli('kimi', ['provider', 'list', '--json']))
}

function model(id: string, displayName: string, description: string, isDefault = false): Model {
  return { id, displayName, description, isDefault, reasoningEfforts: [], serviceTiers: [] }
}

export function parseKimiModels(output: string): Model[] {
  const parsed = JSON.parse(output) as { models?: Record<string, unknown> }
  const entries = Object.entries(parsed.models ?? {})
  return entries.map(([id, value], index) => {
    const details = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    const efforts = Array.isArray(details.supportEfforts)
      ? details.supportEfforts.filter((effort): effort is string => typeof effort === 'string')
      : []
    return {
      id,
      displayName: typeof details.displayName === 'string' ? details.displayName : id,
      isDefault: index === 0,
      reasoningEfforts: efforts,
      ...(typeof details.defaultEffort === 'string'
        ? { defaultReasoningEffort: details.defaultEffort }
        : {}),
      serviceTiers: [],
    }
  })
}

function captureCli(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args)
    let output = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(output)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(new Error(`${command} model discovery timed out`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.on('error', (error) => finish(error))
    child.on('exit', (code) =>
      finish(code === 0 ? undefined : new Error(`${command} model discovery failed`)),
    )
  })
}
