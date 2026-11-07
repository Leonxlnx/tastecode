import type { ProviderId } from '@harness/contracts'

/** Settings and lifecycle capabilities; importing this table never loads a vendor SDK. */
export type ProviderControlCapabilities = Readonly<{
  resume: boolean
  /**
   * The provider can start a session as a copy of a saved one, also of one
   * saved in another account's folder (server-internal).
   */
  forkSession: boolean
  managedMcp: boolean
  inheritedMcp: boolean
  /** The provider can list the MCP servers its own settings load (server-internal). */
  mcpInventory: boolean
  /**
   * A chat on this provider gets TasteCode's agent tools, served as the MCP
   * server `tastecode`, and can start sub-agents on other providers
   * (server-internal). It needs a managed MCP path that one more server does
   * not change; Grok switches to its ACP mode for any server, so it has none.
   */
  agentTools: boolean
  /** The provider lists the skills it loads itself (server-internal). */
  nativeSkills: boolean
  /**
   * The provider's CLI loads Agent Skills from `.agents/skills` in the project
   * and the home folder. Only a capture of the CLI reading them turns this on.
   */
  agentsSkillsDir: boolean
  /**
   * The provider loads the skills that ship with TasteCode itself, from the
   * plugin folder passed as `StartOptions.skillPlugin`, so its sessions skip
   * the skill catalog in the shared instructions (server-internal). Only a
   * runtime with a native plugin loader turns this on (Claude Code's
   * `--plugin-dir`, which shows the skills as `tastecode:<name>`).
   */
  defaultSkillsPlugin: boolean
  nativeModels: boolean
  /**
   * The provider names the chats it runs for TasteCode, and its history source
   * reports that name for sessions in the default account folder (server-internal).
   * Only saved sessions showing such names turn this on.
   */
  nativeTitles: boolean
  notifications: boolean
  skillsInstall: boolean
  account: boolean
  login: boolean
  apiKey: boolean
  signOut: boolean
  usageLimits: boolean
  rateLimitReset: boolean
  /**
   * Minimum spacing of full plan-limit reads, each of which starts a vendor
   * process. A successful read answers at least this long, and a usage change
   * cannot force an earlier one; only a refresh or retry reads sooner.
   */
  limitReadIntervalMs: number
  /** Timed-out limit reads after which the server stops reading until the account changes. */
  limitReadTimeoutLimit?: number
  /**
   * Full reads wait for a client that shows the limits (any intent but
   * `background`). A passive figure is answered from held values only, which
   * live windows from running sessions keep current.
   */
  limitReadsWhenShown?: boolean
  /**
   * The agent reports the diff of every turn that changed files itself
   * (server-internal). For the others the server builds it from the turn's
   * checkpoint, at the cost of one more snapshot when the turn ends.
   */
  turnDiffs?: boolean
}>

const unsupported: ProviderControlCapabilities = {
  resume: false,
  forkSession: false,
  managedMcp: false,
  inheritedMcp: false,
  mcpInventory: false,
  agentTools: false,
  nativeSkills: false,
  agentsSkillsDir: false,
  defaultSkillsPlugin: false,
  nativeModels: false,
  nativeTitles: false,
  notifications: false,
  skillsInstall: false,
  account: false,
  login: false,
  apiKey: false,
  signOut: false,
  usageLimits: false,
  rateLimitReset: false,
  limitReadIntervalMs: 0,
}

/**
 * Codex, Grok and Antigravity start a short-lived process per read. Codex's
 * running sessions report their windows live; the others' do not, so their
 * values can be this old while a turn runs.
 */
const PROCESS_LIMIT_READ_INTERVAL_MS = 5 * 60_000

/**
 * The names the app shows for each provider (the web's provider-presentation
 * labels), for text the server writes, such as an agent tool's answer.
 */
export const PROVIDER_NAMES = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  grok: 'Grok',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  pi: 'Pi',
  acp: 'ACP',
  api: 'API connection',
} as const satisfies Readonly<Record<ProviderId, string>>

export const PROVIDER_CAPABILITIES = {
  acp: {
    ...unsupported,
    resume: true,
    // TasteCode's project servers go to session/new, filtered by the agent's transports.
    managedMcp: true,
    nativeModels: true,
    account: true,
    signOut: true,
  },
  antigravity: {
    ...unsupported,
    nativeModels: true,
    account: true,
    usageLimits: true,
    limitReadIntervalMs: PROCESS_LIMIT_READ_INTERVAL_MS,
    // Each read starts agy with its language server and asks Google for the
    // quota (4 to 12 s), so it waits for a view that shows the limits.
    limitReadsWhenShown: true,
  },
  api: { ...unsupported, resume: true },
  'claude-code': {
    ...unsupported,
    resume: true,
    forkSession: true,
    managedMcp: true,
    mcpInventory: true,
    agentTools: true,
    defaultSkillsPlugin: true,
    nativeModels: true,
    // The CLI saves an `ai-title` row once a prompt says enough to name.
    nativeTitles: true,
    account: true,
    login: true,
    signOut: true,
    usageLimits: true,
    // Each read starts a full Claude CLI, and every turn reports a usage change.
    limitReadIntervalMs: 15 * 60_000,
    // A CLI that still scans its transcripts misses the read deadline every
    // time; two misses are enough to stop paying for that scan.
    limitReadTimeoutLimit: 2,
    // Each read starts a whole CLI; rate_limit_event keeps the session window current.
    limitReadsWhenShown: true,
  },
  codex: {
    resume: true,
    forkSession: true,
    managedMcp: true,
    inheritedMcp: true,
    mcpInventory: true,
    agentTools: true,
    nativeSkills: true,
    agentsSkillsDir: true,
    // skills/extraRoots/set exists, but nothing shows it stays out of ~/.codex.
    defaultSkillsPlugin: false,
    nativeModels: true,
    // Codex's own apps name their threads; the app server leaves TasteCode's unnamed.
    nativeTitles: false,
    notifications: true,
    skillsInstall: true,
    account: true,
    login: true,
    apiKey: true,
    signOut: true,
    usageLimits: true,
    rateLimitReset: true,
    limitReadIntervalMs: PROCESS_LIMIT_READ_INTERVAL_MS,
    // turn/diff/updated after every item that changed a file.
    turnDiffs: true,
  },
  cursor: {
    ...unsupported,
    resume: true,
    nativeModels: true,
    account: true,
    login: true,
    signOut: true,
    usageLimits: true,
    // A read is one HTTPS request, no process; Cursor's figures change with
    // each turn but nothing reports them live, so they are this old at most.
    limitReadIntervalMs: PROCESS_LIMIT_READ_INTERVAL_MS,
  },
  grok: {
    ...unsupported,
    resume: true,
    managedMcp: true,
    mcpInventory: true,
    nativeSkills: true,
    nativeModels: true,
    // Headless sessions save a `generated_title` in their summary.
    nativeTitles: true,
    account: true,
    signOut: true,
    usageLimits: true,
    limitReadIntervalMs: PROCESS_LIMIT_READ_INTERVAL_MS,
  },
  opencode: {
    ...unsupported,
    resume: true,
    managedMcp: true,
    mcpInventory: true,
    agentTools: true,
    nativeSkills: true,
    nativeModels: true,
    account: true,
  },
  pi: { ...unsupported, nativeModels: true },
} as const satisfies Readonly<Record<ProviderId, ProviderControlCapabilities>>
