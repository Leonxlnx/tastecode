import { isDesignBriefAttachment } from '@harness/design-agent/attachment'
import { isCreatifyAttachment } from './creatify.js'
import { DEFAULT_ACCOUNT_ID, ProviderIdSchema } from '@harness/contracts'
import {
  providerRuntime,
  verifyCustomHarness as verifyCustomHarnessCompatibility,
  type AgentSession,
  type ProviderRuntime,
  type SavedSession,
  type StartOptions,
  type TurnOptions,
} from './runtime-loader.js'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import path from 'node:path'
import {
  changedSince,
  patchSince,
  restoreSnapshot,
  takeSnapshot,
  retainCheckpoint,
  retainCheckpoints,
  checkpointRepository,
  RestoreSnapshotError,
} from './checkpoint.js'
import {
  accountForNewThread,
  DEFAULT_ACCOUNTS_ONLY,
  existingAccountHome,
  sourceAccount,
  threadAccountHome,
  type AccountDirectory,
} from './account-directory.js'
import { accountPool } from './account-pool.js'
import { accountRead, type AccountIdentity } from './account-identity.js'
import { checkpointLabel } from './slice-code-units.js'
import { canonicalCheckoutRoot, CheckoutAccess } from './checkout-access.js'
import {
  ProviderControls,
  type CommandInventory,
  type McpInventory,
  type ProviderControlsOptions,
} from './provider-controls.js'
import { ModelListCache } from './model-list-cache.js'
import { PROVIDER_CAPABILITIES, PROVIDER_NAMES } from './provider-capabilities.js'
import { assertProviderOffered } from './provider-edition.js'
import {
  contextForLaunch,
  providerContextControl,
  validateContextSettings,
} from './provider-context.js'
import { runtimeForLaunch, validateRuntime } from './provider-runtimes.js'
import { currentBranch, switchWorkspaceBranch, workspaceChanges } from './workspace.js'
import { compactHistoryReplay } from './history-replay.js'
import { decodeHistoryCursor, readHistoryPage, type HistoryPage } from './history-page.js'
import { readIndexedNewestHistoryPage } from './history-tail.js'
import {
  isProviderSessionMissing,
  mapProviderSession,
  DESIGN_FOLLOW_UP_NOTICE,
  RESTORE_CONTEXT_NOTICE,
  StartupCleanupError,
} from './provider-session.js'
import { handoverBudget, handoverPrompt } from './handover.js'
import { REPLY_STYLE_INSTRUCTIONS } from './reply-style.js'
import { LOCAL_SKILL_CAPABILITIES, listLocalSkills, mergeSkills } from './skill-inventory.js'
import { isDefaultSkillId, loadDefaultSkills, type DefaultSkills } from './default-skills.js'
import type { ProviderAccountSnapshotKind, Store, StoredCheckpoint } from './store.js'
import {
  carryUncommittedChanges,
  createWorktree,
  hasUncommittedChanges,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
  WorktreeDirty,
} from './worktree.js'
import type {
  Account,
  AccountId,
  ApprovalDecision,
  ApprovalMode,
  BackgroundModelPreference,
  BackgroundModelSettings,
  BackgroundModelSource,
  CustomHarness,
  DiffDecision,
  DomainEvent,
  McpCapabilities,
  McpServer,
  McpServerConfig,
  Model,
  PanicStopResult,
  ParamsOf,
  AccountContextSettings,
  AccountRuntimeSetting,
  ProviderContextSettings,
  ProviderContextSettingsMap,
  ProviderAccount,
  ProviderId,
  ProviderLimitSource,
  ProviderRuntimeSettings,
  ResultOf,
  QueuedTurn,
  SessionDiff,
  Skill,
  SkillCapabilities,
  SkillDiscoveryError,
  Thread,
  ThreadInboxStatus,
  ThreadLifecycle,
  ThreadSubagent,
  UsageReadIntent,
} from '@harness/contracts'
import {
  readSessionDiff,
  reviewDiffFile,
  reviewDiffHunk,
  reverseUnifiedDiff,
  StaleDiffSnapshotError,
} from './diff-review.js'
import { McpConfigStore } from './mcp-config.js'
import { readCredential } from './credentials.js'
import { CustomHarnessStore } from './custom-harnesses.js'
import { TerminalManager } from './terminal.js'
import { insideSkillFolder, installLocalSkill, sameSkillFolder } from './skill-install.js'
import {
  continuationPromptFromReplay,
  type EarlierChanges,
  projectHistoryItems,
  sideChatInstructionsFromReplay,
} from './side-chat.js'
import {
  AGENT_TOOLS_SERVER_ID,
  AgentToolError,
  AgentToolsEndpoint,
  type AgentToolsGrant,
  type BrowserToolsBroker,
} from './agent-tools-mcp.js'
import {
  SUBAGENT_INSTRUCTIONS,
  SubagentBroker,
  type AgentModelChoice,
  type SubagentChildSpec,
  type SubagentOutcome,
  type SubagentParent,
} from './subagent-broker.js'
import { IDLE_THREAD_RUNTIME_MS, idleThreadRuntimeLimit } from './runtime-retention.js'
import {
  cleanGeneratedCommitMessage,
  cleanGeneratedTitle,
  commitMessagePrompt,
  resolveBackgroundModel,
  resolveBackgroundModelFrom,
  runBackgroundCompletion,
  titlePrompt,
  type AvailableBackgroundModelSource,
  type BackgroundModelSourceLoader,
} from './background-model.js'
import { VoiceService, type VoiceTranscriber } from './voice.js'
import {
  RecordedDeltaBuffer,
  type ItemDeltaEvent,
  type RecordedDelta,
} from './recorded-delta-buffer.js'
import {
  affectsInboxProjection,
  applyInboxProjectionEvent,
  emptyInboxProjection,
  isEmptyInboxProjection,
  type InboxProjection,
} from './inbox-projection.js'
import { storeLocation } from './data-location.js'

type RecordedEventHandler = (
  threadId: string,
  event: DomainEvent,
  seq: number,
  serializedEvent?: string,
) => void

/** A sub-agent chat's event, with the chat that started it. */
type SubagentEventHandler = (
  threadId: string,
  parentThreadId: string,
  event: DomainEvent,
  seq: number,
  serializedEvent?: string,
) => void

/** The header value's credential reference in the reserved `tastecode` server. */
const AGENT_TOOLS_CREDENTIAL = 'tastecode-agent-tools'

export type SimulatorAgentBridge = {
  readonly serverId: string
  readonly instructions: string
  mcpConfigForThread(threadId: string):
    | {
        readonly server: McpServerConfig
        readonly credentials: Record<string, string>
      }
    | undefined
  rebindThread(fromId: string, toThreadId: string): void
  onThreadClosed(threadId: string): void
}

type HistoryEntry = { seq: number; event: DomainEvent }
type HistoryRead = { events: HistoryEntry[]; serializedEvents?: string | undefined }

/** How far back a continued chat's first prompt follows chats that continued one another. */
const MAX_CONTINUED_CHATS = 8
/**
 * How long a handover waits for its engine to say how large the model's
 * context is. A lookup is a local call; one that hangs gets the default size
 * rather than holding the turn.
 */
const MODEL_WINDOW_WAIT_MS = 2_000
/**
 * A turn diff built from a checkpoint is kept in the chat's log like an
 * agent's own. One that grew past this (generated files, a vendored folder)
 * is left out rather than stored with every replay of the chat.
 */
const MAX_CHECKPOINT_TURN_DIFF_CHARS = 4 * 1024 * 1024
/** Each file is one pathspec on the git command line, which Windows caps at 32k characters. */
const MAX_CHECKPOINT_TURN_DIFF_FILES = 200

export type LifecycleScheduleHint = 'later' | number | undefined

/** Push channel that owns a queued turn's events: the main thread stream or Side chat. */
type QueuedTurnChannel = 'main' | 'side'
type UserSubmission = {
  id: string
  text: string
  attachments: string[]
  createdAt: number
  queueId?: string
  /** Push channel chosen when a queued item was submitted. */
  channel?: QueuedTurnChannel
}
type QueuedTurnEntry = QueuedTurn & {
  options: TurnOptions
  clientSubmissionId?: string
  channel?: QueuedTurnChannel
}
type QueueState = { items: QueuedTurn[]; canSteer: boolean }
type PendingTurnStart = {
  acceptedAt: number
  submission?: UserSubmission
  /** How many Stops the chat had been asked for when this turn's prompt was sent. */
  stopsBefore: number
}
type QueueDrain = { queueId: string; completedTurnId?: string }
type TurnStartBarrier = { done: Promise<void>; release: () => void; turnCompleted?: boolean }
/** How a prompt still on its way to its session hears a Stop; set once it starts listening. */
type PromptStopListener = { cancel?: (error: Error) => void; cancelled?: Promise<never> }
/** A turn Stop already ended for the user, while its agent has not reported its end yet. */
type SettlingStop = {
  turnId: string
  entry: AttachedThreadRuntime
  timer: ReturnType<typeof setTimeout>
  /** The agent accepted the Stop request. */
  confirmed?: boolean
  /** The agent started new work after that, and was asked to stop once more. */
  stoppedAgain?: boolean
  /** A held prompt the user sent meanwhile; it goes first once the agent has ended the turn. */
  sendFirst?: string
}
type BackgroundSourceEntry = {
  reading: Promise<AvailableBackgroundModelSource | undefined>
  /** Infinite while the read is in flight. */
  expiresAt: number
}
type AttachedThreadRuntime = {
  thread: Thread
  session: AgentSession
  projectPath: string
  resumable: boolean
  worktree?: Worktree
}
/** One provider account's sign-in, limits, control process and model lists. */
type AccountScope = {
  controls: ProviderControls
  modelLists: ModelListCache
  /** The account each provider's model lists were read for, to notice a switch made outside the app. */
  modelListAccounts: Map<ProviderId, AccountIdentity>
  /** Absent for the default account. */
  accountId?: AccountId
}
const accountScopeKey = (provider: ProviderId, accountId: AccountId) =>
  `${provider}\u0000${accountId}`
const userTurnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId])
/** TasteCode's own markers among a prompt's attachments: Creatify's, and Design mode's before it. */
const isModeMarker = (attachment: string): boolean =>
  isCreatifyAttachment(attachment) || isDesignBriefAttachment(attachment)
const composeInstructions = (instructions?: string): string =>
  instructions?.trim()
    ? `${REPLY_STYLE_INSTRUCTIONS}\n\n${instructions.trim()}`
    : REPLY_STYLE_INSTRUCTIONS
/**
 * The source an install, update or sign-in terminal works on, from its target:
 * `provider`, `provider:agent` or `update:provider`.
 */
export function providerTerminalSource(
  target: string,
): { provider: ProviderId; agent?: string | undefined } | undefined {
  const [first, ...rest] = target.split(':')
  const [provider, agent] = first === 'update' ? [rest.join(':'), ''] : [first, rest.join(':')]
  if (!provider || !Object.hasOwn(PROVIDER_CAPABILITIES, provider)) return undefined
  return agent ? { provider: provider as ProviderId, agent } : { provider: provider as ProviderId }
}

export function resolveWorkspacePath(workspacePath: string): string {
  if (workspacePath === '~') return os.homedir()
  if (workspacePath.startsWith('~/') || workspacePath.startsWith('~\\')) {
    return path.join(os.homedir(), workspacePath.slice(2))
  }
  return workspacePath
}

/**
 * The private checkout a chat's stored folder belongs to.
 *
 * A nested project's chat stores a folder inside its checkout, but git reports
 * on and removes a worktree only by its root. Deleting that folder leaves the
 * checkout, and any uncommitted work in it, behind, so the root is still the
 * answer. Only a linked worktree (a `.git` file) counts: once the whole
 * checkout is gone, the walk up can reach an unrelated repository above the
 * worktree directory.
 */
