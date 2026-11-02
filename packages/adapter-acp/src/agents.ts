import { join } from 'node:path'
import type { Model, ProviderSetup } from '@harness/contracts'
import { isInstalled, spawnCli } from '@harness/proc/cli'
import { killTree } from '@harness/proc/kill'
import { vendorInstallCommand } from '@harness/proc/updates'
import { z } from 'zod'

/** Set up through the agent's own CLI: install with `installCommand`, then sign in there. */
function cliSetup(
  installUrl: string,
  installCommand: string | undefined,
  loginOpensBrowser?: boolean,
): ProviderSetup {
  return {
    installUrl,
    ...(installCommand ? { installCommand } : {}),
    login: 'provider',
    ...(loginOpensBrowser === undefined ? {} : { loginOpensBrowser }),
  }
}

/** The vendor's install script; without a Windows one, Windows gets the setup guide. */
function scriptInstall(
  urls: { posix: string; windows?: string },
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32' && !urls.windows) return undefined
  return vendorInstallCommand({ posix: urls.posix, windows: urls.windows ?? urls.posix }, platform)
}

const KimiModelsSchema = z.object({
  models: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        supportEfforts: z.array(z.string()).optional(),
        defaultEffort: z.string().optional(),
      }),
    )
    .default({}),
})

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
  /** Who makes the agent, as the vendor names itself. Shown in the library. */
  maker?: string
  /** The CLI's own sign-in command; without one, its first interactive run signs in. */
  loginArgs?: string[]
  /** The CLI's own sign-out command. */
  logoutArgs?: string[]
  /**
   * A sign-in check from the CLI's public output: `args` runs it and
   * `signedIn` matches what it prints once someone is signed in.
   */
  authStatus?: { args: string[]; signedIn: RegExp }
  /**
   * The agent names its models on a new session (session-models.ts), and its
   * sign-in shows there too: an agent that is not signed in refuses the
   * session. Used when the CLI has no cheaper check.
   */
  sessionModels?: boolean
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
  // The library: popular agents from the ACP registry
  // (agentclientprotocol.com/get-started/agents) whose own CLI speaks ACP.
  // Agents that are already providers of their own (Claude Code, Codex, Grok,
  // Cursor, OpenCode, Antigravity, Pi) are not repeated here, and neither are
  // registry entries that wrap another vendor's CLI. Launch arguments follow
  // the registry; install and sign-in follow each vendor's own docs.
  {
    id: 'devin',
    name: 'Devin',
    maker: 'Cognition',
    command: 'devin',
    args: ['acp'],
    // Initialize and session/new captured from devin 3000.11.3 on 2026-10-19.
    verified: true,
    authStatus: { args: ['auth', 'status'], signedIn: /^Logged in\b/m },
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.devin.ai/cli',
      scriptInstall({
        posix: 'https://cli.devin.ai/install.sh',
        windows: 'https://static.devin.ai/cli/setup.ps1',
      }),
      true,
    ),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    maker: 'GitHub',
    command: 'copilot',
    args: ['--acp'],
    // Initialize captured from copilot 1.0.100 on 2026-10-19; session/new
    // answered auth_required (-32000) while signed out.
    verified: true,
    loginArgs: ['login'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
      'npm install -g @github/copilot',
      true,
    ),
  },
  {
    id: 'droid',
    name: 'Droid',
    maker: 'Factory',
    command: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    // Initialize captured from droid 0.233.0 on 2026-10-19; its session/new
    // answered auth_required (-32000) while signed out, which is the sign-in
    // check. Its login lives in the keychain, so no file says more.
    verified: true,
    sessionModels: true,
    setup: cliSetup(
      'https://docs.factory.ai/cli/getting-started/quickstart',
      scriptInstall({
        posix: 'https://app.factory.ai/cli',
        windows: 'https://app.factory.ai/cli/windows',
      }),
      true,
    ),
  },
  {
    id: 'cline',
    name: 'Cline',
    maker: 'Cline',
    command: 'cline',
    args: ['--acp'],
    verified: false,
    loginArgs: ['auth'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.cline.bot/getting-started/installing-cline',
      'npm install -g cline',
      true,
    ),
  },
  {
    id: 'goose',
    name: 'goose',
    maker: 'Block',
    command: 'goose',
    args: ['acp'],
    verified: false,
    // goose has no account; `configure` picks the model provider and key.
    loginArgs: ['configure'],
    sessionModels: true,
    setup: cliSetup(
      'https://goose-docs.ai/docs/getting-started/installation',
      // Windows takes a two-step PowerShell download, so it gets the guide.
      scriptInstall({
        posix: 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh',
      }),
    ),
  },
  {
    id: 'junie',
    name: 'Junie',
    maker: 'JetBrains',
    command: 'junie',
    args: ['--acp=true'],
    verified: false,
    // No login command: the first interactive run offers the JetBrains login.
    sessionModels: true,
    setup: cliSetup(
      'https://junie.jetbrains.com/docs/junie-cli.html',
      scriptInstall({
        posix: 'https://junie.jetbrains.com/install.sh',
        windows: 'https://junie.jetbrains.com/install.ps1',
      }),
      true,
    ),
  },
  {
    id: 'auggie',
    name: 'Auggie',
    maker: 'Augment Code',
    command: 'auggie',
    args: ['--acp'],
    // Initialize captured from auggie 0.36.0 on 2026-10-19; session/new
    // answered auth_required (-32000) while signed out.
    verified: true,
    loginArgs: ['login'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
      'npm install -g @augmentcode/auggie',
      true,
    ),
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe',
    maker: 'Mistral AI',
    // `vibe` is the interactive CLI; the same package installs this server.
    command: 'vibe-acp',
    args: [],
    // Initialize and session/new captured from vibe-acp 2.7.2 on 2026-10-19.
    // It advertises no auth methods: its key lives in the keyring or env.
    verified: true,
    // `vibe-acp --setup` runs the same key setup as `vibe --setup`.
    loginArgs: ['--setup'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.mistral.ai/vibe/code/cli/install-setup',
      // Windows installs uv first and then the tool; that is the guide's job.
      scriptInstall({ posix: 'https://mistral.ai/vibe/install.sh' }),
    ),
  },
  {
    id: 'kilo',
    name: 'Kilo',
    maker: 'Kilo Code',
    command: 'kilo',
    args: ['acp'],
    // Initialize and session/new captured from kilo 7.8.12 on 2026-10-19: it
    // opens sessions without a login, on its free models. (7.3 never answered
    // initialize.)
    verified: true,
    loginArgs: ['auth', 'login'],
    sessionModels: true,
    setup: cliSetup('https://kilo.ai/docs/cli', 'npm install -g @kilocode/cli', true),
  },
  {
    id: 'qoder',
    name: 'Qoder',
    maker: 'Qoder',
    command: 'qoder',
    args: ['--acp'],
    // Initialize captured from qoder 1.1.74 on 2026-10-19; session/new
    // answered auth_required (-32000) while signed out.
    verified: true,
    loginArgs: ['login'],
    sessionModels: true,
    setup: cliSetup(
      'https://docs.qoder.com/cli/installation',
      scriptInstall({
        posix: 'https://qoder.com/install',
        windows: 'https://qoder.com/install.ps1',
      }),
      true,
    ),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    maker: 'Tencent',
    command: 'codebuddy',
    args: ['--acp'],
    // Initialize captured from codebuddy on 2026-10-19 (it names no version);
    // session/new answered auth_required (-32000) while signed out.
    verified: true,
    // No login command: the first interactive run picks a site and signs in.
    sessionModels: true,
    setup: cliSetup(
      'https://www.codebuddy.ai/docs/cli/installation',
      'npm install -g @tencent-ai/codebuddy-code',
      true,
    ),
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
    maker: 'Moonshot AI',
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

/** Whether `acpSignOut` can sign this agent out, so the UI offers it only then. */
export function acpCanSignOut(spec: AcpAgentSpec): boolean {
  return Boolean(spec.logoutArgs ?? spec.credentialProbe)
}

export async function detectAgents(): Promise<Array<AcpAgentSpec & { installed: boolean }>> {
  return Promise.all(
    LISTED_AGENTS.map(async (agent) => ({ ...agent, installed: await isInstalled(agent.command) })),
  )
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
  let models: Model[]
  try {
    // Kept for Kimi 0.x, whose CLI exposes this catalog. Kimi 1.5 removed the
    // command and its ACP session currently exposes no config options, so that
    // version falls back to the provider default instead of showing controls
    // the wire cannot apply.
    models = parseKimiModels(await captureCli('kimi', ['provider', 'list', '--json']))
  } catch {
    return []
  }
  // The legacy catalog can name graded efforts, but the ACP version paired
  // with it only drives model selection. Keep the parser accurate while the
  // selectable rows report only controls this adapter can actually apply.
  return models.map((model) => {
    const selectable = { ...model, reasoningEfforts: [] }
    delete selectable.defaultReasoningEffort
    return selectable
  })
}

function model(id: string, displayName: string, description: string, isDefault = false): Model {
  return { id, displayName, description, isDefault, reasoningEfforts: [], serviceTiers: [] }
}

/** The K version in a Kimi model name: `K2.8 Preview`, `K2.7 Code Highspeed`, `K3-256k`. */
const KIMI_GENERATION = /(?:^|[\s\-_/])k(\d+(?:\.\d+)*)(?=$|[\s\-_/])/i

export function parseKimiModels(output: string): Model[] {
  const parsed = KimiModelsSchema.parse(JSON.parse(output))
  return Object.entries(parsed.models).map(([id, details], index) => {
    const displayName = details.displayName ?? id
    // Kimi names its variants with words after the version (Preview, Code
    // Highspeed), which read as separate families, so K3 replaced nothing.
    // Every K version is one line of models: a newer K supersedes the older
    // ones, and the variants of the newest stay side by side.
    const generation = KIMI_GENERATION.exec(displayName)?.[1]
    return {
      id,
      displayName,
      isDefault: index === 0,
      reasoningEfforts: details.supportEfforts ?? [],
      ...(details.defaultEffort
        ? {
            defaultReasoningEffort: details.defaultEffort,
          }
        : {}),
      serviceTiers: [],
      lab: 'Moonshot',
      ...(generation ? { family: 'kimi-k', generation } : {}),
    }
  })
}

/**
 * Run a short CLI command and collect what it prints. `anyExit` keeps the
 * output of a command that reports a state through its exit code too, such
 * as a status check that exits 1 while signed out.
 */
export function captureCli(
  command: string,
  args: string[],
  timeoutMs = 5000,
  options: { anyExit?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args)
    let output = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void killTree(child).then(() => {
        if (error) reject(error)
        else resolve(output)
      }, reject)
    }
    const timer = setTimeout(() => {
      finish(new Error(`${command} ${args[0]} timed out`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) =>
      finish(code === 0 || options.anyExit ? undefined : new Error(`${command} ${args[0]} failed`)),
    )
  })
}