/** One key per file whichever way an agent named it; Windows paths ignore case. */
function checkoutPathKey(folder: string, file: string): string {
  const resolved = path.resolve(folder, file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function privateCheckoutPath(worktreePath: string): string {
  const root = canonicalCheckoutRoot(worktreePath)
  const marker = statSync(path.join(root, '.git'), { throwIfNoEntry: false })
  return marker?.isFile() ? root : worktreePath
}

const projectTerminalKey = (projectPath: string): string => `project:${projectPath}`

/** Limits read for another account say whose they are. */
function withAccount(source: ProviderLimitSource, scope: AccountScope): ProviderLimitSource {
  return scope.accountId === undefined ? source : { ...source, accountId: scope.accountId }
}

/** A chat's thread names the account it is pinned to; the default account is left out. */
function onAccount(thread: Thread, accountId: string | undefined): Thread {
  return accountId === undefined || accountId === DEFAULT_ACCOUNT_ID
    ? thread
    : { ...thread, accountId }
}

/** A user's MCP server may not take the id TasteCode's agent tools use. */
function assertUserMcpServerId(id: string): void {
  if (id === AGENT_TOOLS_SERVER_ID) {
    throw new Error(`"${AGENT_TOOLS_SERVER_ID}" is reserved for TasteCode's own agent tools.`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const PANIC_STOP_TIMEOUT_MS = 5_000
/**
 * How long a stopped turn's agent may take to report the turn's end before its process
 * is ended. Longer than an adapter's own stop deadline (Claude's is 15 s), which then
 * decides first.
 */
const STOP_SETTLE_TIMEOUT_MS = 30_000
const IDLE_RUNTIME_PRUNE_RETRY_MS = 30_000
const UNSUPPORTED_MCP_CAPABILITIES: McpCapabilities = {
  inventory: false,
  add: false,
  update: false,
  remove: false,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
}
/** A provider without a skill inventory of its own lists none. */
const NO_SKILL_CAPABILITIES: SkillCapabilities = {
  inventory: false,
  configure: false,
  install: false,
}
/** TasteCode-managed project servers only: no vendor inventory, no OAuth. */
const PROJECT_MCP_MANAGEMENT_CAPABILITIES: McpCapabilities = {
  inventory: false,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
}
const MAX_SIDEBAR_STATUS_CHANGES = 2_048
const BACKGROUND_SOURCE_TTL_MS = 60_000
/** Background model sources in source order; custom harnesses follow them. */
const BACKGROUND_PROVIDERS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
] as const
const EMPTY_QUEUE_CACHE_LIMIT = 128

/**
 * Owns every live agent session.
 *
 * Sessions are independent: each has its own adapter and child process, and a
 * turn running in one does not block another. The only thing they share is
 * this map and the store.
 *
 * Every event is written to the log before it is broadcast. That ordering
 * matters — a client that reconnects mid-turn replays from the log, and an
 * event that went out but was never recorded would be one the client can never
 * get back.
 */
export class Orchestrator {
  #threads = new Map<string, AttachedThreadRuntime>()
  #runtimeThreadIdsByProject = new Map<ProviderId, Map<string, Set<string>>>()
  #runtimeRecency = new Map<string, number>()
  #idleRuntimeTimer: ReturnType<typeof setTimeout> | undefined
  #idleRuntimeTimerExpiresAt: number | undefined
  #idleRuntimePruneScheduled = false
  #idleRuntimeEligible = new Set<string>()
  /** Runtimes that started before their project's MCP servers changed, released once idle. */
  #mcpStaleRuntimes = new Map<string, AgentSession>()
  /**
   * Runtimes whose agent still runs work a turn started in the background and starts a
   * turn of its own when it ends. Releasing one would end that work and lose the turn.
   */
  #backgroundWorkThreads = new Set<string>()
  #runtimeOperationCounts = new Map<string, number>()
  /**
   * MCP sign-ins that keep a runtime alive, per thread. `early` holds results
   * that arrived before their start reply so that reply does not re-add them.
   */
  #mcpOAuthThreads = new Map<
    string,
    { starting: number; logins: Map<string, string>; early: Set<string> }
  >()
  /** Approval mode selected for each attached or pending-resume thread; not persisted. */
  #threadApprovals = new Map<string, ApprovalMode>()
  #approvalChanges = new Map<string, Promise<void>>()
  /** First prompts of chats left for their provider to name, until named. */
  #providerNamePrompts = new Map<string, string>()
  /** Chats that already had their fallback title written, or tried, this run. */
  #fallbackTitled = new Set<string>()
  /**
   * Chats whose newest user prompt went to their provider as more than the
   * user's words: the Design follow-up notice, a handover, earlier context.
   */
  #wrappedPrompts = new Set<string>()
  #sideThreads = new Map<string, string>()
  #sideParents = new Map<string, string>()
  #startingSideThreads = new Map<string, Promise<Thread>>()
  #discardedSideThreads = new Set<string>()
  /** Sub-agent chats this process runs, and the chat that started each. */
  #subagentParents = new Map<string, string>()
  /** Each chat's newest user prompt, which may ask for a sub-agent on another provider. */
  #latestUserPrompts = new Map<string, string>()
  #onSubagentEvent: SubagentEventHandler
  #subagents: SubagentBroker
  /** TasteCode's agent tools; absent when this orchestrator serves none. */
  #agentTools: AgentToolsEndpoint | undefined
  /** Optional local iOS/Android simulator MCP bridge. */
  #simulatorAgent: SimulatorAgentBridge | undefined
  /** Each parent chat's token for the agent tools, kept while it exists. */
  #agentToolGrants = new Map<string, AgentToolsGrant>()
  #activeTurns = new Set<string>()
  #activeTurnIds = new Map<string, string>()
  /**
   * For each chat's active turn, how many Stops had been asked for when its prompt was sent.
   * A Stop ends only a turn whose prompt came before it.
   */
  #activeTurnStopsBefore = new Map<string, number>()
  #serverOwnedUserTurns = new Set<string>()
  #suppressedUserItems = new Map<string, Set<string>>()
  #inFlightSubmissionIds = new Map<string, Set<string>>()
  /** Prompts on their way to each thread that have not started or queued yet. */
  #incomingSubmissions = new Map<string, Set<Promise<unknown>>>()
  #startingTurns = new Set<string>()
  /** Each chat's last turn the user stopped, until its next turn starts. */
  #userStoppedTurns = new Map<string, string>()
  /** The checkpoint each chat's latest turn started from, for agents that report no turn diff. */
  #turnStartSnapshots = new Map<string, { repoPath: string; commit: string }>()
  /** The files each chat's running turn reported changing, as the agent named them. */
  #turnWrittenPaths = new Map<string, Set<string>>()
  /** The files each chat's last finished turn reported changing. */
  #lastTurnWrittenPaths = new Map<string, Set<string>>()
  /** Turn diffs being built from a checkpoint, per chat. */
  #turnDiffBuilds = new Map<string, Promise<void>>()
  /** Chats resuming their provider session for a prompt the user just sent. */
  #resumingForPrompt = new Set<string>()
  /** When a prompt that had to wait for its chat's resume was sent, until its turn starts. */
  #resumedPromptSentAt = new Map<string, number>()
  #turnStartBarriers = new Map<string, TurnStartBarrier>()
  #pendingTurnStarts = new Map<string, PendingTurnStart>()
  #acceptedTurnStarts = new Map<string, Map<string, PendingTurnStart>>()
  /**
   * Turns a Stop ended for the user before their agent confirmed it. The agent is still
   * busy with them: prompts sent meanwhile wait in the queue, and the turn's late events
   * are not recorded.
   */
  #settlingStops = new Map<string, SettlingStop>()
  readonly #stopSettleMs: number
  #restoringThreads = new Map<string, Promise<void>>()
  #reviewingDiffs = new Set<string>()
  #queuedTurns = new Map<string, QueuedTurnEntry[]>()
  #emptyQueuedTurns = new Set<string>()
  #drainingQueues = new Map<string, QueueDrain>()
  /**
   * Chats whose queued prompts a Stop holds: they wait for the user instead of going out when
   * the stopped turn ends. The user's next prompt, or sending a held one, lets them go.
   */
  #heldQueues = new Set<string>()
  #resumingThreads = new Map<string, Promise<void>>()
  /** The runtime generation each resume started in; a Stop moves the thread past it. */
  #resumeGenerations = new Map<string, number>()
  /** Prompts waiting on a resume, rejected at once by a Stop. */
  #resumeCancels = new Map<string, Array<(error: Error) => void>>()
  /** Stops that came while a chat resumed, counted per chat. */
  #resumeStops = new Map<string, number>()
  /** Every Stop of a chat, counted per chat. */
  #stopRequests = new Map<string, number>()
  /** The Stops a prompt on its way had seen when it was sent. */
  #submissionStops = new AsyncLocalStorage<{
    threadId: string
    stops: number
    stopRequests: number
  }>()
  /** Chats whose provider session is being replaced; nothing may start a turn meanwhile. */
  #changingProvider = new Set<string>()
  /**
   * The turn that carried a chat's handover, until it ends. An engine that
   * runs a process per turn accepts the prompt before it reads it, so a turn
   * that ends without any answer may never have delivered the handover.
   */
  #handoverTurns = new Map<string, { turnId: string; answered: boolean; carried?: true }>()
  /**
   * Chats whose session carries on a saved provider session, until their
   * first turn there starts. That turn is watched as `carried` in
   * `#handoverTurns`: a provider may refuse what another account saved.
   */
  #carriedThreads = new Set<string>()
  /** Chats whose carried session failed its first turn; the next turn replaces it. */
  #failedCarries = new Set<string>()
  #panicGeneration = 0
  #panicStopping = false
  #panicStop: Promise<PanicStopResult> | undefined
  #checkoutAccess = new CheckoutAccess()
  #stoppingSessions = new Map<string, AgentSession>()
  #runtimeStops = new Map<string, Promise<void>>()
  #runtimeGenerations = new Map<string, number>()
  #disposeGeneration = 0
  #projectGenerations = new Map<string, number>()
  #store: Store
  #recordedDeltas: RecordedDeltaBuffer
  /** The latest patch recorded for each running turn. */
  #recordedTurnDiffs = new Map<string, { turnId: string; diff: string }>()
  #worktreeRoot: string
  readonly #defaultSkillsRoot: string | undefined
  #defaultSkills: DefaultSkills | undefined
  #onEvent: RecordedEventHandler
  #onSideEvent: RecordedEventHandler
  #onQueue: (threadId: string, state: QueueState) => void
  #onLog: (line: string) => void
  #onLogin: (
    provider: ProviderId,
    result: { loginId: string | null; success: boolean; error: string | null },
    accountId?: AccountId,
  ) => void
  #onMcpOAuth: (
    provider: ProviderId,
    projectPath: string,
    result: { serverId: string; loginId: string; success: boolean; error: string | null },
  ) => void
  #onMcpChanged: (provider: ProviderId, projectPath: string) => void
  #onSkillsChanged: (provider: ProviderId, projectPath: string) => void
  #onCommandsChanged: (provider: ProviderId, projectPath: string) => void
  #onUsageChanged: (provider: ProviderId, accountId?: AccountId) => void
  #onLimitsChanged: (source: ProviderLimitSource) => void
  #onModelsChanged: (provider: ProviderId, agent: string | undefined, accountId?: AccountId) => void
  #onLifecycle: (threadId: string, lifecycle: ThreadLifecycle) => void
  #onLifecycleScheduleChanged: (hint?: LifecycleScheduleHint) => void
  #inboxProjections = new Map<string, InboxProjection>()
  #inboxProjectionsLoaded = false
  #staleInboxProjectionThreads = new Set<string>()
  #sidebarStatusRevision = 0
  #sidebarStatusChanges: Array<{ revision: number; threadId: string }> = []
  #mcpConfig: McpConfigStore
  #customHarnesses: CustomHarnessStore
  /** Keyed by source id. */
  #backgroundSources = new Map<string, BackgroundSourceEntry>()
  #backgroundSourcesRevision = 0
  #readCredential: (reference: string) => string
  #voice: VoiceService
  #terminals: TerminalManager
  /**
   * How a provider is turned into a running session. Injectable so the
   * concurrency behaviour can be tested without spawning real agents — the
   * property worth protecting is that sessions do not block or cross-wire each
   * other, and that is about this class, not about any vendor.
   */
  #runtimeFor: (
    provider: ProviderId,
    onLog: (line: string) => void,
    accountHome?: string,
  ) => ProviderRuntime
  /** Which folder each provider account runs in. */
  #accounts: AccountDirectory
  #maxIdleThreadRuntimes: number
  #idleThreadRuntimeMs: number
  #controls: ProviderControls
  #modelLists: ModelListCache
  #providerBinary: ((provider: ProviderId) => Promise<string | undefined>) | undefined
  /** The account each provider's model lists were read for, to notice a switch made outside the app. */
  #modelListAccounts = new Map<ProviderId, AccountIdentity>()
  /** The default account's controls and model lists. */
  #defaultScope: AccountScope
  /** Other accounts' controls and model lists, by provider and account, made when first used. */
  #accountScopes = new Map<string, AccountScope>()
  /** What every account's controls share with the default account's. */
  #scopeOptions: Pick<
    ProviderControlsOptions,
    'controlIdleMs' | 'beforeLimitRead' | 'services' | 'createCodex'
  >
  /** Install, update and sign-in terminals, by terminal id, and the source they change. */
  #providerTerminals = new Map<
    string,
    { provider: ProviderId; agent?: string | undefined; accountId?: AccountId }
  >()

  constructor(
    store: Store,
    handlers: {
      onEvent: RecordedEventHandler
      onSideEvent?: RecordedEventHandler
      /** Events of sub-agent chats, which stay off the chat stream. */
      onSubagentEvent?: SubagentEventHandler
      /** Serve TasteCode's agent tools to chats on providers that take them. */
      agentTools?: boolean
      /** Runs agent browser commands; without it the browser tools are not offered. */
      browserTools?: BrowserToolsBroker
      onQueue?: (threadId: string, state: QueueState) => void
      onLog: (line: string) => void
      /** `accountId` is absent for the default account. */
      onLogin: (
        provider: ProviderId,
        result: { loginId: string | null; success: boolean; error: string | null },
        accountId?: AccountId,
      ) => void
      onMcpOAuth?: (
        provider: ProviderId,
        projectPath: string,
        result: { serverId: string; loginId: string; success: boolean; error: string | null },
      ) => void
      onMcpChanged?: (provider: ProviderId, projectPath: string) => void
      onSkillsChanged?: (provider: ProviderId, projectPath: string) => void
      onCommandsChanged?: (provider: ProviderId, projectPath: string) => void
      /** `accountId` is absent for the default account. */
      onUsageChanged?: (provider: ProviderId, accountId?: AccountId) => void
      /** A provider's held plan limits changed, for example from a live session. */
      onLimitsChanged?: (source: ProviderLimitSource) => void
      /** A source's model list changed after `models.list` answered; `accountId` absent for default. */
      onModelsChanged?: (
        provider: ProviderId,
        agent: string | undefined,
        accountId?: AccountId,
      ) => void
      onLifecycle?: (threadId: string, lifecycle: ThreadLifecycle) => void
      onLifecycleScheduleChanged?: (hint?: LifecycleScheduleHint) => void
      mcpConfig?: McpConfigStore
      simulatorAgent?: SimulatorAgentBridge
      customHarnesses?: CustomHarnessStore
      readCredential?: (reference: string) => string
      voiceTranscriber?: VoiceTranscriber
      onTerminalOutput?: (terminalId: string, data: string, outputOffset: number) => void
      onTerminalExit?: (terminalId: string, exitCode: number | null) => void
      /** `accountHome` is the folder of the provider account the sessions run as; absent, default. */
      runtimeFor?: (
        provider: ProviderId,
        onLog: (line: string) => void,
        accountHome?: string,
      ) => ProviderRuntime
      /** The provider accounts chats can run as. Without it, every provider has its default only. */
      accounts?: AccountDirectory
      /** Test override for the hardware-scaled warm idle runtime limit. */
      maxIdleThreadRuntimes?: number
      /** Test override for the shared idle runtime expiry window. */
      idleThreadRuntimeMs?: number
      /** Test override for releasing one-shot Codex control processes. */
      controlIdleMs?: number
      /** Test override for how long a stopped turn's agent may take to report its end. */
      stopSettleMs?: number
      /** Waited on before an uncached limit read; the server holds it while a turn streams. */
      beforeLimitRead?: () => Promise<void>
      /** Test override for the provider services behind settings and inventories. */
      providerServices?: ProviderControlsOptions['services']
      /** Test override for the Codex control process behind its settings and inventories. */
      createCodex?: ProviderControlsOptions['createCodex']
      /** Names the binary a provider's own model lists come from (path and version). */
      providerBinary?: (provider: ProviderId) => Promise<string | undefined>

      /** Where isolated checkouts live. Outside any repository, on purpose. */
      worktreeRoot?: string
      /** The folder of the skills that ship with TasteCode; absent, sessions get none. */
      defaultSkillsRoot?: string
    },
  ) {
    this.#store = store
    this.#recordedDeltas = new RecordedDeltaBuffer(
      (threadId, event) => this.#commitRecordedDelta(threadId, event),
      { commitBatch: (records) => this.#commitRecordedDeltas(records) },
    )
    this.#worktreeRoot =
      handlers.worktreeRoot ??
      (process.env['HARNESS_WORKTREE_DIR'] || path.join(path.dirname(storeLocation()), 'trees'))
    this.#defaultSkillsRoot = handlers.defaultSkillsRoot
    this.#onEvent = handlers.onEvent
    this.#onSideEvent = handlers.onSideEvent ?? handlers.onEvent
    this.#onSubagentEvent = handlers.onSubagentEvent ?? (() => {})
    this.#subagents = new SubagentBroker(store.subagents, {
      parent: (threadId) => this.#subagentParent(threadId),
      choices: () => this.#agentModelChoices(),
      otherProvidersAllowed: () => this.#store.subagentSettings().otherProviders === true,
      createChild: (spec) => this.#startSubagentThread(spec),
      // The task goes past submitTurn: it is the broker's prompt, not the user's.
      sendToChild: async (threadId, task, options) => {
        await this.trackSubmission(threadId, () =>
          this.#submitTurn(
            threadId,
            task,
            [],
            {
              ...(options.model ? { model: options.model } : {}),
              ...(options.effort ? { effort: options.effort } : {}),
            },
            `subagent-task-${crypto.randomUUID()}`,
          ),
        )
      },
      stopChild: (threadId) => this.interrupt(threadId),
      // Closing a sub-agent's chat ends its runtime and keeps its transcript.
      releaseChild: (threadId) => this.close(threadId),
      outcome: (threadId, turnId) => this.#subagentOutcome(threadId, turnId),
      recordOnParent: (parentThreadId, event) => {
        if (this.#store.thread(parentThreadId)) this.#record(parentThreadId, event)
      },
      interruptParent: (parentThreadId) => this.interrupt(parentThreadId),
    })
    this.#agentTools = handlers.agentTools
      ? new AgentToolsEndpoint(this.#subagents, handlers.browserTools)
      : undefined
    this.#onQueue = handlers.onQueue ?? (() => {})
    this.#onLog = handlers.onLog
    this.#onLogin = handlers.onLogin
    this.#onMcpOAuth = handlers.onMcpOAuth ?? (() => {})
    this.#onMcpChanged = handlers.onMcpChanged ?? (() => {})
    this.#onSkillsChanged = handlers.onSkillsChanged ?? (() => {})
    this.#onCommandsChanged = handlers.onCommandsChanged ?? (() => {})
    this.#onUsageChanged = handlers.onUsageChanged ?? (() => {})
    this.#onLimitsChanged = handlers.onLimitsChanged ?? (() => {})
    this.#onModelsChanged = handlers.onModelsChanged ?? (() => {})
    this.#onLifecycle = handlers.onLifecycle ?? (() => {})
    this.#onLifecycleScheduleChanged = handlers.onLifecycleScheduleChanged ?? (() => {})
    this.#mcpConfig = handlers.mcpConfig ?? new McpConfigStore()
    this.#simulatorAgent = handlers.simulatorAgent
    this.#customHarnesses = handlers.customHarnesses ?? new CustomHarnessStore()
    this.#readCredential = handlers.readCredential ?? readCredential
    this.#voice = new VoiceService(handlers.voiceTranscriber)
    const onTerminalExit = handlers.onTerminalExit ?? (() => {})
    this.#terminals = new TerminalManager({
      onOutput: handlers.onTerminalOutput ?? (() => {}),
      onExit: (terminalId, exitCode) => {
        this.#providerTerminalExited(terminalId)
        onTerminalExit(terminalId, exitCode)
      },
      onLog: (message) => this.#onLog(message),
    })
    this.#runtimeFor =
      handlers.runtimeFor ??
      ((provider, onLog, accountHome) =>
        providerRuntime(provider, onLog, (id) => this.#customHarnesses.find(id), accountHome))
    this.#accounts = handlers.accounts ?? DEFAULT_ACCOUNTS_ONLY
    this.#maxIdleThreadRuntimes =
      handlers.maxIdleThreadRuntimes === undefined
        ? idleThreadRuntimeLimit(os.totalmem())
        : Math.max(1, Math.floor(handlers.maxIdleThreadRuntimes))
    this.#idleThreadRuntimeMs = Math.max(
      0,
      Math.floor(handlers.idleThreadRuntimeMs ?? IDLE_THREAD_RUNTIME_MS),
    )
    this.#stopSettleMs = Math.max(1, handlers.stopSettleMs ?? STOP_SETTLE_TIMEOUT_MS)
    this.#scopeOptions = {
      ...(handlers.controlIdleMs !== undefined ? { controlIdleMs: handlers.controlIdleMs } : {}),
      ...(handlers.beforeLimitRead ? { beforeLimitRead: handlers.beforeLimitRead } : {}),
      ...(handlers.providerServices ? { services: handlers.providerServices } : {}),
      ...(handlers.createCodex ? { createCodex: handlers.createCodex } : {}),
    }
    this.#controls = new ProviderControls({
      listModels: (provider, agent, read) =>
        this.#runtimeFor(provider, this.#onLog).listModels(
          agent,
          read,
          this.#runtimeLaunch(provider, agent),
        ),
      onLog: (_provider, line) => this.#onLog(line),
      onLogin: this.#onLogin,
      onUsageChanged: this.#onUsageChanged,
      ...(handlers.onLimitsChanged
        ? { onLimitsChanged: (_provider, source) => handlers.onLimitsChanged?.(source) }
        : {}),
      onMcpChanged: this.#onMcpChanged,
      onSkillsChanged: this.#onSkillsChanged,
      onCommandsChanged: this.#onCommandsChanged,
      onAuthChanged: (provider) => {
        this.#modelLists.invalidate(provider)
        this.#invalidateBackgroundSources()
      },
      limitSnapshot: {
        read: () => this.#store.limitSnapshot(),
        write: (value) => this.#store.setLimitSnapshot(value),
      },
      chosenRuntime: (provider) => this.#chosenRuntime(provider),
      ...this.#scopeOptions,
    })
    this.#modelLists = new ModelListCache({
      list: (provider, agent, read) => {
        const control = this.#controls.forProvider(provider)
        return control.listModels ? control.listModels(agent, read) : Promise.resolve([])
      },
      onChanged: (provider, agent) => this.#onModelsChanged(provider, agent),
      onLog: (line) => this.#onLog(line),
      snapshot: {
        read: () => this.#store.modelListSnapshot(),
        write: (value) => this.#store.setModelListSnapshot(value),
      },
      binary: handlers.providerBinary,
    })
    this.#providerBinary = handlers.providerBinary
    this.#defaultScope = {
      controls: this.#controls,
      modelLists: this.#modelLists,
      modelListAccounts: this.#modelListAccounts,
    }
  }

  /**
   * The controls and model lists of the account a request names; absent or
   * `default`, the default account's. Another account's are made when first
   * used and serve only its provider, so its sign-in, limits, model lists and
   * Codex control process never mix with another account's.
   */
  #scope(provider: ProviderId, accountId: AccountId | undefined): AccountScope {
    const accountHome = existingAccountHome(this.#accounts, provider, accountId)
    if (accountHome === undefined || accountId === undefined) return this.#defaultScope
    const key = accountScopeKey(provider, accountId)
    let scope = this.#accountScopes.get(key)
    if (!scope) {
      scope = this.#newAccountScope(provider, accountId, accountHome)
      this.#accountScopes.set(key, scope)
    }
    return scope
  }

  #newAccountScope(provider: ProviderId, accountId: AccountId, accountHome: string): AccountScope {
    // Its last limits and model lists answer at once after a restart, as the default account's do.
    const snapshot = (kind: ProviderAccountSnapshotKind) => ({
      read: () => this.#store.providerAccountSnapshot(provider, accountId, kind),
      write: (value: string) =>
        this.#store.setProviderAccountSnapshot(provider, accountId, kind, value),
    })
    const controls = new ProviderControls({
      providers: [provider],
      accountHome,
      listModels: (_provider, agent, read) =>
        this.#runtimeFor(provider, this.#onLog, accountHome).listModels(
          agent,
          read,
          this.#runtimeLaunch(provider, agent, accountId),
        ),
      onLog: (_provider, line) => this.#onLog(line),
      onLogin: (_provider, result) => this.#onLogin(provider, result, accountId),
      onUsageChanged: () => this.#onUsageChanged(provider, accountId),
      onLimitsChanged: (_provider, source) => this.#onLimitsChanged({ ...source, accountId }),
      onAuthChanged: () => modelLists.invalidate(provider),
      limitSnapshot: snapshot('limits'),
      chosenRuntime: () => this.#chosenRuntime(provider, accountId),
      ...this.#scopeOptions,
    })
    const modelLists = new ModelListCache({
      list: (_provider, agent, read) =>
        controls.forProvider(provider).listModels?.(agent, read) ?? Promise.resolve([]),
      onChanged: (_provider, agent) => this.#onModelsChanged(provider, agent, accountId),
      onLog: (line) => this.#onLog(line),
      snapshot: snapshot('models'),
      // Every account runs the same CLI, so its lists follow the same binary.
      binary: this.#providerBinary,
    })
    return { accountId, controls, modelLists, modelListAccounts: new Map() }
  }

  /** The scope of the account a chat runs as; none once that account is gone. */
  #threadScope(thread: Pick<Thread, 'provider' | 'accountId'>): AccountScope | undefined {
    try {
      return this.#scope(thread.provider, thread.accountId)
    } catch {
      return undefined
    }
  }

  #voiceRequests = new Map<string, AbortController>()

  watchProvider(
    provider: ProviderId,
    projectPath: string,
    targets: ParamsOf<'providers.watch'>['targets'],
  ) {
    return this.#controls.forProvider(provider).watch(projectPath, targets)
  }

  /**
   * Every model list is shared: see `ModelListCache` for when it asks the provider
   * again. Each account has lists of its own, since its plan may offer other models.
   */
  async listModels(provider: ProviderId, agent?: string, accountId?: AccountId): Promise<Model[]> {
    const scope = this.#scope(provider, sourceAccount(agent, accountId))
    if (!scope.controls.forProvider(provider).listModels) return []
    return scope.modelLists.list(provider, agent)
  }

  listCustomHarnesses() {
    return this.#customHarnesses.list()
  }

  upsertCustomHarness(harness: Parameters<CustomHarnessStore['upsert']>[0]) {
    const saved = this.#customHarnesses.upsert(harness)
    this.#modelLists.forgetAgent(saved.id)
    this.#invalidateBackgroundSources()
    return saved
  }

  verifyCustomHarness(
    harness: Parameters<CustomHarnessStore['upsert']>[0],
    workspacePath?: string,
  ) {
    return verifyCustomHarnessCompatibility(harness, workspacePath, this.#onLog)
  }

  removeCustomHarness(harnessId: string): void {
    this.#customHarnesses.remove(harnessId)
    this.#modelLists.forgetAgent(harnessId)
    this.#invalidateBackgroundSources()
  }

  contextSettings(): ProviderContextSettingsMap {
    return this.#store.providerContextSettings()
  }

  updateContextSettings(
    provider: ProviderId,
    settings: ProviderContextSettings,
  ): ProviderContextSettingsMap {
    validateContextSettings(providerContextControl(provider), settings)
    return this.#store.updateProviderContextSettings(provider, settings)
  }

  accountContextSettings(): readonly AccountContextSettings[] {
    return this.#store.accountContextSettings()
  }

  runtimeSettings(): ProviderRuntimeSettings {
    return this.#store.providerRuntimeSettings()
  }

  /** The default account's new sessions, model lists and limit reads use it; running ones keep theirs. */
  updateRuntimeSettings(provider: ProviderId, runtime: string | null): ProviderRuntimeSettings {
    validateRuntime(provider, runtime)
    return this.#store.updateProviderRuntimeSettings(provider, runtime)
  }

  accountRuntimeSettings(): readonly AccountRuntimeSetting[] {
    return this.#store.accountRuntimeSettings()
  }

  /** A further account's runtime, used as {@link updateRuntimeSettings} uses the default account's. */
  updateAccountRuntimeSetting(
    provider: ProviderId,
    accountId: AccountId,
    runtime: string | null,
  ): readonly AccountRuntimeSetting[] {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      throw new Error("The default account uses its provider's runtime setting.")
    }
    validateRuntime(provider, runtime)
    // Throws for an account that is gone or one this provider cannot have.
    this.#accounts.home(provider, accountId)
    return this.#store.updateAccountRuntimeSetting(provider, accountId, runtime)
  }

  /**
   * The account's chosen runtime, or undefined for the default one. Each account
   * chooses alone: one without a choice does not follow another account's.
   */
  #chosenRuntime(provider: ProviderId, accountId?: AccountId): string | undefined {
    const chosen =
      accountId === undefined || accountId === DEFAULT_ACCOUNT_ID
        ? this.#store.providerRuntimeSettings()[provider]
        : this.#store
            .accountRuntimeSettings()
            .find((entry) => entry.provider === provider && entry.accountId === accountId)?.runtime
    return runtimeForLaunch(provider, chosen)
  }

  /** Custom harnesses start their own engine; only the provider's own CLI follows the choice. */
  #runtimeLaunch(
    provider: ProviderId,
    agent: string | undefined,
    accountId?: AccountId,
  ): Pick<StartOptions, 'runtime'> {
    const runtime = agent ? undefined : this.#chosenRuntime(provider, accountId)
    return runtime === undefined ? {} : { runtime }
  }

  /** A further account's own settings; the default account always uses its provider's. */
  updateAccountContextSettings(entry: AccountContextSettings): readonly AccountContextSettings[] {
    if (entry.accountId === DEFAULT_ACCOUNT_ID) {
      throw new Error("The default account uses its provider's context settings.")
    }
    validateContextSettings(providerContextControl(entry.provider), entry.settings)
    // Throws for an account that is gone or one this provider cannot have.
    this.#accounts.home(entry.provider, entry.accountId)
    return this.#store.updateAccountContextSettings(entry)
  }

  /**
   * Custom harnesses configure their own engine, so only the provider's own
   * CLI is tuned. A further account's own context settings come first; without
   * any it runs with its provider's. Each account runs through its own chosen
   * runtime.
   */
  #contextRuntimeOptions(
    provider: ProviderId,
    agent: string | undefined,
    accountId: string | undefined,
  ): StartOptions {
    if (agent) return {}
    const launch = this.#runtimeLaunch(provider, agent, accountId)
    const own =
      accountId === undefined || accountId === DEFAULT_ACCOUNT_ID
        ? undefined
        : this.#store
            .accountContextSettings()
            .find((entry) => entry.provider === provider && entry.accountId === accountId)
    const context = contextForLaunch(
      providerContextControl(provider),
      own?.settings ?? this.#store.providerContextSettings()[provider],
    )
    return context ? { ...launch, context } : launch
  }

  async backgroundModelSettings(): Promise<BackgroundModelSettings> {
    const preference = this.#store.backgroundModelPreference()
    const loaded = await Promise.all(this.#backgroundSourceLoaders().map((loader) => loader.load()))
    const available = loaded.filter(
      (source): source is AvailableBackgroundModelSource => source !== undefined,
    )
    const resolved = resolveBackgroundModel(preference, available)
    const sources: BackgroundModelSource[] = available.map((source) => ({
      id: source.id,
      displayName: source.displayName,
      provider: source.provider,
      ...(source.connectionId ? { connectionId: source.connectionId } : {}),
      ...(source.agent ? { agent: source.agent } : {}),
      models: source.models,
    }))
    return { preference, sources, ...(resolved ? { resolved } : {}) }
  }

  async updateBackgroundModelPreference(
    preference: BackgroundModelPreference,
  ): Promise<BackgroundModelSettings> {
    this.#store.updateBackgroundModelPreference(preference)
    return this.backgroundModelSettings()
  }

  async generateBackgroundTitle(
    threadId: string,
    request: string,
    expectedTitle: string,
  ): Promise<{ title: string; applied: boolean }> {
    const before = this.#store.thread(threadId)
    if (!before) throw new Error(`no such thread: ${threadId}`)
    if (before.title !== expectedTitle) return { title: before.title, applied: false }
    // A provider that names its chats does so unasked, and provider history puts
    // that name in place of this one; a title model would only write a second
    // name. History reads the default account's folder only.
    if (
      PROVIDER_CAPABILITIES[before.provider].nativeTitles &&
      threadAccountHome(this.#accounts, before) === undefined
    ) {
      // The provider names a chat after its first prompt, which may still be on
      // its way. One that went out wrapped, such as a handover, would get
      // the chat named after TasteCode's wrapping, so the title model names it.
      await Promise.allSettled(this.#incomingSubmissions.get(threadId) ?? [])
      if (!this.#wrappedPrompts.has(threadId)) {
        this.#store.setProvisionalTitle(threadId, expectedTitle)
        this.#providerNamePrompts.set(threadId, request)
        return { title: expectedTitle, applied: false }
      }
    }

    const output = await this.#runBackgroundTask(titlePrompt(request), before)
    const title = cleanGeneratedTitle(output, expectedTitle)
    const current = this.#store.thread(threadId)
    const applied = current?.title === expectedTitle
    if (applied) this.#store.renameThread(threadId, title)
    return { title: applied ? title : (current?.title ?? expectedTitle), applied }
  }

  /** Whether a chat still has the stand-in title it got while its provider was to name it. */
  awaitsProviderTitle(threadId: string): boolean {
    return (
      !this.#fallbackTitled.has(threadId) && this.#store.provisionalTitle(threadId) !== undefined
    )
  }

  /**
   * Writes a title for a chat whose provider was left to name it and has not by
   * the end of a turn: Claude Code leaves a chat that opens with a bare greeting
   * unnamed. Call once provider history has had its chance to bring the
   * provider's name in. True when the chat was renamed.
   */
  async nameUnnamedChat(threadId: string): Promise<boolean> {
    const provisional = this.#store.provisionalTitle(threadId)
    const chat = this.#store.thread(threadId)
    if (provisional === undefined || !chat || this.#fallbackTitled.has(threadId)) return false
    this.#fallbackTitled.add(threadId)
    // A chat from before this run is known only by its stand-in, the start of its first prompt.
    const request = this.#providerNamePrompts.get(threadId) ?? provisional
    this.#providerNamePrompts.delete(threadId)
    const output = await this.#runBackgroundTask(titlePrompt(request), chat)
    // The provider's name, or the user's own, wins if it arrived meanwhile.
    if (this.#store.provisionalTitle(threadId) !== provisional) return false
    this.#store.renameThread(threadId, cleanGeneratedTitle(output, provisional))
    return true
  }

  /**
   * Notes whether a user prompt goes to the provider as the user's own words.
   * A chat already left for its provider to name keeps its stand-in, the start
   * of the user's request, instead of a name that describes the wrapping.
   */
  #notePromptWrapping(threadId: string, wrapped: boolean): void {
    if (!wrapped) {
      this.#wrappedPrompts.delete(threadId)
      return
    }
    this.#wrappedPrompts.add(threadId)
    if (!this.#providerNamePrompts.delete(threadId)) return
    const standIn = this.#store.provisionalTitle(threadId)
    if (standIn !== undefined) this.#store.renameThread(threadId, standIn)
  }

  /** `threadId`: the chat whose checkout the diff is, when the request names one. */
  async generateBackgroundCommitMessage(diff: SessionDiff, threadId?: string): Promise<string> {
    if (diff.files.length === 0) throw new Error('The working tree is clean.')
    const chat = threadId ? this.#store.thread(threadId) : undefined
    const output = await this.#runBackgroundTask(commitMessagePrompt(diff), chat)
    return cleanGeneratedCommitMessage(output)
  }

  /**
   * `chat`: the chat this writing is for. When the background source is that
   * chat's own provider, the prompt (its first message, its diff) goes through
   * the chat's account, never through the default one.
   */
  async #runBackgroundTask(
    prompt: string,
    chat?: { provider: ProviderId; accountId?: AccountId | undefined },
  ): Promise<string> {
    const preference = this.#store.backgroundModelPreference()
    // Each source read can start vendor processes; read only what this choice needs.
    const failed: Array<Pick<BackgroundModelSourceLoader, 'provider' | 'connectionId' | 'agent'>> =
      []
    let lastError: unknown
    for (;;) {
      const loaders = this.#backgroundSourceLoaders(chat).filter(
        (loader) =>
          !failed.some(
            (source) =>
              source.provider === loader.provider &&
              source.connectionId === loader.connectionId &&
              source.agent === loader.agent,
          ),
      )
      const resolved = await resolveBackgroundModelFrom(preference, loaders)
      if (!resolved) break
      // A custom harness keeps its own sign-in; another provider has no account of this chat.
      const ownAccount = chat && !resolved.agent && resolved.provider === chat.provider
      const runtime = this.#runtimeFor(
        resolved.provider,
        this.#onLog,
        ownAccount ? threadAccountHome(this.#accounts, chat) : undefined,
      )
      // The account's own runtime choice, as its chats and model lists use it.
      const { runtime: runtimeChoice } = this.#runtimeLaunch(
        resolved.provider,
        resolved.agent,
        ownAccount ? chat.accountId : undefined,
      )
      try {
        return await runBackgroundCompletion({
          runtime,
          runtimeChoice,
          selection: resolved,
          prompt,
          onCleanupError: (error) =>
            this.#onLog(`[background] provider cleanup failed: ${errorMessage(error)}`),
        })
      } catch (error) {
        if (preference.mode === 'manual') throw error
        failed.push({
          provider: resolved.provider,
          connectionId: resolved.connectionId,
          agent: resolved.agent,
        })
        lastError = error
      }
    }
    if (lastError !== undefined) throw lastError
    throw new Error(
      preference.mode === 'manual'
        ? 'The selected background model is unavailable. Choose another one in Settings.'
        : 'Connect a provider with an available model before using background writing.',
    )
  }

  /**
   * `chat`: its own provider answers as its account, whose sign-in and plan
   * decide what can write for it, whatever the default account has.
   */
  #backgroundSourceLoaders(chat?: {
    provider: ProviderId
    accountId?: AccountId | undefined
  }): BackgroundModelSourceLoader[] {
    // The desktop starts only the providers the user added; background writing
    // is no exception. Custom harnesses are not part of the roster.
    const roster = this.#store.providerRoster()
    const added = BACKGROUND_PROVIDERS.filter(
      ([provider]) => roster === null || roster.includes(provider),
    )
    const builtIns = added.map(([provider, displayName]) => {
      const accountId =
        chat?.provider === provider && chat.accountId !== DEFAULT_ACCOUNT_ID
          ? chat.accountId
          : undefined
      return {
        provider,
        load: async () => {
          // A chat whose account is gone gets no writing, rather than another account's.
          if (accountId) threadAccountHome(this.#accounts, { provider, accountId })
          return this.#backgroundSource(accountId ? `${provider}@${accountId}` : provider, () =>
            this.#discoverProviderSource(provider, displayName, accountId),
          )
        },
      }
    })
    const custom = this.#customHarnesses.list().map((harness) => ({
      provider: harness.provider,
      agent: harness.id,
      load: () =>
        this.#backgroundSource(`${harness.provider}:${harness.id}`, () =>
          this.#discoverHarnessSource(harness),
        ),
    }))
    return [...builtIns, ...custom]
  }

  /** One read per source serves concurrent callers and, for a minute, later ones. */
  #backgroundSource(
    id: string,
    discover: () => Promise<AvailableBackgroundModelSource | undefined>,
  ): Promise<AvailableBackgroundModelSource | undefined> {
    const current = this.#backgroundSources.get(id)
    if (current && current.expiresAt > Date.now()) return current.reading

    const revision = this.#backgroundSourcesRevision
    const entry: BackgroundSourceEntry = {
      reading: discover(),
      expiresAt: Number.POSITIVE_INFINITY,
    }
    this.#backgroundSources.set(id, entry)
    // A read an invalidation overtook still answers its callers, but nobody later.
    const settle = (succeeded: boolean) => {
      if (this.#backgroundSources.get(id) !== entry) return
      if (succeeded && this.#backgroundSourcesRevision === revision) {
        entry.expiresAt = Date.now() + BACKGROUND_SOURCE_TTL_MS
      } else {
        this.#backgroundSources.delete(id)
      }
    }
    void entry.reading.then(
      () => settle(true),
      () => settle(false),
    )
    return entry.reading
  }

  async #discoverProviderSource(
    provider: (typeof BACKGROUND_PROVIDERS)[number][0],
    displayName: string,
    accountId?: AccountId,
  ): Promise<AvailableBackgroundModelSource | undefined> {
    try {
      const account = await this.account(provider, undefined, accountId)
      if (!account.signedIn) return undefined
      const models = await this.listModels(provider, undefined, accountId)
      if (models.length === 0) return undefined
      return {
        id: provider,
        displayName,
        provider,
        models,
        ...(provider === 'codex'
          ? {
              codexSubscription: Boolean(account.plan && account.plan.toLowerCase() !== 'api key'),
            }
          : {}),
      } satisfies AvailableBackgroundModelSource
    } catch {
      return undefined
    }
  }

  async #discoverHarnessSource(
    harness: CustomHarness,
  ): Promise<AvailableBackgroundModelSource | undefined> {
    try {
      const models = await this.listModels(harness.provider, harness.id)
      if (models.length === 0) return undefined
      return {
        id: `${harness.provider}:${harness.id}`,
        displayName: harness.displayName,
        provider: harness.provider,
        agent: harness.id,
        models,
      } satisfies AvailableBackgroundModelSource
    } catch {
      return undefined
    }
  }

  #invalidateBackgroundSources(): void {
    this.#backgroundSourcesRevision += 1
    this.#backgroundSources.clear()
  }

  async listMcpServers(provider: ProviderId, projectPath: string): Promise<McpInventory> {
    const control = this.#controls.forProvider(provider)
    if (!control.capabilities.managedMcp && !control.listMcpServers) {
      return { capabilities: UNSUPPORTED_MCP_CAPABILITIES, servers: [] }
    }
    this.watchProvider(provider, projectPath, ['mcp'])
    const active = this.#findProjectRuntime(
      provider,
      projectPath,
      ({ session }) => session.listMcpServers !== undefined,
    )
    const inventory: McpInventory = control.listMcpServers
      ? await control.listMcpServers(
          projectPath,
          active
            ? () =>
                this.#withThreadRuntimeOperation(active[0], async () => {
                  const { session, thread } = active[1]
                  const servers = await session.listMcpServers!(thread.id)
                  return session.isMcpLoading?.(thread.id)
                    ? { servers, loading: true }
                    : { servers }
                })
            : undefined,
        )
      : { capabilities: PROJECT_MCP_MANAGEMENT_CAPABILITIES, servers: [] }
    // TasteCode's own agent tools are not one of the user's servers.
    const inherited = inventory.servers.filter((server) => server.id !== AGENT_TOOLS_SERVER_ID)
    const servers = new Map(inherited.map((server) => [server.id, server]))
    for (const config of this.#mcpConfig.list(provider, projectPath)) {
      const current = servers.get(config.id)
      const base: McpServer = current ?? {
        id: config.id,
        scope: 'project',
        enabled: config.enabled,
        auth: { status: 'not_required' },
        startup: { state: 'stopped' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      }
      servers.set(config.id, {
        ...base,
        scope: 'project',
        enabled: config.enabled,
        ...(!config.enabled
          ? { startup: { state: 'stopped' as const } }
          : {
              transport: config.transport,
              ...(config.displayName
                ? {
                    displayName: config.displayName,
                  }
                : {}),
            }),
      })
    }
    if (this.#simulatorAgent) servers.delete(this.#simulatorAgent.serverId)
    return {
      capabilities: inventory.capabilities,
      servers: [...servers.values()],
      ...(inventory.loading ? { loading: true } : {}),
    }
  }

  /**
   * The chat's own session answers first, then any chat in the project, then
   * the provider's discovery service; a provider with none of them has none.
   */
  async listCommands(
    provider: ProviderId,
    projectPath: string,
    threadId?: string,
  ): Promise<CommandInventory> {
    const control = this.#controls.forProvider(provider)
    const own = threadId === undefined ? undefined : this.#threads.get(threadId)
    const active: [string, AttachedThreadRuntime] | undefined =
      threadId !== undefined &&
      own?.session.listCommands &&
      own.thread.provider === provider &&
      own.projectPath === projectPath
        ? [threadId, own]
        : this.#findProjectRuntime(
            provider,
            projectPath,
            ({ session }) => session.listCommands !== undefined,
          )
    const readActive = active
      ? () =>
          this.#withThreadRuntimeOperation(active[0], () =>
            active[1].session.listCommands!(active[1].thread.id),
          )
      : undefined
    if (control.listCommands) this.watchProvider(provider, projectPath, ['commands'])
    const inventory: CommandInventory = control.listCommands
      ? await control.listCommands(projectPath, readActive)
      : { commands: readActive ? await readActive() : [], loading: false }
    return control.capabilities.defaultSkillsPlugin
      ? this.#withBundledCommands(inventory)
      : inventory
  }

  /**
   * A provider that loads the bundled skills as a plugin runs them as that
   * plugin's commands, but a list read before any of its chats loaded the
   * plugin (a probe, a file read) leaves them out. The slash menu then offered
   * them as `$name`, which such a provider does not expand.
   */
  #withBundledCommands(inventory: CommandInventory): CommandInventory {
    const bundled = this.#bundledSkills().commands
    // A live probe reports the plugin-qualified alias. Keep just the bare row,
    // while letting the user's own command keep precedence over a bundled skill.
    const aliases = new Set(bundled.flatMap((command) => command.aliases ?? []))
    const commands = inventory.commands.filter((command) => !aliases.has(command.name))
    const listed = new Set(commands.map((command) => command.name))
    const missing = bundled.filter((command) => !listed.has(command.name))
    return missing.length || commands.length !== inventory.commands.length
      ? { ...inventory, commands: [...commands, ...missing] }
      : inventory
  }

  async listSkills(
    provider: ProviderId,
    projectPath: string,
  ): Promise<{
    capabilities: SkillCapabilities
    skills: Skill[]
    errors: SkillDiscoveryError[]
  }> {
    const control = this.#controls.forProvider(provider)
    // `.agents/skills` is Codex's folder. Listing it for a CLI that never loads
    // it offered skills that did nothing when picked.
    const local = control.capabilities.agentsSkillsDir
      ? await listLocalSkills(projectPath)
      : undefined
    // Every provider's chats can use the skills that ship with TasteCode, so
    // they are listed even where the provider has no inventory of its own.
    const bundled = this.#bundledSkills().skills
    if (!control.listSkills) {
      const own = local
        ? { capabilities: LOCAL_SKILL_CAPABILITIES, ...local }
        : { capabilities: NO_SKILL_CAPABILITIES, skills: [], errors: [] }
      return { ...own, skills: mergeSkills(own.skills, bundled) }
    }
    this.watchProvider(provider, projectPath, ['skills'])
    const vendor = await control.listSkills(projectPath)
    return {
      capabilities: vendor.capabilities,
      skills: mergeSkills(mergeSkills(vendor.skills, local?.skills ?? []), bundled),
      errors: [...vendor.errors, ...(local?.errors ?? [])],
    }
  }

  /** Read once per server: the bundled files do not change while it runs. */
  #bundledSkills(): DefaultSkills {
    const root = this.#defaultSkillsRoot
    this.#defaultSkills ??= root
      ? loadDefaultSkills(root)
      : { root: '', skills: [], commands: [], catalog: '', creatify: '' }
    return this.#defaultSkills
  }

  /**
   * The instructions a session starts with: reply style, then the default
   * skills (as a plugin where the provider loads them itself, as a short
   * catalog everywhere else), then any instructions of the caller. Side work
   * that is not a chat of its own leaves the skills out.
   */
  #sessionStart(
    provider: ProviderId,
    instructions?: string,
    { skills = true, threadId }: { skills?: boolean; threadId?: string | undefined } = {},
  ): Pick<StartOptions, 'instructions' | 'skillPlugin'> {
    const bundled = skills ? this.#bundledSkills() : undefined
    const native = this.#controls.forProvider(provider).capabilities.defaultSkillsPlugin
    const catalog = bundled && !native ? bundled.catalog : ''
    const simulatorInstructions =
      threadId !== undefined &&
      (PROVIDER_CAPABILITIES[provider].managedMcp || PROVIDER_CAPABILITIES[provider].agentTools) &&
      this.#simulatorAgent?.mcpConfigForThread(threadId)
        ? this.#simulatorAgent.instructions
        : undefined
    return {
      instructions: composeInstructions(
        [catalog, instructions?.trim(), simulatorInstructions].filter(Boolean).join('\n\n'),
      ),
      ...(bundled?.skills.length && native ? { skillPlugin: bundled.root } : {}),
    }
  }

  async setSkillEnabled(
    provider: ProviderId,
    projectPath: string,
    skillId: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (isDefaultSkillId(skillId))
      throw new Error('Skills included with TasteCode cannot be turned off yet.')
    const control = this.#controls.forProvider(provider)
    if (!control.setSkillEnabled)
      throw new Error(`provider "${provider}" cannot configure skills yet`)
    this.watchProvider(provider, projectPath, ['skills'])
    return control.setSkillEnabled(projectPath, skillId, enabled)
  }

  async installSkillFromFolder(
    provider: ProviderId,
    projectPath: string,
    folderPath: string,
  ): Promise<Skill> {
    const control = this.#controls.forProvider(provider)
    if (!control.capabilities.skillsInstall || !control.listSkills) {
      throw new Error(`provider "${provider}" cannot install skills yet`)
    }

    const destination = await installLocalSkill(projectPath, folderPath)
    try {
      this.watchProvider(provider, projectPath, ['skills'])
      const inventory = await control.listSkills(projectPath)
      const installed = inventory.skills.find(
        (skill) =>
          skill.source.type === 'folder' && sameSkillFolder(skill.source.path, destination),
      )
      if (installed) return installed

      const discoveryError = inventory.errors.find((error) =>
        insideSkillFolder(error.path, destination),
      )
      throw new Error(discoveryError?.message ?? 'Provider did not discover the installed skill')
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  }

  addMcpServer(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    this.#requireMcpManagement(provider)
    assertUserMcpServerId(server.id)
    this.#controls.forProvider(provider).validateMcpServer?.(server)
    this.#mcpConfig.add(provider, projectPath, server)
    this.#controls.projectMcpConfigChanged(provider, projectPath)
  }

  updateMcpServer(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    this.#requireMcpManagement(provider)
    assertUserMcpServerId(server.id)
    this.#controls.forProvider(provider).validateMcpServer?.(server)
    this.#mcpConfig.update(provider, projectPath, server)
    this.#controls.projectMcpConfigChanged(provider, projectPath)
  }

  removeMcpServer(provider: ProviderId, projectPath: string, serverId: string): void {
    this.#requireMcpManagement(provider)
    this.#mcpConfig.remove(provider, projectPath, serverId)
    this.#controls.projectMcpConfigChanged(provider, projectPath)
  }

  async reloadMcpServers(provider: ProviderId, projectPath: string): Promise<void> {
    this.#requireMcpManagement(provider)
    if (!PROVIDER_CAPABILITIES[provider].inheritedMcp) {
      throw new Error(`provider "${provider}" applies MCP changes to new sessions`)
    }
    const active = new Map<string, AttachedThreadRuntime>()
    for (const threadId of this.#runtimeThreadIdsByProject.get(provider)?.get(projectPath) ?? []) {
      const entry = this.#threads.get(threadId)
      if (entry) active.set(threadId, entry)
    }
    // A runtime that starts from here reads the saved servers.
    if (active.size === 0) return
    const results = await Promise.allSettled(
      [...active].map(async ([threadId, entry]) => {
        if (entry.session.reloadMcpServers) {
          const options = this.#mcpRuntimeOptions(provider, projectPath, threadId)
          // A chat with agent tools keeps them through a reload.
          const own = this.#agentToolGrants.has(threadId)
            ? (await this.#agentToolsOptions(provider, threadId, options)).options
            : options
          return this.#withThreadRuntimeOperation(threadId, () =>
            entry.session.reloadMcpServers!(
              entry.thread.id,
              own.mcpServers ?? [],
              own.mcpCredentials ?? {},
            ),
          )
        }
        // Without a live reload, only a resumed runtime starts with the current servers.
        if (this.#isSideThread(threadId)) {
          throw new Error('Temporary chats keep the MCP servers they started with.')
        }
        if (!entry.resumable) throw new Error('A chat that cannot resume keeps its MCP servers.')
        this.#mcpStaleRuntimes.set(threadId, entry.session)
      }),
    )
    this.#pruneIdleThreadRuntimes()
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === 1) throw failures[0]!.reason
    if (failures.length > 1)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Could not reload MCP servers for every session',
      )
  }

  async startMcpOAuth(
    provider: ProviderId,
    projectPath: string,
    serverId: string,
  ): Promise<{ loginId: string; authUrl: string }> {
    this.#requireMcpManagement(provider)
    const active = this.#findProjectRuntime(provider, projectPath)
    if (!active?.[1].session.startMcpOAuth) {
      throw new Error(
        'start a compatible session for this project before signing in to an MCP server',
      )
    }
    const [threadId, entry] = active
    const pending = this.#mcpOAuthThreads.get(threadId) ?? {
      starting: 0,
      logins: new Map<string, string>(),
      early: new Set<string>(),
    }
    this.#mcpOAuthThreads.set(threadId, pending)
    pending.starting += 1
    this.#touchThreadRuntime(threadId)
    try {
      const login = await entry.session.startMcpOAuth!(serverId, entry.thread.id)
      if (!pending.early.delete(login.loginId)) {
        // A newer sign-in to the same server replaces the older one, which
        // will never report a result.
        for (const [loginId, server] of pending.logins)
          if (server === serverId) pending.logins.delete(loginId)
        pending.logins.set(login.loginId, serverId)
      }
      return login
    } finally {
      pending.starting -= 1
      this.#settleMcpOAuth(threadId, pending)
    }
  }

  #finishMcpOAuth(threadId: string, loginId: string): void {
    const pending = this.#mcpOAuthThreads.get(threadId)
    if (!pending) return
    if (!pending.logins.delete(loginId) && pending.starting > 0) pending.early.add(loginId)
    this.#settleMcpOAuth(threadId, pending)
  }

  #settleMcpOAuth(
    threadId: string,
    pending: { starting: number; logins: Map<string, string>; early: Set<string> },
  ): void {
    if (pending.starting > 0) return
    pending.early.clear()
    if (pending.logins.size > 0 || this.#mcpOAuthThreads.get(threadId) !== pending) return
    this.#mcpOAuthThreads.delete(threadId)
    this.#pruneIdleThreadRuntimes()
  }

  cancelMcpOAuth(provider: ProviderId): never {
    throw new Error(
      `provider "${provider}" cannot cancel MCP OAuth; close the browser flow instead`,
    )
  }

  /**
   * A chat of the project that answers for the project's views (MCP servers,
   * their sign-in, commands). Those views are the default account's, so only a
   * chat on the default account qualifies: another account's chat keeps its
   * own MCP tokens and commands in its own folder.
   */
  #findProjectRuntime(
    provider: ProviderId,
    projectPath: string,
    accepts?: (entry: AttachedThreadRuntime) => boolean,
  ): [string, AttachedThreadRuntime] | undefined {
    const threadIds = this.#runtimeThreadIdsByProject.get(provider)?.get(projectPath)
    if (!threadIds) return undefined
    let stale: [string, AttachedThreadRuntime] | undefined
    for (const threadId of threadIds) {
      const entry = this.#threads.get(threadId)
      if (!entry || entry.thread.accountId !== undefined || (accepts && !accepts(entry))) continue
      // A runtime still waiting to resume does not know the saved MCP servers.
      if (this.#mcpStaleRuntimes.get(threadId) !== entry.session) return [threadId, entry]
      stale ??= [threadId, entry]
    }
    return stale
  }

  #requireMcpManagement(provider: ProviderId): void {
    assertProviderOffered(provider)
    if (!PROVIDER_CAPABILITIES[provider].managedMcp)
      throw new Error(`provider "${provider}" cannot manage MCP servers yet`)
  }

  #mcpRuntimeOptions(provider: ProviderId, projectPath: string, threadId?: string): StartOptions {
    const canManage = PROVIDER_CAPABILITIES[provider].managedMcp
    const canInjectSimulator = canManage || PROVIDER_CAPABILITIES[provider].agentTools
    if (!canInjectSimulator) return {}
    const mcpServers = canManage ? [...this.#mcpConfig.list(provider, projectPath)] : []
    const mcpCredentials: Record<string, string> = {}
    for (const server of mcpServers) {
      if (!server.enabled) continue
      const values =
        server.transport.type === 'stdio'
          ? Object.values(server.transport.environment ?? {})
          : Object.values(server.transport.headers ?? {})
      for (const value of values) {
        if (value.source === 'credential' && mcpCredentials[value.credentialRef] === undefined) {
          mcpCredentials[value.credentialRef] = this.#readCredential(value.credentialRef)
        }
      }
    }
    if (threadId !== undefined && this.#simulatorAgent) {
      const injected = this.#simulatorAgent.mcpConfigForThread(threadId)
      if (injected && !mcpServers.some((entry) => entry.id === injected.server.id)) {
        mcpServers.push(injected.server)
        Object.assign(mcpCredentials, injected.credentials)
      }
    }
    if (!canManage && mcpServers.length === 0) return {}
    return { mcpServers, mcpCredentials }
  }

  /** Whether a chat on `provider` gets the agent tools. Synchronous, so other starts keep their timing. */
  #offersAgentTools(provider: ProviderId): boolean {
    return this.#agentTools !== undefined && PROVIDER_CAPABILITIES[provider].agentTools
  }

  /**
   * Adds TasteCode's agent tools as the reserved `tastecode` server for a chat
   * whose provider takes them. Its token names the chat once `threadId` is
   * known; a new chat's caller binds it after the chat exists.
   */
  async #agentToolsOptions(
    provider: ProviderId,
    threadId: string | undefined,
    mcp: StartOptions,
  ): Promise<{ options: StartOptions; grant?: AgentToolsGrant }> {
    const endpoint = this.#agentTools
    if (!endpoint || !PROVIDER_CAPABILITIES[provider].agentTools) return { options: mcp }
    let url: string
    try {
      url = await endpoint.url()
    } catch (error) {
      this.#onLog(`[agent-tools] not offered: ${errorMessage(error)}`)
      return { options: mcp }
    }
    const grant = (threadId && this.#agentToolGrants.get(threadId)) || endpoint.grant()
    if (threadId) {
      grant.bind(threadId)
      this.#agentToolGrants.set(threadId, grant)
    }
    const server: McpServerConfig = {
      id: AGENT_TOOLS_SERVER_ID,
      enabled: true,
      displayName: 'TasteCode agents',
      transport: {
        type: 'http',
        url,
        headers: { Authorization: { source: 'credential', credentialRef: AGENT_TOOLS_CREDENTIAL } },
      },
    }
    return {
      options: {
        mcpServers: [
          ...(mcp.mcpServers ?? []).filter((entry) => entry.id !== AGENT_TOOLS_SERVER_ID),
          server,
        ],
        mcpCredentials: { ...mcp.mcpCredentials, [AGENT_TOOLS_CREDENTIAL]: grant.authorization },
      },
      grant,
    }
  }

  #revokeAgentTools(threadId: string): void {
    this.#agentToolGrants.get(threadId)?.revoke()
    this.#agentToolGrants.delete(threadId)
  }

  async account(provider: ProviderId, agent?: string, accountId?: AccountId): Promise<Account> {
    const scope = this.#scope(provider, sourceAccount(agent, accountId))
    const account = await scope.controls.forProvider(provider).account(agent)
    if (agent === undefined) {
      // A sign-in or switch in the provider's own CLI shows up only here, and
      // another account may offer other models.
      const { identity, switched } = accountRead(scope.modelListAccounts.get(provider), account)
      scope.modelListAccounts.set(provider, identity)
      if (switched) scope.modelLists.invalidate(provider)
    }
    return account
  }

  /** Spends a reset the account earned, in its own folder; absent, the default account's. */
  async consumeRateLimitReset(
    provider: ProviderId,
    idempotencyKey: string,
    creditId?: string,
    accountId?: AccountId,
  ): Promise<{ outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed' }> {
    const { controls } = this.#scope(provider, accountId)
    const consume = controls.forProvider(provider).consumeRateLimitReset
    if (!consume) throw new Error(`provider "${provider}" cannot consume a rate-limit reset`)
    return consume(idempotencyKey, creditId)
  }

  async usageLimitSource(
    provider: ProviderId,
    intent?: UsageReadIntent,
    accountId?: AccountId,
  ): Promise<ProviderLimitSource> {
    const scope = this.#scope(provider, accountId)
    return withAccount(await scope.controls.forProvider(provider).usageLimitSource(intent), scope)
  }

  /** The provider's held limits, without starting a read; see ProviderControl. */
  heldLimitSource(
    provider: ProviderId,
    intent?: UsageReadIntent,
    accountId?: AccountId,
  ): ProviderLimitSource | undefined {
    const scope = this.#scope(provider, accountId)
    const held = scope.controls.forProvider(provider).heldLimitSource(intent)
    return held && withAccount(held, scope)
  }

  /**
   * The provider's accounts as one pool, from the limits already held for each; it
   * never asks a vendor. An account whose folder is gone shows as unavailable.
   */
  accountPool(provider: ProviderId): ResultOf<'accounts.pool'> {
    const listed = this.#accounts.accounts?.(provider) ?? []
    const accounts: readonly ProviderAccount[] =
      listed.length > 0
        ? listed
        : [{ id: DEFAULT_ACCOUNT_ID, provider, label: 'Default', managed: false }]
    const members = accounts.map((account) => {
      const weights = this.#accounts.planWeights?.(provider, account.plan)
      try {
        const source = this.heldLimitSource(provider, 'background', account.id)
        return { account, weights, source }
      } catch {
        return { account, weights, source: undefined, unavailable: true }
      }
    })
    return accountPool(provider, members, Date.now(), (limitId) =>
      this.#accounts.overallLimit ? this.#accounts.overallLimit(provider, limitId) : true,
    )
  }

  /**
   * The account a new chat the user did not pin starts on when the provider has
   * several: the pool's recommended one, so the allowance that refills first is used
   * first. None without limit data, and none for a custom harness, which runs with
   * its own sign-in; the provider's active account decides then.
   */
  #recommendedAccount(provider: ProviderId, agent: string | undefined): AccountId | undefined {
    if (agent !== undefined || (this.#accounts.accounts?.(provider).length ?? 0) < 2)
      return undefined
    try {
      return this.accountPool(provider).recommended
    } catch (error) {
      this.#onLog(`[accounts] no recommended ${provider} account: ${errorMessage(error)}`)
      return undefined
    }
  }

  /** Signs in as the account, in its own folder; absent, the default account. */
  async startLogin(
    provider: ProviderId,
    accountId?: AccountId,
  ): Promise<{ loginId: string; authUrl?: string }> {
    const start = this.#scope(provider, accountId).controls.forProvider(provider).startLogin
    if (!start) throw new Error(`provider "${provider}" cannot sign in yet`)
    return start()
  }

  async cancelLogin(provider: ProviderId, loginId: string, accountId?: AccountId): Promise<void> {
    await this.#scope(provider, accountId).controls.forProvider(provider).cancelLogin?.(loginId)
  }

  async useApiKey(provider: ProviderId, apiKey: string, accountId?: AccountId): Promise<Account> {
    const use = this.#scope(provider, accountId).controls.forProvider(provider).useApiKey
    if (!use) throw new Error(`provider "${provider}" cannot sign in yet`)
    return use(apiKey)
  }

  async signOut(provider: ProviderId, agent?: string, accountId?: AccountId): Promise<void> {
    const scope = this.#scope(provider, sourceAccount(agent, accountId))
    await scope.controls.forProvider(provider).signOut(agent)
  }

  async voiceStatus(provider: ProviderId): Promise<{
    available: boolean
    reason?: 'provider_unsupported' | 'sign_in_required' | 'unsupported_auth' | 'codex_too_old'
  }> {
    return this.#voice.status(provider)
  }

  async transcribeVoice(input: ParamsOf<'voice.transcribe'>): Promise<{ text: string }> {
    if (this.#voiceRequests.has(input.requestId)) {
      throw new Error('A voice transcription with this request id is already running.')
    }
    const controller = new AbortController()
    this.#voiceRequests.set(input.requestId, controller)
    try {
      const text = await this.#voice.transcribe(input, controller.signal)
      return { text }
    } finally {
      this.#voiceRequests.delete(input.requestId)
    }
  }

  cancelVoice(requestId: string): void {
    this.#voiceRequests.get(requestId)?.abort()
  }

  /**
   * `options.accountId` pins the chat to that provider account; absent, the
   * provider's active one. The chat runs as that account from then on.
   */
  async startThread(
    provider: ProviderId,
    workspacePath: string,
    options: StartOptions & {
      accountId?: AccountId | undefined
      /** An earlier chat whose conversation this one carries on. */
      continueFrom?: string | undefined
    } = {},
  ): Promise<Thread> {
    const resolved = resolveWorkspacePath(workspacePath)
    if (this.#panicStopping) throw new Error('task start cancelled by panic stop')
    // Before the base-branch switch below, which would move the user's checkout
    // for a chat that can never start.
    assertProviderOffered(provider)
    const generation = {
      dispose: this.#disposeGeneration,
      panic: this.#panicGeneration,
      project: this.#projectGenerations.get(resolved) ?? 0,
    }
    const start = () => this.#startThread(provider, workspacePath, options, generation)
    if (options.isolate) return start()
    const owner = `start-${crypto.randomUUID()}`
    this.#checkoutAccess.beginTurn(resolved, owner)
    try {
      if (!options.baseRef) return await start()
      if (options.baseRef !== 'HEAD') {
        const branch = await currentBranch(resolved)
        // A git that timed out on a busy machine says nothing about the
        // checkout. Switching on that guess timed out as well and failed the
        // chat ("could not switch to main"); starting where it is does not.
        if (branch === undefined || branch === options.baseRef) return await start()
      }
    } finally {
      this.#checkoutAccess.endTurn(owner)
    }
    // Prevent a restore or turn from slipping between branch selection and
    // attaching the new runtime. Branch selection is a server operation.
    return this.#checkoutAccess.exclusive(resolved, async () => {
      if (options.baseRef) await switchWorkspaceBranch(resolved, options.baseRef)
      return start()
    })
  }

  /**
   * A chat carries on an earlier one of the same provider, whose conversation
   * the server still has. It is checked before an agent starts.
   */
  #assertContinuable(earlierId: string, provider: ProviderId): void {
    const earlier = this.#store.thread(earlierId)
    if (!earlier || earlier.ephemeral) {
      throw new Error('The chat to continue does not exist any more.')
    }
    if (earlier.provider !== provider) {
      throw new Error('A chat can only be continued with the provider it ran on.')
    }
  }

  /**
   * The provider session a chat's conversation can be carried on from, where
   * its provider saved it: undefined while the session lacks part of the
   * conversation (a handover, a continuation or a restore not sent yet) or a
   * turn is still writing to it.
   */
  #savedSession(threadId: string): SavedSession | undefined {
    const stored = this.#store.thread(threadId)
    if (
      !stored ||
      stored.ephemeral ||
      this.#sideParents.has(threadId) ||
      this.isTurnRunning(threadId) ||
      this.#store.threadNeedsHandover(threadId) ||
      this.#store.threadNeedsContinueContext(threadId) ||
      this.#store.threadNeedsRestoreContext(threadId)
    )
      return undefined
    try {
      const accountHome = threadAccountHome(this.#accounts, stored)
      return {
        providerSessionId: stored.providerSessionId ?? stored.id,
        ...(accountHome === undefined ? {} : { accountHome }),
      }
    } catch {
      // Its account was removed: nothing is left to carry on.
      return undefined
    }
  }

  /**
   * A session that starts with the conversation of a saved one, or undefined
   * when the provider cannot carry that session on; the conversation then
   * goes as text with the first prompt.
   */
  async #carryOn(
    runtime: ProviderRuntime,
    workspacePath: string,
    saved: SavedSession | undefined,
    options: StartOptions,
  ): Promise<{ thread: Thread; session: AgentSession } | undefined> {
    if (!saved || !runtime.fork) return undefined
    try {
      return await runtime.fork(workspacePath, saved, options)
    } catch (error) {
      if (error instanceof StartupCleanupError) throw error
      this.#onLog(`[carry] the conversation goes as text instead: ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * A chat that continues an isolated one gets a checkout of its own, made from
   * the earlier chat's branch; two chats never share one. Whatever the earlier
   * chat had not committed is copied into it, and the earlier checkout is only
   * read. Undefined when there was nothing to carry.
   */
  async #carryEarlierChanges(
    earlierId: string,
    worktree: Worktree,
  ): Promise<'carried' | 'kept' | undefined> {
    const earlier = this.#store.thread(earlierId)?.worktreePath
    if (earlier === undefined) return undefined
    let result
    try {
      result = await carryUncommittedChanges(privateCheckoutPath(earlier), worktree)
    } catch (error) {
      result = { carried: false, reason: errorMessage(error) } as const
    }
    if (result === undefined) return undefined
    if (result.carried) return 'carried'
    this.#onLog(`[continue] uncommitted changes stay in ${earlier}: ${result.reason}`)
    return 'kept'
  }

  /**
   * Where the uncommitted changes of the chat this one continues went, for its
   * first prompt and its note. Undefined when there were none to carry.
   */
  earlierChanges(threadId: string): EarlierChanges | undefined {
    const thread = this.#store.thread(threadId)
    if (thread?.continuedChanges === 'carried') return { carried: true }
    if (thread?.continuedChanges !== 'kept' || thread.continuedFrom === undefined) return undefined
    const keptIn = this.#store.thread(thread.continuedFrom)?.worktreePath
    // A checkout discarded since holds nothing any more, so the prompt names none.
    return keptIn !== undefined && existsSync(keptIn) ? { carried: false, keptIn } : undefined
  }

  /**
   * Moves an open chat to another provider, agent or account. The chat keeps
   * its id, conversation and checkout. A session starts at the new place
   * first; only once it runs does the chat's own session stop, so a chat
   * whose move fails stays where it was. A move to another account of the
   * same provider carries the provider's own session on there; any other move
   * sends the conversation with the next prompt (see `#handoverPrompt`). A
   * notice in the transcript marks the move.
   */
  async changeProvider(
    threadId: string,
    target: {
      provider: ProviderId
      agent?: string | undefined
      accountId?: AccountId | undefined
      model?: string | undefined
      serviceTier?: string | undefined
      effort?: string | undefined
      approval?: ApprovalMode | undefined
    },
  ): Promise<Thread> {
    if (this.#panicStopping) throw new Error('The move was cancelled by panic stop.')
    const stored = this.#store.thread(threadId)
    if (!stored || stored.closedAt !== undefined) throw new Error(`no such thread: ${threadId}`)
    if (stored.ephemeral || this.#sideParents.has(threadId)) {
      throw new Error('A Side chat stays with the provider of its chat.')
    }
    if (target.provider === 'api') {
      throw new Error('A chat cannot move to an API connection.')
    }
    const accountId = accountForNewThread(
      this.#accounts,
      target.provider,
      target.agent,
      target.accountId,
    )
    if (
      stored.provider === target.provider &&
      stored.agent === target.agent &&
      (stored.accountId ?? DEFAULT_ACCOUNT_ID) === accountId
    ) {
      throw new Error('The chat already runs there.')
    }
    if (this.#changingProvider.has(threadId)) {
      throw new Error('This chat is already moving to another provider.')
    }
    this.#assertCanChangeProvider(threadId)
    const approvalChange = this.#approvalChanges.get(threadId)
    if (approvalChange) await approvalChange.catch(() => undefined)

    this.#changingProvider.add(threadId)
    const panicGeneration = this.#panicGeneration
    const disposeGeneration = this.#disposeGeneration
    try {
      // A resume already under way would attach the session the chat leaves.
      await this.#resumingThreads.get(threadId)?.catch(() => undefined)
      if (stored.worktreePath && !existsSync(stored.worktreePath)) {
        throw new Error(
          'The private checkout for this chat is missing. Restore the checkout or start a new chat.',
        )
      }
      const workspacePath = stored.worktreePath ?? resolveWorkspacePath(stored.projectPath)
      const runtime = this.#runtimeFor(
        target.provider,
        this.#onLog,
        existingAccountHome(this.#accounts, target.provider, accountId),
      )
      const approval =
        target.approval ??
        this.#threadApprovals.get(threadId) ??
        this.#store.threadApproval(threadId)
      const startOptions: StartOptions = {
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.model ? { model: target.model } : {}),
        ...(target.effort ? { effort: target.effort } : {}),
        ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
        ...(approval ? { approval } : {}),
        ...this.#sessionStart(target.provider, undefined, { threadId }),
        ...(this.#offersAgentTools(target.provider)
          ? (
              await this.#agentToolsOptions(
                target.provider,
                threadId,
                this.#mcpRuntimeOptions(target.provider, stored.projectPath, threadId),
              )
            ).options
          : this.#mcpRuntimeOptions(target.provider, stored.projectPath, threadId)),
        ...this.#contextRuntimeOptions(target.provider, target.agent, accountId),
      }
      // Another account of the same provider can take the session itself.
      const saved =
        stored.provider === target.provider && stored.agent === target.agent
          ? this.#savedSession(threadId)
          : undefined
      let started
      let carried = false
      try {
        started = await this.#carryOn(runtime, workspacePath, saved, startOptions)
        carried = started !== undefined
        started ??= await runtime.start(workspacePath, startOptions)
      } catch (error) {
        if (!(error instanceof StartupCleanupError)) throw error
        void this.#stopFailedStartup(threadId, workspacePath, error).catch((stopError: unknown) =>
          this.#onLog(`[startup] agent still not stopped: ${errorMessage(stopError)}`),
        )
        throw error.startError
      }
      const nativeId = started.thread.id
      const moved = mapProviderSession(threadId, started)
      const stopStarted = async (reason: string) => {
        await this.#disposeSession(moved.session).catch((error: unknown) =>
          this.#onLog(`Could not stop the session a chat did not move to: ${errorMessage(error)}`),
        )
        throw new Error(reason)
      }
      if (panicGeneration !== this.#panicGeneration || this.#panicStopping) {
        return await stopStarted('The move was cancelled by panic stop.')
      }
      const current = this.#store.thread(threadId)
      if (
        disposeGeneration !== this.#disposeGeneration ||
        !current ||
        current.closedAt !== undefined
      ) {
        return await stopStarted('The chat was closed while it moved.')
      }
      try {
        this.#assertCanChangeProvider(threadId)
      } catch (error) {
        return await stopStarted(errorMessage(error))
      }
      // Stop the session the chat leaves before the new one is attached, so
      // two agents never answer for one chat. A stop that fails is tried
      // again: macOS can refuse to signal a process group that is going away.
      let stopFailure: unknown
      for (const wait of [0, 250, 1_000]) {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        try {
          await (stopFailure === undefined
            ? this.#disposeThreadRuntime(threadId, 'disconnect')
            : this.#stopThreadProvider(threadId))
          stopFailure = undefined
          break
        } catch (error) {
          stopFailure = error
        }
      }
      if (stopFailure !== undefined) {
        return await stopStarted(
          `The current agent did not stop, so the chat stays where it is: ${errorMessage(stopFailure)}`,
        )
      }
      try {
        this.#store.moveThreadToProvider(threadId, {
          provider: target.provider,
          ...(target.agent ? { agent: target.agent } : {}),
          ...(accountId === DEFAULT_ACCOUNT_ID ? {} : { accountId }),
          providerSessionId: nativeId,
          carried,
        })
      } catch (error) {
        return await stopStarted(errorMessage(error))
      }
      if (carried) this.#carriedThreads.add(threadId)
      const thread = onAccount(moved.thread, accountId)
      this.#attachThread(thread, moved.session, stored.projectPath, runtime.resume !== undefined)
      if (approval) {
        this.#threadApprovals.set(threadId, approval)
        this.#store.setThreadApproval(threadId, approval)
      }
      this.#markIdleRuntimeEligible(threadId)
      this.#record(threadId, {
        type: 'item.completed',
        item: {
          id: `notice-${crypto.randomUUID()}`,
          turnId: '',
          type: 'notice',
          status: 'completed',
          notice: {
            kind: 'provider',
            provider: target.provider,
            ...(target.agent ? { agent: target.agent } : {}),
            ...(accountId === DEFAULT_ACCOUNT_ID ? {} : { accountId }),
            ...(target.model ? { model: target.model } : {}),
          },
          createdAt: Date.now(),
        },
      })
      return thread
    } finally {
      this.#changingProvider.delete(threadId)
    }
  }

  /**
   * A handover turn that ends stopped or failed before the agent produced
   * anything may never have reached it, as when its CLI could not start; the
   * next prompt then carries the handover again. Context sent twice costs
   * little, context missing costs the work.
   */
  #watchHandoverTurn(threadId: string, event: DomainEvent): void {
    const watched = this.#handoverTurns.get(threadId)
    if (!watched) return
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.turnId === watched.turnId &&
      event.item.role !== 'user' &&
      event.item.type !== 'error'
    ) {
      watched.answered = true
    } else if (event.type === 'item.delta' && event.turnId === watched.turnId) {
      watched.answered = true
    } else if (event.type === 'turn.completed' && event.turnId === watched.turnId) {
      this.#handoverTurns.delete(threadId)
      if (event.status === 'completed' || watched.answered || !this.#store.thread(threadId)) return
      if (!watched.carried) {
        this.#store.rearmThreadHandover(threadId)
      } else if (event.status === 'failed') {
        // The provider would not take on what another account saved, as when
        // Codex cannot read reasoning another account encrypted. A fresh
        // session gets the conversation as a handover instead.
        this.#store.rearmThreadHandover(threadId)
        this.#failedCarries.add(threadId)
      }
    }
  }

  /** What has to be settled before a chat may move to another provider. */
  #assertCanChangeProvider(threadId: string): void {
    if (this.isTurnRunning(threadId)) {
      throw new Error('Wait for the current turn to finish, or stop it, before the chat moves.')
    }
    if (this.#hasQueuedTurns(threadId)) {
      throw new Error('Send or remove the queued prompts before the chat moves.')
    }
    if (this.#restoringThreads.has(threadId) || this.#reviewingDiffs.has(threadId)) {
      throw new Error('Wait for the restore or the change review to finish before the chat moves.')
    }
  }

  async switchBranch(workspacePath: string, branch: string) {
    const resolved = resolveWorkspacePath(workspacePath)
    return this.#checkoutAccess.exclusive(resolved, () => switchWorkspaceBranch(resolved, branch))
  }

  /** Run a git write such as a commit while no chat works in this checkout or starts to. */
  async whileCheckoutIdle<T>(checkout: string, operation: () => Promise<T>): Promise<T> {
    return this.#checkoutAccess.exclusive(checkout, operation)
  }

  async #startThread(
    provider: ProviderId,
    workspacePath: string,
    options: StartOptions & {
      accountId?: AccountId | undefined
      continueFrom?: string | undefined
    },
    generation: { dispose: number; panic: number; project: number },
  ): Promise<Thread> {
    const simulatorThreadKey = options.ephemeral ? undefined : `${provider}-${crypto.randomUUID()}`
    const mcp = this.#mcpRuntimeOptions(provider, workspacePath, simulatorThreadKey)
    // Awaited only when offered, so other starts keep their timing.
    const agentTools =
      !options.ephemeral && this.#offersAgentTools(provider)
        ? await this.#agentToolsOptions(provider, undefined, mcp)
        : { options: mcp, grant: undefined }
    try {
      const thread = await this.#launchThread(
        provider,
        workspacePath,
        options,
        generation,
        agentTools.options,
        simulatorThreadKey,
      )
      if (agentTools.grant) {
        agentTools.grant.bind(thread.id)
        this.#agentToolGrants.set(thread.id, agentTools.grant)
      }
      return thread
    } catch (error) {
      if (simulatorThreadKey !== undefined) {
        this.#simulatorAgent?.onThreadClosed(simulatorThreadKey)
      }
      agentTools.grant?.revoke()
      throw error
    }
  }

  async #launchThread(
    provider: ProviderId,
    workspacePath: string,
    {
      accountId: requestedAccount,
      continueFrom,
      ...options
    }: StartOptions & { accountId?: AccountId | undefined; continueFrom?: string | undefined },
    generation: { dispose: number; panic: number; project: number },
    mcpOptions: StartOptions,
    simulatorThreadKey?: string,
  ): Promise<Thread> {
    const cancelled = () =>
      generation.dispose !== this.#disposeGeneration ||
      generation.panic !== this.#panicGeneration ||
      generation.project !==
        (this.#projectGenerations.get(resolveWorkspacePath(workspacePath)) ?? 0)
    if (cancelled()) throw new Error('task start cancelled by shutdown or panic stop')
    const accountId = accountForNewThread(
      this.#accounts,
      provider,
      options.agent,
      requestedAccount ?? this.#recommendedAccount(provider, options.agent),
    )
    const accountHome = existingAccountHome(this.#accounts, provider, accountId)
    if (continueFrom !== undefined) this.#assertContinuable(continueFrom, provider)
    // The id has to exist before the worktree, and the worktree before the
    // agent — it is the directory the agent will be spawned in.
    const threadId = simulatorThreadKey ?? `${provider}-${crypto.randomUUID()}`
    const resolvedWorkspacePath = resolveWorkspacePath(workspacePath)
    const runtime = this.#runtimeFor(provider, this.#onLog, accountHome)
    const runtimeOptions = {
      ...options,
      ...this.#sessionStart(provider, options.instructions, {
        skills: !options.ephemeral,
        threadId: simulatorThreadKey,
      }),
      ...mcpOptions,
      ...this.#contextRuntimeOptions(provider, options.agent, accountId),
    }
    const worktree = options.isolate
      ? await createWorktree(resolvedWorkspacePath, threadId, this.#worktreeRoot, options.baseRef)
      : undefined
    const continuedChanges =
      worktree && continueFrom !== undefined
        ? await this.#carryEarlierChanges(continueFrom, worktree)
        : undefined
    const directory = worktree?.workPath ?? worktree?.path ?? resolvedWorkspacePath
    if (cancelled()) {
      if (worktree) await removeWorktree(worktree, true)
      throw new Error('task start cancelled by shutdown or panic stop')
    }

    // A chat that continues another of the same provider carries its session on.
    const saved =
      continueFrom !== undefined && options.agent === undefined
        ? this.#savedSession(continueFrom)
        : undefined
    let started
    let carried = false
    try {
      started = await this.#carryOn(runtime, directory, saved, runtimeOptions)
      carried = started !== undefined
      started ??= await runtime.start(directory, runtimeOptions)
    } catch (error) {
      if (error instanceof StartupCleanupError) {
        // The agent may still be running in the new checkout. Keep the session
        // for shutdown to retry, and remove the checkout only after it stops.
        void this.#stopFailedStartup(threadId, directory, error)
          .then(() => (worktree ? removeWorktree(worktree, true) : undefined))
          .catch((stopError: unknown) =>
            this.#onLog(`[startup] agent still not stopped: ${errorMessage(stopError)}`),
          )
        throw error.startError
      }
      // A worktree for a session that never started is litter, and the next
      // attempt would trip over it.
      if (worktree) await removeWorktree(worktree, true).catch(() => undefined)
      throw error
    }

    const { session } = started
    const thread = onAccount(started.thread, accountId)
    if (simulatorThreadKey !== undefined) {
      this.#simulatorAgent?.rebindThread(simulatorThreadKey, thread.id)
    }
    if (cancelled()) {
      if (simulatorThreadKey !== undefined) this.#simulatorAgent?.onThreadClosed(thread.id)
      this.#checkoutAccess.retainStopping(directory, thread.id)
      await this.#stopThreadProvider(thread.id, session)
      if (worktree) await removeWorktree(worktree, true)
      throw new Error('task start cancelled by shutdown or panic stop')
    }
    try {
      this.#store.addProject(workspacePath)
      this.#store.addThread({
        id: thread.id,
        // The project is the repository, not the private checkout. A session
        // still belongs to the folder the user chose.
        projectPath: workspacePath,
        provider,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(thread.accountId ? { accountId: thread.accountId } : {}),
        ...(continueFrom === undefined ? {} : { continuedFrom: continueFrom }),
        ...(continuedChanges === undefined ? {} : { continuedChanges }),
        title: 'New session',
        createdAt: thread.createdAt,
        ...(worktree
          ? {
              worktreePath: directory,
              worktreeBranch: worktree.branch,
            }
          : {}),
      })
    } catch (error) {
      // Nothing records this session. Stop it through the tracked path so a
      // failed stop stays owned, and remove its checkout only once it stopped.
      this.#checkoutAccess.retainStopping(directory, thread.id)
      await this.#stopThreadProvider(thread.id, session)
        .then(() => (worktree ? removeWorktree(worktree, true) : undefined))
        .catch((cleanupError: unknown) =>
          this.#onLog(`[startup] agent cleanup failed: ${errorMessage(cleanupError)}`),
        )
      throw error
    }
    // Attach before any further storage read so a failure there leaves the
    // session owned by the thread rather than by nobody.
    this.#attachThread(thread, session, workspacePath, runtime.resume !== undefined, worktree)
    if (carried) {
      // Its session already holds the earlier conversation.
      this.#store.clearThreadContinueContext(thread.id)
      this.#carriedThreads.add(thread.id)
    }
    const autoSettleDays = this.#store.sidebarSettings().autoSettleDays
    this.#onLifecycleScheduleChanged(
      autoSettleDays === null ? 'later' : thread.createdAt + autoSettleDays * 24 * 60 * 60 * 1_000,
    )
    if (options.approval) {
      this.#threadApprovals.set(thread.id, options.approval)
      this.#store.setThreadApproval(thread.id, options.approval)
    }
    return thread
  }

  /**
   * Starts one temporary conversation at the current parent boundary.
   *
   * This deliberately uses the same adapter start path for every provider.
   * Native fork APIs are uneven and would make Side chat silently weaker on
   * exactly the providers the shared UI promises to support.
   */
  async startSideThread(
    parentThreadId: string,
    options: Pick<StartOptions, 'model' | 'serviceTier' | 'effort' | 'approval'> = {},
  ): Promise<Thread> {
    if (this.#panicStopping) throw new Error('Side chat start cancelled by panic stop')
    const existingId = this.#sideThreads.get(parentThreadId)
    const existing = existingId ? this.#threads.get(existingId) : undefined
    if (existing) return existing.thread
    if (existingId) {
      this.#sideThreads.delete(parentThreadId)
      this.#sideParents.delete(existingId)
    }

    const starting = this.#startingSideThreads.get(parentThreadId)
    if (starting) return starting
    const pending = this.#createSideThread(parentThreadId, options).finally(() => {
      if (this.#startingSideThreads.get(parentThreadId) === pending) {
        this.#startingSideThreads.delete(parentThreadId)
      }
      this.#pruneIdleThreadRuntimes()
    })
    this.#startingSideThreads.set(parentThreadId, pending)
    return pending
  }

  async #createSideThread(
    parentThreadId: string,
    options: Pick<StartOptions, 'model' | 'serviceTier' | 'effort' | 'approval'>,
  ): Promise<Thread> {
    const panicGeneration = this.#panicGeneration
    const disposeGeneration = this.#disposeGeneration
    const assertCurrent = () => {
      if (
        panicGeneration !== this.#panicGeneration ||
        disposeGeneration !== this.#disposeGeneration
      )
        throw new Error('Side chat start cancelled by shutdown or panic stop')
    }
    // The main chat's own process is not needed: a Side chat reads its saved
    // history. Resuming it cost a second agent process (about 300 MB for
    // Claude Code) and, for Codex, 10-15 s before the Side chat could start.
    const storedParent = this.#store.thread(parentThreadId)
    if (!storedParent) throw new Error(`no such thread: ${parentThreadId}`)
    if (storedParent.ephemeral) throw new Error('Side chat cannot be opened inside Side chat.')
    const parentHistory = await this.history(parentThreadId)

    const provider = storedParent.provider
    const workspacePath =
      storedParent.worktreePath ?? resolveWorkspacePath(storedParent.projectPath)
    const approval =
      options.approval ??
      this.#threadApprovals.get(parentThreadId) ??
      this.#store.threadApproval(parentThreadId) ??
      'ask'
    // Side chat runs as the main chat's account.
    const accountHome = threadAccountHome(this.#accounts, storedParent)
    const runtime = this.#runtimeFor(provider, this.#onLog, accountHome)
    const runtimeOptions: StartOptions = {
      ...options,
      approval,
      ...(storedParent.agent ? { agent: storedParent.agent } : {}),
      ...this.#sessionStart(provider, sideChatInstructionsFromReplay(parentHistory), {
        skills: false,
        threadId: parentThreadId,
      }),
      ...this.#mcpRuntimeOptions(provider, storedParent.projectPath, parentThreadId),
      ...this.#contextRuntimeOptions(provider, storedParent.agent, storedParent.accountId),
    }

    let started: Awaited<ReturnType<ProviderRuntime['start']>> | undefined
    try {
      assertCurrent()
      started = await runtime.start(workspacePath, runtimeOptions)
      const { session } = started
      const thread = onAccount(started.thread, storedParent.accountId)
      this.#saveSideHistoryTombstone(thread)
      assertCurrent()
      const currentParent = this.#store.thread(parentThreadId)
      if (!currentParent || currentParent.closedAt !== undefined) {
        throw new Error('The main chat closed while Side chat was starting.')
      }
      this.#store.addThread({
        id: thread.id,
        projectPath: storedParent.projectPath,
        provider,
        ...(storedParent.agent ? { agent: storedParent.agent } : {}),
        ...(thread.accountId ? { accountId: thread.accountId } : {}),
        title: 'Side chat',
        createdAt: thread.createdAt,
        ephemeral: true,
        parentThreadId,
        ...(storedParent.worktreePath ? { worktreePath: storedParent.worktreePath } : {}),
      })
      this.#sideThreads.set(parentThreadId, thread.id)
      this.#sideParents.set(thread.id, parentThreadId)
      this.#attachThread(thread, session, storedParent.projectPath, runtime.resume !== undefined)
      this.#threadApprovals.set(thread.id, approval)
      this.#store.setThreadApproval(thread.id, approval)
      return thread
    } catch (error) {
      if (error instanceof StartupCleanupError) {
        // No Side chat exists yet, so the stop is owned by a key of its own.
        void this.#stopFailedStartup(
          `side-start-${crypto.randomUUID()}`,
          workspacePath,
          error,
        ).catch((stopError: unknown) =>
          this.#onLog(`[startup] agent still not stopped: ${errorMessage(stopError)}`),
        )
        throw error.startError
      }
      await started?.session.dispose()
      const sideThreadId = started?.thread.id
      if (sideThreadId) {
        this.#sideParents.delete(sideThreadId)
        if (this.#store.thread(sideThreadId)?.ephemeral) {
          this.#store.forgetWorktree(sideThreadId)
          this.#store.deleteThread(sideThreadId)
          this.forgetDeletedThread(sideThreadId)
        }
      }
      if (this.#sideThreads.get(parentThreadId) === sideThreadId) {
        this.#sideThreads.delete(parentThreadId)
      }
      throw error
    }
  }

  /** The sub-agents TasteCode started for a chat, newest first. */
  subagents(threadId: string): ThreadSubagent[] {
    return this.#subagents.list(threadId)
  }

  /** The calling chat as a parent that may start sub-agents now. */
  #subagentParent(threadId: string): SubagentParent {
    const stored = this.#store.thread(threadId)
    if (!stored || stored.closedAt !== undefined) throw new AgentToolError('This chat is closed.')
    if (stored.ephemeral) throw new AgentToolError('A sub-agent cannot start sub-agents.')
    const turnId = this.#activeTurnIds.get(threadId)
    if (turnId === undefined) throw new AgentToolError('Sub-agents start from a running turn.')
    return {
      provider: stored.provider,
      providerName: PROVIDER_NAMES[stored.provider],
      turnId,
      approval:
        this.#threadApprovals.get(threadId) ?? this.#store.threadApproval(threadId) ?? 'ask',
      prompt: this.#latestUserPrompts.get(threadId),
    }
  }

  /**
   * Providers in the roster with a model list this launch already read, minus
   * hidden models. Listing never starts a vendor process: a provider the app
   * has not listed is left out rather than probed from inside a turn.
   */
  #agentModelChoices(): AgentModelChoice[] {
    const roster = this.#store.providerRoster()
    const hidden = new Set(this.#store.hiddenModels())
    const choices: AgentModelChoice[] = []
    for (const provider of ProviderIdSchema.options) {
      if (roster !== null && !roster.includes(provider)) continue
      const listed = this.#defaultScope.modelLists.peek(provider)
      if (!listed) continue
      const models = listed.filter((model) => !hidden.has(`${provider}:${model.id}`))
      if (models.length === 0) continue
      choices.push({
        provider,
        name: PROVIDER_NAMES[provider],
        models: models.map((model) => ({
          id: model.id,
          name: model.displayName,
          ...(model.isDefault ? { default: true as const } : {}),
          ...(model.reasoningEfforts.length > 0 ? { efforts: model.reasoningEfforts } : {}),
        })),
      })
    }
    return choices
  }

  /**
   * Starts a sub-agent's hidden chat in its parent's checkout, at the parent's
   * access level and on the provider's account for new chats. Modelled on
   * Side chat; the chat gets the project's MCP servers but never the agent
   * tools, so sub-agents stay one level deep.
   */
  async #startSubagentThread(spec: SubagentChildSpec): Promise<string> {
    const panicGeneration = this.#panicGeneration
    const disposeGeneration = this.#disposeGeneration
    const assertCurrent = () => {
      if (
        panicGeneration !== this.#panicGeneration ||
        disposeGeneration !== this.#disposeGeneration
      )
        throw new Error('The sub-agent start was cancelled by Stop all or shutdown.')
    }
    const storedParent = this.#store.thread(spec.parentThreadId)
    if (!storedParent || storedParent.closedAt !== undefined) {
      throw new Error('The chat that started this sub-agent closed.')
    }
    const workspacePath =
      storedParent.worktreePath ?? resolveWorkspacePath(storedParent.projectPath)
    // Never a higher access level than the chat that starts it.
    const approval =
      this.#threadApprovals.get(spec.parentThreadId) ??
      this.#store.threadApproval(spec.parentThreadId) ??
      'ask'
    const accountId = accountForNewThread(this.#accounts, spec.provider, undefined, undefined)
    const accountHome = existingAccountHome(this.#accounts, spec.provider, accountId)
    const runtime = this.#runtimeFor(spec.provider, this.#onLog, accountHome)
    const runtimeOptions: StartOptions = {
      approval,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      instructions: composeInstructions(SUBAGENT_INSTRUCTIONS),
      ...this.#mcpRuntimeOptions(spec.provider, storedParent.projectPath),
      ...this.#contextRuntimeOptions(spec.provider, undefined, accountId),
    }
    let started: Awaited<ReturnType<ProviderRuntime['start']>> | undefined
    try {
      assertCurrent()
      started = await runtime.start(workspacePath, runtimeOptions)
      const thread = onAccount(started.thread, accountId)
      this.#saveSubagentHistoryRecord(thread)
      assertCurrent()
      const parent = this.#store.thread(spec.parentThreadId)
      if (!parent || parent.closedAt !== undefined) {
        throw new Error('The chat that started this sub-agent closed.')
      }
      this.#store.addThread({
        id: thread.id,
        projectPath: storedParent.projectPath,
        provider: spec.provider,
        ...(thread.accountId ? { accountId: thread.accountId } : {}),
        title: spec.name ?? 'Sub-agent',
        createdAt: thread.createdAt,
        ephemeral: true,
        ownerThreadId: spec.parentThreadId,
        ...(storedParent.worktreePath ? { worktreePath: storedParent.worktreePath } : {}),
      })
      this.#subagentParents.set(thread.id, spec.parentThreadId)
      this.#attachThread(
        thread,
        started.session,
        storedParent.projectPath,
        runtime.resume !== undefined,
      )
      this.#threadApprovals.set(thread.id, approval)
      this.#store.setThreadApproval(thread.id, approval)
      return thread.id
    } catch (error) {
      if (error instanceof StartupCleanupError) {
        void this.#stopFailedStartup(
          `subagent-start-${crypto.randomUUID()}`,
          workspacePath,
          error,
        ).catch((stopError: unknown) =>
          this.#onLog(`[startup] agent still not stopped: ${errorMessage(stopError)}`),
        )
        throw error.startError
      }
      await started?.session.dispose()
      const childId = started?.thread.id
      if (childId) {
        this.#subagentParents.delete(childId)
        if (this.#store.thread(childId)) {
          this.#store.forgetWorktree(childId)
          this.#store.deleteThread(childId)
          this.forgetDeletedThread(childId)
        }
      }
      throw error
    }
  }

  /** What a sub-agent's turn left, read once when it ends, never per delta. */
  #subagentOutcome(threadId: string, turnId: string): SubagentOutcome {
    const items = projectHistoryItems(this.#store.history(threadId)).filter(
      (item) => item.turnId === turnId,
    )
    const answer = items.findLast(
      (item) => item.type === 'message' && item.role === 'assistant' && item.text?.trim(),
    )?.text
    const changedPaths = [
      ...new Set(
        items.flatMap((item) => (item.type === 'file_change' && item.path ? [item.path] : [])),
      ),
    ]
    return { answer, changedPaths }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
    submission?: UserSubmission,
  ): Promise<string> {
    // The words the user sent; whatever the prompt carries in front of them is not theirs.
    this.#latestUserPrompts.set(threadId, text)
    // Creatify's marker is no file. It asks for the creative skills note behind
    // the words; without a skill installed the prompt goes as written. The old
    // Design marker of an earlier client or queue starts nothing; it goes too.
    const wantsCreatify = attachments.some(isCreatifyAttachment)
    const creatify = wantsCreatify ? this.#bundledSkills().creatify : ''
    attachments = attachments.filter((attachment) => !isModeMarker(attachment))
    // A failed change leaves the session on its last applied mode, which is
    // the mode this turn runs under. Its error belongs to whoever changed it.
    const approvalChange = this.#approvalChanges.get(threadId)
    if (approvalChange) await approvalChange.catch(() => undefined)
    if (this.#panicStopping) throw new Error('turn cancelled by panic stop')
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot start a turn while a diff rejection is running')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot start a turn while restoring a checkpoint')
    }
    if (this.#changingProvider.has(threadId)) {
      throw new Error('This chat is moving to another provider. Send again once it has moved.')
    }
    if (this.#failedCarries.has(threadId) && !this.isTurnRunning(threadId)) {
      // Stopping it starts a fresh session, which the handover reaches.
      await this.#disposeThreadRuntime(threadId, 'disconnect')
      await this.#ensureThread(threadId, options)
    }
    const entry = this.#get(threadId)
    // A chat that moved carries everything, a continuation and a restore included.
    const handover = this.#store.threadNeedsHandover(threadId)
    // Only a continued chat asks the store; the cached row says which ones are.
    const continuation =
      !handover &&
      this.#store.thread(threadId)?.continuedFrom !== undefined &&
      this.#store.threadNeedsContinueContext(threadId)
    // Sub-agent results its agent has not read go in front of the prompt.
    const unreadSubagents = this.#subagents.unreadResults(threadId)
    // The prompt carries more than the user's words; the transcript keeps the words.
    if (
      (handover ||
        continuation ||
        unreadSubagents ||
        creatify ||
        this.#store.threadNeedsRestoreContext(threadId)) &&
      !submission
    ) {
      submission = { id: crypto.randomUUID(), text, attachments, createdAt: Date.now() }
    }
    // The conversation the handover carries ends before this prompt is recorded.
    const handoverThrough = handover ? this.#store.lastSeq(threadId) : 0
    this.#touchThreadRuntime(threadId)
    if (!this.#sideParents.has(threadId) && !this.#subagentParents.has(threadId))
      this.#wakeForActivity(threadId)
    const panicGeneration = this.#panicGeneration
    const pendingStart = this.#beginTurnStart(threadId, submission)
    this.#addSidebarStatus(this.#startingTurns, threadId)
    let releaseTurnStart: () => void = () => undefined
    const turnStartBarrier: TurnStartBarrier = {
      done: new Promise<void>((resolve) => {
        releaseTurnStart = resolve
      }),
      release: () => releaseTurnStart(),
    }
    this.#turnStartBarriers.set(threadId, turnStartBarrier)
    try {
      this.#checkoutAccess.beginTurn(this.#repoPath(threadId), threadId)
      // Before the agent writes, not after. A checkpoint taken afterwards would
      // record the damage rather than the state worth returning to.
      await this.#checkpoint(threadId, text)
      if (panicGeneration !== this.#panicGeneration) {
        throw new Error('turn cancelled by panic stop')
      }
      if (this.#threads.get(threadId) !== entry) {
        throw new Error('turn cancelled because the provider session changed')
      }
      const brief = existsSync(path.join(this.#repoPath(threadId), '.taste', 'brief.json'))
      // A provider runs its own slash command only when the prompt starts with
      // it, so a command goes as typed and whatever would go in front of it waits
      // for the next prompt. Only a turn that would carry something reads the list.
      const command =
        (brief ||
          handover ||
          continuation ||
          unreadSubagents !== undefined ||
          creatify !== '' ||
          this.#store.threadNeedsRestoreContext(threadId)) &&
        (await this.#isProviderCommand(threadId, entry, text))
      const words = `${text}${creatify}`
      const ownPrompt = brief ? `${DESIGN_FOLLOW_UP_NOTICE}${words}` : words
      const prompt = unreadSubagents ? `${unreadSubagents.text}${ownPrompt}` : ownPrompt
      const sent = command
        ? text
        : handover
          ? await this.#handoverPrompt(
              threadId,
              prompt,
              handoverThrough,
              entry.session,
              options.model,
            )
          : this.#promptAfterRestore(
              threadId,
              continuation ? await this.#promptWithEarlierChat(threadId, prompt) : prompt,
            )
      this.#notePromptWrapping(threadId, sent !== text)
      const turnId = await entry.session.sendTurn(threadId, sent, attachments, options)
      if (panicGeneration !== this.#panicGeneration) {
        await entry.session.interrupt(threadId)
        throw new Error('turn cancelled by panic stop')
      }
      if (this.#discardedSideThreads.has(threadId)) {
        throw new Error('Side chat was closed while its turn was starting.')
      }
      if (this.#threads.get(threadId) !== entry) {
        throw new Error('turn cancelled because the provider session changed')
      }
      this.#acceptTurnStart(threadId, turnId, pendingStart)
      // A command delivered none of it; the next prompt still does.
      if (!command) {
        this.#store.clearThreadRestoreContext(threadId)
        if (continuation) this.#store.clearThreadContinueContext(threadId)
        if (unreadSubagents) this.#subagents.markRead(unreadSubagents.itemIds)
      }
      if (handover && !command) {
        this.#store.clearThreadHandover(threadId)
        this.#handoverTurns.set(threadId, { turnId, answered: false })
      } else if (this.#carriedThreads.delete(threadId)) {
        this.#handoverTurns.set(threadId, { turnId, answered: false, carried: true })
      }
      return turnId
    } catch (error) {
      if (this.#threads.get(threadId) === entry) this.#markIdleRuntimeEligible(threadId)
      this.#forgetPendingTurnStart(threadId, pendingStart)
      throw error
    } finally {
      if (this.#turnStartBarriers.get(threadId) === turnStartBarrier) {
        this.#deleteSidebarStatus(this.#startingTurns, threadId)
        this.#turnStartBarriers.delete(threadId)
      }
      turnStartBarrier.release()
      this.#releaseCheckoutIfIdle(threadId)
      // The completion's own drain found this start still running. A queued
      // dispatch retries through #drainQueue; a direct send retries here.
      if (
        turnStartBarrier.turnCompleted &&
        this.#threads.get(threadId) === entry &&
        !this.isTurnRunning(threadId)
      )
        void this.#drainQueue(threadId)
      this.#pruneIdleThreadRuntimes()
    }
  }

  /** Send now when idle, otherwise put the prompt behind the active turn. */
  submitTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
    clientSubmissionId?: string,
  ): Promise<{ queued: false; turnId: string } | { queued: true; queuedTurn: QueuedTurn }> {
    // The user prompted a sub-agent's chat from the Agents tab: its run may reopen.
    // Read from the store, since a released child is not attached until it resumes.
    if (this.#store.thread(threadId)?.ownerThreadId !== undefined) {
      this.#subagents.userPrompted(threadId, text)
    }
    return this.trackSubmission(threadId, () =>
      this.#submitTurn(threadId, text, attachments, options, clientSubmissionId),
    )
  }

  /**
   * Runs `submit`, which hands a prompt to `threadId`, as a prompt on its way: a Stop sent
   * meanwhile reaches the agent once the prompt has started or queued. The server also runs
   * the work it does before `submitTurn` under this, so a Stop cannot overtake that either.
   */
  trackSubmission<T>(threadId: string, submit: () => Promise<T>): Promise<T> {
    let submission: Promise<T>
    try {
      // The server's own tracking wraps submitTurn's; the prompt was sent under the outer one.
      const outer = this.#submissionStops.getStore()
      submission =
        outer?.threadId === threadId
          ? submit()
          : this.#submissionStops.run(
              {
                threadId,
                stops: this.#resumeStops.get(threadId) ?? 0,
                stopRequests: this.#stopRequests.get(threadId) ?? 0,
              },
              submit,
            )
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const incoming = this.#incomingSubmissions.get(threadId) ?? new Set<Promise<unknown>>()
    incoming.add(submission)
    this.#incomingSubmissions.set(threadId, incoming)
    const arrived = () => {
      incoming.delete(submission)
      if (incoming.size === 0 && this.#incomingSubmissions.get(threadId) === incoming)
        this.#incomingSubmissions.delete(threadId)
    }
    void submission.then(arrived, arrived)
    return submission
  }

  async #submitTurn(
    threadId: string,
    text: string,
    attachments: string[],
    options: TurnOptions,
    clientSubmissionId: string | undefined,
  ): Promise<{ queued: false; turnId: string } | { queued: true; queuedTurn: QueuedTurn }> {
    const panicGeneration = this.#panicGeneration
    const disposeGeneration = this.#disposeGeneration
    if (this.#panicStopping) throw new Error('turn cancelled by panic stop')
    const tracked = this.#submissionStops.getStore()
    const sentUnder =
      tracked?.threadId === threadId ? tracked.stops : (this.#resumeStops.get(threadId) ?? 0)
    // A prompt that was on its way when a Stop came while the chat resumed goes with it.
    const stoppedOnTheWay = () => {
      if ((this.#resumeStops.get(threadId) ?? 0) !== sentUnder)
        throw new Error('turn cancelled while resuming')
    }
    // At once, before it waits for anything, and without releasing what the Stop held.
    stoppedOnTheWay()
    // The user is writing again after a Stop: what they queued before it may go, in order.
    // A prompt that was already on its way when the Stop came is not that.
    const sentBeforeAStop =
      tracked?.threadId === threadId &&
      tracked.stopRequests !== (this.#stopRequests.get(threadId) ?? 0)
    if (!sentBeforeAStop) this.#heldQueues.delete(threadId)
    if (this.#changingProvider.has(threadId)) {
      throw new Error('This chat is moving to another provider. Send again once it has moved.')
    }
    // A Stop while the session resumes cancels this prompt at once; the resume
    // itself can take 10-15 s more to wind down, and the chat must not wait for it.
    // So does a Stop while it waits for an access mode change to the chat first.
    const stop: PromptStopListener = {}
    const listenForStop = () => {
      if (stop.cancelled || this.#threads.has(threadId)) return
      stop.cancelled = new Promise<never>((_resolve, reject) => {
        stop.cancel = reject
      })
      this.#resumeCancels.set(threadId, [
        ...(this.#resumeCancels.get(threadId) ?? []),
        stop.cancel!,
      ])
    }
    let sentAt = 0
    let resuming = false
    try {
      const approvalChange = this.#approvalChanges.get(threadId)
      if (approvalChange) {
        listenForStop()
        const changed = approvalChange.catch(() => undefined)
        await (stop.cancelled ? Promise.race([changed, stop.cancelled]) : changed)
      }
      stoppedOnTheWay()
      // A resume can take many seconds. The chat shows the prompt starting from
      // the moment it was sent, not only once the provider session is back.
      // From there, the turn start (or the queue) that follows sets its status.
      resuming = !this.#threads.has(threadId)
      sentAt = Date.now()
      if (resuming) this.#addSidebarStatus(this.#resumingForPrompt, threadId)
      listenForStop()
      const ensured = this.#ensureThread(threadId, options)
      await (stop.cancelled ? Promise.race([ensured, stop.cancelled]) : ensured)
      stoppedOnTheWay()
      // An access mode change that came while the chat resumed. sendTurn would
      // wait for it after the queue check below, and a prompt sent meanwhile
      // would pass that check as well and start beside this one.
      let waited: Promise<void> | undefined
      for (
        let change = this.#approvalChanges.get(threadId);
        change !== undefined && change !== waited;
        change = this.#approvalChanges.get(threadId)
      ) {
        waited = change
        const changed = change.catch(() => undefined)
        await (stop.cancelled ? Promise.race([changed, stop.cancelled]) : changed)
        stoppedOnTheWay()
      }
    } finally {
      if (resuming) this.#deleteSidebarStatus(this.#resumingForPrompt, threadId)
      if (stop.cancel) {
        const rest = (this.#resumeCancels.get(threadId) ?? []).filter(
          (item) => item !== stop.cancel,
        )
        if (rest.length) this.#resumeCancels.set(threadId, rest)
        else this.#resumeCancels.delete(threadId)
      }
    }
    if (panicGeneration !== this.#panicGeneration || disposeGeneration !== this.#disposeGeneration)
      throw new Error('turn cancelled by panic stop or shutdown')
    if (this.#changingProvider.has(threadId)) {
      throw new Error('This chat is moving to another provider. Send again once it has moved.')
    }
    if (clientSubmissionId) this.#assertFreshSubmissionId(threadId, clientSubmissionId)
    const submittedAt = Date.now()
    const submission = clientSubmissionId
      ? { id: clientSubmissionId, text, attachments, createdAt: submittedAt }
      : undefined
    const queue = this.#queueEntries(threadId)
    if (
      this.#activeTurns.has(threadId) ||
      this.#acceptedTurnStarts.has(threadId) ||
      this.#startingTurns.has(threadId) ||
      this.#drainingQueues.has(threadId) ||
      // The agent is still ending a turn the user stopped and cannot take a prompt yet.
      this.#settlingStops.has(threadId) ||
      queue.length > 0
    ) {
      const queuedTurn: QueuedTurnEntry = {
        id: clientSubmissionId ?? crypto.randomUUID(),
        text,
        attachments,
        createdAt: submittedAt,
        options,
        channel: this.#isSideThread(threadId) ? 'side' : 'main',
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
      }
      this.#store.enqueueQueuedTurn({ ...queuedTurn, threadId })
      queue.push(queuedTurn)
      this.#retainQueueEntries(threadId, queue)
      this.#notifyQueue(threadId)
      if (!this.#activeTurns.has(threadId) && !this.#startingTurns.has(threadId)) {
        void this.#drainQueue(threadId)
      }
      return { queued: true, queuedTurn: this.#publicQueuedTurn(queuedTurn) }
    }

    // Its turn started when it was sent: the chat counted the working time
    // from there, and must not jump back by the resume once the turn starts.
    if (resuming) this.#resumedPromptSentAt.set(threadId, sentAt)
    let turnId: string
    try {
      turnId = await this.sendTurn(threadId, text, attachments, options, submission)
    } finally {
      this.#resumedPromptSentAt.delete(threadId)
    }
    if (this.#activeTurnIds.get(threadId) === turnId) {
      this.#addSidebarStatus(this.#activeTurns, threadId)
    }
    return { queued: false, turnId }
  }

  queue(threadId: string): QueueState {
    return {
      items: this.#queueEntries(threadId).map((item) => this.#publicQueuedTurn(item)),
      canSteer: this.#canSteerQueue(threadId),
    }
  }

  #canSteerQueue(threadId: string): boolean {
    const session = this.#threads.get(threadId)?.session
    return session?.capabilities.steer === true && session.steer !== undefined
  }

  #notifySteerChange(threadId: string, previous: boolean): void {
    if (previous === this.#canSteerQueue(threadId)) return
    // Detached runtimes still need to revoke the capability clients cached.
    try {
      this.#onQueue(threadId, this.queue(threadId))
    } catch {
      // A failed client notification must not interrupt runtime attachment or cleanup.
    }
  }

  deleteQueuedTurn(threadId: string, queuedTurnId: string): void {
    const queue = this.#queueEntries(threadId)
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0 || !this.#store.deleteQueuedTurn(threadId, queuedTurnId)) {
      throw new Error('That queued prompt already started or was removed.')
    }
    queue.splice(index, 1)
    this.#retainQueueEntries(threadId, queue)
    this.#notifyQueue(threadId)
    this.#pruneIdleThreadRuntimes()
  }

  moveQueuedTurn(threadId: string, queuedTurnId: string, direction: 'up' | 'down'): void {
    const queue = this.#queueEntries(threadId)
    const from = queue.findIndex((item) => item.id === queuedTurnId)
    const to = from + (direction === 'up' ? -1 : 1)
    if (from < 0 || to < 0 || to >= queue.length) return
    if (!this.#store.moveQueuedTurn(threadId, queuedTurnId, direction)) return
    ;[queue[from], queue[to]] = [queue[to]!, queue[from]!]
    this.#notifyQueue(threadId)
  }

  async steerQueuedTurn(threadId: string, queuedTurnId: string): Promise<void> {
    // A Stop held the queue; the prompt the user picks goes now, as a turn of its own. The
    // Stop may have ended an agent that would not stop, so its chat resumes first.
    if (
      this.#heldQueues.has(threadId) &&
      !this.#activeTurns.has(threadId) &&
      !this.isTurnRunning(threadId)
    ) {
      // A Stop or Stop all while it waits wins, as it does for a prompt the user sends.
      const stops = this.#resumeStops.get(threadId) ?? 0
      const panicGeneration = this.#panicGeneration
      const disposeGeneration = this.#disposeGeneration
      const stoppedMeanwhile = () => {
        if (
          this.#panicStopping ||
          panicGeneration !== this.#panicGeneration ||
          disposeGeneration !== this.#disposeGeneration
        )
          throw new Error('turn cancelled by panic stop or shutdown')
        if ((this.#resumeStops.get(threadId) ?? 0) !== stops)
          throw new Error('turn cancelled while resuming')
      }
      // An access mode change resumes the chat itself, in its new mode.
      const approvalChange = this.#approvalChanges.get(threadId)
      if (approvalChange) await approvalChange.catch(() => undefined)
      stoppedMeanwhile()
      await this.#ensureThread(threadId)
      stoppedMeanwhile()
      return this.#sendHeldQueuedTurn(threadId, queuedTurnId)
    }
    const session = this.#get(threadId).session
    if (!this.#activeTurns.has(threadId)) throw new Error('there is no running turn to steer')
    if (!session.capabilities.steer || !session.steer) {
      throw new Error('this agent does not support steering a running turn')
    }
    if (this.#drainingQueues.has(threadId))
      throw new Error('a queued prompt is already being steered')

    const queue = this.#queueEntries(threadId)
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) throw new Error('queued prompt not found')
    const queued = queue[index]!
    const activeTurnId = this.#activeTurnIds.get(threadId)
    if (queued.clientSubmissionId && !activeTurnId) {
      throw new Error('running turn identity is not available yet')
    }
    const claimed = this.#store.claimQueuedTurn(threadId, queuedTurnId, 'steer')
    if (!claimed) throw new Error('queued prompt is no longer available')
    const [item] = queue.splice(index, 1)
    if (!item) return
    this.#retainQueueEntries(threadId, queue)
    const claimedIds = this.#inFlightSubmissionIds.get(threadId) ?? new Set<string>()
    if (item.clientSubmissionId) {
      claimedIds.add(item.clientSubmissionId)
      this.#inFlightSubmissionIds.set(threadId, claimedIds)
    }
    this.#notifyQueue(threadId)
    const ownedTurnKey = activeTurnId ? userTurnKey(threadId, activeTurnId) : undefined
    const alreadyOwned = ownedTurnKey ? this.#serverOwnedUserTurns.has(ownedTurnKey) : false
    // The creative skills note of a prompt queued with Creatify on. It needs the
    // turn's id: the transcript must show the words, not what the agent got.
    const steerNote =
      activeTurnId && item.attachments.some(isCreatifyAttachment)
        ? this.#bundledSkills().creatify
        : ''
    // The agent's own copy of the steered words is left out of a turn TasteCode
    // records the prompts of, so there TasteCode records these too.
    const recordsSteer = Boolean(
      activeTurnId && (item.clientSubmissionId || alreadyOwned || steerNote),
    )
    if (ownedTurnKey && recordsSteer) this.#serverOwnedUserTurns.add(ownedTurnKey)
    const generation = this.#panicGeneration
    const draining: QueueDrain = { queueId: item.id }
    this.#drainingQueues.set(threadId, draining)
    const current = () =>
      generation === this.#panicGeneration && this.#threads.get(threadId)?.session === session
    const restore = () => {
      if (!current() || !this.#store.restoreQueuedTurn(threadId, item.id)) return
      // The empty array may have been evicted or replaced while steering.
      // Reload durable order so prompts added or moved meanwhile stay intact.
      this.#queuedTurns.delete(threadId)
      this.#notifyQueue(threadId)
    }
    try {
      this.#latestUserPrompts.set(threadId, item.text)
      // A prompt queued with Creatify on (or, before it, Design mode) carries TasteCode's
      // marker. It is no file: an agent handed it as one tries to read tastecode://….
      await session.steer(
        threadId,
        `${item.text}${steerNote}`,
        item.attachments.filter((attachment) => !isModeMarker(attachment)),
      )
      if (!current()) return
      // An acknowledged steer belongs to the captured turn even when that turn
      // finished before this continuation ran; restoring it would run it twice.
      if (activeTurnId && recordsSteer) {
        this.#recordUserSubmission(threadId, activeTurnId, {
          id: item.clientSubmissionId ?? item.id,
          text: item.text,
          attachments: item.attachments,
          createdAt: item.createdAt,
          queueId: item.id,
          ...(item.channel ? { channel: item.channel } : {}),
        })
      } else {
        this.#store.completeQueuedTurn(threadId, item.id)
      }
    } catch (error) {
      if (!current()) throw error
      if (ownedTurnKey && !alreadyOwned) this.#serverOwnedUserTurns.delete(ownedTurnKey)
      restore()
      throw error
    } finally {
      if (item.clientSubmissionId) {
        claimedIds.delete(item.clientSubmissionId)
        if (claimedIds.size === 0 && this.#inFlightSubmissionIds.get(threadId) === claimedIds)
          this.#inFlightSubmissionIds.delete(threadId)
      }
      if (this.#drainingQueues.get(threadId) === draining) {
        this.#drainingQueues.delete(threadId)
        void this.#drainQueue(threadId)
      }
    }
  }

  /**
   * Log first, then broadcast.
   *
   * A client that reconnects mid-turn catches up from the log. An event that
   * went out but was never recorded would be one it can never get back, so the
   * write has to happen first even though it is the slower half.
   */
  #record(threadId: string, event: DomainEvent): void {
    if (this.#discardedSideThreads.has(threadId)) return
    if (event.type === 'item.delta') {
      this.#recordedDeltas.push(threadId, event)
      return
    }
    if (event.type === 'diff.updated') {
      // Codex repeats the whole unchanged turn patch after most items. Each
      // copy would be another full patch in the log that replay then discards.
      const recorded = this.#recordedTurnDiffs.get(threadId)
      if (recorded?.turnId === event.turnId && recorded.diff === event.diff) return
    }
    this.#recordedDeltas.flush(threadId)
    this.#commitRecord(threadId, event)
  }

  /** Persist and publish one coalesced stream after the write commits. */
  #commitRecordedDelta(threadId: string, event: ItemDeltaEvent): void {
    if (this.#discardedSideThreads.has(threadId)) return
    const { seq, serializedEvent } = this.#store.appendWithSerializedEvent(threadId, event)
    if (this.#sideParents.has(threadId)) {
      this.#onSideEvent(threadId, event, seq, serializedEvent)
    } else if (this.#subagentParents.size > 0 && this.#subagentParents.has(threadId)) {
      this.#onSubagentEvent(
        threadId,
        this.#subagentParents.get(threadId)!,
        event,
        seq,
        serializedEvent,
      )
    } else {
      this.#onEvent(threadId, event, seq, serializedEvent)
    }
  }

  /** Persist and then publish one shared multi-thread delta window atomically. */
  #commitRecordedDeltas(records: RecordedDelta[]): void {
    const accepted =
      this.#discardedSideThreads.size === 0
        ? records
        : records.filter(({ threadId }) => !this.#discardedSideThreads.has(threadId))
    const only = accepted[0]
    if (accepted.length === 1 && only) {
      this.#commitRecordedDelta(only.threadId, only.event)
      return
    }
    if (accepted.length === 0) return
    const persisted = this.#store.appendBatchWithSerializedEvents(accepted)
    for (let index = 0; index < accepted.length; index += 1) {
      const { threadId, event } = accepted[index]!
      const { seq, serializedEvent } = persisted[index]!
      if (this.#sideParents.has(threadId)) {
        this.#onSideEvent(threadId, event, seq, serializedEvent)
      } else if (this.#subagentParents.size > 0 && this.#subagentParents.has(threadId)) {
        this.#onSubagentEvent(
          threadId,
          this.#subagentParents.get(threadId)!,
          event,
          seq,
          serializedEvent,
        )
      } else {
        this.#onEvent(threadId, event, seq, serializedEvent)
      }
    }
  }

  #commitRecord(threadId: string, event: DomainEvent): void {
    if (this.#discardedSideThreads.has(threadId)) return
    if (
      event.type === 'turn.completed' &&
      this.#activeTurnIds.has(threadId) &&
      this.#activeTurnIds.get(threadId) !== event.turnId
    ) {
      return
    }
    if (event.type === 'turn.started') this.#userStoppedTurns.delete(threadId)
    // An agent reports the work the user stopped as failed once it has killed
    // it, often after the turn ended ("runner pipe closed"). It was stopped.
    if (
      event.type === 'item.completed' &&
      event.item.status === 'failed' &&
      event.item.turnId === this.#userStoppedTurns.get(threadId)
    ) {
      event = { ...event, item: { ...event.item, status: 'started' } }
    }
    let matchedStart: PendingTurnStart | undefined
    if (event.type === 'turn.started') {
      const acceptedStarts = this.#acceptedTurnStarts.get(threadId)
      matchedStart = acceptedStarts?.get(event.turn.id)
      if (matchedStart) {
        this.#deleteAcceptedTurnStart(threadId, event.turn.id)
      } else {
        matchedStart = this.#pendingTurnStarts.get(threadId)
        if (matchedStart) this.#pendingTurnStarts.delete(threadId)
      }
      if (matchedStart) {
        event = { ...event, turn: { ...event.turn, createdAt: matchedStart.acceptedAt } }
      }
    }
    if (event.type === 'turn.completed') {
      this.#noteTurnDiffFromCheckpoint(threadId, event.turnId)
      this.#deleteAcceptedTurnStart(threadId, event.turnId)
      const draining = this.#drainingQueues.get(threadId)
      if (draining) draining.completedTurnId = event.turnId
      const starting = this.#turnStartBarriers.get(threadId)
      if (starting) starting.turnCompleted = true
      event = { ...event, completedAt: Date.now() }
    }
    if (event.type === 'thread.error') {
      this.#pendingTurnStarts.delete(threadId)
      this.#acceptedTurnStarts.delete(threadId)
    }
    if (event.type === 'turn.started') {
      this.#touchThreadRuntime(threadId)
      this.#addSidebarStatus(this.#activeTurns, threadId)
      // A turn the agent began without a prompt of ours dates from now.
      if (this.#activeTurnIds.get(threadId) !== event.turn.id)
        this.#activeTurnStopsBefore.set(threadId, this.#stopRequests.get(threadId) ?? 0)
      this.#activeTurnIds.set(threadId, event.turn.id)
      this.#turnWrittenPaths.delete(threadId)
    }
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.type === 'file_change' &&
      event.item.path
    ) {
      const paths = this.#turnWrittenPaths.get(threadId) ?? new Set<string>()
      paths.add(event.item.path)
      this.#turnWrittenPaths.set(threadId, paths)
    }
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      this.#markIdleRuntimeEligible(threadId)
      this.#deleteSidebarStatus(this.#activeTurns, threadId)
      const activeTurnId =
        event.type === 'turn.completed' ? event.turnId : this.#activeTurnIds.get(threadId)
      this.#activeTurnIds.delete(threadId)
      this.#activeTurnStopsBefore.delete(threadId)
      if (activeTurnId) this.#serverOwnedUserTurns.delete(userTurnKey(threadId, activeTurnId))
      this.#suppressedUserItems.delete(threadId)
      this.#recordedTurnDiffs.delete(threadId)
      this.#releaseCheckoutIfIdle(threadId)
    }
    const { seq, serializedEvent } = this.#store.appendWithSerializedEvent(threadId, event)
    if (event.type === 'diff.updated' && this.#activeTurnIds.get(threadId) === event.turnId) {
      this.#recordedTurnDiffs.set(threadId, { turnId: event.turnId, diff: event.diff })
    }
    const affectsInbox = affectsInboxProjection(event)
    if (
      affectsInbox &&
      this.#inboxProjectionsLoaded &&
      !this.#staleInboxProjectionThreads.has(threadId)
    ) {
      const inboxProjection = this.#inboxProjections.get(threadId) ?? emptyInboxProjection()
      applyInboxProjectionEvent(inboxProjection, event)
      if (isEmptyInboxProjection(inboxProjection)) this.#inboxProjections.delete(threadId)
      else this.#inboxProjections.set(threadId, inboxProjection)
    }
    if (affectsInbox) this.#recordSidebarStatusChange(threadId)
    const sideChat = this.#sideParents.has(threadId)
    const subagentParent = this.#subagentParents.get(threadId)
    if (
      !sideChat &&
      subagentParent === undefined &&
      (event.type === 'turn.started' ||
        event.type === 'approval.requested' ||
        event.type === 'user_input.requested')
    ) {
      this.#wakeForActivity(threadId)
    }
    if (
      !sideChat &&
      subagentParent === undefined &&
      (event.type === 'turn.completed' || event.type === 'thread.error')
    ) {
      this.#wakeForActivity(threadId, true)
    }
    if (sideChat) this.#onSideEvent(threadId, event, seq, serializedEvent)
    else if (subagentParent !== undefined) {
      this.#onSubagentEvent(threadId, subagentParent, event, seq, serializedEvent)
      this.#subagents.childEvent(threadId, event)
    } else {
      this.#onEvent(threadId, event, seq, serializedEvent)
      // What its turn started carries on in the background.
      if (event.type === 'turn.completed' || event.type === 'thread.error')
        this.#subagents.parentTurnEnded(threadId)
    }
    if (
      event.type === 'turn.started' &&
      matchedStart?.submission &&
      !this.#serverOwnedUserTurns.has(userTurnKey(threadId, event.turn.id))
    ) {
      this.#recordUserSubmission(threadId, event.turn.id, matchedStart.submission)
    }
    if (event.type === 'turn.completed' && this.#hasQueuedTurns(threadId)) {
      void this.#drainQueue(threadId)
    }
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      if (this.#activeTurns.size > 0) this.#scheduleIdleRuntimePrune()
      else this.#pruneIdleThreadRuntimes()
    }
  }

  #recordUserSubmission(threadId: string, turnId: string, submission: UserSubmission): void {
    this.#serverOwnedUserTurns.add(userTurnKey(threadId, turnId))
    const visibleAttachments = submission.attachments.filter(
      (attachment) => !isModeMarker(attachment),
    )
    const event: DomainEvent = {
      type: 'item.completed',
      item: {
        id: submission.id,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: submission.text,
        ...(visibleAttachments.length > 0
          ? {
              attachments: visibleAttachments,
            }
          : {}),
        createdAt: submission.createdAt,
      },
    }
    if (submission.queueId) {
      const { seq, serializedEvent } = this.#store.appendAndCompleteQueuedTurn(
        threadId,
        submission.queueId,
        event,
      )
      // A queued Side-chat prompt must stay on the Side-chat stream when it
      // replays: the stored channel wins, and rows written before the channel
      // was persisted fall back to the thread's side-chat linkage.
      const side =
        submission.channel !== undefined
          ? submission.channel === 'side'
          : this.#isSideThread(threadId)
      // A sub-agent's chat streams on its own channel, as #record sends its other
      // events; its open detail would otherwise miss the prompt until reopened.
      const subagentParent = this.#subagentParents.get(threadId)
      if (side) this.#onSideEvent(threadId, event, seq, serializedEvent)
      else if (subagentParent !== undefined)
        this.#onSubagentEvent(threadId, subagentParent, event, seq, serializedEvent)
      else this.#onEvent(threadId, event, seq, serializedEvent)
    } else {
      this.#record(threadId, event)
    }
  }

  /** A thread's history, for a client opening or reattaching to it. */
  async history(threadId: string, afterSeq = 0): Promise<HistoryEntry[]> {
    return (await this.#readHistory(threadId, afterSeq)).events
  }

  /** Preserve fresh snapshot JSON so the server does not encode a long replay twice. */
  async historyForResponse(threadId: string, afterSeq = 0): Promise<HistoryRead> {
    return this.#readHistory(threadId, afterSeq)
  }

  /** Newest whole turns first; `before` walks back through the same compact replay. */
  async historyPage(
    threadId: string,
    request: { before?: string | undefined; turnLimit?: number | undefined },
  ): Promise<HistoryPage> {
    const before =
      request.before === undefined ? undefined : decodeHistoryCursor(threadId, request.before)
    if (before) {
      await this.#restoringThreads.get(threadId)
      this.#touchThreadRuntime(threadId)
      // Older pages come from the replay that issued the cursor while it is
      // still saved. Appended events, a streaming turn's deltas included,
      // reach older rows only as late updates the client already received
      // live; reading the current replay instead would flush, re-compact and
      // re-save the whole thread for every page.
      const issued = this.#store.providerHistoryChangedAfter(threadId, before.seq)
        ? undefined
        : this.#store.replaySnapshotAt(threadId, before.seq)
      if (issued) {
        const page = readHistoryPage(threadId, issued, { before, turnLimit: request.turnLimit })
        // A restart's newest page comes from the current replay, not the cursor's.
        if (!page.reset) return page
      }
    } else {
      const page = await this.#readNewestHistoryPage(threadId, request.turnLimit)
      if (page) return page
    }
    const { events } = await this.#readHistory(threadId, 0)
    return readHistoryPage(threadId, events, {
      before,
      turnLimit: request.turnLimit,
      // Truncation or a provider rewrite since the cursor was issued may have
      // moved turns across its boundary; the client restarts from the newest page.
      isStale: (cursor, snapshotSeq) =>
        cursor.seq > snapshotSeq || this.#store.providerHistoryChangedAfter(threadId, cursor.seq),
    })
  }

  /**
   * A cold open reads only the end of the event log when the history index
   * can vouch for it. A replay still held in memory is cheaper to cut.
   */
  async #readNewestHistoryPage(
    threadId: string,
    turnLimit: number | undefined,
  ): Promise<HistoryPage | undefined> {
    await this.#restoringThreads.get(threadId)
    this.#touchThreadRuntime(threadId)
    this.#recordedDeltas.flush(threadId)
    if (this.#store.hasTailReplaySnapshotInMemory(threadId)) return undefined
    return readIndexedNewestHistoryPage(this.#store, threadId, turnLimit)
  }

  async #readHistory(threadId: string, afterSeq: number): Promise<HistoryRead> {
    await this.#restoringThreads.get(threadId)
    this.#touchThreadRuntime(threadId)
    this.#recordedDeltas.flush(threadId)
    if (afterSeq === 0) {
      const snapshot = this.#store.tailReplaySnapshotForResponse(threadId)
      if (snapshot) {
        return {
          events: snapshot.entries,
          serializedEvents: snapshot.serializedEntries,
        }
      }
      // A thread deleted meanwhile, for example under an older-page cursor, has no
      // replay to build; saving it used to fail on the missing thread, and so does this.
      if (!this.#store.thread(threadId)) throw new Error('Thread not found')
      const base = this.#store.replaySnapshotBase(threadId)
      const tail = this.#store.history(threadId, base?.seq ?? 0)
      // A thread that predates the history index gets it from this full read.
      if (!base) this.#store.backfillHistoryIndex(threadId, tail)
      const compacted = compactHistoryReplay(base ? [...base.entries, ...tail] : tail)
      const seq = tail.at(-1)?.seq ?? base?.seq ?? 0
      // History skips unreadable and retired rows, so `seq` can name an older
      // event than the thread's newest row; this replay still read to the end.
      const serializedEvents = this.#store.saveReplaySnapshot(threadId, seq, compacted, {
        readToEnd: true,
      })
      return { events: compacted, serializedEvents }
    }
    return { events: this.#store.history(threadId, afterSeq) }
  }

  async diff(threadId: string): Promise<SessionDiff> {
    return readSessionDiff(this.#diffRepoPath(threadId), threadId, this.#store)
  }

  /** Reverse only the exact provider patch shown in the latest edit block. */
  async undoTurnChanges(threadId: string, turnId: string, expectedDiff: string): Promise<void> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot undo changes while the agent turn is running')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot undo changes while restoring a checkpoint')
    }
    if (this.#reviewingDiffs.has(threadId)) throw new StaleDiffSnapshotError()

    return this.#withRestoreLock(threadId, async () => {
      this.#reviewingDiffs.add(threadId)
      try {
        const diff = this.#store.turnDiff(threadId, turnId)
        if (!diff || diff !== expectedDiff) {
          throw new Error('This edit block changed. Reload the session and try again.')
        }
        try {
          await reverseUnifiedDiff(this.#repoPath(threadId), diff)
        } catch (error) {
          const reason =
            error instanceof Error && error.cause instanceof Error ? error.cause : error
          this.#onLog(`Undo of an edit block did not apply: ${errorMessage(reason)}`)
          throw new Error('These files changed after this edit block. Undo did not change them.', {
            cause: error,
          })
        }
        this.#record(threadId, { type: 'diff.updated', turnId, diff: '' })
      } finally {
        this.#reviewingDiffs.delete(threadId)
        this.#pruneIdleThreadRuntimes()
      }
    })
  }

  async reviewHunk(
    threadId: string,
    version: string,
    filePath: string,
    hunkId: string,
    decision: DiffDecision,
  ): Promise<SessionDiff> {
    const review = () =>
      reviewDiffHunk(
        this.#diffRepoPath(threadId),
        threadId,
        version,
        filePath,
        hunkId,
        decision,
        this.#store,
      )
    return decision === 'reject' ? this.#rejectDiff(threadId, review) : review()
  }

  async reviewFile(
    threadId: string,
    version: string,
    filePath: string,
    decision: DiffDecision,
  ): Promise<SessionDiff> {
    const review = () =>
      reviewDiffFile(
        this.#diffRepoPath(threadId),
        threadId,
        version,
        filePath,
        decision,
        this.#store,
      )
    return decision === 'reject' ? this.#rejectDiff(threadId, review) : review()
  }

  /** Whether a session is still live, as opposed to merely on record. */
  isRunning(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  /** Whether the agent is inside a turn, rather than merely attached to the session. */
  isTurnRunning(threadId: string): boolean {
    return (
      this.#activeTurns.has(threadId) ||
      this.#acceptedTurnStarts.has(threadId) ||
      this.#startingTurns.has(threadId)
    )
  }

  /** Changes only when an in-memory value used by `projects.list` can change. */
  sidebarStatusRevision(): number {
    return this.#sidebarStatusRevision
  }

  /** Exact changed rows for an incremental projects.list projection, when still retained. */
  sidebarStatusChangesSince(revision: number): readonly string[] | undefined {
    if (revision === this.#sidebarStatusRevision) return []
    if (revision < 0 || revision > this.#sidebarStatusRevision) return undefined
    const first = this.#sidebarStatusChanges[0]
    if (!first || revision < first.revision - 1) return undefined

    const changed = new Set<string>()
    for (let index = this.#sidebarStatusChanges.length - 1; index >= 0; index -= 1) {
      const entry = this.#sidebarStatusChanges[index]!
      if (entry.revision <= revision) break
      changed.add(entry.threadId)
    }
    return [...changed]
  }

  inboxStatus(threadId: string, queued?: boolean, unread?: boolean): ThreadInboxStatus {
    // The first sidebar read folds only non-default status rows in one bulk
    // query. After that, #commitRecord advances the sparse cache without
    // another SQLite read. A history rewrite pays for only that thread once.
    if (!this.#inboxProjectionsLoaded) {
      this.#inboxProjections = this.#store.inboxProjections()
      this.#inboxProjectionsLoaded = true
    }
    let projection = this.#inboxProjections.get(threadId)
    if (this.#staleInboxProjectionThreads.delete(threadId)) {
      projection = emptyInboxProjection()
      for (const { event } of this.#store.history(threadId))
        applyInboxProjectionEvent(projection, event)
      if (isEmptyInboxProjection(projection)) {
        this.#inboxProjections.delete(threadId)
        projection = undefined
      } else {
        this.#inboxProjections.set(threadId, projection)
      }
    }
    if ((projection?.approvals?.size ?? 0) > 0) return 'approval'
    if ((projection?.inputs?.size ?? 0) > 0) return 'input'
    if (this.#startingTurns.has(threadId) || this.#resumingForPrompt.has(threadId)) {
      return 'starting'
    }
    if (this.#activeTurns.has(threadId) || this.#acceptedTurnStarts.has(threadId)) return 'working'
    if (queued ?? this.#hasQueuedTurns(threadId)) return 'queued'
    if (!projection) return (unread ?? this.#store.thread(threadId)?.unread) ? 'ready' : 'idle'
    if (projection.last === 'failed') return 'failed'
    return (unread ?? this.#store.thread(threadId)?.unread) ? 'ready' : projection.last
  }

  /** Forget the inbox projection after anything that rewrites history. */
  #dropInboxProjection(threadId: string): void {
    this.#inboxProjections.delete(threadId)
    this.#staleInboxProjectionThreads.add(threadId)
    this.#recordSidebarStatusChange(threadId)
  }

  /** Remove sparse read-model state after the owning durable thread is deleted. */
  invalidateImportedHistory(threadId: string): void {
    this.#dropInboxProjection(threadId)
  }

  forgetDeletedThread(threadId: string): void {
    this.#latestUserPrompts.delete(threadId)
    this.#wrappedPrompts.delete(threadId)
    this.#stopRequests.delete(threadId)
    this.#revokeAgentTools(threadId)
    this.#subagents.forget(threadId)
    // The store deleted a chat's sub-agent chats with it.
    for (const [childId, parentId] of this.#subagentParents) {
      if (parentId === threadId || childId === threadId) this.#subagentParents.delete(childId)
    }
    this.#inboxProjections.delete(threadId)
    this.#staleInboxProjectionThreads.delete(threadId)
    this.#simulatorAgent?.onThreadClosed(threadId)
    this.#heldQueues.delete(threadId)
  }

  #addSidebarStatus(set: Set<string>, threadId: string): void {
    if (set.has(threadId)) return
    set.add(threadId)
    this.#recordSidebarStatusChange(threadId)
  }

  #deleteSidebarStatus(set: Set<string>, threadId: string): void {
    if (!set.delete(threadId)) return
    this.#recordSidebarStatusChange(threadId)
  }

  #recordSidebarStatusChange(threadId: string): void {
    this.#sidebarStatusRevision += 1
    this.#sidebarStatusChanges.push({ revision: this.#sidebarStatusRevision, threadId })
    if (this.#sidebarStatusChanges.length > MAX_SIDEBAR_STATUS_CHANGES * 2) {
      this.#sidebarStatusChanges.splice(0, MAX_SIDEBAR_STATUS_CHANGES)
    }
  }

  settleThread(threadId: string): ThreadLifecycle {
    // The server settles idle chats on its own, and the classic sidebar keeps listing them with
    // an Archive action. Archiving one makes it the user's own archive instead of an error.
    const thread = this.#store.thread(threadId)
    const settled = thread?.closedAt === undefined ? thread?.lifecycle : undefined
    if (settled?.state === 'settled') {
      if (settled.reason === 'manual') return settled
      this.#assertCanHide(threadId)
      return this.#notifyLifecycle(threadId, this.#store.settleThread(threadId, 'manual'))
    }
    this.#assertLifecycleState(threadId, 'active')
    this.#assertCanHide(threadId)
    return this.#notifyLifecycle(threadId, this.#store.settleThread(threadId, 'manual'))
  }

  unsettleThread(threadId: string): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'settled')
    return this.#notifyLifecycle(threadId, this.#store.touchThread(threadId))
  }

  snoozeThread(threadId: string, wakeAt: number): ThreadLifecycle {
    if (wakeAt <= Date.now()) throw new Error('wake time must be in the future')
    this.#assertLifecycleState(threadId, 'active')
    this.#assertCanHide(threadId)
    return this.#notifyLifecycle(threadId, this.#store.snoozeThread(threadId, wakeAt))
  }

  unsnoozeThread(threadId: string): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'snoozed')
    return this.#notifyLifecycle(threadId, this.#store.touchThread(threadId))
  }

  setThreadKeepActive(threadId: string, keepActive: boolean): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'active')
    return this.#notifyLifecycle(threadId, this.#store.setThreadKeepActive(threadId, keepActive))
  }

  markThreadRead(threadId: string): void {
    this.#store.markThreadRead(threadId)
  }

  refreshLifecycle(now = Date.now()): void {
    // Clients only hear about changes the batch actually committed.
    const changed: Array<[string, ThreadLifecycle]> = []
    this.#store.batchLifecycleUpdates(() => {
      for (const threadId of this.#store.dueSnoozedThreadIds(now)) {
        const lifecycle = this.#store.wakeSnoozedThread(threadId, now, now)
        if (lifecycle) changed.push([threadId, lifecycle])
      }

      const days = this.#store.sidebarSettings().autoSettleDays
      if (days === null) return
      const cutoff = now - days * 24 * 60 * 60 * 1_000
      for (const thread of this.#store.inactiveThreadCandidates(cutoff)) {
        if (!this.#canHide(thread)) continue
        const lifecycle = this.#store.settleInactiveThread(thread.id, cutoff, now)
        if (lifecycle) changed.push([thread.id, lifecycle])
      }
    })
    for (const [threadId, lifecycle] of changed) this.#notifyLifecycle(threadId, lifecycle)
  }

  #wakeForActivity(threadId: string, unread = false): void {
    const before = this.#store.thread(threadId)
    if (!before) return
    const at = Date.now()
    const lifecycle = this.#store.touchThread(threadId, unread, at)
    if (before.lifecycle.state !== 'active') this.#notifyLifecycle(threadId, lifecycle)
    else this.#onLifecycleScheduleChanged(at >= before.lastActiveAt ? 'later' : undefined)
  }

  #assertCanHide(threadId: string): void {
    const thread = this.#store.thread(threadId)
    if (!thread) throw new Error('thread not found')
    if (thread.closedAt !== undefined) throw new Error('archived threads cannot change inbox shelf')
    const status = this.inboxStatus(threadId)
    if (['starting', 'working', 'queued', 'approval', 'input'].includes(status)) {
      throw new Error(`cannot hide a thread while its status is ${status}`)
    }
  }

  #assertLifecycleState(threadId: string, expected: 'active' | 'settled' | 'snoozed'): void {
    const thread = this.#store.thread(threadId)
    if (!thread) throw new Error('thread not found')
    if (thread.closedAt !== undefined) throw new Error('archived threads cannot change inbox shelf')
    if (thread.lifecycle.state !== expected) {
      throw new Error(`thread is ${thread.lifecycle.state}, expected ${expected}`)
    }
  }

  #canHide(thread: { id: string; unread: boolean }): boolean {
    try {
      const status = this.inboxStatus(thread.id, undefined, thread.unread)
      return !['starting', 'working', 'queued', 'approval', 'input'].includes(status)
    } catch {
      return false
    }
  }

  #notifyLifecycle(threadId: string, lifecycle: ThreadLifecycle): ThreadLifecycle {
    this.#onLifecycle(threadId, lifecycle)
    this.#onLifecycleScheduleChanged()
    return lifecycle
  }

  openTerminal(threadId: string, columns: number, rows: number, terminalKey?: string): string {
    return this.#terminals.open(threadId, this.#repoPath(threadId), columns, rows, terminalKey)
  }

  openProjectTerminal(
    projectPath: string,
    columns: number,
    rows: number,
    terminalKey?: string,
  ): string {
    const project = this.#store.project(projectPath)
    if (!project) throw new Error('project is not registered')
    return this.#terminals.open(
      projectTerminalKey(project.path),
      resolveWorkspacePath(project.path),
      columns,
      rows,
      terminalKey,
    )
  }

  /**
   * Run a provider install command in its own terminal session. Keyed by
   * target so clicking install twice attaches to the run already going, and
   * rooted in the home directory because a global CLI install has no business
   * inside any particular project checkout.
   */
  installProvider(target: string, command: string, columns: number, rows: number): string {
    return this.#trackProviderTerminal(
      target,
      this.#terminals.run(`install:${target}`, command, os.homedir(), columns, rows),
    )
  }

  /**
   * Run a provider's interactive sign-in CLI in its own terminal session.
   * Keyed by target so a second Sign in click reattaches to the session
   * already going, and rooted in the home directory because signing in to a
   * global CLI has no business inside any particular project checkout. As
   * another `account`, the CLI runs with that account's variables and signs
   * its folder in, in a terminal of its own.
   */
  launchProviderLogin(
    target: string,
    command: string,
    columns: number,
    rows: number,
    account?: { id: AccountId; environment: NodeJS.ProcessEnv },
  ): string {
    const key = account ? `login:${target}@${account.id}` : `login:${target}`
    return this.#trackProviderTerminal(
      target,
      this.#terminals.run(key, command, os.homedir(), columns, rows, account?.environment),
      account?.id,
    )
  }

  /**
   * Installs, updates and sign-ins run as `provider`, `provider:agent` or
   * `update:provider` terminals. Whatever they changed, the source may list
   * other models once they exit.
   */
  #trackProviderTerminal(target: string, terminalId: string, accountId?: AccountId): string {
    const source = providerTerminalSource(target)
    if (source)
      this.#providerTerminals.set(terminalId, accountId ? { ...source, accountId } : source)
    return terminalId
  }

  #providerTerminalExited(terminalId: string): void {
    const source = this.#providerTerminals.get(terminalId)
    if (!source) return
    this.#providerTerminals.delete(terminalId)
    const modelLists = source.accountId
      ? this.#accountScopes.get(accountScopeKey(source.provider, source.accountId))?.modelLists
      : this.#modelLists
    modelLists?.invalidate(source.provider, source.agent)
  }

  /**
   * Stops what runs as a provider account before it is removed: its chats'
   * sessions, its sign-in terminal, its control process and its cached reads.
   * Windows cannot delete a folder a running CLI still uses, and a removed
   * account's chats must not go on in it. A chat that is still working keeps
   * the account until the user stops it. `unregister` runs once nothing
   * refuses and before anything stops, so nothing new starts as the account
   * while it is released.
   */
  async releaseAccount(
    provider: ProviderId,
    accountId: AccountId,
    unregister?: () => void,
  ): Promise<void> {
    const runsAs = (thread: { provider: ProviderId; accountId?: string | undefined } | undefined) =>
      thread?.provider === provider && thread.accountId === accountId
    const attached = [...this.#threads]
      .filter(([, entry]) => runsAs(entry.thread))
      .map(([threadId]) => threadId)
    const busy =
      [...this.#resumingThreads.keys()].some((threadId) => runsAs(this.#store.thread(threadId))) ||
      attached.some((threadId) => this.isTurnRunning(threadId) || this.#hasQueuedTurns(threadId))
    if (busy) {
      throw new Error(
        'A chat on this account is still working. Stop it first, then remove the account.',
      )
    }
    unregister?.()
    const key = accountScopeKey(provider, accountId)
    const scope = this.#accountScopes.get(key)
    this.#accountScopes.delete(key)
    scope?.modelLists.dispose()
    const terminals = [...this.#providerTerminals]
      .filter(([, source]) => runsAs(source))
      .map(([terminalId]) => terminalId)
    await Promise.all([
      ...attached.map((threadId) => this.#disposeThreadRuntime(threadId, 'disconnect')),
      ...terminals.map((terminalId) => this.#terminals.close(terminalId)),
      scope?.controls.disposeAll(),
    ])
  }

  writeTerminal(terminalId: string, data: string): void {
    this.#terminals.write(terminalId, data)
  }

  resizeTerminal(terminalId: string, columns: number, rows: number): void {
    this.#terminals.resize(terminalId, columns, rows)
  }

  async closeTerminal(terminalId: string): Promise<void> {
    await this.#terminals.close(terminalId)
  }

  /**
   * Start closing every terminal. Server shutdown calls this before anything
   * else: terminal jobs get a fixed budget inside the desktop's force stop,
   * and disposeAll later waits for this same close.
   */
  closeAllTerminals(): Promise<void> {
    return this.#terminals.closeAll()
  }

  terminalStatus(terminalId: string) {
    return this.#terminals.status(terminalId)
  }

  #repoPath(threadId: string): string {
    const stored = this.#store.thread(threadId)
    if (!stored) throw new Error(`no such thread: ${threadId}`)
    return stored.worktreePath ?? resolveWorkspacePath(stored.projectPath)
  }

  #diffRepoPath(threadId: string): string {
    const worktreePath = this.#store.thread(threadId)?.worktreePath
    if (!worktreePath) throw new Error('diff review requires an isolated session')
    return worktreePath
  }

  async #rejectDiff(threadId: string, review: () => Promise<SessionDiff>): Promise<SessionDiff> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot reject a diff while the agent turn is running')
    }
    if (this.#restoringThreads.has(threadId)) throw new StaleDiffSnapshotError()
    // One rejection at a time per thread: two concurrent reverse-applies pass
    // the same staleness check and then patch the same worktree, and git's
    // fuzz can land the second one at the wrong offset silently. The client
    // retries with a fresh diff on this error.
    if (this.#reviewingDiffs.has(threadId)) throw new StaleDiffSnapshotError()
    this.#reviewingDiffs.add(threadId)
    try {
      return await this.#checkoutAccess.exclusive(this.#diffRepoPath(threadId), review)
    } finally {
      this.#reviewingDiffs.delete(threadId)
      this.#pruneIdleThreadRuntimes()
    }
  }

  /** Detached callers never await this, so a storage failure is logged rather than thrown. */
  #drainQueue(threadId: string, queuedTurnId?: string): Promise<void> {
    return this.#drainQueueOnce(threadId, queuedTurnId).catch((error: unknown) => {
      this.#onLog(`could not start the next queued turn; it remains queued: ${errorMessage(error)}`)
    })
  }

  /** The user sends one prompt a Stop held, ahead of the others; the rest follow it in order. */
  async #sendHeldQueuedTurn(threadId: string, queuedTurnId: string): Promise<void> {
    if (!this.#queueEntries(threadId).some((item) => item.id === queuedTurnId))
      throw new Error('queued prompt not found')
    if (this.#drainingQueues.has(threadId)) throw new Error('a queued prompt is already being sent')
    this.#heldQueues.delete(threadId)
    // The agent is still ending the stopped turn: the picked prompt goes first once it has.
    const settling = this.#settlingStops.get(threadId)
    if (settling) {
      settling.sendFirst = queuedTurnId
      return
    }
    await this.#drainQueueOnce(threadId, queuedTurnId)
  }

  /**
   * Sends the queue's first prompt, or `queuedTurnId` when the user picked one; the first
   * when the picked one has left the queue meanwhile.
   */
  async #drainQueueOnce(threadId: string, queuedTurnId?: string): Promise<void> {
    const entry = this.#threads.get(threadId)
    if (
      !entry ||
      // A panic stop empties every queue; a drain that was already in flight
      // must not start the turn it grabbed before the panic landed.
      this.#panicStopping ||
      this.#drainingQueues.has(threadId) ||
      this.isTurnRunning(threadId) ||
      // A Stop holds what was queued before it until the user sends again.
      this.#heldQueues.has(threadId) ||
      // The agent is still ending a stopped turn; the queue drains once it has.
      this.#settlingStops.has(threadId)
    ) {
      return
    }
    const queue = this.#queueEntries(threadId)
    const index = Math.max(
      0,
      queuedTurnId === undefined ? 0 : queue.findIndex((item) => item.id === queuedTurnId),
    )
    const next = queue[index]
    if (!next) {
      this.#pruneIdleThreadRuntimes()
      return
    }

    const claimed = this.#store.claimQueuedTurn(threadId, next.id, 'normal')
    if (!claimed) return
    queue.splice(index, 1)
    this.#retainQueueEntries(threadId, queue)

    const draining: QueueDrain = { queueId: next.id }
    this.#drainingQueues.set(threadId, draining)
    this.#notifyQueue(threadId)
    const generation = this.#panicGeneration
    let drainNext = false
    // A Creatify prompt is recorded by TasteCode in any case; its record then
    // also takes it off the queue, so a start that fails after the record
    // cannot leave it queued and shown twice.
    const submissionId =
      next.clientSubmissionId ?? (next.attachments.some(isCreatifyAttachment) ? next.id : undefined)
    try {
      const turnId = await this.sendTurn(
        threadId,
        next.text,
        next.attachments,
        next.options,
        submissionId
          ? {
              id: submissionId,
              text: next.text,
              attachments: next.attachments,
              createdAt: next.createdAt,
              queueId: next.id,
              ...(next.channel ? { channel: next.channel } : {}),
            }
          : undefined,
      )
      if (this.#threads.get(threadId) !== entry) return
      if (generation !== this.#panicGeneration) {
        // A panic landed while the adapter call was in flight: the user said
        // stop-everything, so this turn must neither run on nor re-queue.
        await entry.session.interrupt(threadId)
        return
      }
      if (!submissionId && !this.#store.completeQueuedTurn(threadId, next.id)) return
      if (!this.#threads.has(threadId) || this.#store.thread(threadId)?.closedAt !== undefined)
        return
      if (this.#activeTurnIds.get(threadId) === turnId) {
        this.#addSidebarStatus(this.#activeTurns, threadId)
      }
      // Completion can arrive before the provider acknowledges the send. Its
      // drain was blocked by this dispatch, so retry after releasing the latch.
      drainNext = draining.completedTurnId === turnId && !this.isTurnRunning(threadId)
    } catch {
      if (this.#threads.get(threadId) !== entry) return
      // After a panic the queue was emptied on purpose; putting the grabbed
      // prompt back would resurrect it.
      let restored = false
      if (generation === this.#panicGeneration) {
        restored = this.#store.restoreQueuedTurn(threadId, next.id)
        if (restored) {
          // An empty cached array can be evicted while the send is pending.
          // Restore from storage so newer queued prompts remain visible.
          this.#queuedTurns.delete(threadId)
          this.#notifyQueue(threadId)
        }
      }
      this.#onLog(
        restored
          ? 'could not start queued turn; it remains queued'
          : 'queued turn ended after acceptance or cancellation',
      )
    } finally {
      if (this.#drainingQueues.get(threadId) === draining) {
        this.#drainingQueues.delete(threadId)
        this.#pruneIdleThreadRuntimes()
        if (drainNext) void this.#drainQueue(threadId)
      }
    }
  }

  #notifyQueue(threadId: string): void {
    if (!this.#threads.has(threadId)) return
    this.#onQueue(threadId, this.queue(threadId))
  }

  #publicQueuedTurn(item: QueuedTurnEntry): QueuedTurn {
    return {
      id: item.id,
      text: item.text,
      attachments: item.attachments.filter((path) => !isModeMarker(path)),
      createdAt: item.createdAt,
    }
  }

  #queueEntries(threadId: string): QueuedTurnEntry[] {
    const cached = this.#queuedTurns.get(threadId)
    if (cached) return this.#retainQueueEntries(threadId, cached)
    const restored = this.#store.queuedTurns(threadId).map((turn) => {
      const { threadId: _threadId, intent: _intent, clientSubmissionId, channel, ...entry } = turn
      return {
        ...entry,
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
        ...(channel ? { channel } : {}),
      }
    })
    return this.#retainQueueEntries(threadId, restored)
  }

  #retainQueueEntries(threadId: string, entries: QueuedTurnEntry[]): QueuedTurnEntry[] {
    this.#queuedTurns.set(threadId, entries)
    if (entries.length > 0) {
      this.#emptyQueuedTurns.delete(threadId)
      return entries
    }

    this.#emptyQueuedTurns.delete(threadId)
    this.#emptyQueuedTurns.add(threadId)
    while (this.#emptyQueuedTurns.size > EMPTY_QUEUE_CACHE_LIMIT) {
      const oldestThreadId = this.#emptyQueuedTurns.values().next().value
      if (oldestThreadId === undefined) break
      this.#emptyQueuedTurns.delete(oldestThreadId)
      if (this.#queuedTurns.get(oldestThreadId)?.length === 0) {
        this.#queuedTurns.delete(oldestThreadId)
      }
    }
    return entries
  }

  #hasQueuedTurns(threadId: string): boolean {
    const cached = this.#queuedTurns.get(threadId)
    return cached ? cached.length > 0 : this.#store.queuedThreadIds().has(threadId)
  }

  /** Where the working tree stood before a turn. Silent when there is no repo. */
  async #checkpoint(threadId: string, label: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored) return
    const repoPath = this.#repoPath(threadId)
    // Its snapshot and the last turn's diff would race for the same refs.
    await this.#turnDiffBuilds.get(threadId)

    try {
      const snapshot = await takeSnapshot(repoPath, {
        retainIn: this.#store.checkpointNamespace,
      })
      this.#store.recordCheckpointRepository(canonicalCheckoutRoot(repoPath))
      this.#store.addCheckpoint({
        threadId,
        seq: this.#store.lastSeq(threadId),
        commit: snapshot.commit,
        label: checkpointLabel(label),
      })
      this.#turnStartSnapshots.set(threadId, { repoPath, commit: snapshot.commit })
    } catch {
      this.#turnStartSnapshots.delete(threadId)
      // A folder that is not a repository is a normal case. Failing the turn
      // over a backup the user never asked for would be the wrong trade.
    }
  }

  /**
   * The edits card and its Undo read a turn's diff, which only some agents
   * report. For the others it is what changed in the checkout since the
   * checkpoint the turn started from, unless another chat wrote in the same
   * checkout meanwhile: its changes would then count as this turn's.
   */
  #noteTurnDiffFromCheckpoint(threadId: string, turnId: string): void {
    const start = this.#turnStartSnapshots.get(threadId)
    this.#turnStartSnapshots.delete(threadId)
    const written = this.#turnWrittenPaths.get(threadId)
    this.#turnWrittenPaths.delete(threadId)
    // A chat that shared this checkout and ends later compares its files with these.
    if (written) this.#lastTurnWrittenPaths.set(threadId, written)
    else this.#lastTurnWrittenPaths.delete(threadId)
    if (!start || !written) return
    const provider = this.#store.thread(threadId)?.provider
    if (!provider || PROVIDER_CAPABILITIES[provider].turnDiffs) return
    if (this.#recordedTurnDiffs.get(threadId)?.turnId === turnId) return
    // Only the files the agent said it changed: the user may have edited
    // others meanwhile, and Undo must never revert those. A file changed only
    // by a command (a formatter, a generator) is therefore not on the card.
    const folder = path.resolve(start.repoPath)
    if (!this.#checkoutWasOwn(threadId, folder, written)) return
    const files = [...written].flatMap((file) => {
      const relative = path.relative(folder, path.resolve(folder, file))
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative] : []
    })
    if (files.length === 0 || files.length > MAX_CHECKPOINT_TURN_DIFF_FILES) return
    const build = this.#recordTurnDiffFromCheckpoint(threadId, turnId, start, files).finally(() => {
      if (this.#turnDiffBuilds.get(threadId) === build) this.#turnDiffBuilds.delete(threadId)
    })
    this.#turnDiffBuilds.set(threadId, build)
  }

  /**
   * Whether the files this turn wrote hold its changes only. Another chat that
   * worked in the same checkout meanwhile may have changed them too. The
   * exception is the chat's own sub-agent, or the chat that started this one,
   * when the two wrote different files.
   */
  #checkoutWasOwn(threadId: string, folder: string, written: ReadonlySet<string>): boolean {
    const others = this.#checkoutAccess.coWritersSinceBegin(threadId)
    if (others.size === 0) return true
    const own = new Set([...written].map((file) => checkoutPathKey(folder, file)))
    const parent = this.#store.thread(threadId)?.ownerThreadId
    for (const other of others) {
      if (other !== parent && this.#store.thread(other)?.ownerThreadId !== threadId) return false
      const theirs = [
        ...(this.#turnWrittenPaths.get(other) ?? []),
        ...(this.#lastTurnWrittenPaths.get(other) ?? []),
      ]
      const otherFolder = path.resolve(this.#repoPath(other))
      if (theirs.some((file) => own.has(checkoutPathKey(otherFolder, file)))) return false
    }
    return true
  }

  async #recordTurnDiffFromCheckpoint(
    threadId: string,
    turnId: string,
    start: { repoPath: string; commit: string },
    files: string[],
  ): Promise<void> {
    try {
      const diff = await patchSince(start.repoPath, start.commit, files)
      if (!diff) return
      if (diff.length > MAX_CHECKPOINT_TURN_DIFF_CHARS) {
        this.#onLog(`Turn diff from checkpoint left out: ${diff.length} characters`)
        return
      }
      // A newer turn has started meanwhile; the card is its own now.
      if (this.#activeTurnIds.has(threadId) || this.#startingTurns.has(threadId)) return
      if (!this.#store.thread(threadId)) return
      this.#record(threadId, { type: 'diff.updated', turnId, diff })
    } catch (error) {
      this.#onLog(`Turn diff from checkpoint failed: ${errorMessage(error)}`)
    }
  }

  checkpoints(threadId: string): StoredCheckpoint[] {
    return this.#store.checkpoints(threadId)
  }

  async #withRestoreLock<T>(threadId: string, restore: () => Promise<T>): Promise<T> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot restore during a running turn')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot restore while another restore is running')
    }
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot restore while a diff rejection is running')
    }

    let finishRestore!: () => void
    this.#restoringThreads.set(threadId, new Promise((resolve) => (finishRestore = resolve)))
    try {
      return await this.#checkoutAccess.exclusive(this.#repoPath(threadId), restore)
    } finally {
      this.#restoringThreads.delete(threadId)
      finishRestore()
      this.#pruneIdleThreadRuntimes()
    }
  }

  /**
   * Put a session back to a checkpoint — files and conversation together.
   *
   * Returns where the replaced state was saved, because restoring is itself an
   * action someone can regret. Nothing reachable this way is unrecoverable.
   */
  async restoreCheckpoint(threadId: string, checkpointId: number): Promise<{ undo: string }> {
    return this.#withRestoreLock(threadId, async () => {
      const stored = this.#store.thread(threadId)
      const checkpoint = this.#store.checkpoint(checkpointId)
      if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
        throw new Error('no such checkpoint')
      }

      const repoPath = this.#repoPath(threadId)
      const replaced = await this.#restoreSnapshotWithRecovery(
        threadId,
        repoPath,
        checkpoint.commit,
      )

      // Rolling the files back without this would leave the transcript
      // describing work that no longer exists on disk.
      try {
        this.#dropInboxProjection(threadId)
        const undo = this.#store.saveRestoreUndo(threadId, checkpoint.seq, replaced.commit)
        return { undo }
      } catch (error) {
        await restoreSnapshot(repoPath, replaced.commit)
        throw error
      }
    })
  }

  /** Reverse the latest restore, including both files and conversation. */
  async undoRestore(threadId: string, token: string): Promise<void> {
    return this.#withRestoreLock(threadId, async () => {
      const stored = this.#store.thread(threadId)
      const undo = this.#store.restoreUndo(threadId, token)
      if (!stored || !undo) throw new Error('restore can no longer be undone')

      const repoPath = this.#repoPath(threadId)
      const replaced = await this.#restoreSnapshotWithRecovery(threadId, repoPath, undo.commit)
      try {
        this.#store.applyRestoreUndo(threadId, token)
        this.#dropInboxProjection(threadId)
      } catch (error) {
        await restoreSnapshot(repoPath, replaced.commit)
        throw error
      }
    })
  }

  /**
   * The first prompt of a chat that continues an earlier one carries that
   * chat's conversation as it stands now. A chat's own transcript keeps only
   * the user's words of its first prompt, so when the earlier chat continued
   * another one itself, that one's conversation up to where it was continued
   * comes first; otherwise a second continuation loses the original request.
   * An earlier chat deleted since ends the chain there, and with none left the
   * prompt stays as it is.
   */
  async #promptWithEarlierChat(threadId: string, prompt: string): Promise<string> {
    const chats = await this.#earlierChats(threadId)
    const continued = chats.pop()
    if (!continued) return prompt
    return (
      continuationPromptFromReplay(continued, prompt, {
        earlier: chats,
        changes: this.earlierChanges(threadId),
      }) ?? prompt
    )
  }

  /**
   * The chats this one carries on, oldest first, each as far as it went
   * before the next one took over. Events share one sequence across chats, so
   * a chat's first event marks where it left the one it continued; what that
   * one did later is another branch. `laterStart` cuts the chat this one
   * continued; without it that chat counts as it stands now.
   */
  async #earlierChats(
    threadId: string,
    laterStart = Number.POSITIVE_INFINITY,
  ): Promise<HistoryEntry[][]> {
    const chats: HistoryEntry[][] = []
    const seen = new Set([threadId])
    let earlierId = this.#store.thread(threadId)?.continuedFrom
    while (
      earlierId !== undefined &&
      !seen.has(earlierId) &&
      chats.length < MAX_CONTINUED_CHATS &&
      this.#store.thread(earlierId)
    ) {
      seen.add(earlierId)
      const history = (await this.history(earlierId)).filter((entry) => entry.seq < laterStart)
      chats.unshift(history)
      for (const entry of history) laterStart = Math.min(laterStart, entry.seq)
      earlierId = this.#store.thread(earlierId)?.continuedFrom
    }
    return chats
  }

  /**
   * The first prompt a chat sends after it moved to another provider: its
   * conversation up to `through`, any chats it carried on before that, and
   * where the work stands, sized for the session that gets it.
   */
  async #handoverPrompt(
    threadId: string,
    request: string,
    through: number,
    session: AgentSession,
    model: string | undefined,
  ): Promise<string> {
    const stored = this.#store.thread(threadId)
    // git and the engine answer while the history is read; the prompt waits on all three.
    const [history, workspace, modelWindow] = await Promise.all([
      this.history(threadId),
      workspaceChanges(this.#repoPath(threadId)).catch(() => undefined),
      session.modelContextWindow
        ? abortable(
            session.modelContextWindow(model),
            AbortSignal.timeout(MODEL_WINDOW_WAIT_MS),
          ).catch(() => undefined)
        : undefined,
    ])
    const own = history.filter((entry) => entry.seq <= through)
    const earlier = await this.#earlierChats(threadId, own[0]?.seq)
    const context = stored
      ? this.#contextRuntimeOptions(stored.provider, stored.agent, stored.accountId).context
      : undefined
    // The user's chosen window first, then what the engine knows of this model,
    // then the engine's default.
    return handoverPrompt({
      conversations: [...earlier, own],
      request,
      budget: handoverBudget({
        contextWindow: context?.window ?? modelWindow ?? session.capabilities.context?.windows[0],
        promptLimit: session.promptLimit,
        request,
      }),
      workspace,
      keepAttachment: (file) => existsSync(file),
    })
  }

  #promptAfterRestore(threadId: string, prompt: string): string {
    if (!this.#store.threadNeedsRestoreContext(threadId)) return prompt
    return `${RESTORE_CONTEXT_NOTICE}${prompt}`
  }

  /**
   * Whether `text` starts with a command the chat's provider lists, the list
   * the slash menu offers. Text that only looks like one, or a list that
   * cannot be read, leaves the turn an ordinary prompt.
   */
  async #isProviderCommand(
    threadId: string,
    entry: AttachedThreadRuntime,
    text: string,
  ): Promise<boolean> {
    // Codex runs its commands whatever their case. Taking one for prose would put text
    // around it and break it; taking prose for a command only leaves that text out once.
    const name = /^\/([^/\s]\S*)(?:\s|$)/.exec(text.trimStart())?.[1]?.toLowerCase()
    if (name === undefined) return false
    const inventory = await this.listCommands(
      entry.thread.provider,
      entry.projectPath,
      threadId,
    ).catch(() => undefined)
    return (
      inventory?.commands.some(
        (command) =>
          command.name.toLowerCase() === name ||
          command.aliases?.some((alias) => alias.toLowerCase() === name),
      ) === true
    )
  }

  async #restoreSnapshotWithRecovery(threadId: string, repoPath: string, commit: string) {
    try {
      return await restoreSnapshot(repoPath, commit, this.#store.checkpointNamespace)
    } catch (error) {
      if (error instanceof RestoreSnapshotError) {
        try {
          this.#store.addCheckpoint({
            threadId,
            seq: this.#store.lastSeq(threadId),
            commit: error.snapshot.commit,
            label: 'Recovery: original files before failed restore',
          })
        } catch {
          // The original message still names the commit holding the files.
          throw error
        }
        throw new Error(
          `${error.message} Select "Recovery: original files before failed restore" in this chat's checkpoints to recover them.`,
          { cause: error },
        )
      }
      throw error
    }
  }

  /** What the agent has changed since a checkpoint, so a restore is informed. */
  async changedSinceCheckpoint(threadId: string, checkpointId: number): Promise<string[]> {
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
      throw new Error('no such checkpoint')
    }
    return changedSince(this.#repoPath(threadId), checkpoint.commit)
  }

  /** Upgrade saved checkpoints from versions that did not create Git refs. */
  async protectStoredCheckpoints(): Promise<void> {
    const repositories = new Map<string, Set<string>>()
    const roots = new Map<string, string>()
    for (const entry of this.#store.checkpointReferences()) {
      const directory =
        entry.worktreePath && existsSync(entry.worktreePath)
          ? entry.worktreePath
          : resolveWorkspacePath(entry.projectPath)
      try {
        let root = roots.get(directory)
        if (!root) {
          root = await checkpointRepository(directory)
          roots.set(directory, root)
        }
        const commits = repositories.get(root) ?? new Set<string>()
        for (const commit of entry.commits) commits.add(commit)
        repositories.set(root, commits)
        this.#store.recordCheckpointRepository(root)
      } catch (error) {
        this.#onLog(`Could not locate saved checkpoints in ${directory}: ${errorMessage(error)}`)
      }
    }
    for (const [repoPath, commits] of repositories) {
      try {
        await retainCheckpoints(repoPath, this.#store.checkpointNamespace, commits)
      } catch {
        // One already-missing legacy object must not leave every other saved
        // checkpoint unprotected. This slower path runs only on migration failure.
        for (const commit of commits) {
          try {
            await retainCheckpoint(repoPath, this.#store.checkpointNamespace, commit)
          } catch (error) {
            this.#onLog(
              `Could not protect a saved checkpoint in ${repoPath}: ${errorMessage(error)}`,
            )
          }
        }
      }
    }
  }

  respondToApproval(threadId: string, approvalId: string, decision: ApprovalDecision): void {
    // TasteCode asked this one itself, about starting a sub-agent.
    if (this.#subagents.answer(threadId, approvalId, decision)) return
    this.#get(threadId).session.respondToApproval(approvalId, decision)
  }

  /**
   * Change a thread's access level. Persisted threads are resumed with the
   * selected mode; attached sessions receive the change directly when their
   * adapter supports it.
   */
  async setThreadApproval(threadId: string, approval: ApprovalMode): Promise<void> {
    this.#refuseApprovalDuringMove(threadId)
    const previous = this.#approvalChanges.get(threadId)
    // A Stop all or shutdown after this request cancels a resume it would start.
    const asked = { panic: this.#panicGeneration, dispose: this.#disposeGeneration }
    const changing = (async () => {
      await previous?.catch(() => undefined)
      await this.#applyThreadApproval(threadId, approval, asked)
    })()
    this.#approvalChanges.set(threadId, changing)
    try {
      await changing
    } finally {
      if (this.#approvalChanges.get(threadId) === changing) this.#approvalChanges.delete(threadId)
    }
  }

  async #applyThreadApproval(
    threadId: string,
    approval: ApprovalMode,
    asked: { panic: number; dispose: number },
  ): Promise<void> {
    // Wait out every resume, a prompt's own after a Stop included: one that started from
    // the old mode attaches first and then gets this one, like any attached session.
    for (
      let resuming = this.#resumingThreads.get(threadId);
      resuming;
      resuming = this.#resumingThreads.get(threadId)
    ) {
      // Its own cleanup forgets its generation before the wait below ends.
      const resumeGeneration = this.#resumeGenerations.get(threadId)
      try {
        await resuming
      } catch (error) {
        // A resume a Stop cancelled, before or during this wait, ends on its own; the
        // change then resumes afresh. A resume that fails for a real reason still fails it.
        if (resumeGeneration === (this.#runtimeGenerations.get(threadId) ?? 0)) throw error
      }
    }
    // A move may have begun while this change waited behind another one.
    this.#refuseApprovalDuringMove(threadId)
    const previous = this.#threadApprovals.get(threadId)
    const hadPrevious = this.#threadApprovals.has(threadId)
    try {
      const attached = this.#threads.get(threadId)
      if (attached && !attached.session.setApproval) {
        if (this.isTurnRunning(threadId)) {
          throw new Error('Stop the running turn before changing access mode for this agent.')
        }
        if (!attached.resumable) {
          throw new Error('This agent cannot change access mode. Start a new chat with that mode.')
        }
        await this.#disposeThreadRuntime(threadId, 'disconnect')
      }
      this.#threadApprovals.set(threadId, approval)
      if (attached?.session.setApproval) {
        await this.#withThreadRuntimeOperation(threadId, () =>
          attached.session.setApproval!(approval),
        )
      } else {
        if (asked.panic !== this.#panicGeneration || asked.dispose !== this.#disposeGeneration)
          throw new Error('access mode change cancelled by panic stop or shutdown')
        await this.#ensureThread(threadId)
      }
      this.#store.setThreadApproval(threadId, approval)
    } catch (error) {
      if (hadPrevious) this.#threadApprovals.set(threadId, previous!)
      else this.#threadApprovals.delete(threadId)
      throw error
    }
  }

  /** A move starts its session in the mode it was given; a change meanwhile would be lost. */
  #refuseApprovalDuringMove(threadId: string): void {
    if (this.#changingProvider.has(threadId)) {
      throw new Error(
        'This chat is moving to another provider. Choose the mode again once it has moved.',
      )
    }
  }

  respondToUserInput(threadId: string, requestId: string, answers: Record<string, string[]>): void {
    const session = this.#get(threadId).session
    if (!session.respondToUserInput) throw new Error('this agent does not support structured input')
    session.respondToUserInput(requestId, answers)
  }

  async interrupt(threadId: string): Promise<void> {
    // A chat's sub-agents stop with it, a background one included. A chat
    // without any keeps the exact timing it had.
    const children = this.#subagents.stopFor(threadId)
    try {
      const stopsBefore = this.#stopRequests.get(threadId) ?? 0
      this.#stopRequests.set(threadId, stopsBefore + 1)
      // Only prompts already on their way when Stop came can start the turn it stops.
      const incoming = [...(this.#incomingSubmissions.get(threadId) ?? [])]
      // "Stop" on a thread that is not live must be a no-op, not an error the
      // user cannot act on.
      if (!this.#threads.has(threadId)) {
        // A persisted thread is not attached until resume resolves. Invalidate
        // that resume so its pending submission cannot run after the user stops it.
        // A prompt that waits to resume, behind an access mode change or for the
        // old session to stop, goes the same way.
        if (this.#resumingThreads.has(threadId) || this.#resumeCancels.has(threadId)) {
          this.#runtimeGenerations.set(threadId, (this.#runtimeGenerations.get(threadId) ?? 0) + 1)
          this.#resumeStops.set(threadId, (this.#resumeStops.get(threadId) ?? 0) + 1)
          // Nothing goes out on its own after a Stop, queued prompts a resume was for included.
          if (this.#hasQueuedTurns(threadId)) this.#heldQueues.add(threadId)
          // The prompt is cancelled now; the resume it waits on may take seconds to end.
          this.#deleteSidebarStatus(this.#resumingForPrompt, threadId)
          const cancels = this.#resumeCancels.get(threadId) ?? []
          this.#resumeCancels.delete(threadId)
          for (const cancel of cancels) cancel(new Error('turn cancelled while resuming'))
          return
        }
        if (incoming.length === 0) return
      }
      // An agent asked to stop before its turn exists has nothing to stop and
      // drops the request; the turn then ran to its end behind "Stopping…". A new
      // chat stopped while it starts sends its prompt and the Stop back to back,
      // and the Stop overtook the prompt on its way in. Wait for those prompts to
      // start or queue first. The queue is held meanwhile: a turn that ends in
      // the wait must not start a queued prompt that the Stop then catches.
      if (this.#hasQueuedTurns(threadId)) this.#heldQueues.add(threadId)
      await Promise.allSettled(incoming)
      // Nothing goes out on its own after a Stop: what waits in the queue now
      // waits for the user, not for the stopped turn to end.
      if (this.#hasQueuedTurns(threadId)) this.#heldQueues.add(threadId)
      // The checkpoint runs before the provider starts. An interrupt sent in
      // that window used to hit an idle adapter and disappear, after which the
      // turn started anyway. Wait until the adapter has accepted or rejected
      // the start, then deliver the interrupt against its real active turn.
      const barrier = this.#turnStartBarriers.get(threadId)?.done
      await barrier
      const entry = this.#threads.get(threadId)
      if (!entry) return
      // While the Stop waited, the turn it was for may have ended and a prompt sent after the
      // click started another. That one is not this Stop's to end.
      if (
        this.#activeTurnIds.has(threadId) &&
        (this.#activeTurnStopsBefore.get(threadId) ?? 0) > stopsBefore
      )
        return
      // The chat shows the turn stopped now. An agent can take seconds to confirm a Stop,
      // or never do so, and the chat must not keep running behind "Stopping…" meanwhile.
      const stop = this.#settleStoppedTurn(threadId, entry)
      try {
        await entry.session.interrupt(threadId)
        if (stop) stop.confirmed = true
      } catch (error) {
        if (!stop) throw error
        // The turn has ended meanwhile, by the agent or with its process.
        if (this.#settlingStops.get(threadId) !== stop) return
        if (!entry.resumable) {
          // The agent runs on and nothing can end it without losing the chat; say so.
          this.#finishSettlingStop(threadId, stop)
          throw error
        }
        // The chat already shows the turn as stopped, so end the agent that refused to stop.
        // The next prompt resumes the session in a new process.
        await this.#endUnconfirmedStop(
          threadId,
          stop,
          `The agent refused Stop (${errorMessage(error)})`,
        )
      }
    } finally {
      if (children) await children
    }
  }

  /**
   * Ends a stopped turn for the user: its open items, requests and the turn itself settle
   * as interrupted, the way a restart settles them. The agent is still asked to stop and
   * stays busy until it reports the end, or until the settle deadline ends its process.
   */
  #settleStoppedTurn(threadId: string, entry: AttachedThreadRuntime): SettlingStop | undefined {
    const turnId = this.#activeTurnIds.get(threadId)
    if (!turnId || this.#settlingStops.has(threadId)) return undefined
    this.#userStoppedTurns.set(threadId, turnId)
    const stop: SettlingStop = {
      turnId,
      entry,
      timer: setTimeout(
        () =>
          void this.#endUnconfirmedStop(
            threadId,
            stop,
            `The agent did not end the stopped turn within ${Math.ceil(this.#stopSettleMs / 1000)} s`,
          ),
        this.#stopSettleMs,
      ),
    }
    stop.timer.unref?.()
    this.#settlingStops.set(threadId, stop)
    this.#recordedDeltas.flush(threadId)
    let open: DomainEvent[] = []
    try {
      // Stop ends the running turn only. A background sub-agent whose launching call already
      // completed keeps running in the live session, which reports how it ends.
      open = this.#store.interruptedLifecycleEvents(threadId, {
        launchedSubagents: false,
        stoppedByUser: true,
      })
    } catch (error) {
      this.#onLog(`Could not settle the stopped turn's open work: ${errorMessage(error)}`)
    }
    for (const event of open) if (event.type !== 'turn.completed') this.#record(threadId, event)
    // Through the session path, so a handover sees its turn end.
    this.#handleSessionEvent(threadId, { type: 'turn.completed', turnId, status: 'interrupted' })
    return stop
  }

  /**
   * While a stopped turn settles, its agent's events belong to the turn the user already saw
   * end. Returns whether the event is consumed here instead of recorded.
   */
  #settlingStopEvent(threadId: string, event: DomainEvent): boolean {
    const stop = this.#settlingStops.get(threadId)
    if (!stop) return false
    switch (event.type) {
      case 'turn.completed':
        if (event.turnId === stop.turnId) this.#finishSettlingStop(threadId, stop)
        return true
      case 'thread.error':
        // Once the agent accepted the Stop, its errors belong to the run it is ending, or to
        // work nobody asked for: an agent may report a stopped run as failed, for instance
        // after a repeat Stop it turned down. The user already saw the turn end as stopped,
        // so a banner now would be spurious. Before that, an error is still news.
        if (!stop.confirmed) return false
        this.#onLog(`The agent reported an error while ending a stopped turn: ${event.message}`)
        return true
      // Spend still counts, and a resolution only closes a request.
      case 'usage.updated':
      case 'approval.resolved':
      case 'user_input.resolved':
        return false
      default:
        // Every prompt waits while a Stop settles, so any turn the agent runs now is the
        // stopped one, or work of its own that nobody asked for.
        if (event.type === 'item.started' && stop.confirmed && !stop.stoppedAgain) {
          // New work after the agent accepted the Stop, such as a steer Claude keeps
          // queued through it, would run unseen. Stop that too.
          stop.stoppedAgain = true
          this.#onLog('The agent started new work in a stopped turn; stopping it again')
          void stop.entry.session
            .interrupt(threadId)
            .catch((error: unknown) =>
              this.#onLog(`Could not stop the agent's new work: ${errorMessage(error)}`),
            )
        }
        return true
    }
  }

  #finishSettlingStop(threadId: string, stop: SettlingStop): void {
    if (this.#settlingStops.get(threadId) !== stop) return
    clearTimeout(stop.timer)
    this.#settlingStops.delete(threadId)
    this.#releaseCheckoutIfIdle(threadId)
    // Prompts sent after the Stop waited for the agent to finish it. Prompts queued before
    // it stay held until the user sends again.
    if (
      this.#threads.get(threadId) === stop.entry &&
      this.#hasQueuedTurns(threadId) &&
      !this.#heldQueues.has(threadId)
    ) {
      void this.#drainQueue(threadId, stop.sendFirst)
    } else {
      this.#pruneIdleThreadRuntimes()
    }
  }

  /**
   * The agent did not end a stopped turn in time, or refused the Stop: end its process, as
   * a disconnect would. A resumable chat continues in a new one with its next prompt.
   */
  #endUnconfirmedStop(threadId: string, stop: SettlingStop, why: string): Promise<void> {
    if (this.#settlingStops.get(threadId) !== stop) return Promise.resolve()
    if (this.#threads.get(threadId) !== stop.entry || !stop.entry.resumable) {
      if (this.#threads.get(threadId) === stop.entry)
        this.#onLog(`${why}; it keeps its process because the chat could not resume without it`)
      this.#finishSettlingStop(threadId, stop)
      return Promise.resolve()
    }
    this.#onLog(`${why}; ending its process`)
    const stopped = this.#disposeThreadRuntime(threadId, 'disconnect')
    void this.#resumeQueuedAfterDisconnect(threadId, stopped, stop.sendFirst)
    return stopped.catch((error: unknown) =>
      this.#onLog(`Could not end the stopped agent: ${errorMessage(error)}`),
    )
  }

  /** Overlapping callers share one stop, so none can lift the guard while another still runs. */
  panicStop(): Promise<PanicStopResult> {
    if (this.#panicStop) return this.#panicStop
    const stop = this.#runPanicStop().finally(() => {
      if (this.#panicStop === stop) this.#panicStop = undefined
    })
    this.#panicStop = stop
    return stop
  }

  async #runPanicStop(): Promise<PanicStopResult> {
    const sessions = [...this.#threads.entries()]
    // An idle chat has nothing to stop, and some agents reject an interrupt
    // without a running turn; that failure must not close the chat.
    const busy = sessions.filter(([threadId]) => this.isTurnRunning(threadId))
    this.#panicStopping = true
    this.#panicGeneration += 1
    // A resume under way ends with the Stop all, as at a chat's own Stop: what the
    // user asks after it waits that resume out and resumes afresh.
    for (const threadId of this.#resumingThreads.keys()) {
      this.#runtimeGenerations.set(threadId, (this.#runtimeGenerations.get(threadId) ?? 0) + 1)
      this.#resumeStops.set(threadId, (this.#resumeStops.get(threadId) ?? 0) + 1)
    }
    this.#cancelResumingPrompts('turn cancelled by panic stop')
    // Every sub-agent ends as stopped; the busy chats below include theirs.
    this.#subagents.release()
    try {
      let queueClearFailed = false
      const hideQueues = (threadIds: Iterable<string>) => {
        for (const threadId of threadIds) {
          const cached = this.#queuedTurns.get(threadId)
          this.#retainQueueEntries(threadId, [])
          if (!cached) continue
          try {
            this.#notifyQueue(threadId)
          } catch {
            queueClearFailed = true
          }
        }
      }
      try {
        hideQueues(this.#store.clearAllQueuedTurns())
      } catch {
        queueClearFailed = true
        hideQueues(
          new Set([...sessions.map(([threadId]) => threadId), ...this.#queuedTurns.keys()]),
        )
      }

      const stoppedSessions = await Promise.all(
        busy.map(async ([threadId, entry]) => {
          let timeout: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              (async () => {
                await this.#turnStartBarriers.get(threadId)?.done
                if (this.#threads.get(threadId) === entry) await entry.session.interrupt(threadId)
              })(),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('interrupt timed out; session was force-stopped')),
                  PANIC_STOP_TIMEOUT_MS,
                )
              }),
            ])
            return { threadId, status: 'interrupted' as const }
          } catch (error) {
            // Force-stop the runtime only. Stop all is not the user closing the chat.
            // A runtime that replaced it meanwhile was not the one that hung.
            if (this.#threads.get(threadId) === entry) {
              const disposed = this.#disposeThreadRuntime(threadId, 'disconnect')
              // The detached runtime's own cleanup events are dropped, so settle
              // its turn and requests here, before anything can start another.
              this.#settleInterruptedLifecycles(threadId)
              await disposed
            }
            return {
              threadId,
              status: 'failed' as const,
              error: (error instanceof Error ? error.message : String(error)) || 'Unknown error',
            }
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }),
      )
      if (queueClearFailed) throw new Error('could not clear every queued prompt during Stop all')
      return { sessions: stoppedSessions }
    } finally {
      this.#panicStopping = false
    }
  }

  /** Record what restart recovery would for a runtime that is gone. */
  #settleInterruptedLifecycles(threadId: string, onlySubagents = false): void {
    try {
      for (const event of this.#store.interruptedLifecycleEvents(threadId)) {
        if (
          onlySubagents &&
          (event.type !== 'item.completed' ||
            event.item.subagent?.state !== 'interrupted' ||
            // TasteCode's own sub-agents run in chats of their own and outlive this runtime.
            // The broker settles them: on close and Stop, and after a restart.
            event.item.subagent.threadId !== undefined ||
            this.#store.subagents.get(event.item.id) !== undefined)
        )
          continue
        this.#record(threadId, event)
      }
    } catch (error) {
      this.#onLog(`Could not settle the force-stopped turn: ${errorMessage(error)}`)
    }
  }

  async close(threadId: string): Promise<void> {
    // A sub-agent's chat goes with the chat that started it; closing stops it.
    if (this.#store.thread(threadId)?.ownerThreadId !== undefined) {
      await this.#disposeThreadRuntime(threadId)
      return
    }
    if (this.#store.thread(threadId)?.ephemeral) {
      await this.closeSideThread(threadId)
      return
    }
    const sideThreadId = this.#sideThreads.get(threadId)
    const runtimeDisposed = this.#disposeThreadRuntime(threadId)
    this.#recordedDeltas.flush(threadId)
    // Always mark closed, live entry or not: closing is the user's statement
    // about the thread. Early-returning when no session was attached left a
    // thread mid-resume unmarked, so the resume guard never saw the close
    // and attached a zombie anyway.
    //
    // Marked closed, not deleted. Ending the process is not the same as
    // wanting the transcript gone.
    //
    // The worktree deliberately survives: it may hold work the agent did not
    // commit, and closing a session is not a statement about that work.
    //
    // Recorded before waiting for the Side chat to stop, so a replacement Side
    // chat that starts meanwhile sees the closed parent and refuses to attach.
    this.#store.closeThread(threadId)
    this.#revokeAgentTools(threadId)
    this.#simulatorAgent?.onThreadClosed(threadId)
    this.#onLifecycleScheduleChanged()
    await Promise.all([
      sideThreadId ? this.closeSideThread(sideThreadId) : undefined,
      runtimeDisposed,
      ...this.#endSubagents(threadId),
    ])
  }

  /** A chat's sub-agents end with its process; their chats stay readable. */
  #endSubagents(threadId: string): Array<Promise<void>> {
    this.#subagents.release(threadId)
    return this.#store
      .ownedThreadIds(threadId)
      .map((childId) => this.#disposeThreadRuntime(childId))
  }

  /**
   * Ends a chat's agent process without archiving the chat, so the next
   * message resumes it. Removing a project uses this: the project can be added
   * back, and its chats must still accept messages then.
   */
  async stopThread(threadId: string): Promise<void> {
    if (this.#store.thread(threadId)?.ownerThreadId !== undefined) {
      await this.#disposeThreadRuntime(threadId, 'close')
      return
    }
    if (this.#store.thread(threadId)?.ephemeral) {
      await this.closeSideThread(threadId)
      return
    }
    // A prompt claimed for dispatch or steering has not been accepted yet, and
    // its drain gives up once the runtime is gone. Return it to the queue, as
    // a disconnect does, or it stays hidden until a restart runs it.
    const draining = this.#drainingQueues.get(threadId)
    if (draining) this.#store.restoreQueuedTurn(threadId, draining.queueId)
    const sideThreadId = this.#sideThreads.get(threadId)
    const runtimeDisposed = this.#disposeThreadRuntime(threadId, 'close')
    this.#recordedDeltas.flush(threadId)
    await Promise.all([
      sideThreadId ? this.closeSideThread(sideThreadId) : undefined,
      runtimeDisposed,
      ...this.#endSubagents(threadId),
    ])
  }

  async closeSideThread(threadId: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    // A retry after a failed stop finds the row gone but the agent still owned.
    if (!stored) return this.#stopThreadProvider(threadId)
    if (!stored.ephemeral) throw new Error('thread is not a Side chat')
    this.#saveSideHistoryTombstone(
      {
        id: stored.id,
        provider: stored.provider,
        workspacePath: stored.worktreePath ?? resolveWorkspacePath(stored.projectPath),
        createdAt: stored.createdAt,
      },
      stored.providerSessionId,
    )
    this.#discardedSideThreads.add(threadId)
    this.#recordedDeltas.discard(threadId)
    const runtimeDisposed = this.#disposeThreadRuntime(threadId)
    if (stored.parentThreadId && this.#sideThreads.get(stored.parentThreadId) === threadId) {
      this.#sideThreads.delete(stored.parentThreadId)
    }
    this.#sideParents.delete(threadId)
    // This is a borrowed checkout, never owned by the temporary chat.
    this.#store.forgetWorktree(threadId)
    this.#store.deleteThread(threadId)
    this.forgetDeletedThread(threadId)
    await runtimeDisposed
  }

  #saveSideHistoryTombstone(thread: Thread, providerSessionId = thread.id): void {
    this.#store.replaceProviderHistory(thread.provider, thread.id, {
      id: providerSessionId,
      workspacePath: thread.workspacePath,
      title: 'Side chat',
      createdAt: thread.createdAt,
      updatedAt: thread.createdAt,
      revision: 'side-chat',
      internal: true,
    })
  }

  /**
   * Whether a thread owns the Side-chat stream rather than the main one.
   * Stored `ephemeral` is the durable side-chat marker; the runtime
   * `#sideParents` map only covers threads created by this process.
   */
  #isSideThread(threadId: string): boolean {
    if (this.#sideParents.has(threadId)) return true
    const stored = this.#store.thread(threadId)
    // A sub-agent's chat is stored ephemeral too, but has an owner.
    return stored?.ephemeral === true && stored.ownerThreadId === undefined
  }

  /** Keeps provider history import from listing a sub-agent's session as a chat of its own. */
  #saveSubagentHistoryRecord(thread: Thread, providerSessionId = thread.id): void {
    this.#store.replaceProviderHistory(thread.provider, thread.id, {
      id: providerSessionId,
      workspacePath: thread.workspacePath,
      title: 'Sub-agent',
      createdAt: thread.createdAt,
      updatedAt: thread.createdAt,
      revision: 'subagent',
      internal: true,
    })
  }

  #disposeThreadRuntime(threadId: string, reason: 'close' | 'disconnect' = 'close'): Promise<void> {
    this.#runtimeGenerations.set(threadId, (this.#runtimeGenerations.get(threadId) ?? 0) + 1)
    const terminalsClosed =
      reason === 'close'
        ? this.#terminals
            .closeThread(threadId)
            .catch((error) => this.#onLog(`[terminal] thread close failed: ${errorMessage(error)}`))
        : Promise.resolve()
    const entry = this.#threads.get(threadId)
    if (entry) {
      const couldSteer = this.#canSteerQueue(threadId)
      this.#threads.delete(threadId)
      this.#notifySteerChange(threadId, couldSteer)
      this.#unindexThreadRuntime(threadId, entry)
      this.#runtimeRecency.delete(threadId)
      // Detached sessions can no longer publish their sub-agents' final snapshots.
      this.#settleInterruptedLifecycles(threadId, true)
    }
    // A stopped turn's agent goes with its runtime; nothing is left to wait for.
    const settlingStop = this.#settlingStops.get(threadId)
    if (settlingStop) clearTimeout(settlingStop.timer)
    this.#settlingStops.delete(threadId)
    const providerStopped = this.#stopThreadProvider(threadId, entry?.session)
    // A session gone before its handover turn ended may never have read it.
    const handover = this.#handoverTurns.get(threadId)
    this.#handoverTurns.delete(threadId)
    if (handover && !handover.answered && !handover.carried && this.#store.thread(threadId)) {
      this.#store.rearmThreadHandover(threadId)
    }
    this.#failedCarries.delete(threadId)
    this.#idleRuntimeEligible.delete(threadId)
    this.#mcpStaleRuntimes.delete(threadId)
    this.#backgroundWorkThreads.delete(threadId)
    this.#runtimeOperationCounts.delete(threadId)
    this.#mcpOAuthThreads.delete(threadId)
    this.#threadApprovals.delete(threadId)
    this.#deleteSidebarStatus(this.#activeTurns, threadId)
    const activeTurnId = this.#activeTurnIds.get(threadId)
    this.#activeTurnIds.delete(threadId)
    this.#activeTurnStopsBefore.delete(threadId)
    if (activeTurnId) this.#serverOwnedUserTurns.delete(userTurnKey(threadId, activeTurnId))
    this.#suppressedUserItems.delete(threadId)
    this.#recordedTurnDiffs.delete(threadId)
    this.#inFlightSubmissionIds.delete(threadId)
    this.#deleteSidebarStatus(this.#startingTurns, threadId)
    this.#turnStartBarriers.get(threadId)?.release()
    this.#turnStartBarriers.delete(threadId)
    this.#pendingTurnStarts.delete(threadId)
    this.#acceptedTurnStarts.delete(threadId)
    this.#reviewingDiffs.delete(threadId)
    this.#queuedTurns.delete(threadId)
    this.#emptyQueuedTurns.delete(threadId)
    this.#drainingQueues.delete(threadId)
    return Promise.all([terminalsClosed, providerStopped]).then(() => undefined)
  }

  /**
   * Whether a session's private checkout still holds work nobody has seen.
   *
   * Asked before offering to discard it, so the choice is put to the user in
   * terms of what they would lose rather than as a routine tidy-up.
   */
  async hasUnsavedWork(threadId: string): Promise<boolean> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath) return false
    return hasUncommittedChanges(privateCheckoutPath(stored.worktreePath))
  }

  /**
   * Remove a session's private checkout.
   *
   * Refuses when the agent left uncommitted work unless `force` — which is the
   * user answering "yes, discard it", never a default. The branch is kept
   * either way; it holds whatever was committed.
   */
  async discardWorktree(threadId: string, force = false): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath || !stored.worktreeBranch) return
    const root = canonicalCheckoutRoot(stored.worktreePath)
    const worktree = {
      path: privateCheckoutPath(stored.worktreePath),
      branch: stored.worktreeBranch,
      repoPath: resolveWorkspacePath(stored.projectPath),
    }

    const assertUnshared = () => {
      const referenced =
        this.#store
          .projects()
          .some((project) => canonicalCheckoutRoot(resolveWorkspacePath(project.path)) === root) ||
        this.#store
          .threads()
          .some(
            (thread) =>
              thread.id !== threadId &&
              canonicalCheckoutRoot(
                thread.worktreePath ?? resolveWorkspacePath(thread.projectPath),
              ) === root,
          )
      if (referenced || this.#sideThreads.has(threadId))
        throw new Error(
          'This checkout is used by another project or chat. Remove those references before discarding it.',
        )
    }
    assertUnshared()
    await this.#checkoutAccess.exclusive(stored.worktreePath, async () => {
      await this.#terminals.closeThread(threadId)
      assertUnshared()
      if (!force && (await hasUncommittedChanges(worktree.path)))
        throw new WorktreeDirty(worktree.path)
      // The agent process works inside this checkout. Close the chat and wait
      // for that process to exit; a failed stop keeps the checkout in place.
      await this.close(threadId)
      await removeWorktree(worktree, force)
      this.#store.forgetWorktree(threadId)
    })
  }

  /**
   * Clear up after a crash.
   *
   * A process killed mid-session leaves git believing in checkouts that are
   * gone, and the next session on that path fails with a message about a path
   * being "already registered" — our leftovers, reported to someone who did
   * nothing wrong. Git can forget the stale registration, but the chat keeps
   * its private path so it cannot silently resume in the main project.
   */
  async recoverWorktrees(): Promise<void> {
    const repos = new Set(
      this.#store.worktrees().map((entry) => resolveWorkspacePath(entry.repoPath)),
    )
    for (const repo of repos) {
      await pruneWorktrees(repo).catch(() => undefined)
    }
  }

  async disposeAll(): Promise<void> {
    this.#disposeGeneration += 1
    this.#cancelResumingPrompts('turn cancelled by panic stop or shutdown')
    // Their git runs work in the checkouts.
    await Promise.allSettled(this.#turnDiffBuilds.values())
    this.#subagents.dispose()
    const agentToolsClosed = this.#agentTools?.close()
    this.#agentToolGrants.clear()
    const accountScopes = [...this.#accountScopes.values()]
    this.#accountScopes.clear()
    const controlStopped = Promise.all([
      this.#controls.disposeAll(),
      ...accountScopes.map((scope) => scope.controls.disposeAll()),
    ])
    this.#modelLists.dispose()
    for (const scope of accountScopes) scope.modelLists.dispose()
    this.#modelListAccounts.clear()
    const terminalsClosed = this.#terminals.closeAll()
    for (const controller of this.#voiceRequests.values()) controller.abort()
    this.#voiceRequests.clear()
    for (const [threadId, entry] of this.#threads) {
      this.#stoppingSessions.set(threadId, entry.session)
      const couldSteer = this.#canSteerQueue(threadId)
      this.#threads.delete(threadId)
      this.#notifySteerChange(threadId, couldSteer)
    }
    this.#threads.clear()
    for (const threadId of this.#stoppingSessions.keys())
      this.#settleInterruptedLifecycles(threadId, true)
    const providerStops = [...this.#stoppingSessions.keys()].map((threadId) =>
      this.#stopThreadProvider(threadId),
    )
    const stopped = Promise.allSettled([
      terminalsClosed,
      controlStopped,
      agentToolsClosed,
      ...providerStops,
    ])
    this.#recordedDeltas.flushAll()
    this.#threads.clear()
    this.#runtimeThreadIdsByProject.clear()
    this.#runtimeRecency.clear()
    this.#clearIdleRuntimeTimer()
    this.#idleRuntimeEligible.clear()
    this.#mcpStaleRuntimes.clear()
    this.#backgroundWorkThreads.clear()
    this.#runtimeOperationCounts.clear()
    this.#mcpOAuthThreads.clear()
    this.#sideThreads.clear()
    this.#sideParents.clear()
    this.#subagentParents.clear()
    this.#startingSideThreads.clear()
    this.#discardedSideThreads.clear()
    this.#activeTurns.clear()
    this.#activeTurnIds.clear()
    this.#serverOwnedUserTurns.clear()
    this.#suppressedUserItems.clear()
    this.#inFlightSubmissionIds.clear()
    this.#startingTurns.clear()
    for (const barrier of this.#turnStartBarriers.values()) barrier.release()
    this.#turnStartBarriers.clear()
    this.#pendingTurnStarts.clear()
    this.#acceptedTurnStarts.clear()
    for (const stop of this.#settlingStops.values()) clearTimeout(stop.timer)
    this.#settlingStops.clear()
    this.#reviewingDiffs.clear()
    this.#queuedTurns.clear()
    this.#emptyQueuedTurns.clear()
    this.#drainingQueues.clear()
    this.#heldQueues.clear()
    this.#resumingThreads.clear()
    this.#resumeGenerations.clear()
    this.#resumeCancels.clear()
    this.#inboxProjections.clear()
    this.#inboxProjectionsLoaded = false
    this.#staleInboxProjectionThreads.clear()
    this.#invalidateBackgroundSources()
    const failures = (await stopped).filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length)
      throw new AggregateError(
        [...new Set(failures.map((result) => result.reason))],
        'Some app processes could not be stopped',
      )
  }

  #releaseCheckoutIfIdle(threadId: string): void {
    // An agent still ending a stopped turn may still write to the checkout.
    if (
      !this.isTurnRunning(threadId) &&
      !this.#stoppingSessions.has(threadId) &&
      !this.#settlingStops.has(threadId)
    )
      this.#checkoutAccess.endTurn(threadId)
  }

  /** A start whose cleanup failed may leave its agent running; a later stop retries it. */
  #stopFailedStartup(owner: string, directory: string, error: StartupCleanupError): Promise<void> {
    this.#onLog(`[startup] agent cleanup failed: ${errorMessage(error.cleanupError)}`)
    this.#checkoutAccess.retainStopping(directory, owner)
    return this.#stopThreadProvider(owner, error.session as AgentSession)
  }

  #stopThreadProvider(threadId: string, session?: AgentSession): Promise<void> {
    if (session) this.#stoppingSessions.set(threadId, session)
    const existing = this.#runtimeStops.get(threadId)
    if (existing) return existing
    const stopping = this.#stoppingSessions.get(threadId)
    if (!stopping) {
      this.#releaseCheckoutIfIdle(threadId)
      return Promise.resolve()
    }
    const stopped = this.#disposeSession(stopping)
      .then(() => {
        if (this.#stoppingSessions.get(threadId) === stopping) {
          this.#stoppingSessions.delete(threadId)
          this.#releaseCheckoutIfIdle(threadId)
        }
      })
      .finally(() => {
        if (this.#runtimeStops.get(threadId) === stopped) this.#runtimeStops.delete(threadId)
      })
    this.#runtimeStops.set(threadId, stopped)
    return stopped
  }

  #disposeSession(session: AgentSession): Promise<void> {
    try {
      return Promise.resolve(session.dispose())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  #get(threadId: string) {
    const entry = this.#threads.get(threadId)
    if (!entry) throw new Error(`no such thread: ${threadId}`)
    return entry
  }

  /** `turnOptions` are the model options of the turn that needs the runtime, if any. */
  /** Rejects every prompt waiting on a resume now, not once its resume has ended. */
  #cancelResumingPrompts(message: string): void {
    const waiting = [...this.#resumeCancels.values()].flat()
    this.#resumeCancels.clear()
    for (const cancel of waiting) cancel(new Error(message))
  }

  async #ensureThread(threadId: string, turnOptions: TurnOptions = {}): Promise<void> {
    // What this caller may still resume for; a later Stop, Stop all or shutdown cancels it.
    const callerGeneration = this.#runtimeGenerations.get(threadId) ?? 0
    const panicGeneration = this.#panicGeneration
    const disposeGeneration = this.#disposeGeneration
    // One frame for every wait, so callers that waited out a cancelled resume take
    // the next one in the order they came.
    let waited = false
    for (;;) {
      if (this.#stoppingSessions.has(threadId)) {
        await this.#stopThreadProvider(threadId)
        waited = true
      }
      // Whatever happened during a wait decides before anything resumes.
      if (waited) {
        // A resume now would attach the session the chat leaves. First, as the move
        // itself may have ended this caller's generation.
        if (this.#changingProvider.has(threadId))
          throw new Error('This chat is moving to another provider. Send again once it has moved.')
        if (
          panicGeneration !== this.#panicGeneration ||
          disposeGeneration !== this.#disposeGeneration
        )
          throw new Error('turn cancelled by panic stop or shutdown')
        if ((this.#runtimeGenerations.get(threadId) ?? 0) !== callerGeneration)
          throw new Error('turn cancelled while resuming')
      }
      if (this.#threads.has(threadId)) return
      const generation = this.#runtimeGenerations.get(threadId) ?? 0
      const existing = this.#resumingThreads.get(threadId)
      if (!existing) {
        const pending = this.#resumeThread(threadId, turnOptions).finally(() => {
          if (this.#resumingThreads.get(threadId) === pending) {
            this.#resumingThreads.delete(threadId)
            this.#resumeGenerations.delete(threadId)
          }
          this.#pruneIdleThreadRuntimes()
        })
        this.#resumingThreads.set(threadId, pending)
        this.#resumeGenerations.set(threadId, generation)
        return pending
      }
      if (this.#resumeGenerations.get(threadId) === generation) return existing
      // A Stop cancelled that resume. It winds down on its own; this one follows it.
      await existing.catch(() => undefined)
      waited = true
    }
  }
  async #resumeThread(threadId: string, turnOptions: TurnOptions): Promise<void> {
    const generation = this.#runtimeGenerations.get(threadId) ?? 0
    const disposeGeneration = this.#disposeGeneration
    const panicGeneration = this.#panicGeneration
    const stored = this.#store.thread(threadId)
    if (!stored || stored.closedAt !== undefined) throw new Error(`no such thread: ${threadId}`)
    if (stored.worktreePath && !existsSync(stored.worktreePath)) {
      throw new Error(
        'The private checkout for this chat is missing. Restore the checkout or start a new chat.',
      )
    }

    // Its sessions live in its account's folder, so a chat resumes only there.
    const accountHome = threadAccountHome(this.#accounts, stored)
    const runtime = this.#runtimeFor(stored.provider, this.#onLog, accountHome)
    // A chat that moved and has sent nothing there yet left no conversation in
    // its new session. Some engines create theirs only at the first turn, so
    // there may be nothing to resume; a fresh session loses nothing.
    const fresh = this.#store.threadNeedsHandover(threadId)
    const resume = runtime.resume
    if (!fresh && !resume) {
      throw new Error(`${stored.provider} sessions cannot resume after TasteCode restarts yet`)
    }
    const workspacePath = stored.worktreePath ?? resolveWorkspacePath(stored.projectPath)
    const approval = this.#threadApprovals.get(threadId) ?? this.#store.threadApproval(threadId)
    const resumeState = this.#store.threadRuntimeState(threadId)
    const options: StartOptions = {
      // Opening without the turn's model options would make an engine that
      // applies them at launch (Claude effort) restart right after resuming.
      ...(turnOptions.model ? { model: turnOptions.model } : {}),
      ...(turnOptions.effort ? { effort: turnOptions.effort } : {}),
      ...(turnOptions.serviceTier ? { serviceTier: turnOptions.serviceTier } : {}),
      ...(stored.agent ? { agent: stored.agent } : {}),
      ...(approval ? { approval } : {}),
      // Side chats and sub-agents never get the agent tools: one level deep.
      ...(stored.ephemeral || !this.#offersAgentTools(stored.provider)
        ? this.#mcpRuntimeOptions(
            stored.provider,
            stored.projectPath,
            stored.ephemeral ? undefined : threadId,
          )
        : (
            await this.#agentToolsOptions(
              stored.provider,
              threadId,
              this.#mcpRuntimeOptions(stored.provider, stored.projectPath, threadId),
            )
          ).options),
      ...this.#contextRuntimeOptions(stored.provider, stored.agent, stored.accountId),
    }
    const sessionStart = this.#sessionStart(stored.provider, undefined, {
      skills: !stored.ephemeral,
      threadId: stored.ephemeral ? undefined : threadId,
    })
    let freshSessionId: string | undefined
    // The provider has no saved conversation for this chat's session. With no turn ever
    // completed there is nothing to carry; otherwise (another account's folder, a moved file)
    // the conversation goes to the new session as a handover, and the transcript says so.
    let missingSession: { carried: boolean } | undefined
    const startFresh = () =>
      runtime.start(workspacePath, { ...options, ...sessionStart }).then((started) => {
        freshSessionId = started.thread.id
        return mapProviderSession(threadId, started)
      })
    const result = await (
      fresh || !resume
        ? startFresh()
        : resume(threadId, workspacePath, {
            ...options,
            ...(stored.providerSessionId ? { providerSessionId: stored.providerSessionId } : {}),
            ...(resumeState === undefined ? {} : { resumeState }),
            ...sessionStart,
          }).catch((error: unknown) => {
            if (!isProviderSessionMissing(error)) throw error
            missingSession = { carried: !this.#store.threadHasCompletedTurn(threadId) }
            this.#onLog(
              `[resume] ${errorMessage(error)}; continuing in a new ${stored.provider} session${missingSession.carried ? '' : ' with the conversation so far'}`,
            )
            return startFresh()
          })
    ).catch((error: unknown) => {
      if (!(error instanceof StartupCleanupError)) throw error
      void this.#stopFailedStartup(threadId, workspacePath, error).catch((stopError: unknown) =>
        this.#onLog(`[startup] agent still not stopped: ${errorMessage(stopError)}`),
      )
      throw error.startError
    })
    if (result.thread.id !== threadId) {
      this.#checkoutAccess.retainStopping(workspacePath, threadId)
      await this.#stopThreadProvider(threadId, result.session)
      throw new Error(`provider resumed unexpected thread ${result.thread.id}`)
    }
    // The thread may have been closed while the provider was resuming; a
    // late attach would leave a zombie agent process nobody can reach.
    const current = this.#store.thread(threadId)
    if (panicGeneration !== this.#panicGeneration) {
      this.#checkoutAccess.retainStopping(workspacePath, threadId)
      await this.#stopThreadProvider(threadId, result.session)
      throw new Error('turn cancelled by panic stop')
    }
    if (
      disposeGeneration !== this.#disposeGeneration ||
      !current ||
      current.closedAt !== undefined
    ) {
      this.#checkoutAccess.retainStopping(workspacePath, threadId)
      await this.#stopThreadProvider(threadId, result.session)
      throw new Error(`thread ${threadId} was closed while resuming`)
    }
    if ((this.#runtimeGenerations.get(threadId) ?? 0) !== generation) {
      this.#checkoutAccess.retainStopping(workspacePath, threadId)
      await this.#stopThreadProvider(threadId, result.session)
      throw new Error('turn cancelled while resuming')
    }
    if (freshSessionId !== undefined) {
      // The session it replaces never ran a turn; it stays the chat's own.
      this.#store.moveThreadToProvider(threadId, {
        provider: stored.provider,
        ...(stored.agent ? { agent: stored.agent } : {}),
        ...(stored.accountId ? { accountId: stored.accountId } : {}),
        providerSessionId: freshSessionId,
        // A pending handover stays pending; a missing session with turns starts one.
        ...(missingSession?.carried ? { carried: true } : {}),
      })
    }
    this.#attachThread(
      onAccount(result.thread, stored.accountId),
      result.session,
      stored.projectPath,
      runtime.resume !== undefined,
    )
    if (missingSession && !missingSession.carried) {
      this.#record(threadId, {
        type: 'item.completed',
        item: {
          id: `notice-${crypto.randomUUID()}`,
          turnId: '',
          type: 'notice',
          status: 'completed',
          notice: {
            kind: 'provider',
            provider: stored.provider,
            ...(stored.agent ? { agent: stored.agent } : {}),
            ...(stored.accountId && stored.accountId !== DEFAULT_ACCOUNT_ID
              ? { accountId: stored.accountId }
              : {}),
            reason: 'session_missing',
          },
          createdAt: Date.now(),
        },
      })
    }
    // A resumed Side chat must rejoin its stream: the runtime routing maps
    // only cover threads created by this process, while the side-chat linkage
    // survives in the store across an orchestrator restart.
    if (stored.ownerThreadId !== undefined) {
      this.#subagentParents.set(threadId, stored.ownerThreadId)
    } else if (stored.ephemeral && stored.parentThreadId !== undefined) {
      this.#sideParents.set(threadId, stored.parentThreadId)
      if (!this.#sideThreads.has(stored.parentThreadId)) {
        this.#sideThreads.set(stored.parentThreadId, threadId)
      }
    }
    this.#markIdleRuntimeEligible(threadId)
  }

  #acceptTurnStart(threadId: string, turnId: string, pendingStart: PendingTurnStart): void {
    if (this.#pendingTurnStarts.get(threadId) !== pendingStart) return
    this.#pendingTurnStarts.delete(threadId)
    this.#activeTurnIds.set(threadId, turnId)
    this.#activeTurnStopsBefore.set(threadId, pendingStart.stopsBefore)
    const starts = this.#acceptedTurnStarts.get(threadId) ?? new Map<string, PendingTurnStart>()
    starts.set(turnId, pendingStart)
    this.#acceptedTurnStarts.set(threadId, starts)
    if (pendingStart.submission) {
      this.#recordUserSubmission(threadId, turnId, pendingStart.submission)
    }
  }

  #beginTurnStart(threadId: string, submission?: UserSubmission): PendingTurnStart {
    const sentAt = this.#resumedPromptSentAt.get(threadId)
    this.#resumedPromptSentAt.delete(threadId)
    // A prompt on its way since before a Stop counts from when it was sent.
    const tracked = this.#submissionStops.getStore()
    const pending = {
      acceptedAt: sentAt ?? Date.now(),
      ...(submission ? { submission } : {}),
      stopsBefore:
        tracked?.threadId === threadId
          ? tracked.stopRequests
          : (this.#stopRequests.get(threadId) ?? 0),
    }
    this.#pendingTurnStarts.set(threadId, pending)
    return pending
  }

  #forgetPendingTurnStart(threadId: string, pending: PendingTurnStart): void {
    if (this.#pendingTurnStarts.get(threadId) === pending) {
      this.#pendingTurnStarts.delete(threadId)
    }
  }

  #deleteAcceptedTurnStart(threadId: string, turnId: string): void {
    const starts = this.#acceptedTurnStarts.get(threadId)
    if (!starts) return
    starts.delete(turnId)
    if (starts.size === 0) this.#acceptedTurnStarts.delete(threadId)
  }

  #assertFreshSubmissionId(threadId: string, clientSubmissionId: string): void {
    const pending = this.#pendingTurnStarts.get(threadId)?.submission?.id === clientSubmissionId
    let accepted = false
    for (const start of this.#acceptedTurnStarts.get(threadId)?.values() ?? []) {
      if (start.submission?.id !== clientSubmissionId) continue
      accepted = true
      break
    }
    const queued = this.#queueEntries(threadId).some(
      (turn) => turn.clientSubmissionId === clientSubmissionId,
    )
    const inFlight = this.#inFlightSubmissionIds.get(threadId)?.has(clientSubmissionId)
    if (
      pending ||
      accepted ||
      queued ||
      inFlight ||
      this.#store.hasQueuedSubmission(threadId, clientSubmissionId) ||
      this.#store.hasUserSubmission(threadId, clientSubmissionId)
    ) {
      throw new Error(`clientSubmissionId "${clientSubmissionId}" was already used for this thread`)
    }
  }

  #handleSessionEvent(threadId: string, event: DomainEvent): void {
    this.#watchHandoverTurn(threadId, event)
    const suppressedUserItems = this.#suppressedUserItems.get(threadId)
    if (event.type === 'item.delta' && suppressedUserItems?.has(event.itemId)) return
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.type === 'message' &&
      event.item.role === 'user' &&
      (this.#serverOwnedUserTurns.has(userTurnKey(threadId, event.item.turnId)) ||
        this.#pendingTurnStarts.get(threadId)?.submission !== undefined ||
        this.#acceptedTurnStarts.get(threadId)?.get(event.item.turnId)?.submission !== undefined)
    ) {
      if (event.type === 'item.started') {
        const itemIds = suppressedUserItems ?? new Set<string>()
        itemIds.add(event.item.id)
        this.#suppressedUserItems.set(threadId, itemIds)
      } else {
        suppressedUserItems?.delete(event.item.id)
      }
      return
    }
    this.#record(threadId, event)
  }

  /** Drop per-project watch state when a project leaves the sidebar. */
  forgetProject(projectPath: string): void {
    const resolved = resolveWorkspacePath(projectPath)
    this.#projectGenerations.set(resolved, (this.#projectGenerations.get(resolved) ?? 0) + 1)
    void this.#terminals
      .closeThread(projectTerminalKey(projectPath))
      .catch((error) => this.#onLog(`[terminal] project close failed: ${errorMessage(error)}`))
    this.#controls.forgetProject(projectPath)
  }

  // This map is the release-candidate LRU, not an index of every attached
  // thread. Adding fresh or non-resumable sessions makes each attach scan the
  // whole live thread set and turns a many-thread start into quadratic work.
  #markIdleRuntimeEligible(threadId: string): void {
    if (!this.#threads.get(threadId)?.resumable) {
      this.#idleRuntimeEligible.delete(threadId)
      this.#runtimeRecency.delete(threadId)
      return
    }
    this.#idleRuntimeEligible.add(threadId)
    this.#touchThreadRuntime(threadId)
  }

  #touchThreadRuntime(threadId: string): void {
    const entry = this.#threads.get(threadId)
    if (!entry?.resumable || !this.#idleRuntimeEligible.has(threadId)) {
      this.#runtimeRecency.delete(threadId)
      return
    }
    this.#runtimeRecency.delete(threadId)
    this.#runtimeRecency.set(threadId, performance.now())
  }

  async #withThreadRuntimeOperation<T>(
    threadId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.#runtimeOperationCounts.set(
      threadId,
      (this.#runtimeOperationCounts.get(threadId) ?? 0) + 1,
    )
    this.#touchThreadRuntime(threadId)
    try {
      return await operation()
    } finally {
      const remaining = (this.#runtimeOperationCounts.get(threadId) ?? 1) - 1
      if (remaining === 0) this.#runtimeOperationCounts.delete(threadId)
      else this.#runtimeOperationCounts.set(threadId, remaining)
      this.#pruneIdleThreadRuntimes()
    }
  }

  #canReleaseIdleRuntime(threadId: string, queuedThreadIds: ReadonlySet<string>): boolean {
    const entry = this.#threads.get(threadId)
    return Boolean(
      entry?.resumable &&
      this.#idleRuntimeEligible.has(threadId) &&
      !queuedThreadIds.has(threadId) &&
      !this.#sideParents.has(threadId) &&
      !this.#startingSideThreads.has(threadId) &&
      !this.#runtimeOperationCounts.has(threadId) &&
      !this.#mcpOAuthThreads.has(threadId) &&
      !this.#backgroundWorkThreads.has(threadId) &&
      !this.#activeTurns.has(threadId) &&
      !this.#startingTurns.has(threadId) &&
      !this.#turnStartBarriers.has(threadId) &&
      !this.#pendingTurnStarts.has(threadId) &&
      !this.#acceptedTurnStarts.has(threadId) &&
      !this.#settlingStops.has(threadId) &&
      !this.#inFlightSubmissionIds.has(threadId) &&
      !this.#restoringThreads.has(threadId) &&
      !this.#reviewingDiffs.has(threadId) &&
      !this.#drainingQueues.has(threadId) &&
      !this.#resumingThreads.has(threadId),
    )
  }

  #releaseIdleRuntime(threadId: string): void {
    const entry = this.#threads.get(threadId)
    if (!entry) return
    const couldSteer = this.#canSteerQueue(threadId)
    this.#threads.delete(threadId)
    this.#notifySteerChange(threadId, couldSteer)
    this.#settleInterruptedLifecycles(threadId, true)
    this.#unindexThreadRuntime(threadId, entry)
    this.#runtimeRecency.delete(threadId)
    this.#idleRuntimeEligible.delete(threadId)
    this.#mcpStaleRuntimes.delete(threadId)
    this.#backgroundWorkThreads.delete(threadId)
    // The tracked stop path keeps a failed stop for shutdown to retry, and a
    // resume waits for it rather than starting a second process alongside.
    void this.#stopThreadProvider(threadId, entry.session).catch((error) =>
      this.#onLog(`Could not stop idle agent: ${errorMessage(error)}`),
    )
  }

  #clearIdleRuntimeTimer(): void {
    clearTimeout(this.#idleRuntimeTimer)
    this.#idleRuntimeTimer = undefined
    this.#idleRuntimeTimerExpiresAt = undefined
  }

  #hasIdleRuntimeReleaseBlockers(queuedThreadIds: ReadonlySet<string>): boolean {
    // Keep this conservative list in sync with #canReleaseIdleRuntime. A false
    // positive only uses the slower scan; a false negative could evict work.
    return (
      queuedThreadIds.size > 0 ||
      this.#sideParents.size > 0 ||
      this.#startingSideThreads.size > 0 ||
      this.#runtimeOperationCounts.size > 0 ||
      this.#mcpOAuthThreads.size > 0 ||
      this.#backgroundWorkThreads.size > 0 ||
      this.#activeTurns.size > 0 ||
      this.#startingTurns.size > 0 ||
      this.#turnStartBarriers.size > 0 ||
      this.#pendingTurnStarts.size > 0 ||
      this.#acceptedTurnStarts.size > 0 ||
      this.#settlingStops.size > 0 ||
      this.#inFlightSubmissionIds.size > 0 ||
      this.#restoringThreads.size > 0 ||
      this.#reviewingDiffs.size > 0 ||
      this.#drainingQueues.size > 0 ||
      this.#resumingThreads.size > 0
    )
  }

  #scheduleIdleRuntimeExpiry(nextExpiresAt: number, now: number): void {
    // A timer that fires sooner is still safe. Keep it and recompute once at
    // that boundary instead of creating and cancelling a timer for every
    // completion in a many-thread event burst.
    if (
      this.#idleRuntimeTimer !== undefined &&
      this.#idleRuntimeTimerExpiresAt !== undefined &&
      this.#idleRuntimeTimerExpiresAt <= nextExpiresAt
    ) {
      return
    }
    this.#clearIdleRuntimeTimer()
    this.#idleRuntimeTimerExpiresAt = nextExpiresAt
    this.#idleRuntimeTimer = setTimeout(
      () => {
        this.#idleRuntimeTimer = undefined
        this.#idleRuntimeTimerExpiresAt = undefined
        this.#pruneIdleThreadRuntimesInBackground()
      },
      Math.max(1, nextExpiresAt - now),
    )
    this.#idleRuntimeTimer.unref?.()
  }

  #scheduleIdleRuntimePrune(): void {
    if (this.#idleRuntimePruneScheduled) return
    this.#idleRuntimePruneScheduled = true
    queueMicrotask(() => {
      if (!this.#idleRuntimePruneScheduled) return
      this.#idleRuntimePruneScheduled = false
      this.#pruneIdleThreadRuntimesInBackground()
    })
  }

  /** Timer and microtask callbacks have no caller to report to; a throw there would crash the server. */
  #pruneIdleThreadRuntimesInBackground(): void {
    try {
      this.#pruneIdleThreadRuntimes()
    } catch (error) {
      this.#onLog(`Could not release idle agents: ${errorMessage(error)}`)
      const now = performance.now()
      this.#scheduleIdleRuntimeExpiry(now + IDLE_RUNTIME_PRUNE_RETRY_MS, now)
    }
  }

  #pruneIdleThreadRuntimes(): void {
    this.#idleRuntimePruneScheduled = false
    if (this.#runtimeRecency.size === 0) {
      this.#clearIdleRuntimeTimer()
      return
    }
    const queuedThreadIds = this.#store.queuedThreadIds()
    for (const [threadId, session] of this.#mcpStaleRuntimes) {
      if (this.#threads.get(threadId)?.session !== session) {
        this.#mcpStaleRuntimes.delete(threadId)
      } else if (this.#canReleaseIdleRuntime(threadId, queuedThreadIds)) {
        this.#releaseIdleRuntime(threadId)
      }
    }
    const now = performance.now()

    // The normal idle state has no release blockers. Map insertion order is
    // the LRU order, so expiry and capacity pruning only need the oldest rows.
    // Avoid rebuilding and rescanning the retained candidate list for every
    // completion in a large burst.
    if (!this.#hasIdleRuntimeReleaseBlockers(queuedThreadIds)) {
      let oldest = this.#runtimeRecency.entries().next().value
      while (
        oldest &&
        (oldest[1] + this.#idleThreadRuntimeMs <= now ||
          this.#runtimeRecency.size > this.#maxIdleThreadRuntimes)
      ) {
        this.#releaseIdleRuntime(oldest[0])
        oldest = this.#runtimeRecency.entries().next().value
      }
      if (!oldest) {
        this.#clearIdleRuntimeTimer()
        return
      }
      this.#scheduleIdleRuntimeExpiry(oldest[1] + this.#idleThreadRuntimeMs, now)
      return
    }

    const retained: Array<{ threadId: string; expiresAt: number }> = []
    for (const [threadId, touchedAt] of this.#runtimeRecency) {
      if (!this.#canReleaseIdleRuntime(threadId, queuedThreadIds)) continue
      const expiresAt = touchedAt + this.#idleThreadRuntimeMs
      if (expiresAt <= now) this.#releaseIdleRuntime(threadId)
      else retained.push({ threadId, expiresAt })
    }

    const releaseCount = Math.max(0, retained.length - this.#maxIdleThreadRuntimes)
    for (let index = 0; index < releaseCount; index += 1) {
      this.#releaseIdleRuntime(retained[index]!.threadId)
    }

    let nextExpiresAt = Number.POSITIVE_INFINITY
    for (let index = releaseCount; index < retained.length; index += 1) {
      nextExpiresAt = Math.min(nextExpiresAt, retained[index]!.expiresAt)
    }
    if (!Number.isFinite(nextExpiresAt)) {
      this.#clearIdleRuntimeTimer()
      return
    }
    this.#scheduleIdleRuntimeExpiry(nextExpiresAt, now)
  }

  #indexThreadRuntime(threadId: string, entry: AttachedThreadRuntime): void {
    let projects = this.#runtimeThreadIdsByProject.get(entry.thread.provider)
    if (!projects) {
      projects = new Map()
      this.#runtimeThreadIdsByProject.set(entry.thread.provider, projects)
    }
    let threadIds = projects.get(entry.projectPath)
    if (!threadIds) {
      threadIds = new Set()
      projects.set(entry.projectPath, threadIds)
    }
    threadIds.add(threadId)
  }

  #unindexThreadRuntime(threadId: string, entry: AttachedThreadRuntime): void {
    const projects = this.#runtimeThreadIdsByProject.get(entry.thread.provider)
    const threadIds = projects?.get(entry.projectPath)
    if (!projects || !threadIds) return
    threadIds.delete(threadId)
    if (threadIds.size === 0) projects.delete(entry.projectPath)
    if (projects.size === 0) this.#runtimeThreadIdsByProject.delete(entry.thread.provider)
  }

  #attachThread(
    thread: Thread,
    session: AgentSession,
    projectPath: string,
    resumable: boolean,
    worktree?: Worktree,
  ): void {
    // A racing double-attach must not silently drop the previous session's
    // process — dispose it before overwriting.
    const couldSteer = this.#canSteerQueue(thread.id)
    const previous = this.#threads.get(thread.id)
    if (previous) {
      this.#threads.delete(thread.id)
      this.#settleInterruptedLifecycles(thread.id, true)
    }
    if (previous)
      void this.#disposeSession(previous.session).catch((error) =>
        this.#onLog(`Could not stop replaced agent: ${errorMessage(error)}`),
      )
    if (
      previous &&
      (previous.thread.provider !== thread.provider || previous.projectPath !== projectPath)
    ) {
      this.#unindexThreadRuntime(thread.id, previous)
    }
    const entry: AttachedThreadRuntime = {
      thread,
      session,
      projectPath,
      resumable: resumable && session.resumable !== false,
      ...(worktree ? { worktree } : {}),
    }
    this.#threads.set(thread.id, entry)
    this.#indexThreadRuntime(thread.id, entry)
    this.#touchThreadRuntime(thread.id)
    session.onMcpOAuth?.((result) => {
      if (this.#threads.get(thread.id)?.session !== session) return
      this.#onMcpOAuth(thread.provider, projectPath, result)
      this.#finishMcpOAuth(thread.id, result.loginId)
    })
    // A chat's usage and live limit windows are its account's.
    const accountControls = this.#threadScope(thread)?.controls
    session.onUsageChanged?.(() => {
      if (this.#threads.get(thread.id)?.session === session) {
        accountControls?.usageChanged(thread.provider)
      }
    })
    session.onLimitsUpdated?.((limits) => {
      if (this.#threads.get(thread.id)?.session === session) {
        accountControls?.applyLimitRows(thread.provider, limits)
      }
    })
    session.onMcpChanged?.(() => {
      if (this.#threads.get(thread.id)?.session === session && this.#store.thread(thread.id)) {
        this.#onMcpChanged(thread.provider, projectPath)
      }
    })
    session.onCommandsChanged?.(() => {
      if (this.#threads.get(thread.id)?.session === session && this.#store.thread(thread.id)) {
        this.#onCommandsChanged(thread.provider, projectPath)
      }
    })
    // A replaced session's background work ended with its process.
    this.#backgroundWorkThreads.delete(thread.id)
    session.onBackgroundWorkChanged?.(() => {
      if (this.#threads.get(thread.id)?.session !== session) return
      if (session.hasBackgroundWork?.() === true) {
        this.#backgroundWorkThreads.add(thread.id)
        return
      }
      if (!this.#backgroundWorkThreads.delete(thread.id)) return
      // The idle window starts when the work ends, not when the turn that started it did.
      this.#touchThreadRuntime(thread.id)
      this.#scheduleIdleRuntimePrune()
    })
    session.onDisconnected?.(() => {
      if (this.#threads.get(thread.id)?.session !== session || !this.#store.thread(thread.id)) {
        return
      }
      // A terminal event can claim the next queued prompt before disconnect
      // arrives. Return that unaccepted prompt before removing its runtime.
      const draining = this.#drainingQueues.get(thread.id)
      if (draining) this.#store.restoreQueuedTurn(thread.id, draining.queueId)
      this.#recordedDeltas.flush(thread.id)
      const stopped = this.#disposeThreadRuntime(thread.id, 'disconnect')
      void this.#resumeQueuedAfterDisconnect(thread.id, stopped)
    })
    session.onProviderSessionId?.((providerSessionId) => {
      // A disposed provider may still flush its terminal frame. Only the
      // session currently attached to this TasteCode thread may rotate the
      // persisted resume identity.
      if (this.#threads.get(thread.id)?.session === session) {
        this.#store.setProviderSessionId(thread.id, providerSessionId)
        if (this.#isSideThread(thread.id)) this.#saveSideHistoryTombstone(thread, providerSessionId)
        else if (this.#subagentParents.has(thread.id))
          this.#saveSubagentHistoryRecord(thread, providerSessionId)
      }
    })
    session.on('event', (event) => {
      if (this.#threads.get(thread.id)?.session === session && this.#store.thread(thread.id)) {
        if (event.type === 'turn.completed' && session.snapshot) {
          this.#store.saveThreadRuntimeState(thread.id, session.snapshot())
        }
        if (this.#settlingStopEvent(thread.id, event)) return
        this.#handleSessionEvent(thread.id, event)
      }
    })
    if (session.snapshot) this.#store.saveThreadRuntimeState(thread.id, session.snapshot())
    this.#notifySteerChange(thread.id, couldSteer)
    this.#pruneIdleThreadRuntimes()
  }

  async #resumeQueuedAfterDisconnect(
    threadId: string,
    stopped: Promise<void>,
    /** A held prompt the user picked to go first. */
    sendFirst?: string,
  ): Promise<void> {
    const panic = this.#panicGeneration
    const dispose = this.#disposeGeneration
    let stops: number | undefined
    try {
      await stopped
      if (
        panic !== this.#panicGeneration ||
        dispose !== this.#disposeGeneration ||
        this.#panicStopping ||
        !this.#hasQueuedTurns(threadId) ||
        // A Stop held them, so they wait for the user; no process is started for them.
        this.#heldQueues.has(threadId) ||
        !this.#store.thread(threadId) ||
        this.#store.thread(threadId)?.closedAt !== undefined
      )
        return
      stops = this.#resumeStops.get(threadId) ?? 0
      await this.#ensureThread(threadId)
      if (panic === this.#panicGeneration && dispose === this.#disposeGeneration)
        await this.#drainQueue(threadId, sendFirst)
    } catch (error) {
      if (panic !== this.#panicGeneration || dispose !== this.#disposeGeneration) return
      // A Stop ended the resume and held the queue; it waits for the user, or goes
      // behind the prompt they sent since, which already released the hold.
      if (this.#heldQueues.has(threadId)) return
      if (stops !== undefined && (this.#resumeStops.get(threadId) ?? 0) !== stops) return
      this.#onLog(`Could not resume queued prompts: ${errorMessage(error)}`)
      if (this.#store.thread(threadId) && this.#hasQueuedTurns(threadId)) {
        this.#record(threadId, {
          type: 'thread.error',
          threadId,
          message: `Could not resume queued prompts: ${errorMessage(error)}. They remain queued; retry or remove them.`,
        })
      }
    }
  }
}
