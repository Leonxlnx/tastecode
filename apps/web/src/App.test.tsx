// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  methods,
  type DomainEvent,
  type Model,
  type ModelConnection,
  type ParamsOf,
  type QueuedTurn,
  type ResultOf,
} from '@harness/contracts'
import { StrictMode, type ComponentProps } from 'react'
import { z } from 'zod'
import { ACCOUNT_CHECK_SEND_GRACE_MS, App, resolveSendAvailability, titleFrom } from './App.js'
import type { NativeMenuAction, NativeMenuActionSource } from './bridge.js'
import { DESIGN_BRIEF_ATTACHMENT } from './design-agent/briefing.js'
import { serializeModelCatalogCache as serializeCatalogWithinLimits } from './model-catalog-cache.js'
import { choicesFor, type ModelChoice } from './model-catalog.js'
import { parseModelVisibility, type ModelVisibilityRecord } from './model-catalog-visibility.js'
import { KEYBINDING_DEFINITIONS, type Shortcut } from './shortcuts.js'
import { TERMINAL_PLACEMENT_KEY } from './terminal-placement.js'
import { IndeterminateRequestError, type ConnectionState, type Transport } from './transport.js'
import { resetInstalls } from './provider-install.js'
import { providerUpdatesStore } from './provider-updates.js'
import { mockKeyboardModifierState } from './test-keyboard.js'
import { NEWEST_HISTORY_TURNS } from './thread-controller.js'

const NEWEST_PAGE = { turnLimit: NEWEST_HISTORY_TURNS }
const PENDING_CHAT_DELETES_KEY = 'harness.pendingChatDeletes.v1'

beforeEach(mockKeyboardModifierState)

const SessionOrderSchema = z.record(z.string(), z.array(z.string()))
type TestRequest = (method: string, params: unknown) => unknown | Promise<unknown>
type ServerProject = ResultOf<'projects.list'>['projects'][number]
type ServerSession = ServerProject['sessions'][number]
type ServerProvider = ResultOf<'providers.list'>['providers'][number]
type SidebarSettings = ResultOf<'sidebar.settings'>
type TestServerSession = Pick<ServerSession, 'id'> & Partial<Omit<ServerSession, 'id'>>
interface TestServerProject extends Omit<ServerProject, 'sessions'> {
  sessions: TestServerSession[]
}
interface TestServerProvider extends Omit<
  Partial<ServerProvider>,
  'id' | 'displayName' | 'capabilities'
> {
  id: ServerProvider['id']
  displayName: string
  capabilities?: Partial<NonNullable<ServerProvider['capabilities']>>
}

const ASSIGNED_DEFAULT_SHORTCUTS: Array<{ label: string; shortcut: Shortcut }> =
  KEYBINDING_DEFINITIONS.flatMap((definition) =>
    definition.defaultShortcut
      ? [{ label: definition.label, shortcut: { ...definition.defaultShortcut } }]
      : [],
  )

const transport = vi.hoisted(() => ({
  request: vi.fn<TestRequest>(),
  listeners: new Map<string, (data: unknown) => void>(),
  stateListeners: new Set<(state: ConnectionState) => void>(),
  sequenceGapListeners: new Set<(expected: number, received: number) => void>(),
  urls: new Array<string>(),
  /** The app's own connection, for stores keyed by it. */
  instance: undefined as object | undefined,
  state: 'open' as ConnectionState,
  connect: vi.fn(),
  close: vi.fn(),
  ensureHealthy: vi.fn(() => Promise.resolve()),
}))

const shellRenders = vi.hoisted(() => ({
  composer: vi.fn(),
  sidebar: vi.fn(),
  stageHeader: vi.fn(),
  threadFrame: vi.fn(),
}))

const utilityRenders = vi.hoisted(() => ({
  commandPalette: vi.fn(),
  sessionSearch: vi.fn(),
  settings: vi.fn(),
  terminalPane: vi.fn(),
}))

const appRenders = vi.hoisted(() => vi.fn())
const highlighterHighlight = vi.hoisted(() => vi.fn(() => ({ tokens: [] })))
const desktopShell = vi.hoisted(() => ({ enabled: false }))
const shortcutPlatform = vi.hoisted(() => ({ macOS: true }))
const nativeMenu = vi.hoisted(() => ({
  listener: undefined as
    ((action: NativeMenuAction, source?: NativeMenuActionSource) => void) | undefined,
  syncShortcuts: vi.fn(),
}))
type ThreadProps = ComponentProps<(typeof import('./ui/Thread.js'))['Thread']>
interface ThreadCallbacks {
  decideApproval: ThreadProps['onDecide'] | undefined
  answerUserInput: ThreadProps['onAnswerUserInput'] | undefined
  undoChanges: ThreadProps['onUndoChanges'] | undefined
  threadId: ThreadProps['threadId']
  searchJump: ThreadProps['searchJump']
  searchJumpDone: ThreadProps['onSearchJumpDone']
  editMessage?: ThreadProps['onEditMessage'] | undefined
}
const threadCallbacks = vi.hoisted<ThreadCallbacks>(() => ({
  decideApproval: undefined,
  answerUserInput: undefined,
  undoChanges: undefined,
  threadId: undefined,
  searchJump: undefined,
  searchJumpDone: undefined,
}))
const pickFolder = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>())
const droppedProjectFolderPaths = vi.hoisted(() =>
  vi.fn<(files: ArrayLike<File>) => Promise<string[]>>(),
)

vi.mock('./transport.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./transport.js')>()
  return {
    ...original,
    Transport: class {
      constructor(url: string) {
        transport.urls.push(url)
        transport.instance = this
      }
      get state() {
        return transport.state
      }
      connect() {
        transport.connect()
      }
      close() {
        transport.close()
      }
      ensureHealthy() {
        return transport.ensureHealthy()
      }
      on(channel: string, listener: (data: unknown) => void) {
        transport.listeners.set(channel, listener)
        return () => transport.listeners.delete(channel)
      }
      onState(listener: (state: ConnectionState) => void) {
        transport.stateListeners.add(listener)
        return () => transport.stateListeners.delete(listener)
      }
      onSequenceGap(listener: (expected: number, received: number) => void) {
        transport.sequenceGapListeners.add(listener)
        return () => transport.sequenceGapListeners.delete(listener)
      }
      request(method: string, params: unknown) {
        return transport.request(method, params)
      }
    },
  }
})

vi.mock('./ui/highlighter.js', () => {
  const plugin = {
    type: 'code-highlighter',
    name: 'test-highlighter',
    getSupportedLanguages: () => [],
    getThemes: () => [],
    supportsLanguage: () => true,
    highlight: highlighterHighlight,
  }
  return {
    shikiPlugin: plugin,
  }
})

// App tests exercise session routing, while Thread's own tests cover its
// virtualized renderer. happy-dom intentionally renders no virtual rows.
vi.mock('./ui/Thread.js', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    Thread: (props: ThreadProps) => {
      const frame = useSyncExternalStore(
        props.frameStore.subscribe,
        props.frameStore.getSnapshot,
        props.frameStore.getSnapshot,
      )
      const { items, liveItems } = frame
      shellRenders.threadFrame(frame)
      return (
        <div
          data-testid="thread"
          data-started-at={frame.activeTurn?.startedAt}
          ref={() => {
            threadCallbacks.decideApproval = props.onDecide
            threadCallbacks.answerUserInput = props.onAnswerUserInput
            threadCallbacks.undoChanges = props.onUndoChanges
            threadCallbacks.threadId = props.threadId
            threadCallbacks.searchJump = props.searchJump
            threadCallbacks.searchJumpDone = props.onSearchJumpDone
            threadCallbacks.editMessage = props.onEditMessage
          }}
        >
          {items.map((base, index) => (
            <span key={base.id} data-item-id={base.id}>
              {liveItems?.get(index)?.item.text ?? base.text}
            </span>
          ))}
          {frame.running && !props.stopping && frame.activeTurn ? <span>Working</span> : null}
          {props.loadFailure !== undefined ? (
            <button type="button" onClick={props.onRetryLoad}>
              Retry loading: {props.loadFailure}
            </button>
          ) : null}
        </div>
      )
    },
  }
})

vi.mock('./ui/Sidebar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Sidebar.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    Sidebar: memo((props: ComponentProps<typeof original.Sidebar>) => {
      shellRenders.sidebar(props)
      return <original.Sidebar {...props} />
    }),
  }
})

vi.mock('./ui/Composer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Composer.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    Composer: memo((props: ComponentProps<typeof original.Composer>) => {
      shellRenders.composer(props)
      return <original.Composer {...props} />
    }),
  }
})

vi.mock('./ui/StageHeader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/StageHeader.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    StageHeader: memo((props: ComponentProps<typeof original.StageHeader>) => {
      shellRenders.stageHeader(props)
      return <original.StageHeader {...props} />
    }),
  }
})

vi.mock('./ui/CommandPalette.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/CommandPalette.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    CommandPalette: memo((props: ComponentProps<typeof original.CommandPalette>) => {
      utilityRenders.commandPalette()
      return <original.CommandPalette {...props} />
    }),
  }
})

vi.mock('./ui/Settings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Settings.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    Settings: memo((props: ComponentProps<typeof original.Settings>) => {
      utilityRenders.settings()
      return <original.Settings {...props} />
    }),
  }
})

vi.mock('./ui/SessionSearch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/SessionSearch.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    SessionSearch: memo((props: ComponentProps<typeof original.SessionSearch>) => {
      utilityRenders.sessionSearch()
      return <original.SessionSearch {...props} />
    }),
  }
})

vi.mock('./ui/TerminalPane.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/TerminalPane.js')>()
  const { memo } = await import('react')
  return {
    ...original,
    TerminalPane: memo((props: ComponentProps<typeof original.TerminalPane>) => {
      utilityRenders.terminalPane()
      return (
        <div
          data-testid="terminal-pane"
          className={props.mode === 'workspace' ? 'terminal-pane--workspace' : undefined}
        >
          {props.threadId ?? props.projectPath}
        </div>
      )
    }),
  }
})

vi.mock('./bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge.js')>()),
  canDropProjectFolders: true,
  droppedProjectFolderPaths,
  get isDesktop() {
    return desktopShell.enabled
  },
  pickFolder,
  syncNativeMenuShortcuts: nativeMenu.syncShortcuts,
  onNativeMenuAction: (
    listener: (action: NativeMenuAction, source?: NativeMenuActionSource) => void,
  ) => {
    nativeMenu.listener = listener
    return () => {
      if (nativeMenu.listener === listener) nativeMenu.listener = undefined
    }
  },
  isMacOS: () => {
    appRenders()
    return shortcutPlatform.macOS
  },
}))

vi.mock('./voice-capability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./voice-capability.js')>()),
  canCaptureVoice: () => true,
}))

/** What the server reports. Projects live there now, not in localStorage. */
let serverProjects: TestServerProject[] = []
let serverProviders: TestServerProvider[] = []
let serverUnsavedWork = { isolated: false, uncommitted: false }
let serverSidebarSettings: SidebarSettings = { mode: 'classic', autoSettleDays: 3 }

function serverSession(input: TestServerSession): ServerSession {
  return {
    title: input.id,
    provider: 'codex',
    createdAt: 0,
    running: false,
    ...input,
  }
}

function serverProject(
  path: string,
  name: string,
  sessions: TestServerSession[] = [],
): TestServerProject {
  return {
    path,
    name,
    pinned: false,
    createdAt: 0,
    sessions,
  }
}

function contractValidServerProjects(): ServerProject[] {
  return serverProjects.map((project) => ({
    ...project,
    sessions: project.sessions.map(serverSession),
  }))
}

function contractValidServerProviders(): ServerProvider[] {
  return serverProviders.map(({ capabilities, ...provider }) => {
    const result: ServerProvider = {
      installed: true,
      auth: 'authenticated',
      ...provider,
    }
    if (capabilities) {
      result.capabilities = {
        steer: false,
        fork: false,
        interrupt: false,
        reasoningItems: false,
        approvals: false,
        images: false,
        ...capabilities,
      }
    }
    return result
  })
}

beforeEach(() => {
  shortcutPlatform.macOS = true
  desktopShell.enabled = false
  pickFolder.mockReset().mockResolvedValue(undefined)
  droppedProjectFolderPaths.mockReset().mockResolvedValue([])
  nativeMenu.listener = undefined
  nativeMenu.syncShortcuts.mockClear()
  appRenders.mockClear()
  shellRenders.composer.mockClear()
  shellRenders.sidebar.mockClear()
  shellRenders.stageHeader.mockClear()
  shellRenders.threadFrame.mockClear()
  utilityRenders.commandPalette.mockClear()
  utilityRenders.sessionSearch.mockClear()
  utilityRenders.settings.mockClear()
  utilityRenders.terminalPane.mockClear()
  transport.listeners.clear()
  transport.stateListeners.clear()
  transport.sequenceGapListeners.clear()
  transport.urls.length = 0
  threadCallbacks.decideApproval = undefined
  threadCallbacks.answerUserInput = undefined
  threadCallbacks.threadId = undefined
  threadCallbacks.searchJump = undefined
  threadCallbacks.searchJumpDone = undefined
  window.location.hash = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('dark')
  localStorage.clear()
  localStorage.setItem('harness.provider', 'codex')
  serverProjects = [
    {
      path: '/work/project',
      name: 'project',
      pinned: false,
      createdAt: 0,
      sessions: [
        {
          id: 'untouched-thread',
          title: 'New session',
          provider: 'codex',
          createdAt: 0,
          running: false,
        },
      ],
    },
  ]
  serverUnsavedWork = { isolated: false, uncommitted: false }
  serverSidebarSettings = { mode: 'classic', autoSettleDays: 3 }
  serverProviders = [
    {
      id: 'codex',
      displayName: 'Codex',
      installed: true,
      auth: 'authenticated',
      capabilities: {
        steer: true,
        fork: true,
        interrupt: true,
        reasoningItems: true,
        approvals: true,
        userInput: true,
        autoReview: true,
        images: true,
      },
    },
  ]

  transport.request.mockImplementation((method: string, params: unknown) => {
    switch (method) {
      case 'providers.list':
        return Promise.resolve({ providers: contractValidServerProviders() })
      case 'harnesses.list':
        return Promise.resolve({ harnesses: [] })
      case 'models.list':
        return Promise.resolve({ models: [] })
      case 'workspace.info':
        return Promise.resolve({ branch: 'main', added: 0, removed: 0, dirtyFiles: 0 })
      case 'workspace.branches':
        return Promise.resolve({ branches: ['main', 'feature/shelf'] })
      case 'workspace.switchBranch': {
        const request = methods['workspace.switchBranch'].params.parse(params)
        return Promise.resolve({
          branch: request.branch,
          added: 0,
          removed: 0,
          dirtyFiles: 0,
        })
      }
      case 'auth.status':
        return Promise.resolve({ signedIn: true })
      case 'projects.list':
        return Promise.resolve({ projects: contractValidServerProjects() })
      case 'sidebar.settings':
        return Promise.resolve(serverSidebarSettings)
      case 'sidebar.updateSettings': {
        const request = methods['sidebar.updateSettings'].params.parse(params)
        serverSidebarSettings = methods['sidebar.settings'].result.parse({
          ...serverSidebarSettings,
          ...request,
        })
        return Promise.resolve(serverSidebarSettings)
      }
      case 'thread.history':
        return Promise.resolve({ events: [], running: false, approval: 'ask' })
      case 'thread.queue':
        return Promise.resolve({ items: [], canSteer: true })
      case 'thread.settle':
        return Promise.resolve({
          lifecycle: { state: 'settled', settledAt: 100, reason: 'manual' },
        })
      case 'thread.unsettle':
      case 'thread.unsnooze':
        return Promise.resolve({ lifecycle: { state: 'active', keepActive: false } })
      case 'thread.snooze': {
        const request = methods['thread.snooze'].params.parse(params)
        return Promise.resolve({
          lifecycle: {
            state: 'snoozed',
            snoozedAt: 100,
            wakeAt: request.wakeAt,
          },
        })
      }
      case 'thread.setKeepActive': {
        const request = methods['thread.setKeepActive'].params.parse(params)
        return Promise.resolve({
          lifecycle: {
            state: 'active',
            keepActive: request.keepActive,
          },
        })
      }
      case 'usage.summary':
        return Promise.resolve({
          session: {
            inputTokens: 1200,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 1200,
          },
          today: {
            inputTokens: 3400,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 3400,
          },
          limits: [{ label: '5 hours', usedPercent: 25 }],
        })
      case 'usage.consumeReset':
        return Promise.resolve({ outcome: 'reset' })
      case 'usage.history':
        return Promise.resolve(profileHistoryResult())
      case 'pullRequests.list':
        return Promise.resolve({
          account: { available: true, authenticated: true, login: 'Blueemi' },
          items: [],
          fetchedAt: Date.now(),
          truncated: false,
        })
      case 'thread.checkpoints':
        return Promise.resolve({
          checkpoints: [{ id: 7, seq: 1, label: 'Fix the parser', createdAt: 1_800_000 }],
        })
      case 'thread.changedSince':
        return Promise.resolve({ files: ['src/parser.ts', 'src/parser.test.ts'] })
      case 'thread.restore':
        return Promise.resolve({ undo: 'undo-token' })
      case 'thread.undoRestore':
        return Promise.resolve({})
      case 'thread.unsavedWork':
        return Promise.resolve(serverUnsavedWork)
      case 'thread.discardWorktree':
      case 'thread.close':
        return Promise.resolve({})
      case 'thread.delete': {
        // The server really does drop it, so the next listing must agree.
        const { threadId } = methods['thread.delete'].params.parse(params)
        serverProjects = serverProjects.map((project) => {
          return {
            ...project,
            sessions: project.sessions.filter((session) => session.id !== threadId),
          }
        })
        return Promise.resolve({})
      }
      case 'thread.start': {
        // The real server records the session as it starts it, so the next
        // listing has to show it or the rail would stay empty.
        const { workspacePath, isolate } = methods['thread.start'].params.parse(params)
        serverProjects = serverProjects.map((project) => {
          if (project.path !== workspacePath) return project
          return {
            ...project,
            sessions: [
              ...project.sessions,
              {
                id: 'thread-1',
                title: 'New session',
                createdAt: 1,
                ...(isolate ? { worktreeBranch: 'harness/thread-1' } : {}),
              },
            ],
          }
        })
        return Promise.resolve({ threadId: 'thread-1' })
      }
      case 'thread.rename': {
        const { threadId, title } = methods['thread.rename'].params.parse(params)
        serverProjects = serverProjects.map((project) => {
          return {
            ...project,
            sessions: project.sessions.map((session) =>
              session.id === threadId ? { ...session, title } : session,
            ),
          }
        })
        return Promise.resolve({})
      }
      case 'thread.sendTurn':
        return Promise.resolve({ queued: false, turnId: 'turn-1' })
      default:
        return Promise.resolve({})
    }
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'startViewTransition')
  resetInstalls()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function openSettings() {
  const direct = screen.queryByRole('button', { name: 'Settings' })
  if (direct) {
    fireEvent.click(direct)
    return
  }
  fireEvent.click(screen.getByRole('button', { name: 'Account' }))
  fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
}

async function openProviderSettings() {
  openSettings()
  const settings = await screen.findByRole('dialog', { name: 'Settings' })
  fireEvent.click(await within(settings).findByRole('button', { name: 'Providers' }))
}

/** Test snapshots are small, so they always fit the cache. */
function serializeModelCatalogCache(
  ...args: Parameters<typeof serializeCatalogWithinLimits>
): string {
  const raw = serializeCatalogWithinLimits(...args)
  if (raw === undefined) throw new Error('test catalog exceeds the cache limits')
  return raw
}

function cachedCodexChoice(): ModelChoice {
  return {
    key: 'codex:gpt-6.1-sol',
    provider: 'codex',
    sourceName: 'Codex',
    mark: 'openai',
    model: {
      id: 'gpt-6.1-sol',
      displayName: 'GPT-5.6 Sol',
      isDefault: true,
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
      serviceTiers: [],
    },
  }
}

function profileHistoryResult() {
  const totals = {
    uncachedInputTokens: 20,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    processedTokens: 110,
    estimatedCostUsd: 0,
    cacheSavingsUsd: 0,
    providerReportedCostUsd: 0,
    providerReportedTokens: 0,
    pricedTokens: 0,
    unpricedTokens: 110,
  }
  return {
    range: 'all' as const,
    startDate: '2026-08-09',
    endDate: '2026-08-09',
    generatedAt: 1,
    sessionCount: 1,
    activeDays: 1,
    totals,
    providers: [{ provider: 'codex' as const, sessionCount: 1, totals }],
    models: [
      {
        provider: 'codex' as const,
        model: 'gpt-5.6-sol',
        sessionCount: 1,
        pricing: 'unpriced' as const,
        totals,
      },
    ],
    daily: [
      {
        date: '2026-08-09',
        sessionCount: 1,
        totals,
        providers: [{ provider: 'codex' as const, tokens: 110, estimatedCostUsd: 0 }],
      },
    ],
    sources: [{ provider: 'codex' as const, available: true, sessionCount: 1 }],
    scan: { status: 'idle' as const, filesProcessed: 1, filesTotal: 1 },
    warnings: [],
  }
}

function connectionChoice(connectionId: string): ModelChoice {
  return {
    key: `api:${connectionId}:deepseek-v4-flash`,
    provider: 'api',
    sourceName: 'NaN',
    mark: 'custom',
    connectionId,
    model: {
      id: 'deepseek-v4-flash',
      displayName: 'deepseek-v4-flash',
      isDefault: true,
      reasoningEfforts: [],
      serviceTiers: [],
    },
  }
}

/**
 * Claude Code's catalog as an installed build cached it on 2026-10-13: the
 * current lineup under its aliases, then every older generation under its own
 * id, Haiku 4.5 only as a dated snapshot.
 */
function claudeCodeLineup(): Model[] {
  const lineup: [id: string, displayName: string][] = [
    ['fable', 'Fable 5.1'],
    ['opus', 'Opus 5.5'],
    ['sonnet', 'Sonnet 5.5'],
    ['haiku', 'Haiku 5.5'],
    ['claude-fable-5', 'Fable 5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-opus-4-7', 'Opus 4.7'],
    ['claude-opus-4-6', 'Opus 4.6'],
    ['claude-opus-4-5', 'Opus 4.5'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
  ]
  return lineup.map(([id, displayName]) => ({
    id,
    displayName,
    isDefault: id === 'opus',
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
    serviceTiers: [],
  }))
}

/**
 * The hidden list that build saved at visibility version 4: the `sonnet` and
 * `haiku` aliases hidden by an older default, while Opus 5, Sonnet 5 and the
 * dated Haiku 4.5 were never hidden.
 */
const OLDER_BUILD_HIDDEN_MODELS = [
  'codex:gpt-5.5',
  'codex:gpt-5.4',
  'claude-code:claude-fable-5',
  'claude-code:sonnet',
  'claude-code:haiku',
  'claude-code:claude-opus-4-8',
  'claude-code:claude-opus-4-7',
  'claude-code:claude-opus-4-6',
  'claude-code:claude-opus-4-5',
  'claude-code:claude-sonnet-4-6',
  'claude-code:opus%5B1m%5D',
]

function claudeCodeServerProvider(): TestServerProvider {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    auth: 'authenticated',
    capabilities: {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: false,
      images: false,
    },
  }
}

function modelConnection(overrides: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: 'nan-1',
    displayName: 'NaN',
    preset: 'custom',
    transport: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    enabled: true,
    credentialConfigured: true,
    ...overrides,
  }
}

function grokServerProvider(): TestServerProvider {
  return { ...claudeCodeServerProvider(), id: 'grok', displayName: 'Grok' }
}

/** Codex and Claude Code list their catalogs; Grok's discovery always fails. */
function mockDiscoveryWithFailingGrok(claudeModels?: Promise<{ models: Model[] }>) {
  const request = transport.request.getMockImplementation()
  if (!request) throw new Error('missing request mock')
  transport.request.mockImplementation((method: string, params: unknown) => {
    if (method !== 'models.list') return request(method, params)
    const { provider } = methods['models.list'].params.parse(params)
    if (provider === 'grok') return Promise.reject(new Error('Grok model discovery failed'))
    if (provider === 'claude-code') {
      return claudeModels ?? Promise.resolve({ models: claudeCodeLineup() })
    }
    return Promise.resolve({
      models: [
        cachedCodexChoice().model,
        { ...cachedCodexChoice().model, id: 'gpt-5.5', displayName: 'GPT-5.5' },
      ],
    })
  })
}

/** Open the model picker and wait until the `launch`-th discovery has asked Grok and finished. */
async function settleDiscoveryWithFailingGrok(launch: number) {
  // With a cached catalog, a provider the composer is not on is listed once
  // the picker needs it.
  act(() => composerProps().onModelSelectorOpen?.())
  await waitFor(() =>
    expect(
      transport.request.mock.calls.filter(
        ([method, params]) =>
          method === 'models.list' &&
          methods['models.list'].params.parse(params).provider === 'grok',
      ),
    ).toHaveLength(launch),
  )
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
}

function offeredModelNames(provider: string): string[] {
  return composerProps()
    .models.filter((choice) => choice.provider === provider)
    .map((choice) => choice.model.displayName)
}

function savedVisibility(): ModelVisibilityRecord | undefined {
  return parseModelVisibility(localStorage.getItem('harness.modelVisibility.v2'))
}

/** The saved choices, as `key=shown` or `key=hidden`, sorted. */
function savedOverrides(): string[] {
  return Object.entries(savedVisibility()?.overrides ?? {})
    .map(([key, override]) => `${key}=${override.visible ? 'shown' : 'hidden'}`)
    .sort()
}

/** Leon's list as an older build saved it at format version 4, keys only. */
const LEON_HIDDEN_MODELS = [
  'codex:gpt-5.5',
  'codex:gpt-5.4',
  'codex:gpt-5.4-mini',
  'codex:gpt-5.3-codex-spark',
  'claude-code:claude-fable-5',
  'claude-code:claude-opus-4-8',
  'claude-code:claude-opus-4-7',
  'claude-code:claude-opus-4-6',
  'claude-code:claude-opus-4-5',
  'claude-code:claude-sonnet-4-6',
  'claude-code:opus%5B1m%5D',
  'claude-code:claude-opus-5',
  'claude-code:claude-sonnet-5',
  'claude-code:claude-haiku-4-5-20251001',
  'claude-code:claude-haiku-4-5',
]
/** The rows of that list its build recorded at version 8; the rest were no longer listed. */
const LEON_RECORDED_ROWS = LEON_HIDDEN_MODELS.filter(
  (key) =>
    ![
      'codex:gpt-5.4',
      'codex:gpt-5.4-mini',
      'codex:gpt-5.3-codex-spark',
      'claude-code:opus%5B1m%5D',
    ].includes(key),
)

/** The lineups listed live on 2026-10-16: codex-cli 0.163, Claude Code and Grok. */
function mockLiveDiscovery() {
  const request = transport.request.getMockImplementation()
  if (!request) throw new Error('missing request mock')
  const row = (id: string, displayName: string, isDefault = false): Model => ({
    id,
    displayName,
    isDefault,
    reasoningEfforts: [],
    serviceTiers: [],
  })
  const lineups = new Map<string, Model[]>([
    [
      'codex',
      [
        row('gpt-6-astra', 'GPT-6-Astra'),
        row('gpt-6.1-sol', 'GPT-6.1-Sol', true),
        row('gpt-5.6-terra', 'GPT-5.6-Terra'),
        row('gpt-6-luna', 'GPT-6-Luna'),
        row('gpt-6-sol', 'GPT-6-Sol'),
        row('gpt-5.6-sol', 'GPT-5.6-Sol'),
        row('gpt-5.6-luna', 'GPT-5.6-Luna'),
        row('gpt-5.5', 'GPT-5.5'),
      ],
    ],
    ['claude-code', claudeCodeLineup()],
    [
      'grok',
      [
        row('grok-4.7', 'Grok 4.7', true),
        row('grok-4.7-build-fast', 'Grok 4.7 Build Fast'),
        row('grok-4.6', 'Grok 4.6'),
        row('grok-4.5', 'Grok 4.5'),
      ],
    ],
  ])
  transport.request.mockImplementation((method: string, params: unknown) => {
    if (method !== 'models.list') return request(method, params)
    const { provider } = methods['models.list'].params.parse(params)
    return Promise.resolve({ models: lineups.get(provider) ?? [] })
  })
}

function dispatchTransitionEnd(element: Element, propertyName: string) {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { configurable: true, value: propertyName })
  element.dispatchEvent(event)
}
interface ProjectProbe {
  resolve: (value: ResultOf<'projects.list'>) => void
  reject: (reason?: unknown) => void
}

function projectsSnapshot(running: boolean): ResultOf<'projects.list'> {
  return {
    projects: contractValidServerProjects().map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({ ...session, running })),
    })),
  }
}

async function renderWithDeferredProjectProbes(): Promise<ProjectProbe[]> {
  const request = transport.request.getMockImplementation()
  if (!request) throw new Error('missing request mock')
  const probes: ProjectProbe[] = []
  let capture = false
  transport.request.mockImplementation((method: string, params: unknown) =>
    method === 'projects.list' && capture
      ? new Promise<ResultOf<'projects.list'>>((resolve, reject) =>
          probes.push({ resolve, reject }),
        )
      : request(method, params),
  )
  await openNewSession()
  transport.request.mockClear()
  capture = true
  return probes
}

function rpcCount(method: string): number {
  return transport.request.mock.calls.filter(([called]) => called === method).length
}

function completeTurn(threadId: string, turnId: string): void {
  emitThreadEvent(threadId, { type: 'turn.completed', turnId, status: 'completed' })
}

function startTurn(threadId: string, turnId: string): void {
  emitThreadEvent(threadId, {
    type: 'turn.started',
    turn: { id: turnId, threadId, status: 'running', createdAt: 1 },
  })
}

function submitTurn(text: string): void {
  const composer = screen.getByPlaceholderText('Do anything')
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.keyDown(composer, { key: 'Enter' })
}

function waitForWorkspace(count: number): Promise<void> {
  return waitFor(() => expect(rpcCount('workspace.info')).toBe(count))
}

function waitForInitialWorkspace(): Promise<void> {
  return waitFor(() =>
    expect(transport.request).toHaveBeenCalledWith('workspace.branches', {
      path: '/work/project',
    }),
  )
}

async function openNewSession(): Promise<void> {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
  await Promise.all([waitForInitialWorkspace(), screen.findByTestId('thread')])
}

function setConnectionState(state: ConnectionState): void {
  for (const listener of transport.stateListeners) listener(state)
}

function composerProps() {
  return shellRenders.composer.mock.lastCall![0] as ComponentProps<
    typeof import('./ui/Composer.js').Composer
  >
}

function sidebarProps() {
  return shellRenders.sidebar.mock.lastCall![0] as ComponentProps<
    typeof import('./ui/Sidebar.js').Sidebar
  >
}

function terminalOpenRequests() {
  return transport.request.mock.calls.filter(([method]) => method === 'terminal.open').length
}

async function openCheckpointHistory() {
  const header = shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
    typeof import('./ui/StageHeader.js').StageHeader
  >
  act(() => header.onOpenRollback())
  fireEvent.click(await screen.findByRole('button', { name: /Before “Fix the parser”/ }))
  await waitFor(() => expect(restoreButton().disabled).toBe(false))
}

function restoreButton() {
  return within(screen.getByRole('dialog', { name: 'Restore' })).getByRole<HTMLButtonElement>(
    'button',
    { name: /^Restor/ },
  )
}

describe('web client', () => {
  it('publishes a healthy source while another model catalog remains pending', async () => {
    serverProviders.push({ ...serverProviders[0]!, id: 'claude-code', displayName: 'Claude Code' })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'models.list') {
        return methods[method].params.parse(params).provider === 'claude-code'
          ? new Promise(() => undefined)
          : Promise.resolve({ models: [cachedCodexChoice().model] })
      }
      return request(method, params)
    })
    render(<App />)
    await waitFor(() =>
      expect(composerProps().models.map((choice) => choice.key)).toContain(cachedCodexChoice().key),
    )
    // The settled source reaches the cache on the trailing write.
    await waitFor(() => expect(localStorage.getItem('harness.modelCatalog.v1')).not.toBeNull(), {
      timeout: 3_000,
    })
    const cache = JSON.parse(localStorage.getItem('harness.modelCatalog.v1')!)
    expect(cache.validatedSources.map((source: { source: string }) => source.source)).toEqual([
      'codex',
    ])
    expect(composerProps().modelsLoaded).toBe(true)
  })

  it('writes the cache once for sources that settle together, then for the full catalog', async () => {
    for (const id of ['claude-code', 'grok', 'cursor'] as const) {
      serverProviders.push({ ...serverProviders[0]!, id, displayName: id })
    }
    let releaseCursor!: () => void
    const cursorModels = new Promise<{ models: Model[] }>((resolve) => {
      releaseCursor = () =>
        resolve({ models: [{ ...cachedCodexChoice().model, id: 'cursor-model' }] })
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method !== 'models.list') return request(method, params)
      const { provider } = methods[method].params.parse(params)
      if (provider === 'cursor') return cursorModels
      return Promise.resolve({
        models: [{ ...cachedCodexChoice().model, id: `${provider}-model` }],
      })
    })
    const setItem = vi.spyOn(localStorage, 'setItem')
    const cacheWrites = () =>
      setItem.mock.calls
        .filter(([key]) => key === 'harness.modelCatalog.v1')
        .map(([, value]) =>
          (JSON.parse(value) as { validatedSources: { source: string }[] }).validatedSources
            .map((entry) => entry.source)
            .sort(),
        )
    try {
      render(<App />)
      await waitFor(() => expect(cacheWrites()).toEqual([['claude-code', 'codex', 'grok']]), {
        timeout: 3_000,
      })
      await act(async () => releaseCursor())
      await waitFor(() => expect(cacheWrites()).toHaveLength(2))
      expect(cacheWrites()[1]).toEqual(['claude-code', 'codex', 'cursor', 'grok'])
    } finally {
      setItem.mockRestore()
    }
  })

  it('does not renew an unresolved source cache when another provider completes', async () => {
    serverProviders.push({ ...serverProviders[0]!, id: 'claude-code', displayName: 'Claude Code' })
    const stale = {
      ...cachedCodexChoice(),
      key: 'claude-code:old',
      provider: 'claude-code' as const,
      sourceName: 'Claude Code',
      mark: 'anthropic' as const,
      model: { ...cachedCodexChoice().model, id: 'old' },
    }
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([stale], { validatedAt: Date.now() - 600_000 }),
    )
    const request = transport.request.getMockImplementation()!
    let reject!: (error: Error) => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'models.list')
        return methods[method].params.parse(params).provider === 'claude-code'
          ? new Promise((_, fail) => {
              reject = fail
            })
          : Promise.resolve({ models: [cachedCodexChoice().model] })
      return request(method, params)
    })
    render(<App />)
    // Claude Code is listed once the picker needs it.
    act(() => composerProps().onModelSelectorOpen?.())
    await waitFor(() =>
      expect(composerProps().models.map((choice) => choice.key)).toContain(cachedCodexChoice().key),
    )
    await act(async () => reject(new Error('catalog unavailable')))
    const cache = JSON.parse(localStorage.getItem('harness.modelCatalog.v1')!)
    expect(cache.validatedSources.map((source: { source: string }) => source.source)).toEqual([
      'codex',
    ])
    expect(cache.models.map((choice: { key: string }) => choice.key)).toContain(stale.key)
  })

  it('drops the model catalog cache once the catalog outgrows it', async () => {
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()]),
    )
    const models = Array.from({ length: 2_001 }, (_, index) => ({
      ...cachedCodexChoice().model,
      id: `listed-${index}`,
      displayName: `Listed ${index}`,
      isDefault: index === 0,
    }))
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'models.list' ? Promise.resolve({ models }) : request(method, params),
    )
    render(<App />)
    await waitFor(() => expect(localStorage.getItem('harness.modelCatalog.v1')).toBeNull())
    expect(composerProps().modelsLoaded).toBe(true)
  })

  it('retains a legacy project list through an unacknowledged outage', async () => {
    const legacy = [{ path: '/legacy', name: 'Important name' }]
    localStorage.setItem('harness.projects', JSON.stringify(legacy))
    const request = transport.request.getMockImplementation()!
    let reject!: (error: Error) => void
    transport.request.mockImplementation((method, params) =>
      method === 'projects.add'
        ? new Promise((_, fail) => {
            reject = fail
          })
        : request(method, params),
    )
    const view = render(<App />)
    await waitFor(() => expect(rpcCount('projects.add')).toBe(1))
    expect(JSON.parse(localStorage.getItem('harness.projects')!)).toEqual(legacy)
    await act(async () => reject(new IndeterminateRequestError('request expired during outage')))
    expect(JSON.parse(localStorage.getItem('harness.projects')!)).toEqual(legacy)
    view.unmount()
    expect(JSON.parse(localStorage.getItem('harness.projects')!)).toEqual(legacy)
  })

  it('migrates only acknowledged legacy projects across a restart', async () => {
    const legacy = [
      { path: '/one', name: 'One' },
      { path: '/two', name: 'Two' },
      { path: '/three', name: 'Three' },
    ]
    localStorage.setItem('harness.projects', JSON.stringify(legacy))
    const request = transport.request.getMockImplementation()!
    let fail = true
    transport.request.mockImplementation((method, params) => {
      if (method === 'projects.add' && methods[method].params.parse(params).path === '/two' && fail)
        return Promise.reject(new Error('offline'))
      return request(method, params)
    })
    const first = render(<App />)
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('harness.projects')!)).toEqual([legacy[1]]),
    )
    first.unmount()
    fail = false
    transport.request.mockClear()
    render(<App />)
    await waitFor(() => expect(localStorage.getItem('harness.projects')).toBeNull())
    expect(transport.request.mock.calls.filter(([method]) => method === 'projects.add')).toEqual([
      ['projects.add', legacy[1]],
    ])
  })

  it.each([false, true])(
    'recovers an indeterminate question reply on an open socket (resolved: %s)',
    async (resolved) => {
      const question: Extract<DomainEvent, { type: 'user_input.requested' }> = {
        type: 'user_input.requested',
        request: {
          id: 'question-1',
          turnId: 'turn-1',
          createdAt: 1,
          autoResolutionMs: null,
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Which option?',
              allowOther: true,
              secret: false,
              options: null,
            },
          ],
        },
      }
      const request = transport.request.getMockImplementation()!
      let replied = false
      transport.request.mockImplementation((method, params) => {
        if (method === 'thread.respondToUserInput') {
          replied = true
          return Promise.reject(new IndeterminateRequestError('malformed reply'))
        }
        if (method === 'thread.history')
          return Promise.resolve({
            events: [
              { seq: 1, event: question },
              ...(replied && resolved
                ? [{ seq: 2, event: { type: 'user_input.resolved', id: 'question-1' } }]
                : []),
            ],
            running: true,
            approval: 'ask',
          })
        return request(method, params)
      })
      await openNewSession()
      await waitFor(() =>
        expect(shellRenders.threadFrame.mock.lastCall![0].userInputs).toHaveLength(1),
      )
      const original = shellRenders.threadFrame.mock.lastCall![0].userInputs[0]
      transport.request.mockClear()
      await act(async () => {
        await expect(
          threadCallbacks.answerUserInput!('question-1', { choice: ['A'] }),
        ).rejects.toThrow('malformed reply')
      })
      expect(transport.state).toBe('open')
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      })
      const requests = shellRenders.threadFrame.mock.lastCall![0].userInputs
      expect(requests).toHaveLength(resolved ? 0 : 1)
      if (!resolved) {
        expect(requests[0]).toEqual(original)
        expect(requests[0]).not.toBe(original)
      }
    },
  )

  it.each([true, false])('uses the latest account sign-in result (%s)', (signedIn) => {
    const providers = contractValidServerProviders().map((status) => ({
      ...status,
      auth: signedIn ? ('unauthenticated' as const) : ('authenticated' as const),
    }))
    expect(
      resolveSendAvailability({
        catalog: 'ready',
        activeProvider: 'codex',
        serverBoundSession: false,
        connections: [],
        providerStatuses: providers,
        accountCheck: { provider: 'codex', state: 'ready', account: { signedIn } },
      }),
    ).toBe(signedIn ? 'ready' : 'setup-required')
  })

  it('keeps Send available when the account could not be confirmed', () => {
    type SendInput = Parameters<typeof resolveSendAvailability>[0]
    const resolve = (
      status: Partial<SendInput['providerStatuses'][number]>,
      accountCheck: SendInput['accountCheck'],
    ) =>
      resolveSendAvailability({
        catalog: 'ready',
        activeProvider: 'codex',
        serverBoundSession: false,
        connections: [],
        providerStatuses: contractValidServerProviders().map((entry) => ({
          ...entry,
          auth: 'unknown' as const,
          ...(entry.id === 'codex' ? status : {}),
        })),
        accountCheck,
      })
    const failed: SendInput['accountCheck'] = {
      provider: 'codex',
      state: 'failed',
      error: { id: 'account:codex:1', message: 'CLI did not respond within the time limit' },
    }
    expect(resolve({}, failed)).toBe('ready')
    // A confirmed sign-out still asks for setup, and a provider problem still blocks.
    expect(resolve({}, { provider: 'codex', state: 'ready', account: { signedIn: false } })).toBe(
      'setup-required',
    )
    expect(resolve({ problem: 'Codex needs an update.' }, failed)).toBe('unavailable')
    expect(resolve({ auth: 'unauthenticated' }, failed)).toBe('setup-required')
    // A read still running waits only through the grace period.
    expect(resolve({}, { provider: 'codex', state: 'loading' })).toBe('loading')
    expect(resolve({}, { provider: 'codex', state: 'loading', slow: true })).toBe('ready')
    expect(
      resolve({ auth: 'unauthenticated' }, { provider: 'codex', state: 'loading', slow: true }),
    ).toBe('setup-required')
    // A provider that was signed in at its last read does not wait for this one.
    expect(resolve({}, { provider: 'codex', state: 'loading', remembered: true })).toBe('ready')
    expect(
      resolve(
        { auth: 'unauthenticated' },
        { provider: 'codex', state: 'loading', remembered: true },
      ),
    ).toBe('setup-required')
  })

  it('cuts a prompt title before an emoji split at 40 code units', () => {
    expect(titleFrom('x'.repeat(39) + '🌊 reply with ok')).toBe('x'.repeat(39) + '…')
  })

  it('cuts a long ascii prompt title at 40 code units', () => {
    expect(titleFrom('c'.repeat(50))).toBe('c'.repeat(40) + '…')
  })

  it.each([false, true])(
    'preserves the next draft through startup (switch away: %s)',
    async (switchAway) => {
      const request = transport.request.getMockImplementation()!
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      transport.request.mockImplementation(async (method, params) => {
        if (method === 'thread.start') await gate
        return request(method, params)
      })
      render(<App />)
      await screen.findByRole('button', { name: /^New session,/ })
      submitTurn('First prompt')
      await waitFor(() => expect(rpcCount('thread.start')).toBe(1))
      const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
      fireEvent.change(composer, { target: { value: 'Next unsent prompt' } })
      act(() => composerProps().onAttachmentsChange?.(['/work/later.png']))
      if (switchAway) fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
      await act(async () => release())
      await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
      if (!switchAway) {
        expect(composer.value).toBe('Next unsent prompt')
        fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
      }
      fireEvent.click(await screen.findByRole('button', { name: /^First prompt,/ }))
      expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
        'Next unsent prompt',
      )
      expect(composerProps().draftRequest?.attachments).toEqual(['/work/later.png'])
    },
  )

  it('keeps a rejected side prompt in the chat that is still starting', async () => {
    const request = transport.request.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    transport.request.mockImplementation(async (method, params) => {
      if (method === 'thread.start') await gate
      return request(method, params)
    })
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    submitTurn('First prompt')
    await waitFor(() => expect(rpcCount('thread.start')).toBe(1))
    submitTurn('/side what is this?')
    await screen.findByText('Start the main chat before opening a side chat.')
    const composer = () => screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    expect(composer().value).toBe('/side what is this?')
    await act(async () => release())
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    expect(composer().value).toBe('/side what is this?')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(composer().value).toBe('')
    fireEvent.click(await screen.findByRole('button', { name: /^First prompt,/ }))
    expect(composer().value).toBe('/side what is this?')
  })

  it('restores failed startup into the new-chat draft without overwriting another chat', async () => {
    const request = transport.request.getMockImplementation()!
    let reject!: (error: Error) => void
    transport.request.mockImplementation((method, params) =>
      method === 'thread.start'
        ? new Promise((_, fail) => {
            reject = fail
          })
        : request(method, params),
    )
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    act(() => composerProps().onSend('Failed first prompt', ['/work/first.png']))
    await waitFor(() => expect(rpcCount('thread.start')).toBe(1))
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Later draft' },
    })
    act(() => composerProps().onAttachmentsChange?.(['/work/later.png']))
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Other chat draft' },
    })
    await act(async () => reject(new Error('start refused')))
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Other chat draft',
    )
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Later draft\n\nFailed first prompt',
    )
    expect(composerProps().draftRequest?.attachments).toEqual([
      '/work/later.png',
      '/work/first.png',
    ])
  })

  it('brings back every unsent draft after a restart', async () => {
    const docs = {
      key: 'skill:docs',
      kind: 'skill' as const,
      id: '/skills/docs/SKILL.md',
      name: 'Docs',
      description: 'Project docs',
      scope: 'Project',
      token: '$docs',
      available: true,
    }
    const composer = () => screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const first = render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    fireEvent.change(composer(), { target: { value: 'New chat idea' } })
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    fireEvent.change(composer(), { target: { value: 'Half-typed reply' } })
    act(() => composerProps().onAttachmentsChange?.(['/work/later.png']))
    act(() => composerProps().onResourcesChange?.([docs]))
    window.dispatchEvent(new Event('pagehide'))
    first.unmount()

    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    expect(composer().value).toBe('New chat idea')
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    expect(composer().value).toBe('Half-typed reply')
    expect(screen.getByRole('button', { name: 'Remove later.png' })).toBeTruthy()
    expect(composerProps().draftRequest?.resources).toEqual([docs])
  })

  it('saves drafts when the page is hidden instead of on every keystroke', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'H' } })
    fireEvent.change(composer, { target: { value: 'Half' } })
    expect(localStorage.getItem('harness.composerDrafts.v1')).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem('harness.composerDrafts.v1')!)).toEqual({
      'new-chat': { text: 'Half', attachments: [], resources: [] },
    })
  })

  it('saves a draft typed while the chat starts under the real chat only', async () => {
    const request = transport.request.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    transport.request.mockImplementation(async (method, params) => {
      if (method === 'thread.start') await gate
      return request(method, params)
    })
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    submitTurn('First prompt')
    await waitFor(() => expect(rpcCount('thread.start')).toBe(1))
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Next unsent prompt' },
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('harness.composerDrafts.v1')).toBeNull()
    await act(async () => release())
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem('harness.composerDrafts.v1')!)).toEqual({
      'thread-1': { text: 'Next unsent prompt', attachments: [], resources: [] },
    })
  })

  it("drops a deleted chat's draft from the saved drafts", async () => {
    serverProjects[0]!.sessions.push({ id: 'doomed-thread', title: 'Doomed chat', createdAt: 5 })
    const composer = () => screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const first = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Doomed chat,/ }))
    fireEvent.change(composer(), { target: { value: 'Doomed draft' } })
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    fireEvent.change(composer(), { target: { value: 'Kept draft' } })
    act(() => sidebarProps().onDeleteSession('doomed-thread'))
    await screen.findByText('Chat deleted')
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('harness.composerDrafts.v1')!)).toEqual({
        'untouched-thread': { text: 'Kept draft', attachments: [], resources: [] },
      }),
    )
    first.unmount()

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    expect(composer().value).toBe('Kept draft')
  })

  it.each(['{not json', '[1,2]', '{"new-chat":{"text":5}}'])(
    'starts with empty drafts when the saved drafts are corrupt (%s)',
    async (saved) => {
      localStorage.setItem('harness.composerDrafts.v1', saved)
      const composer = () => screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
      const first = render(<App />)
      await screen.findByRole('button', { name: /^New session,/ })
      expect(composer().value).toBe('')
      fireEvent.change(composer(), { target: { value: 'Fresh start' } })
      first.unmount()

      render(<App />)
      await screen.findByRole('button', { name: /^New session,/ })
      expect(composer().value).toBe('Fresh start')
    },
  )

  it('offers an unsent draft back after Edit as new prompt replaces it', async () => {
    await openNewSession()
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement

    // An empty composer has nothing to lose, so it gets no notice.
    act(() => threadCallbacks.editMessage?.('An earlier prompt'))
    expect(composer.value).toBe('An earlier prompt')
    expect(screen.queryByText('Your draft was replaced.')).toBeNull()

    fireEvent.change(composer, { target: { value: 'my unsent draft' } })
    act(() => threadCallbacks.editMessage?.('An earlier prompt'))
    expect(composer.value).toBe('An earlier prompt')
    expect(screen.getByText('Your draft was replaced.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(composer.value).toBe('my unsent draft'))
  })
  it('puts the last sent prompt back on Arrow Up in an empty composer', async () => {
    const fallback = transport.request.getMockImplementation()!
    const prompt = (id: string, text: string, createdAt: number) => ({
      seq: createdAt,
      event: {
        type: 'item.completed',
        item: {
          id,
          turnId: id,
          type: 'message',
          role: 'user',
          status: 'completed',
          text,
          createdAt,
        },
      },
    })
    transport.request.mockImplementation((method, params) =>
      method === 'thread.history'
        ? Promise.resolve({
            events: [prompt('first', 'Fix the build', 1), prompt('second', 'Now add a test', 2)],
            running: false,
          })
        : fallback(method, params),
    )
    await openNewSession()
    await screen.findByText('Now add a test')
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'typed' } })
    fireEvent.keyDown(composer, { key: 'ArrowUp' })
    expect(composer.value).toBe('typed')

    fireEvent.change(composer, { target: { value: '' } })
    fireEvent.keyDown(composer, { key: 'ArrowUp' })
    expect(composer.value).toBe('Now add a test')
    // The composer was empty, so nothing was replaced.
    expect(screen.queryByText('Your draft was replaced.')).toBeNull()

    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(composer.value).toBe('')
  })
  it('keeps an acknowledged access mode when a change is rejected', async () => {
    const request = transport.request.getMockImplementation()!
    let reject!: (error: Error) => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'thread.history')
        return Promise.resolve({ events: [], running: false, approval: 'full' })
      if (method === 'thread.setApproval')
        return new Promise((_, fail) => {
          reject = fail
        })
      return request(method, params)
    })
    await openNewSession()
    await waitFor(() => expect(composerProps().approval).toBe('full'))
    act(() => composerProps().onApprovalChange('ask'))
    expect(composerProps().approval).toBe('full')
    await act(async () => reject(new Error('access refused')))
    expect(composerProps().approval).toBe('full')
    expect(await screen.findByText('access refused')).toBeTruthy()
  })

  it('serializes access edits and keeps the last successful mode', async () => {
    const request = transport.request.getMockImplementation()!
    let release!: () => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'thread.setApproval') {
        const { approval } = methods['thread.setApproval'].params.parse(params)
        return approval === 'full'
          ? new Promise((resolve) => {
              release = () => resolve({})
            })
          : Promise.reject(new Error('access refused'))
      }
      return request(method, params)
    })
    await openNewSession()
    act(() => {
      composerProps().onApprovalChange('full')
      composerProps().onApprovalChange('ask')
    })
    expect(rpcCount('thread.setApproval')).toBe(1)
    await act(async () => release())
    expect(rpcCount('thread.setApproval')).toBe(2)
    expect(composerProps().approval).toBe('full')
  })

  describe('restore Undo notice', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function restoreAndOfferUndo() {
      await openNewSession()
      await openCheckpointHistory()
      fireEvent.click(screen.getByRole('button', { name: /^Restore( checkpoint)?$/ }))
      const undo = await screen.findByRole('button', { name: 'Undo restore' })
      await waitFor(() => expect(rpcCount('thread.checkpoints')).toBe(2))
      return undo.closest('.notice')!
    }

    it('keeps offering Undo restore until the user acts', async () => {
      const notice = await restoreAndOfferUndo()

      act(() => vi.advanceTimersByTime(10_000))

      expect(notice.getAttribute('data-state')).toBe('open')
      expect(notice.textContent).toContain('Restored to before “Fix the parser”.')
      expect(screen.getByRole('button', { name: 'Undo restore' })).toBeTruthy()
    })

    it('ends the Undo restore offer when dismissed', async () => {
      const notice = await restoreAndOfferUndo()

      fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: 'Dismiss' }))

      expect(notice.getAttribute('data-state')).toBe('closing')
    })

    it('ends the Undo restore offer when a message is sent', async () => {
      const notice = await restoreAndOfferUndo()

      act(() => composerProps().onSend('Keep going', []))

      await waitFor(() => expect(notice.getAttribute('data-state')).toBe('closing'))
    })

    it('ends the Undo restore offer when another chat opens', async () => {
      serverProjects[0]!.sessions.push({ id: 'second-thread', title: 'Second chat' })
      const notice = await restoreAndOfferUndo()

      act(() => sidebarProps().onSelectSession('second-thread'))

      await waitFor(() => expect(notice.getAttribute('data-state')).toBe('closing'))
    })

    it('auto-dismisses the Restore undone notice after five seconds', async () => {
      await restoreAndOfferUndo()
      fireEvent.click(screen.getByRole('button', { name: 'Undo restore' }))
      const notice = (await screen.findByText('Restore undone.')).closest('.notice')!
      // The notice arms its timer in a passive effect, which React may run in a task of its own
      // after the commit that shows the text; let that task run before the clock moves.
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)))

      act(() => vi.advanceTimersByTime(4_900))
      expect(notice.getAttribute('data-state')).toBe('open')
      act(() => vi.advanceTimersByTime(100))
      expect(notice.getAttribute('data-state')).toBe('closing')
    })
  })

  it.each(['thread.history', 'thread.checkpoints', 'workspace.info'])(
    'retains restore Undo when %s refresh fails',
    async (failedMethod) => {
      const request = transport.request.getMockImplementation()!
      let restored = false
      transport.request.mockImplementation((method, params) => {
        if (method === 'thread.restore') restored = true
        if (restored && method === failedMethod) return Promise.reject(new Error('refresh failed'))
        return request(method, params)
      })
      await openNewSession()
      await openCheckpointHistory()
      fireEvent.click(restoreButton())
      fireEvent.click(await screen.findByRole('button', { name: 'Undo restore' }))
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('thread.undoRestore', {
          threadId: 'untouched-thread',
          undo: 'undo-token',
        }),
      )
      expect(rpcCount('thread.restore')).toBe(1)
      expect(screen.queryByRole('dialog', { name: 'Restore' })).toBeNull()
    },
  )

  it('lists branches for a new chat only, and again when its menu opens after 30 s', async () => {
    serverProjects.push(
      serverProject('/work/other', 'other', [{ id: 'other-thread', title: 'Other chat' }]),
    )
    render(<App />)
    await waitFor(() => expect(composerProps().branches).toEqual(['main', 'feature/shelf']))
    expect(rpcCount('workspace.branches')).toBe(1)

    // Opening chats, here and in another project, reads the checkout but no branch list.
    act(() => sidebarProps().onSelectSession('other-thread'))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', { path: '/work/other' }),
    )
    expect(composerProps().branches).toEqual([])
    act(() => sidebarProps().onSelectSession('untouched-thread'))
    await waitFor(() => expect(composerProps().projectPath).toBe('/work/project'))
    expect(rpcCount('workspace.branches')).toBe(1)

    // A new chat within 30 s offers the kept list, also when its menu opens.
    act(() => sidebarProps().onNewSession('/work/project'))
    await waitFor(() => expect(composerProps().newSession).toBe(true))
    expect(composerProps().branches).toEqual(['main', 'feature/shelf'])
    act(() => composerProps().onBranchMenuOpen?.())
    expect(rpcCount('workspace.branches')).toBe(1)

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001)
    try {
      act(() => composerProps().onBranchMenuOpen?.())
      await waitFor(() => expect(rpcCount('workspace.branches')).toBe(2))
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps the next project workspace when a restore Undo finishes after a switch', async () => {
    serverProjects.push(
      serverProject('/work/other', 'other', [{ id: 'other-thread', title: 'Other chat' }]),
    )
    const request = transport.request.getMockImplementation()!
    let undone = false
    const finishInfo: Array<(info: ResultOf<'workspace.info'>) => void> = []
    transport.request.mockImplementation((method, params) => {
      if (method === 'thread.undoRestore') undone = true
      if (method === 'workspace.info') {
        const { path } = methods[method].params.parse(params)
        if (path === '/work/other')
          return Promise.resolve({ branch: 'other-branch', added: 0, removed: 0, dirtyFiles: 0 })
        if (undone) return new Promise((resolve) => finishInfo.push(resolve))
      }
      return request(method, params)
    })
    await openNewSession()
    await openCheckpointHistory()
    fireEvent.click(restoreButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Undo restore' }))
    await waitFor(() => expect(finishInfo.length).toBeGreaterThan(0))

    act(() => sidebarProps().onSelectSession('other-thread'))
    await waitFor(() => expect(composerProps().branch).toBe('other-branch'))
    await act(async () => {
      for (const finish of finishInfo)
        finish({ branch: 'project-branch', added: 0, removed: 0, dirtyFiles: 0 })
    })

    expect(composerProps().branch).toBe('other-branch')
  })

  it('keeps the next chat restore points when the previous chat read fails late', async () => {
    serverProjects[0]!.sessions.push({ id: 'second-thread', title: 'Second chat' })
    const request = transport.request.getMockImplementation()!
    let failFirst: ((error: Error) => void) | undefined
    transport.request.mockImplementation((method, params) => {
      if (
        method === 'thread.checkpoints' &&
        methods[method].params.parse(params).threadId === 'untouched-thread'
      )
        return new Promise((_, reject) => {
          failFirst = reject
        })
      return request(method, params)
    })
    const header = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >
    await openNewSession()
    await waitFor(() => expect(failFirst).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /^Second chat,/ }))
    await waitFor(() => expect(header().checkpointCount).toBe(1))
    await act(async () => failFirst?.(new Error('checkpoints failed')))

    expect(header().sessionId).toBe('second-thread')
    expect(header().checkpointCount).toBe(1)
  })

  it('does not report a history failure for a chat the user already left', async () => {
    serverProjects[0]!.sessions.push({ id: 'second-thread', title: 'Second chat' })
    const request = transport.request.getMockImplementation()!
    let failFirst: ((error: Error) => void) | undefined
    transport.request.mockImplementation((method, params) => {
      if (
        method === 'thread.history' &&
        methods[method].params.parse(params).threadId === 'untouched-thread'
      )
        return new Promise((_, reject) => {
          failFirst = reject
        })
      return request(method, params)
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await waitFor(() => expect(failFirst).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /^Second chat,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'second-thread',
        page: NEWEST_PAGE,
      }),
    )
    await act(async () => failFirst?.(new Error('history read failed')))

    expect(screen.queryByText('history read failed')).toBeNull()
  })

  it('does not offer the previous restore target while inspecting another checkpoint', async () => {
    const request = transport.request.getMockImplementation()!
    let reject!: (error: Error) => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'thread.checkpoints')
        return Promise.resolve({
          checkpoints: [
            { id: 7, seq: 1, label: 'Fix the parser', createdAt: 1 },
            { id: 8, seq: 2, label: 'Fix the tests', createdAt: 2 },
          ],
        })
      if (
        method === 'thread.changedSince' &&
        methods[method].params.parse(params).checkpointId === 8
      )
        return new Promise((_, fail) => {
          reject = fail
        })
      return request(method, params)
    })
    await openNewSession()
    await openCheckpointHistory()
    fireEvent.click(screen.getByRole('button', { name: /Before “Fix the tests”/ }))
    expect(restoreButton().disabled).toBe(true)
    await act(async () => reject(new Error('inspection failed')))
    expect(restoreButton().disabled).toBe(true)
    expect(rpcCount('thread.restore')).toBe(0)
  })

  it('drops the previous chat restore points when switching to a running chat', async () => {
    serverProjects[0]!.sessions.push({ id: 'running-thread', title: 'Running chat' })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (
        method === 'thread.checkpoints' &&
        methods[method].params.parse(params).threadId === 'running-thread'
      )
        return Promise.resolve({ checkpoints: [] })
      if (
        method === 'thread.history' &&
        methods[method].params.parse(params).threadId === 'running-thread'
      )
        return Promise.resolve({ events: [], running: true })
      return request(method, params)
    })
    const openPalette = async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      await screen.findByRole('dialog', { name: 'Command palette' })
    }
    const closePalette = async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search commands' }), {
        key: 'Escape',
      })
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
      )
    }
    await openNewSession()
    fireEvent.click(screen.getByRole('button', { name: /^Running chat,/ }))
    startTurn('running-thread', 'turn-running')
    await screen.findByText('Working')

    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^New session,/ }).classList).toContain(
        'is-active',
      ),
    )
    await openPalette()
    expect(await screen.findByRole('option', { name: /Restore points/ })).toBeTruthy()
    await closePalette()

    fireEvent.click(screen.getByRole('button', { name: /^Running chat,/ }))
    await screen.findByText('Working')
    await openPalette()
    expect(screen.queryByRole('option', { name: /Restore points/ })).toBeNull()
  })

  it('clears the removed project chat and rejects its pending start completion', async () => {
    serverProjects.push({
      path: '/work/other',
      name: 'Other',
      pinned: false,
      createdAt: 1,
      sessions: [],
    })
    const request = transport.request.getMockImplementation()!
    let release!: (value: { threadId: string }) => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'thread.start')
        return new Promise((resolve) => {
          release = resolve
        })
      if (method === 'projects.remove') {
        serverProjects = serverProjects.filter((project) => project.path !== '/work/project')
        return Promise.resolve({})
      }
      return request(method, params)
    })
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    submitTurn('Pending removed project')
    await waitFor(() => expect(rpcCount('thread.start')).toBe(1))
    act(() => sidebarProps().onRemoveProject('/work/project'))
    await waitFor(() => expect(composerProps().projectPath).toBe('/work/other'))
    expect(composerProps().newSession).toBe(true)
    expect(screen.queryByTestId('thread')).toBeNull()
    // Even a stale list must not resurrect a removed project.
    serverProjects.push({
      path: '/work/project',
      name: 'project',
      pinned: false,
      createdAt: 0,
      sessions: [],
    })
    await act(async () => release({ threadId: 'late-thread' }))
    act(() => setConnectionState('open'))
    await act(async () => Promise.resolve())
    expect(sidebarProps().projects.map((project) => project.path)).toEqual(['/work/other'])
    expect(rpcCount('thread.sendTurn')).toBe(0)
    expect(transport.request).toHaveBeenCalledWith('thread.close', { threadId: 'late-thread' })
  })

  it.each(['select', 'send'] as const)('cancels a pending deletion on %s', async (activity) => {
    await openNewSession()
    const oldSend = composerProps().onSend
    act(() => sidebarProps().onDeleteSession('untouched-thread'))
    await screen.findByText('Chat deleted')
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
    act(() => {
      if (activity === 'select') sidebarProps().onSelectSession('untouched-thread')
      else oldSend('Keep this chat', [])
    })
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })
    expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull()
  })

  it.each(['number shortcut', 'next chat', 'palette'] as const)(
    'keeps a chat queued for deletion out of %s navigation',
    async (route) => {
      serverProjects[0]!.sessions.push({ id: 'doomed-thread', title: 'Doomed chat', createdAt: 5 })
      await openNewSession()
      act(() => sidebarProps().onDeleteSession('doomed-thread'))
      await screen.findByText('Chat deleted')
      if (route === 'number shortcut') fireEvent.keyDown(window, { key: '1', metaKey: true })
      else if (route === 'next chat')
        fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true, altKey: true })
      else {
        fireEvent.keyDown(window, { key: 'k', metaKey: true })
        fireEvent.change(await screen.findByRole('textbox', { name: 'Search commands' }), {
          target: { value: 'Doomed' },
        })
        expect(screen.queryByRole('option', { name: /Doomed chat/ })).toBeNull()
      }
      await act(async () => window.dispatchEvent(new Event('pagehide')))
      expect(transport.request).not.toHaveBeenCalledWith('thread.history', {
        threadId: 'doomed-thread',
        page: NEWEST_PAGE,
      })
      expect(transport.request).toHaveBeenCalledWith('thread.delete', {
        threadId: 'doomed-thread',
      })
    },
  )

  it('keeps a chat queued for deletion out of chat search', async () => {
    serverProjects[0]!.sessions.push({ id: 'doomed-thread', title: 'Doomed chat', createdAt: 5 })
    const contentHit = (threadId: string, threadTitle: string) => ({
      projectPath: '/work/project',
      projectName: 'project',
      threadId,
      threadTitle,
      turnId: `turn-in-${threadId}`,
      provider: 'codex',
      createdAt: 0,
      snippet: [{ text: 'Doomed', highlighted: true }],
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'search.sessions'
        ? Promise.resolve({
            results: [
              contentHit('doomed-thread', 'Doomed chat'),
              contentHit('untouched-thread', 'New session'),
            ],
            nextCursor: null,
          })
        : request(method, params),
    )
    await openNewSession()
    act(() => sidebarProps().onDeleteSession('doomed-thread'))
    await screen.findByText('Chat deleted')

    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'Doomed' },
    })
    // The kept chat's hit shows that the server's results have arrived.
    expect(await screen.findByRole('option', { name: /^New session, project,/ })).toBeTruthy()
    expect(screen.queryAllByRole('option', { name: /^Doomed chat,/ })).toHaveLength(0)

    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'doomed-thread',
    })
  })

  it('does not open a chat queued for deletion after settling the active chat', async () => {
    serverProjects[0]!.sessions.push(
      { id: 'kept-thread', title: 'Kept chat', createdAt: 3 },
      { id: 'doomed-thread', title: 'Doomed chat', createdAt: 5 },
    )
    await openNewSession()
    act(() => sidebarProps().onDeleteSession('doomed-thread'))
    await screen.findByText('Chat deleted')
    act(() => sidebarProps().inbox?.onSettle('untouched-thread'))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'kept-thread',
        page: NEWEST_PAGE,
      }),
    )
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(transport.request).not.toHaveBeenCalledWith('thread.history', {
      threadId: 'doomed-thread',
      page: NEWEST_PAGE,
    })
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'doomed-thread',
    })
  })

  it("forgets a deleted chat's saved model setup and keeps the others", async () => {
    serverProjects[0]!.sessions.push({ id: 'doomed-thread', title: 'Doomed chat', createdAt: 5 })
    const saved = JSON.stringify({ modelKey: 'codex:gpt-6.1-sol', effort: 'high' })
    localStorage.setItem('harness.modelByThread:doomed-thread', saved)
    localStorage.setItem('harness.modelByThread:untouched-thread', saved)
    await openNewSession()
    act(() => sidebarProps().onDeleteSession('doomed-thread'))
    await screen.findByText('Chat deleted')
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.delete', {
        threadId: 'doomed-thread',
      }),
    )
    await waitFor(() =>
      expect(localStorage.getItem('harness.modelByThread:doomed-thread')).toBeNull(),
    )
    expect(localStorage.getItem('harness.modelByThread:untouched-thread')).not.toBeNull()
  })

  it('cancels a deletion safety check when the chat is selected again', async () => {
    const request = transport.request.getMockImplementation()!
    let release!: (work: typeof serverUnsavedWork) => void
    transport.request.mockImplementation((method, params) =>
      method === 'thread.unsavedWork'
        ? new Promise((resolve) => {
            release = resolve
          })
        : request(method, params),
    )
    await openNewSession()
    act(() => sidebarProps().onDeleteSession('untouched-thread'))
    act(() => sidebarProps().onSelectSession('untouched-thread'))
    await act(async () => release({ isolated: false, uncommitted: false }))
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(rpcCount('thread.delete')).toBe(0)
    expect(screen.queryByText('Chat deleted')).toBeNull()
  })

  it('keeps populated histories and drafts even when titled New session', async () => {
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.history'
        ? Promise.resolve({
            events: [completedHistoryEvent(1, 'saved-message', 'Saved history')],
            running: false,
            approval: 'ask',
          })
        : request(method, params),
    )
    await openNewSession()
    await waitFor(() => expect(screen.getByTestId('thread').textContent).toContain('Saved history'))
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Saved draft' },
    })
    act(() => composerProps().onAttachmentsChange?.(['/work/saved.png']))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(rpcCount('thread.delete')).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    expect(screen.getByTestId('thread').textContent).toContain('Saved history')
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Saved draft',
    )
    expect(composerProps().draftRequest?.attachments).toEqual(['/work/saved.png'])
  })

  it('clears an established chat when its active project is removed', async () => {
    serverProjects.push({
      path: '/work/other',
      name: 'Other',
      pinned: false,
      createdAt: 1,
      sessions: [],
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'projects.remove') {
        serverProjects = serverProjects.filter((project) => project.path !== '/work/project')
        return Promise.resolve({})
      }
      return request(method, params)
    })
    await openNewSession()
    act(() => sidebarProps().onRemoveProject('/work/project'))
    await waitFor(() => expect(composerProps().projectPath).toBe('/work/other'))
    expect(composerProps().newSession).toBe(true)
    expect(sidebarProps().activeSessionId).toBeUndefined()
    expect(screen.queryByTestId('thread')).toBeNull()
  })

  it('does not ask the code highlighter before a code block needs it', () => {
    render(<App />)

    expect(highlighterHighlight).not.toHaveBeenCalled()
  })

  it('routes edited-file undo through the exact thread, turn, and patch', async () => {
    await openNewSession()
    transport.request.mockClear()

    await act(async () => {
      await threadCallbacks.undoChanges?.('thread-1', 'turn-1', 'the exact diff')
    })

    expect(transport.request).toHaveBeenCalledWith('thread.undoTurnChanges', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      expectedDiff: 'the exact diff',
    })
  })

  it('hides older generations per source as soon as it answers, and saves no defaults', async () => {
    serverProviders = [...serverProviders, claudeCodeServerProvider()]
    // The names the adapters give these rows; the defaults read their generation there.
    const names = new Map([
      ['opus', 'Opus 5.5'],
      ['claude-opus-4-8', 'Opus 4.8'],
    ])
    const listed = (id: string, isDefault = false) => ({
      id,
      displayName: names.get(id) ?? id,
      isDefault,
      reasoningEfforts: [],
      serviceTiers: [],
    })
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseClaude!: (value: unknown) => void
    const claudeModels = new Promise((resolve) => {
      releaseClaude = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'models.list') return request(method, params)
      return methods['models.list'].params.parse(params).provider === 'claude-code'
        ? claudeModels
        : Promise.resolve({ models: [listed('gpt-6.1-sol', true), listed('gpt-5.5')] })
    })
    const offeredKeys = () => composerProps().models.map((choice) => choice.key)

    render(<App />)

    // Codex has answered and Claude Code has not: the picker already leaves
    // out the older Codex model instead of listing it until every provider
    // is done.
    await waitFor(() => expect(offeredKeys()).toContain('codex:gpt-6.1-sol'))
    expect(offeredKeys()).not.toContain('codex:gpt-5.5')

    await act(async () => {
      releaseClaude({ models: [listed('opus', true), listed('claude-opus-4-8')] })
      await claudeModels
    })

    await waitFor(() => expect(offeredKeys()).toEqual(['codex:gpt-6.1-sol', 'claude-code:opus']))
    // Defaults follow the catalog; only the moment Opus 5.5 took over is saved.
    expect(savedVisibility()?.overrides).toEqual({})
    expect(Object.keys(savedVisibility()?.firstSeen ?? {})).toEqual(['claude-code:opus'])
  })

  it('keeps a visibility edit made while live discovery is pending', async () => {
    // Load Settings first so this test measures discovery ordering.
    await import('./ui/Settings.js')
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()]),
    )
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseModels!: (value: unknown) => void
    const models = new Promise((resolve) => {
      releaseModels = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list' ? models : request(method, params),
    )

    render(<App />)
    openSettings()
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.click(await within(settings).findByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6 Sol in model picker' }),
    )

    await waitFor(() => expect(savedOverrides()).toEqual(['codex:gpt-6.1-sol=hidden']))
    releaseModels({
      models: [
        cachedCodexChoice().model,
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      ],
    })

    // The composer button names GPT-5.5 too once it is the visible choice, so
    // look for the Settings row by its switch.
    const legacy = await screen.findByRole('switch', { name: 'Include GPT-5.5 in model picker' })
    // The edit stays; GPT-5.5, listed only now, is hidden by its default
    // without anything saved for it.
    expect(legacy.getAttribute('aria-checked')).toBe('false')
    expect(savedOverrides()).toEqual(['codex:gpt-6.1-sol=hidden'])
  })

  it('never replaces a saved model-visibility choice with defaults', async () => {
    const saved = {
      overrides: { 'codex:gpt-6.1-sol': { visible: false, at: 1 } },
      firstSeen: {},
    }
    localStorage.setItem('harness.modelVisibility.v2', JSON.stringify(saved))
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list'
        ? Promise.resolve({
            models: [
              {
                id: 'gpt-6.1-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                reasoningEfforts: [],
                serviceTiers: [],
              },
              {
                id: 'gpt-5.5',
                displayName: 'GPT-5.5',
                isDefault: false,
                reasoningEfforts: [],
                serviceTiers: [],
              },
            ],
          })
        : request(method, params),
    )

    render(<App />)

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' }),
    )
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(savedVisibility()).toEqual(saved)
  })

  it("imports Leon's saved list once: newer generations take over, his own choice stays", async () => {
    serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
    // Format version 4, every row he still has listed recorded at 8, and one
    // model he hid himself.
    const hidden = [...LEON_HIDDEN_MODELS, 'codex:gpt-6-astra']
    localStorage.setItem('harness.modelVisibilityVersion', '4')
    localStorage.setItem('harness.hiddenModels', JSON.stringify(hidden))
    localStorage.setItem(
      'harness.modelVisibilityRows',
      JSON.stringify(
        Object.fromEntries(LEON_RECORDED_ROWS.concat('codex:gpt-6-astra').map((key) => [key, '8'])),
      ),
    )
    localStorage.setItem('harness.listedModels', '[]')
    mockLiveDiscovery()

    render(<App />)

    await waitFor(() => expect(offeredModelNames('grok')).toEqual(['Grok 4.7']))
    await waitFor(() =>
      expect(offeredModelNames('codex')).toEqual(['GPT-6.1-Sol', 'GPT-5.6-Terra', 'GPT-6-Luna']),
    )
    expect(offeredModelNames('claude-code')).toEqual([
      'Fable 5.1',
      'Opus 5.5',
      'Sonnet 5.5',
      'Haiku 5.5',
    ])
    await waitFor(() =>
      expect(savedOverrides()).toEqual([
        // A row his list hid that Claude Code no longer lists keeps its state.
        'claude-code:claude-haiku-4-5=hidden',
        'codex:gpt-6-astra=hidden',
      ]),
    )
    expect(savedVisibility()?.legacyHidden).toBeUndefined()
    for (const key of [
      'harness.hiddenModels',
      'harness.modelVisibilityVersion',
      'harness.modelVisibilityRows',
      'harness.listedModels',
    ]) {
      expect(localStorage.getItem(key)).toBeNull()
    }
  })

  it('returns an older build’s list to the current lineups from the cached catalog', async () => {
    serverProviders = [...serverProviders, claudeCodeServerProvider()]
    // Version 4 predates Claude Code's reset (7) and Codex's (8), so every
    // entry in this list was a default of that build, not a choice.
    localStorage.setItem('harness.modelVisibilityVersion', '4')
    localStorage.setItem('harness.hiddenModels', JSON.stringify(OLDER_BUILD_HIDDEN_MODELS))
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([
        ...choicesFor(
          { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
          claudeCodeLineup(),
        ),
        cachedCodexChoice(),
      ]),
    )
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list' ? new Promise(() => undefined) : request(method, params),
    )

    render(<App />)

    // Claude Code shows its cached rows until the picker needs it listed.
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' }),
    )
    // The first frame already shows Sonnet 5.5 and Haiku 5.5, which that
    // build hid while their aliases named an older generation.
    expect(offeredModelNames('claude-code')).toEqual([
      'Fable 5.1',
      'Opus 5.5',
      'Sonnet 5.5',
      'Haiku 5.5',
    ])
    expect(composerProps().models.map((choice) => choice.key)).toContain('codex:gpt-6.1-sol')
    await waitFor(() => expect(savedVisibility()).toBeDefined())
    expect(savedVisibility()?.overrides).toEqual({})
    expect(localStorage.getItem('harness.hiddenModels')).toBeNull()
  })

  it('imports a source the cache did not list once it is listed after the restored selection', async () => {
    serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
    localStorage.setItem('harness.provider', 'claude-code')
    localStorage.setItem('harness.model', 'claude-code:haiku')
    // Saved at version 8: the user hid Sonnet 5.5; Opus 5 is an old default.
    localStorage.setItem('harness.modelVisibilityVersion', '8')
    localStorage.setItem(
      'harness.hiddenModels',
      JSON.stringify(['claude-code:sonnet', 'claude-code:claude-opus-5']),
    )
    let releaseClaude!: (value: { models: Model[] }) => void
    const claudeModels = new Promise<{ models: Model[] }>((resolve) => {
      releaseClaude = resolve
    })
    mockDiscoveryWithFailingGrok(claudeModels)

    render(<App />)

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'claude-code' }),
    )
    // Only the restored selection paints for Claude Code, so its entries wait.
    expect(offeredModelNames('claude-code')).toEqual(['haiku'])
    await waitFor(() =>
      expect(savedVisibility()?.legacyHidden).toEqual([
        'claude-code:sonnet',
        'claude-code:claude-opus-5',
      ]),
    )

    await act(async () => {
      releaseClaude({ models: claudeCodeLineup() })
      await claudeModels
    })
    await settleDiscoveryWithFailingGrok(1)

    expect(offeredModelNames('claude-code')).toEqual(['Fable 5.1', 'Opus 5.5', 'Haiku 5.5'])
    await waitFor(() => expect(savedOverrides()).toEqual(['claude-code:sonnet=hidden']))
    expect(savedVisibility()?.legacyHidden).toBeUndefined()
  })

  it.each([
    ['from the cached catalog', true],
    ['once Claude Code is listed', false],
  ])(
    'keeps Opus 5 turned on across reloads while Grok cannot be listed, shown %s',
    async (_label, cached) => {
      serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
      if (cached) {
        localStorage.setItem(
          'harness.modelCatalog.v1',
          serializeModelCatalogCache([
            ...choicesFor(
              { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
              claudeCodeLineup(),
            ),
            cachedCodexChoice(),
          ]),
        )
      }
      mockDiscoveryWithFailingGrok()
      const currentLineup = ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']

      const first = render(<App />)
      await settleDiscoveryWithFailingGrok(1)

      expect(offeredModelNames('claude-code')).toEqual(currentLineup)
      expect(offeredModelNames('codex')).toEqual(['GPT-5.6 Sol'])
      openSettings()
      await act(() => vi.dynamicImportSettled())
      // Opening Settings lists Claude Code, which can still be settling.
      fireEvent.click(await screen.findByRole('button', { name: 'Models' }, { timeout: 5_000 }))
      fireEvent.click(await screen.findByRole('switch', { name: 'Include Opus 5 in model picker' }))
      await waitFor(() => expect(savedOverrides()).toEqual(['claude-code:claude-opus-5=shown']))
      first.unmount()

      for (const launch of [2, 3]) {
        const view = render(<App />)
        await settleDiscoveryWithFailingGrok(launch)

        expect(offeredModelNames('claude-code')).toEqual([...currentLineup, 'Opus 5'])
        expect(savedOverrides()).toEqual(['claude-code:claude-opus-5=shown'])
        view.unmount()
      }
    },
    // Three launches and the first Settings import, which alone can take
    // seconds on a loaded machine.
    15_000,
  )

  it('never starts a chat on another provider than the picker names while its source loads', async () => {
    const capabilities = {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: false,
      images: false,
    }
    serverProviders = [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities,
      },
      { id: 'grok', displayName: 'Grok', installed: true, auth: 'authenticated', capabilities },
    ]
    // No stored model yet, and the stored provider is still listing its models.
    localStorage.setItem('harness.provider', 'claude-code')
    const listed = (id: string) => ({
      id,
      displayName: id,
      isDefault: true,
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      serviceTiers: [],
    })
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseClaude!: (value: unknown) => void
    const claudeModels = new Promise((resolve) => {
      releaseClaude = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'models.list') return request(method, params)
      return methods['models.list'].params.parse(params).provider === 'claude-code'
        ? claudeModels
        : Promise.resolve({ models: [listed('grok-4.7')] })
    })

    render(<App />)
    const composer = (await screen.findByPlaceholderText('Do anything')) as HTMLTextAreaElement

    // Grok has answered and Claude Code has not. The picker must not name the
    // Grok default while a send would start Claude Code without a model.
    await waitFor(() =>
      expect(composerProps().models.map((choice) => choice.key)).toContain('grok:grok-4.7'),
    )
    expect(composerProps().modelPending).toBe(true)
    expect(screen.queryByRole('button', { name: 'Model and reasoning' })).toBeNull()
    expect(document.querySelector('.composer-skeleton-model')).toBeTruthy()
    fireEvent.change(composer, { target: { value: 'Wait for the model' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('title')).toBe(
      'Loading models…',
    )
    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())

    await act(async () => {
      releaseClaude({ models: [listed('opus')] })
      await claudeModels
    })

    // The Enter pressed while the model loaded is sent once it is known, on
    // the provider and model the picker names, never on Grok's default.
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({ provider: 'claude-code', model: 'opus' }),
      ),
    )
    expect(transport.request).not.toHaveBeenCalledWith(
      'thread.start',
      expect.objectContaining({ provider: 'grok' }),
    )
  })

  it('keeps a choice made before a new profile is listed, while Grok cannot be listed', async () => {
    serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
    // A launch before this one cached the catalog but saved no visibility.
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([
        ...choicesFor(
          { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
          claudeCodeLineup(),
        ),
        cachedCodexChoice(),
      ]),
    )
    let releaseClaude!: (value: { models: Model[] }) => void
    const claudeModels = new Promise<{ models: Model[] }>((resolve) => {
      releaseClaude = resolve
    })
    mockDiscoveryWithFailingGrok(claudeModels)

    const first = render(<App />)
    openSettings()
    await act(() => vi.dynamicImportSettled())
    fireEvent.click(await screen.findByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include Sonnet 5.5 in model picker' }),
    )
    await waitFor(() => expect(savedOverrides()).toEqual(['claude-code:sonnet=hidden']))
    await act(async () => {
      releaseClaude({ models: claudeCodeLineup() })
      await claudeModels
    })
    await settleDiscoveryWithFailingGrok(1)
    first.unmount()

    mockDiscoveryWithFailingGrok()
    for (const launch of [2, 3]) {
      const view = render(<App />)
      await settleDiscoveryWithFailingGrok(launch)

      expect(offeredModelNames('claude-code')).toEqual(['Fable 5.1', 'Opus 5.5', 'Haiku 5.5'])
      expect(savedOverrides()).toEqual(['claude-code:sonnet=hidden'])
      view.unmount()
    }
  })

  it('keeps a choice on an ACP agent row while Grok cannot be listed', async () => {
    serverProviders = [
      ...serverProviders,
      claudeCodeServerProvider(),
      grokServerProvider(),
      { ...claudeCodeServerProvider(), id: 'acp', displayName: 'ACP agent' },
    ]
    mockDiscoveryWithFailingGrok()
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'acp.agents')
        return Promise.resolve({
          agents: [{ id: 'kimi', name: 'Kimi CLI', installed: true, verified: true }],
        })
      if (method === 'models.list' && methods['models.list'].params.parse(params).agent === 'kimi')
        return Promise.resolve({
          models: [
            {
              id: 'model-x',
              displayName: 'Model X',
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [],
            },
          ],
        })
      return request(method, params)
    })

    const first = render(<App />)
    await settleDiscoveryWithFailingGrok(1)
    await waitFor(() =>
      expect(composerProps().models.map((choice) => choice.key)).toContain('acp:kimi:model-x'),
    )
    openSettings()
    await act(() => vi.dynamicImportSettled())
    fireEvent.click(await screen.findByRole('button', { name: 'Models' }))
    fireEvent.click(await screen.findByRole('switch', { name: 'Include Model X in model picker' }))
    await waitFor(() => expect(savedOverrides()).toEqual(['acp:kimi:model-x=hidden']))
    first.unmount()

    for (const launch of [2, 3]) {
      const view = render(<App />)
      await settleDiscoveryWithFailingGrok(launch)
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('models.list', {
          provider: 'acp',
          agent: 'kimi',
        }),
      )
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

      expect(savedOverrides()).toEqual(['acp:kimi:model-x=hidden'])
      expect(composerProps().models.map((choice) => choice.key)).not.toContain('acp:kimi:model-x')
      view.unmount()
    }
  })

  it('lets a newly listed generation take over in the same session, once', async () => {
    // Load Settings first so this test measures discovery ordering.
    await import('./ui/Settings.js')
    const row = (id: string, displayName: string, isDefault = false): Model => ({
      id,
      displayName,
      isDefault,
      reasoningEfforts: [],
      serviceTiers: [],
    })
    let lineup = [row('gpt-6.1-sol', 'GPT-6.1-Sol', true), row('gpt-5.6-terra', 'GPT-5.6-Terra')]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list' ? Promise.resolve({ models: lineup }) : request(method, params),
    )
    const refreshes = () =>
      transport.request.mock.calls.filter(([method]) => method === 'models.list').length

    const first = render(<App />)
    await waitFor(() =>
      expect(offeredModelNames('codex')).toEqual(['GPT-6.1-Sol', 'GPT-5.6-Terra']),
    )
    openSettings()
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.click(await within(settings).findByRole('button', { name: 'Models' }))
    // Turned off and on again: an explicit choice to show GPT-5.6-Terra.
    const terra = () =>
      screen.getByRole('switch', { name: 'Include GPT-5.6-Terra in model picker' })
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6-Terra in model picker' }),
    )
    fireEvent.click(terra())
    await waitFor(() => expect(savedOverrides()).toEqual(['codex:gpt-5.6-terra=shown']))

    // A refresh lists GPT-6-Terra: the older generation gives way although
    // the user had shown it, without a restart.
    // A later moment than the choice, as it always is outside a test.
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 5)))
    lineup = [...lineup, row('gpt-6-terra', 'GPT-6-Terra')]
    const before = refreshes()
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() => expect(refreshes()).toBe(before + 1))
    await waitFor(() => expect(offeredModelNames('codex')).toEqual(['GPT-6.1-Sol', 'GPT-6-Terra']))
    expect(terra().getAttribute('aria-checked')).toBe('false')

    // Showing it again now sticks across a reload.
    fireEvent.click(terra())
    await waitFor(() => expect(terra().getAttribute('aria-checked')).toBe('true'))
    first.unmount()
    render(<App />)
    await waitFor(() =>
      expect(offeredModelNames('codex')).toEqual(['GPT-6.1-Sol', 'GPT-5.6-Terra', 'GPT-6-Terra']),
    )
  })

  it('saves All on a large source as one change', async () => {
    serverProviders = [grokServerProvider()]
    localStorage.setItem('harness.provider', 'grok')
    const rows: Model[] = Array.from({ length: 300 }, (_, index) => ({
      id: `grok-row-${index}`,
      displayName: `Row ${String.fromCharCode(97 + (index % 26))}${'z'.repeat(Math.floor(index / 26))}`,
      isDefault: index === 0,
      reasoningEfforts: [],
      serviceTiers: [],
    }))
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list' ? Promise.resolve({ models: rows }) : request(method, params),
    )

    render(<App />)
    // A source this large starts with its first four rows.
    await waitFor(() => expect(offeredModelNames('grok')).toHaveLength(4))
    openSettings()
    await act(() => vi.dynamicImportSettled())
    fireEvent.click(await screen.findByRole('button', { name: 'Models' }))
    const setItem = vi.spyOn(localStorage, 'setItem')
    try {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Show all Grok models in model picker' }),
      )
      await waitFor(() => expect(offeredModelNames('grok')).toHaveLength(300))
      expect(
        setItem.mock.calls.filter(([key]) => key === 'harness.modelVisibility.v2'),
      ).toHaveLength(1)
      expect(savedOverrides()).toHaveLength(296)
    } finally {
      setItem.mockRestore()
    }
  })

  it.each([
    [7, 1],
    [1, 0],
  ])(
    'lists the models again on focus %i hours after the last listing: %i more',
    async (hours, more) => {
      render(<App />)
      await waitFor(() => expect(rpcCount('models.list')).toBe(1))
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + hours * 60 * 60_000)

      act(() => window.dispatchEvent(new Event('focus')))
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('models.list')).toBe(1 + more)
      // The window showing again right after does not list a second time.
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('models.list')).toBe(1 + more)
    },
  )

  it('lists the models again once the app updated a provider', async () => {
    let updated = false
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) => {
      switch (method) {
        case 'providers.updates':
          return Promise.resolve({
            updates: [
              {
                provider: 'codex',
                displayName: 'Codex',
                currentVersion: updated ? '0.163.0' : '0.154.0',
                latestVersion: '0.163.0',
                updateAvailable: !updated,
                canUpdate: true,
              },
            ],
          })
        case 'providers.update':
          updated = true
          return Promise.resolve({ terminalId: 'update-codex' })
        case 'terminal.status':
          return Promise.resolve({ status: 'exited', output: '', outputOffset: 0, exitCode: 0 })
        default:
          return request(method, params)
      }
    })

    render(<App />)
    await waitFor(() => expect(rpcCount('models.list')).toBe(1))
    const store = providerUpdatesStore(transport.instance as Transport)
    await act(() => store.start('codex'))

    await waitFor(() => expect(store.snapshot().operations.codex?.phase).toBe('succeeded'))
    await waitFor(() => expect(rpcCount('models.list')).toBe(2))
    // Exactly once for the update.
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(rpcCount('models.list')).toBe(2)
  })

  describe('when the server announces a changed model list', () => {
    const row = (id: string, displayName: string, isDefault = false): Model => ({
      id,
      displayName,
      isDefault,
      reasoningEfforts: [],
      serviceTiers: [],
    })
    const announce = (payload: { provider: string; agent?: string }) =>
      act(() => transport.listeners.get('models.changed')?.(payload))
    const settled = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    it('lists that source again on its own', async () => {
      let lineup = [row('gpt-6-astra', 'GPT-6-Astra', true)]
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'models.list' ? Promise.resolve({ models: lineup }) : request(method, params),
      )

      render(<App />)
      await waitFor(() => expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra']))
      lineup = [...lineup, row('gpt-6.1-sol', 'GPT-6.1-Sol')]
      announce({ provider: 'codex' })

      await waitFor(() =>
        expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra', 'GPT-6.1-Sol']),
      )
      expect(rpcCount('models.list')).toBe(2)
      // Only that list, not the whole catalog.
      expect(rpcCount('providers.list')).toBe(1)

      // A source this catalog does not list is not requested.
      announce({ provider: 'acp', agent: 'kimi' })
      await settled()
      expect(rpcCount('models.list')).toBe(2)
    })

    it('lists once more after the listing a change arrived during', async () => {
      const answers: Array<() => void> = []
      let lineup = [row('gpt-6-astra', 'GPT-6-Astra', true)]
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'models.list'
          ? new Promise((resolve) => {
              const listed = lineup
              answers.push(() => resolve({ models: listed }))
            })
          : request(method, params),
      )

      render(<App />)
      await waitFor(() => expect(answers).toHaveLength(1))
      lineup = [...lineup, row('gpt-6-luna', 'GPT-6-Luna')]
      announce({ provider: 'codex' })
      announce({ provider: 'codex' })
      act(() => answers[0]!())
      await waitFor(() => expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra']))

      await waitFor(() => expect(answers).toHaveLength(2))
      act(() => answers[1]!())
      await waitFor(() => expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra', 'GPT-6-Luna']))
      await settled()
      expect(rpcCount('models.list')).toBe(2)
    })

    it('keeps the source where it stood', async () => {
      serverProviders = [...serverProviders, claudeCodeServerProvider()]
      mockLiveDiscovery()
      const sourceOrder = () => [
        ...new Set(composerProps().models.map((choice) => choice.provider)),
      ]

      render(<App />)
      await waitFor(() => expect(offeredModelNames('claude-code')).not.toEqual([]))
      await settled()
      expect(sourceOrder()).toEqual(['codex', 'claude-code'])
      announce({ provider: 'codex' })
      await waitFor(() => expect(rpcCount('models.list')).toBe(3))
      await settled()
      expect(sourceOrder()).toEqual(['codex', 'claude-code'])
    })

    it('keeps a newer list that settled before the rest of the catalog', async () => {
      serverProviders = [...serverProviders, claudeCodeServerProvider()]
      let lineup = [row('gpt-6-astra', 'GPT-6-Astra', true)]
      let releaseClaude!: () => void
      const claudeModels = new Promise<{ models: Model[] }>((resolve) => {
        releaseClaude = () => resolve({ models: claudeCodeLineup() })
      })
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method: string, params: unknown) => {
        if (method !== 'models.list') return request(method, params)
        return methods['models.list'].params.parse(params).provider === 'claude-code'
          ? claudeModels
          : Promise.resolve({ models: lineup })
      })

      render(<App />)
      await waitFor(() => expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra']))
      lineup = [...lineup, row('gpt-6.1-sol', 'GPT-6.1-Sol')]
      announce({ provider: 'codex' })
      await waitFor(() =>
        expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra', 'GPT-6.1-Sol']),
      )
      // Claude Code still holds the catalog open; its end must not bring back
      // the list Codex answered first.
      await act(async () => releaseClaude())
      await waitFor(() => expect(offeredModelNames('claude-code')).not.toEqual([]))
      await settled()
      expect(offeredModelNames('codex')).toEqual(['GPT-6-Astra', 'GPT-6.1-Sol'])
    })
  })

  describe('for a provider the composer is not on', () => {
    const cachedClaudeChoices = () =>
      choicesFor(
        { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
        claudeCodeLineup(),
      )
    const listedProviders = () =>
      transport.request.mock.calls
        .filter(([method]) => method === 'models.list')
        .map(([, params]) => methods['models.list'].params.parse(params).provider)
    const settled = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    const launchWithCachedClaude = async () => {
      serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
      localStorage.setItem(
        'harness.modelCatalog.v1',
        serializeModelCatalogCache([...cachedClaudeChoices(), cachedCodexChoice()]),
      )
      mockLiveDiscovery()
      render(<App />)
      await waitFor(() => expect(listedProviders()).toEqual(['codex']))
      await settled()
      // Grok has nothing cached and waits too.
      expect(listedProviders()).toEqual(['codex'])
    }

    it('shows its cached rows and lists it once the picker opens', async () => {
      await launchWithCachedClaude()
      expect(offeredModelNames('claude-code')).toEqual([
        'Fable 5.1',
        'Opus 5.5',
        'Sonnet 5.5',
        'Haiku 5.5',
      ])
      // A change to a source left for later waits until it is needed.
      act(() => transport.listeners.get('models.changed')?.({ provider: 'claude-code' }))
      await settled()
      expect(listedProviders()).not.toContain('claude-code')

      act(() => composerProps().onModelSelectorOpen?.())
      await waitFor(() =>
        expect([...listedProviders()].sort()).toEqual(['claude-code', 'codex', 'grok']),
      )
      act(() => composerProps().onModelSelectorOpen?.())
      await settled()
      expect(rpcCount('models.list')).toBe(3)
    })

    it('lists it as soon as the composer moves to it', async () => {
      await launchWithCachedClaude()
      const opus = cachedClaudeChoices().find((choice) => choice.model.displayName === 'Opus 5.5')!
      act(() => composerProps().onModelChange(opus.key))
      await waitFor(() => expect(listedProviders()).toEqual(['codex', 'claude-code']))
      await settled()
      expect(listedProviders()).toEqual(['codex', 'claude-code'])
    })

    it('lists it when Settings opens', async () => {
      await launchWithCachedClaude()
      openSettings()
      await waitFor(() => expect(listedProviders()).toContain('claude-code'))
    })

    it('puts a source with nothing cached in its place once the picker lists it', async () => {
      serverProviders = [...serverProviders, claudeCodeServerProvider(), grokServerProvider()]
      localStorage.setItem(
        'harness.modelCatalog.v1',
        serializeModelCatalogCache([
          cachedCodexChoice(),
          ...choicesFor({ provider: 'grok', sourceName: 'Grok', mark: 'grok' }, [
            { ...cachedCodexChoice().model, id: 'grok-4.7', displayName: 'Grok 4.7' },
          ]),
        ]),
      )
      mockLiveDiscovery()
      const sourceOrder = () => [
        ...new Set(composerProps().models.map((choice) => choice.provider)),
      ]
      render(<App />)
      await waitFor(() => expect(listedProviders()).toEqual(['codex']))
      await settled()
      // Claude Code has nothing cached and waits for the picker as well.
      expect(sourceOrder()).toEqual(['codex', 'grok'])

      act(() => composerProps().onModelSelectorOpen?.())
      await waitFor(() => expect(offeredModelNames('claude-code')).not.toEqual([]))
      await settled()
      expect(sourceOrder()).toEqual(['codex', 'claude-code', 'grok'])
    })

    it('lists an agent that registers after the picker opened', async () => {
      const kimi = { id: 'kimi', name: 'Kimi CLI' }
      localStorage.setItem(
        'harness.modelCatalog.v1',
        serializeModelCatalogCache([
          cachedCodexChoice(),
          ...choicesFor({ provider: 'acp', sourceName: kimi.name, mark: 'kimi', agent: kimi }, [
            { ...cachedCodexChoice().model, id: 'kimi-k3', displayName: 'Kimi K3' },
          ]),
        ]),
      )
      let releaseAgents!: () => void
      const agents = new Promise<unknown>((resolve) => {
        releaseAgents = () =>
          resolve({ agents: [{ id: 'kimi', name: 'Kimi CLI', installed: true, verified: true }] })
      })
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'acp.agents' ? agents : request(method, params),
      )
      render(<App />)
      await waitFor(() => expect(listedProviders()).toEqual(['codex']))

      act(() => composerProps().onModelSelectorOpen?.())
      await act(async () => releaseAgents())
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('models.list', {
          provider: 'acp',
          agent: 'kimi',
        }),
      )
    })
  })

  it('explains project loading failures and recovers after reconnect', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let attempts = 0
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'projects.list' && attempts++ === 0) {
        return Promise.reject(new Error('server unavailable'))
      }
      return request(method, params)
    })

    render(<App />)

    expect(
      within(screen.getByRole('main')).getByText('Loading projects…').closest('[role="status"]'),
    ).not.toBeNull()
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('heading').textContent).toContain('Projects could not be loaded')

    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })

    expect((await screen.findByRole('heading')).textContent).toContain(
      'What should we build in project?',
    )
    expect(attempts).toBe(2)
  })

  it('paints the new-chat heading from the last run before projects load', async () => {
    const firstRun = render(<App />)
    await screen.findByRole('heading', { name: 'What should we build in project?' })
    expect(localStorage.getItem('harness.startupProjectName')).toBe('project')
    firstRun.unmount()

    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let listProjects: (() => void) | undefined
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'projects.list'
        ? new Promise((resolve) => {
            listProjects = () => resolve(request(method, params))
          })
        : request(method, params),
    )
    serverProjects = [serverProject('/work/project', 'Renamed project')]

    render(<App />)

    expect(screen.getByRole('heading').textContent).toBe('What should we build in project?')
    expect(within(screen.getByRole('main')).queryByText('Loading projects…')).toBeNull()
    expect(within(screen.getByRole('navigation')).getByText('Loading projects…')).toBeTruthy()

    await waitFor(() => expect(listProjects).toBeDefined())
    act(() => listProjects?.())

    await screen.findByRole('heading', { name: 'What should we build in Renamed project?' })
    await waitFor(() =>
      expect(localStorage.getItem('harness.startupProjectName')).toBe('Renamed project'),
    )
  })

  it('forgets the remembered project when the server has none', async () => {
    localStorage.setItem('harness.startupProjectName', 'Removed project')
    serverProjects = []

    render(<App />)

    expect(screen.getByRole('heading').textContent).toBe('What should we build in Removed project?')
    await screen.findByRole('heading', { name: 'Add a project to start building.' })
    expect(localStorage.getItem('harness.startupProjectName')).toBeNull()
  })

  it('adds the first project from the empty state', async () => {
    serverProjects = []
    pickFolder.mockResolvedValue('/work/new-project')
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'projects.add') {
        serverProjects = [
          {
            path: '/work/new-project',
            name: 'new-project',
            pinned: false,
            createdAt: 0,
            sessions: [],
          },
        ]
        return Promise.resolve({
          path: '/work/new-project',
          name: 'new-project',
          pinned: false,
          createdAt: 0,
        })
      }
      return request(method, params)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('projects.add', {
        path: '/work/new-project',
      })
    })
    expect(
      await screen.findByRole('heading', { name: 'What should we build in new-project?' }),
    ).toBeTruthy()
  })

  it.each(['projects.add', 'projects.list'])(
    'reports a failed %s when adding a project',
    async (failedMethod) => {
      serverProjects = []
      pickFolder.mockResolvedValue('/work/new-project')
      const request = transport.request.getMockImplementation()!
      let adding = false
      transport.request.mockImplementation((method, params) => {
        if (method === 'projects.add') adding = true
        if (adding && method === failedMethod) return Promise.reject(new Error('connection lost'))
        return request(method, params)
      })

      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))

      expect(await screen.findByText('connection lost')).toBeTruthy()
    },
  )

  it('adds one or many dropped folders without adding duplicates twice', async () => {
    serverProjects = []
    droppedProjectFolderPaths.mockResolvedValue([
      '/work/first-project',
      '/work/second-project',
      '/work/first-project',
    ])
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'projects.add') {
        const { path } = methods['projects.add'].params.parse(params)
        const name = path.split('/').at(-1) ?? path
        if (!serverProjects.some((project) => project.path === path)) {
          serverProjects.push({ path, name, pinned: false, createdAt: 0, sessions: [] })
        }
        return Promise.resolve({ path, name, pinned: false, createdAt: 0 })
      }
      return request(method, params)
    })

    render(<App />)

    const rail = await screen.findByRole('navigation')
    const files = [new File([], 'first-project'), new File([], 'second-project')]
    const dataTransfer = { files, types: ['Files'], dropEffect: 'none' }
    fireEvent.dragEnter(rail, { dataTransfer })
    fireEvent.drop(rail, { dataTransfer })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('projects.add', {
        path: '/work/first-project',
      })
      expect(transport.request).toHaveBeenCalledWith('projects.add', {
        path: '/work/second-project',
      })
    })
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'projects.add'),
    ).toHaveLength(2)
    expect(
      await screen.findByRole('heading', { name: 'What should we build in second-project?' }),
    ).toBeTruthy()
  })

  it('keeps the dropped folders that were added when another one fails', async () => {
    serverProjects = []
    droppedProjectFolderPaths.mockResolvedValue(['/work/first-project', '/work/second-project'])
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'projects.add') {
        const { path } = methods['projects.add'].params.parse(params)
        if (path === '/work/second-project') return Promise.reject(new Error('permission denied'))
        const name = path.split('/').at(-1) ?? path
        serverProjects.push({ path, name, pinned: false, createdAt: 0, sessions: [] })
        return Promise.resolve({ path, name, pinned: false, createdAt: 0 })
      }
      return request(method, params)
    })

    render(<App />)

    const rail = await screen.findByRole('navigation')
    const files = [new File([], 'first-project'), new File([], 'second-project')]
    const dataTransfer = { files, types: ['Files'], dropEffect: 'none' }
    fireEvent.dragEnter(rail, { dataTransfer })
    fireEvent.drop(rail, { dataTransfer })

    expect(
      await screen.findByRole('heading', { name: 'What should we build in first-project?' }),
    ).toBeTruthy()
    expect(
      await screen.findByText('Could not add /work/second-project. permission denied'),
    ).toBeTruthy()
  })

  it('reports a folder picker failure instead of leaving it unhandled', async () => {
    serverProjects = []
    pickFolder.mockRejectedValue(new Error('folder dialog failed'))

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))

    expect(await screen.findByText('folder dialog failed')).toBeTruthy()
    expect(rpcCount('projects.add')).toBe(0)
  })

  it('opens the workspace directly on first launch', async () => {
    localStorage.removeItem('harness.provider')

    render(<App />)

    expect(screen.queryByText('Set up TasteCode')).toBeNull()
    expect(document.querySelector('.shell')).not.toBeNull()
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'codex' })
    })
  })

  it('moves a launch without a usable stored provider to the first ready one', async () => {
    // Every provider main parks is usable on nightly, so store one neither branch knows.
    localStorage.setItem('harness.provider', 'retired-provider')
    serverProviders = [
      { ...serverProviders[0]!, id: 'grok', displayName: 'Grok' },
      serverProviders[0]!,
    ]

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'grok' })
      expect(localStorage.getItem('harness.provider')).toBe('grok')
    })
  })

  it('keeps a usable stored provider when another one is listed first', async () => {
    serverProviders = [
      { ...serverProviders[0]!, id: 'grok', displayName: 'Grok' },
      serverProviders[0]!,
    ]

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'grok' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('auth.status', { provider: 'grok' })
    expect(localStorage.getItem('harness.provider')).toBe('codex')
  })

  it('starts a first launch on Claude Code until the server lists providers', async () => {
    localStorage.removeItem('harness.provider')
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'providers.list' ? new Promise(() => {}) : request(method, params),
    )

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'claude-code' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('auth.status', { provider: 'codex' })
  })

  it('keeps a stored provider instead of the Claude Code default', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'providers.list' ? new Promise(() => {}) : request(method, params),
    )

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'codex' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('auth.status', {
      provider: 'claude-code',
    })
  })

  it('lands a first launch on Claude Code when the server lists it first', async () => {
    localStorage.removeItem('harness.provider')
    serverProviders = [
      { ...serverProviders[0]!, id: 'claude-code', displayName: 'Claude Code' },
      serverProviders[0]!,
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'models.list') return request(method, params)
      const input = methods['models.list'].params.parse(params)
      return Promise.resolve({
        models: [
          {
            id: `${input.provider}-default`,
            displayName: `${input.provider} default`,
            isDefault: true,
            reasoningEfforts: [],
            serviceTiers: [],
          },
        ],
      })
    })

    render(<App />)

    await waitFor(() => {
      expect(localStorage.getItem('harness.model')).toBe('claude-code:claude-code-default')
    })
    expect(localStorage.getItem('harness.provider')).toBe('claude-code')
  })

  it('defers the closed workspace panel until first intent and then retains it', async () => {
    render(<App />)

    const launcher = await screen.findByRole('button', { name: 'Show workspace tools' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('.workspace-panel:not(.workspace-panel--bottom)')).toBeNull()

    fireEvent.pointerEnter(launcher)
    expect(document.querySelector('.workspace-panel:not(.workspace-panel--bottom)')).toBeNull()
    fireEvent.click(launcher)
    // The first open imports the workspace panel chunk, which vitest transforms
    // cold; that alone can take longer than waitFor's 1 s default.
    await waitFor(() => expect(document.querySelector('.workspace-panel')).toBeTruthy(), {
      timeout: 10_000,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace tools' }))
    expect(document.querySelector('.workspace-panel')).toBeTruthy()
    expect(document.querySelector('.workspace-panel')?.classList).not.toContain('is-open')
  })

  it.each(['macOS', 'Windows', 'Linux'])(
    'opens workspace tools repeatedly on %s',
    async (platform) => {
      shortcutPlatform.macOS = platform === 'macOS'
      const modifier = shortcutPlatform.macOS ? { metaKey: true } : { ctrlKey: true }
      render(<App />)

      await screen.findByRole('button', { name: 'Show workspace tools' })
      expect(document.querySelector('.workspace-panel:not(.workspace-panel--bottom)')).toBeNull()
      fireEvent.keyDown(window, { key: 't', ...modifier })

      expect(await screen.findByRole('textbox', { name: 'Browser address' })).toBeTruthy()
      expect(document.querySelector('.workspace-panel')?.classList).toContain('is-open')
      fireEvent.click(screen.getByRole('button', { name: 'Hide workspace tools' }))
      expect(document.querySelector('.workspace-panel')?.classList).not.toContain('is-open')
      fireEvent.keyDown(window, { key: 't', ...modifier })
      await waitFor(() =>
        expect(document.querySelector('.workspace-panel')?.classList).toContain('is-open'),
      )
      fireEvent.keyDown(window, {
        key: shortcutPlatform.macOS ? 'π' : 'p',
        code: 'KeyP',
        ...modifier,
        altKey: true,
      })
      expect(await screen.findByRole('tab', { name: 'Files' })).toBeTruthy()
      fireEvent.keyDown(window, { key: ',', ...modifier })
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
      expect(fireEvent.keyDown(window, { key: 't', ...modifier })).toBe(true)
    },
  )

  it('returns open Settings to Keybinds when the keybinds shortcut is pressed again', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Show workspace tools' })

    fireEvent.keyDown(window, { key: '/', metaKey: true })
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    const keybinds = await within(settings).findByRole('button', { name: 'Keybinds' })
    expect(keybinds.getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(settings).getByRole('button', { name: 'Appearance' }))
    expect(keybinds.getAttribute('aria-current')).toBeNull()

    fireEvent.keyDown(window, { key: '/', metaKey: true })

    expect(keybinds.getAttribute('aria-current')).toBe('page')
  })

  it('mounts the deferred workspace panel for a preview capture', async () => {
    render(<App />)

    await waitFor(() => {
      expect(transport.listeners.has('preview.captureRequested')).toBe(true)
    })
    expect(document.querySelector('.workspace-panel:not(.workspace-panel--bottom)')).toBeNull()
    act(() => {
      transport.listeners.get('preview.captureRequested')?.({
        requestId: '00000000-0000-4000-8000-000000000001',
        url: 'http://127.0.0.1:4173/',
        viewports: [{ width: 1_280, height: 800 }],
      })
    })

    expect(await screen.findByRole('textbox', { name: 'Browser address' })).toBeTruthy()
    expect(document.querySelector('.workspace-panel')?.classList).toContain('is-open')
  })

  it('opens workspace tools from the app surface instead of native window chrome', async () => {
    render(<App />)

    const launcher = await screen.findByRole('button', { name: 'Show workspace tools' })
    expect(launcher.closest('.titlebar')).toBeNull()
    expect(launcher.closest('.stage')).toBeNull()
    fireEvent.click(launcher)
    expect(screen.queryByRole('button', { name: 'Show workspace tools' })).toBeNull()
    const close = await screen.findByRole('button', { name: 'Hide workspace tools' })
    expect(close).toBe(launcher)
    expect(close.closest('.panel-toggles')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    const terminalTab = await screen.findByTestId('terminal-pane')
    expect(screen.queryByRole('button', { name: 'Expand workspace tools' })).toBeNull()
    expect(close.closest('.stage')).toBeNull()
    fireEvent.click(close)
    expect(screen.getByRole('button', { name: 'Show workspace tools' })).toBe(launcher)
    expect(document.querySelector('.workspace-layout')?.classList.contains('is-panel-open')).toBe(
      false,
    )
    expect(document.querySelectorAll('.workspace-panel [role="tab"]')).toHaveLength(1)

    fireEvent.click(launcher)
    expect(await screen.findByTestId('terminal-pane')).toBe(terminalTab)
  })

  it('routes /side with an inline prompt into an ephemeral Side chat', async () => {
    localStorage.setItem('harness.models.cache', serializeModelCatalogCache([cachedCodexChoice()]))
    const fallback = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (
        method === 'thread.history' &&
        methods['thread.history'].params.parse(params).threadId === 'untouched-thread'
      ) {
        return Promise.resolve({
          events: [
            {
              seq: 1,
              event: {
                type: 'item.completed',
                item: {
                  id: 'main-user',
                  turnId: 'main-turn',
                  type: 'message',
                  role: 'user',
                  status: 'completed',
                  text: 'Fix the build',
                  createdAt: 1,
                },
              },
            },
          ],
          running: false,
        })
      }
      if (method === 'sideChat.start') return Promise.resolve({ threadId: 'side-1' })
      if (
        method === 'thread.history' &&
        methods['thread.history'].params.parse(params).threadId === 'side-1'
      ) {
        return Promise.resolve({ events: [], running: false })
      }
      return fallback(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: '/side why did it fail?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'sideChat.start',
        expect.objectContaining({ parentThreadId: 'untouched-thread' }),
      ),
    )
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ threadId: 'side-1', text: 'why did it fail?' }),
      ),
    )
    expect(screen.getByRole('textbox', { name: 'Message temporary chat' })).toBeTruthy()
    expect(screen.queryByText('From main chat')).toBeNull()
  })

  it('discovers a custom harness source and binds new sessions to its harness id', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'harnesses.list') {
        return Promise.resolve({
          harnesses: [
            {
              id: 'codex-fork',
              displayName: 'Codex Fork',
              provider: 'codex',
              command: 'codex-fork',
              args: [],
            },
          ],
        })
      }
      if (
        method === 'models.list' &&
        methods['models.list'].params.parse(params).agent === 'codex-fork'
      ) {
        return Promise.resolve({
          models: [
            {
              id: 'openrouter/deepseek-v3.2',
              displayName: 'DeepSeek V3.2',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'high',
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'codex',
        agent: 'codex-fork',
      }),
    )
    expect(
      (await screen.findByRole('button', { name: 'Model and reasoning' })).textContent,
    ).toContain('DeepSeek V3.2')
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use my Codex fork' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({
          provider: 'codex',
          agent: 'codex-fork',
          model: 'openrouter/deepseek-v3.2',
          effort: 'high',
        }),
      ),
    )
  })

  it('discovers a custom Pi source and binds new sessions to its harness id', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'harnesses.list') {
        return Promise.resolve({
          harnesses: [
            {
              id: 'deepseek-pi',
              displayName: 'DeepSeek Pi',
              provider: 'pi',
              command: 'deepseek-pi',
              args: [],
            },
          ],
        })
      }
      if (
        method === 'models.list' &&
        methods['models.list'].params.parse(params).agent === 'deepseek-pi'
      ) {
        return Promise.resolve({
          models: [
            {
              id: 'openrouter/deepseek-v3.2',
              displayName: 'DeepSeek V3.2',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'high',
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'pi',
        agent: 'deepseek-pi',
      }),
    )
    expect(
      (await screen.findByRole('button', { name: 'Model and reasoning' })).textContent,
    ).toContain('DeepSeek V3.2')
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use my Pi fork' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({
          provider: 'pi',
          agent: 'deepseek-pi',
          model: 'openrouter/deepseek-v3.2',
          effort: 'high',
        }),
      ),
    )
  })

  it('opens the pull-request workspace from the sidebar', async () => {
    // Resolve the lazy feature chunk before the click; the assertion is about
    // App routing, while PullRequestsView owns its own loading tests.
    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('projects.list', {})
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Pull requests' }))

    expect(await screen.findByRole('region', { name: 'Pull requests' })).toBeTruthy()
    expect(await screen.findByText('No pull requests')).toBeTruthy()
    expect(transport.request).toHaveBeenCalledWith('pullRequests.list', { refresh: false })
  })

  it('shows the chat checkout pull request in the header and opens it', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    const listed = {
      id: 'PR_12',
      repository: 'Blueemi/harness',
      number: 12,
      title: 'Teach the parser tables',
      url: 'https://github.com/Blueemi/harness/pull/12',
      author: { login: 'Blueemi', isBot: false },
      updatedAt: '2026-08-09T12:00:00Z',
      isDraft: false,
      state: 'OPEN',
      additions: 4,
      deletions: 1,
      commentsCount: 0,
      headRefName: 'feature/tables',
      baseRefName: 'main',
      relationship: 'authored',
    }
    let state = 'OPEN'
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'pullRequests.forCheckout') {
        return Promise.resolve({
          available: true,
          branch: 'feature/tables',
          repository: 'Blueemi/harness',
          pullRequest: {
            repository: 'Blueemi/harness',
            number: 12,
            title: 'Teach the parser tables',
            url: 'https://github.com/Blueemi/harness/pull/12',
            state,
            isDraft: false,
            checks: 'passing',
            headRefName: 'feature/tables',
          },
          fetchedAt: 1,
        })
      }
      if (method === 'pullRequests.list') {
        return Promise.resolve({
          account: { available: true, authenticated: true, login: 'Blueemi' },
          items: [{ ...listed, id: 'PR_13', number: 13, title: 'Newer change' }, listed],
          fetchedAt: Date.now(),
          truncated: false,
        })
      }
      if (method === 'pullRequests.detail') return new Promise(() => {})
      return request(method, params)
    })

    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)
    await act(async () => {
      await sidebarProps().onSelectSession('untouched-thread')
    })
    expect(
      await screen.findByRole('button', {
        name: 'Pull request #12: Open, Checks passing. Show in Pull requests',
      }),
    ).toBeTruthy()
    expect(transport.request).toHaveBeenCalledWith('pullRequests.forCheckout', {
      projectPath: '/work/project',
      threadId: 'untouched-thread',
    })

    // The agent merged it during the turn; the chip catches up when the turn ends.
    const asked = rpcCount('pullRequests.forCheckout')
    startTurn('untouched-thread', 'turn-1')
    state = 'MERGED'
    completeTurn('untouched-thread', 'turn-1')
    expect(
      await screen.findByRole('button', {
        name: 'Pull request #12: Merged. Show in Pull requests',
      }),
    ).toBeTruthy()
    expect(rpcCount('pullRequests.forCheckout')).toBe(asked + 1)

    fireEvent.click(screen.getByRole('button', { name: /^Pull request #12:/ }))
    expect(await screen.findByRole('region', { name: 'Pull requests' })).toBeTruthy()
    await waitFor(() =>
      expect(document.querySelector('.pr-list-item.is-selected')?.textContent).toContain(
        'Teach the parser tables',
      ),
    )
  })

  it.each([
    {
      account: { available: false, authenticated: false, error: 'GitHub CLI is not installed' },
      action: 'install' as const,
      button: 'Install GitHub CLI',
      tab: 'GitHub CLI install',
      terminalId: 'term-github-install',
      columns: 100,
      canCancelSignIn: false,
    },
    {
      account: { available: true, authenticated: false, error: 'Sign in with gh auth login' },
      action: 'login' as const,
      button: 'Sign in',
      tab: 'GitHub login',
      terminalId: 'term-github-login',
      columns: 320,
      canCancelSignIn: true,
    },
  ])('opens GitHub $action in the expanded workspace terminal', async (scenario) => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let setupComplete = false
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'pullRequests.list') {
        return Promise.resolve({
          account: setupComplete
            ? scenario.action === 'install'
              ? { available: true, authenticated: false, error: 'Sign in with gh auth login' }
              : { available: true, authenticated: true, login: 'Blueemi' }
            : scenario.account,
          items: [],
          fetchedAt: Date.now(),
          truncated: false,
        })
      }
      if (method === 'pullRequests.setup') {
        return Promise.resolve({ terminalId: scenario.terminalId })
      }
      return request(method, params)
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )

    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pull requests' }))
    fireEvent.click(await screen.findByRole('button', { name: scenario.button }))

    const workspace = document.querySelector<HTMLElement>('.workspace-layout')!
    await waitFor(() => expect(workspace.classList.contains('is-panel-open')).toBe(true))
    expect(workspace.classList.contains('is-panel-expanded')).toBe(true)
    expect(await screen.findByLabelText(`${scenario.tab} terminal`)).toBeTruthy()
    if (scenario.canCancelSignIn) {
      expect(await screen.findByRole('button', { name: 'Cancel sign-in' })).toBeTruthy()
    } else {
      expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull()
    }
    expect(screen.queryByLabelText('Login code')).toBeNull()
    expect(transport.request).toHaveBeenCalledWith('pullRequests.setup', {
      action: scenario.action,
      columns: scenario.columns,
      rows: 30,
    })

    setupComplete = true
    act(() => {
      transport.listeners.get('terminal.exit')!({
        terminalId: scenario.terminalId,
        exitCode: 0,
      })
    })

    await waitFor(() => expect(screen.queryByLabelText(`${scenario.tab} terminal`)).toBeNull())
    await waitFor(() => expect(workspace.classList.contains('is-panel-open')).toBe(false))
    expect(transport.request).toHaveBeenCalledWith('pullRequests.list', { refresh: true })
    if (scenario.action === 'install') {
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
    } else {
      expect(await screen.findByText('No pull requests')).toBeTruthy()
    }
  })

  it('starts a new chat about a pull request from the Chat button', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    const pullRequest = {
      id: 'PR_1',
      repository: 'Blueemi/harness',
      number: 1,
      title: 'Add the parser',
      url: 'https://github.com/Blueemi/harness/pull/1',
      author: { login: 'Blueemi', isBot: false },
      updatedAt: '2026-08-09T12:00:00Z',
      isDraft: false,
      state: 'OPEN',
      additions: 12,
      deletions: 3,
      commentsCount: 0,
      headRefName: 'feature/parser',
      baseRefName: 'main',
      relationship: 'authored',
      localProjectPath: '/work/project',
    }
    const detail = {
      ...pullRequest,
      body: '',
      createdAt: '2026-08-09T11:00:00Z',
      headRefOid: 'head-oid',
      baseRefOid: 'base-oid',
      changedFiles: 1,
      mergeable: 'MERGEABLE',
      maintainerCanModify: true,
      reviewers: [],
      requestedReviewers: [],
      assignees: [],
      labels: [],
      checks: [],
      comments: [],
      reviews: [],
      reviewThreads: [],
      reviewThreadsTruncated: false,
      permissions: { canPush: true, canAdmin: false },
      mergeMethods: { merge: true, rebase: true, squash: true, deleteBranchOnMerge: false },
    }
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'pullRequests.list') {
        return Promise.resolve({
          account: { available: true, authenticated: true, login: 'Blueemi' },
          items: [pullRequest],
          fetchedAt: Date.now(),
          truncated: false,
        })
      }
      if (method === 'pullRequests.detail') {
        return Promise.resolve(detail)
      }
      if (method === 'thread.sendTurn') return Promise.reject(new Error('rejected'))
      return request(method, params)
    })

    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('projects.list', {})
    })
    const rejected =
      (fireEvent.click(screen.getByRole('button', { name: /^New session,/ })),
      await screen.findByPlaceholderText('Do anything'))
    fireEvent.keyDown(
      (fireEvent.change(rejected, { target: { value: 'Rejected draft' } }), rejected),
      { key: 'Enter' },
    )
    await waitFor(() => expect((rejected as HTMLTextAreaElement).value).toBe('Rejected draft'))
    fireEvent.click(await screen.findByRole('button', { name: 'Pull requests' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }))

    // Back on the chat surface, starting a new session with the PR link drafted.
    expect(screen.queryByRole('region', { name: 'Pull requests' })).toBeNull()
    const composer = await screen.findByPlaceholderText('Do anything')
    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toBe(
        'I wanted to work on https://github.com/Blueemi/harness/pull/1 (Add the parser).',
      )
    })
  })

  it('shows model discovery failures with a retry that preserves the draft', async () => {
    let failing = true
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list' && failing)
        return Promise.reject(new Error('Model service is offline'))
      return request(method, params)
    })
    render(<App />)
    const composer = (await screen.findByPlaceholderText('Do anything')) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Keep my model draft' } })
    const error = await screen.findByText('Could not load Codex models. Model service is offline')
    expect(error.closest('.composer__provider-shelf')).toBeTruthy()
    failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry models' }))
    await waitFor(() =>
      expect(
        screen.queryByText('Could not load Codex models. Model service is offline'),
      ).toBeNull(),
    )
    expect(composer.value).toBe('Keep my model draft')
  })

  it('restores the selected model immediately on the first cache-enabled launch', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') return Promise.reject(new Error('provider unavailable'))
      return request(method, params)
    })
    // Older builds persisted a bare model id rather than the source-qualified key.
    localStorage.setItem('harness.model', 'gpt-6.1-sol')
    localStorage.setItem('harness.effort', 'high')
    localStorage.setItem('harness.serviceTier', 'priority')
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({ codex: { modelKey: 'codex:gpt-6.1-sol', serviceTier: 'priority' } }),
    )

    render(<App />)

    expect(screen.queryByText('Loading models…')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    expect(
      await screen.findByRole('button', { name: 'Use gpt-6.1-sol through Codex' }),
    ).toBeTruthy()
    expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
      'Effort: High',
    )
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'codex',
      }),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(localStorage.getItem('harness.serviceTier')).toBe('priority')
    expect(localStorage.getItem('harness.modelCatalog.v1')).toBeNull()

    cleanup()
    transport.request.mockClear()
    render(<App />)
    expect(localStorage.getItem('harness.serviceTier')).toBe('priority')
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('workspace.info', { path: '/work/project' })
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep the valid tier' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({ provider: 'codex', serviceTier: 'priority' }),
      )
    })
  })

  it('shows a validated model snapshot while discovery refreshes in the background', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list') return new Promise(() => {})
      return request(method, params)
    })
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()]),
    )

    render(<App />)

    expect(screen.queryByText('Loading models…')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    expect(
      await screen.findByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }),
    ).toBeTruthy()
  })

  it('shows stale cached model names while discovery refreshes in the background', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list') return new Promise(() => {})
      return request(method, params)
    })
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()], { validatedAt: 0 }),
    )
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')

    render(<App />)

    const modelButton = await screen.findByRole('button', { name: 'Model and reasoning' })
    expect(modelButton.textContent).toContain('5.6 Sol')
    fireEvent.click(modelButton)
    expect(
      await screen.findByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }),
    ).toBeTruthy()
  })

  it('keeps the cached source when its discovery request fails', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let rejectModels!: (reason?: unknown) => void
    const failedDiscovery = new Promise<never>((_resolve, reject) => {
      rejectModels = reject
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') return failedDiscovery
      return request(method, params)
    })
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()]),
    )
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' })
    })
    await act(async () => {
      rejectModels(new Error('provider unavailable'))
      await failedDiscovery.catch(() => undefined)
    })
    await waitFor(() => {
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('gpt-6.1-sol')
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        '5.6 Sol',
      )
    })
  })

  it('does not turn a custom bootstrap into a server cache on failed discovery', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') return Promise.reject(new Error('provider unavailable'))
      return request(method, params)
    })
    localStorage.setItem('harness.model', 'custom:codex:private-model')
    localStorage.setItem(
      'harness.customModels.v1',
      JSON.stringify([{ provider: 'codex', modelId: 'private-model', displayName: '' }]),
    )

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' })
      expect(localStorage.getItem('harness.modelCatalog.v1')).toBeNull()
    })
  })

  it('unblocks a verified cached source without waiting on another provider catalog', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    serverProviders = [
      ...serverProviders,
      { ...serverProviders[0]!, id: 'grok', displayName: 'Grok' },
    ]
    let releaseProviders!: () => void
    const providersGate = new Promise<void>((resolve) => {
      releaseProviders = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list')
        return providersGate.then(() => ({ providers: serverProviders }))
      if (
        method === 'models.list' &&
        methods['models.list'].params.parse(params).provider === 'grok'
      )
        return new Promise(() => {})
      return request(method, params)
    })
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice()]),
    )
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')
    localStorage.setItem('harness.effort', 'ultra')
    localStorage.setItem('harness.serviceTier', 'priority')

    render(<App />)

    const modelButton = await screen.findByRole('button', { name: 'Model and reasoning' })
    expect(modelButton.textContent).toContain('High')
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('workspace.info', {
        path: '/work/project',
      })
    })
    const composer = screen.getByPlaceholderText('Do anything')
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    fireEvent.change(composer, { target: { value: 'Use what the UI shows' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect((composer as HTMLTextAreaElement).value).toBe('Use what the UI shows')
    expect(screen.queryByText('Checking providers…')).toBeNull()
    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
    await act(async () => {
      releaseProviders()
      await providersGate
    })
    await waitFor(() => expect(sendButton.disabled).toBe(false))
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
        model: 'gpt-6.1-sol',
        effort: 'high',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use what the UI shows',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-6.1-sol',
        effort: 'high',
      })
    })
  })

  it('fetches models for each installed ACP agent', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'acp.agents') {
        return Promise.resolve({
          agents: [{ id: 'kimi', name: 'Kimi CLI', installed: true, verified: true }],
        })
      }
      return request(method, params)
    })
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'acp',
        agent: 'kimi',
      })
    })
  })

  it('discovers models for every installed nightly provider', async () => {
    const installedDirectProviders = [
      'codex',
      'claude-code',
      'grok',
      'cursor',
      'opencode',
      'antigravity',
      'pi',
    ] as const
    serverProviders = installedDirectProviders.map((id) => ({
      ...serverProviders[0]!,
      id,
      displayName: id,
    }))
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'models.list') return request(method, params)
      const input = methods['models.list'].params.parse(params)
      return Promise.resolve({
        models: [
          {
            id: `${input.provider}-startup`,
            displayName: `${input.provider} startup`,
            isDefault: true,
            reasoningEfforts: [],
            serviceTiers: [],
          },
        ],
      })
    })

    render(<App />)

    await waitFor(() => {
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('codex-startup')
    })
    const directProviders = transport.request.mock.calls.flatMap(([method, params]) => {
      if (method !== 'models.list') return []
      const input = methods['models.list'].params.parse(params)
      return input.agent === undefined ? [input.provider] : []
    })
    expect(directProviders).toEqual([...installedDirectProviders])
  })

  it('starts an API-only chat through its selected connection without a vendor CLI', async () => {
    serverProviders = []
    localStorage.setItem('harness.provider', 'api')
    localStorage.setItem('harness.model', 'api:nan-1:deepseek-v4-flash')
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list')
        return Promise.resolve({ connections: [modelConnection()] })
      if (method === 'connections.models')
        return Promise.resolve({ models: [connectionChoice('nan-1').model] })
      if (method === 'thread.start') {
        const source = methods['thread.start'].params.parse(params)
        return Promise.resolve(request(method, params)).then((result) => {
          const { threadId } = methods['thread.start'].result.parse(result)
          serverProjects = serverProjects.map((project) => ({
            ...project,
            sessions: project.sessions.map((session) =>
              session.id === threadId
                ? { ...session, provider: source.provider, connectionId: source.connectionId }
                : session,
            ),
          }))
          return result
        })
      }
      return request(method, params)
    })
    render(<App />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        'deepseek v4 flash',
      ),
    )
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use this connection' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({
          provider: 'api',
          connectionId: 'nan-1',
          model: 'deepseek-v4-flash',
        }),
      ),
    )
    expect(transport.request).not.toHaveBeenCalledWith(
      'models.list',
      expect.objectContaining({ provider: 'api' }),
    )
    expect(transport.request).not.toHaveBeenCalledWith('auth.status', { provider: 'api' })
  })

  it.each(['loaded', 'pending', 'thread preference', 'source preference'] as const)(
    'restores a saved API chat using its own default model (%s)',
    async (scenario) => {
      serverProviders = []
      serverProjects = [
        {
          ...serverProjects[0]!,
          sessions: [
            {
              id: 'api-one',
              title: 'First connection',
              provider: 'api',
              connectionId: 'one',
              createdAt: 0,
              running: false,
            },
            {
              id: 'api-two',
              title: 'Second connection',
              provider: 'api',
              connectionId: 'two',
              createdAt: 0,
              running: false,
            },
          ],
        },
      ]
      const preferred = { modelKey: 'api:two:model-a' }
      if (scenario === 'thread preference')
        localStorage.setItem('harness.modelByThread:api-two', JSON.stringify(preferred))
      if (scenario === 'source preference')
        localStorage.setItem('harness.modelBySource', JSON.stringify({ 'api:two': preferred }))
      let releaseModels!: () => void
      const modelsReady =
        scenario === 'pending'
          ? new Promise<void>((resolve) => {
              releaseModels = resolve
            })
          : Promise.resolve()
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method, params) => {
        if (method === 'connections.list')
          return Promise.resolve({
            connections: [
              modelConnection({ id: 'one', displayName: 'First API', defaultModel: 'model-a' }),
              modelConnection({ id: 'two', displayName: 'Second API', defaultModel: 'model-b' }),
            ],
          })
        if (method === 'connections.models') {
          const { connectionId } = methods['connections.models'].params.parse(params)
          return modelsReady.then(() => ({
            models: [
              {
                ...connectionChoice(connectionId).model,
                id: 'model-a',
                displayName: 'Model A',
                isDefault: connectionId === 'one',
              },
              {
                ...connectionChoice(connectionId).model,
                id: 'model-b',
                displayName: 'Model B',
                isDefault: connectionId === 'two',
              },
            ],
          }))
        }
        return request(method, params)
      })
      render(<App />)
      if (scenario !== 'pending')
        await waitFor(() =>
          expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('api:two:model-b'),
        )
      fireEvent.click(
        await screen.findByRole('button', { name: 'Second connection, API connection' }),
      )
      if (scenario === 'pending') {
        await waitFor(() =>
          expect(transport.request).toHaveBeenCalledWith('thread.history', {
            threadId: 'api-two',
            page: NEWEST_PAGE,
          }),
        )
        await act(async () => releaseModels())
      }
      const expected = scenario.includes('preference') ? 'Model A' : 'Model B'
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
          expected,
        ),
      )
      fireEvent.click(screen.getByRole('button', { name: 'First connection, API connection' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
          'Model A',
        ),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Second connection, API connection' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
          expected,
        ),
      )
      const composer = screen.getByPlaceholderText('Do anything')
      fireEvent.change(composer, { target: { value: 'Continue on the second connection' } })
      fireEvent.keyDown(composer, { key: 'Enter' })
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith(
          'thread.sendTurn',
          expect.objectContaining({
            threadId: 'api-two',
            model: scenario.includes('preference') ? 'model-a' : 'model-b',
          }),
        ),
      )
    },
  )

  it('publishes the model catalog without waiting for the connection store', async () => {
    const request = transport.request.getMockImplementation()!
    const pendingConnections = new Promise<never>(() => {})
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list') return pendingConnections
      if (method === 'models.list') {
        return Promise.resolve({ models: [cachedCodexChoice().model] })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' })
    })
    await waitFor(() => {
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('gpt-6.1-sol')
    })
  })

  it('reports a refused connection list instead of silently dropping its models', async () => {
    // A build with the connection surface cached this choice. The server then
    // refuses the stored config — the failure an installed build produced when it
    // met a preset its schema did not know.
    const connectionChoice: ModelChoice = {
      key: 'api:nan-1:deepseek-v4-flash',
      provider: 'api',
      sourceName: 'NaN',
      mark: 'custom',
      connectionId: 'nan-1',
      model: {
        id: 'deepseek-v4-flash',
        displayName: 'deepseek-v4-flash',
        isDefault: true,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    }
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice(), connectionChoice]),
    )
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list') {
        return Promise.reject(
          new Error('invalid provider config: expected a version 1 connection list'),
        )
      }
      if (method === 'models.list') {
        return Promise.resolve({ models: [cachedCodexChoice().model] })
      }
      return request(method, params)
    })

    render(<App />)

    // Silence here left the connection's models on screen with no way to tell why
    // they stopped working, so the failure has to reach the composer, with the
    // reason and a way to try again.
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain('Could not load API connections.')
    expect(notice.textContent).toContain('expected a version 1 connection list')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('stays quiet when a connection list fails and no connection model was ever offered', async () => {
    // A server too old to know the method refuses it the same way a broken
    // connection list does. Nobody who never had a connection model needs to
    // hear about it, so the composer stays clear.
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list') {
        return Promise.reject(new Error('Method not found'))
      }
      if (method === 'models.list') {
        return Promise.resolve({ models: [cachedCodexChoice().model] })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() => {
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('gpt-6.1-sol')
    })
    expect(screen.queryByText(/Could not load API connections/)).toBeNull()
  })

  it('drops a cached connection model once the connection list settles without it', async () => {
    // The cache still holds a model paid for by a connection the user has since
    // removed. Once the list settles, the rebuilt catalog must not keep offering
    // it — a lingering entry is a picker choice that can never answer a turn.
    localStorage.setItem(
      'harness.modelCatalog.v1',
      serializeModelCatalogCache([cachedCodexChoice(), connectionChoice('gone-1')]),
    )
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list') return Promise.resolve({ connections: [] })
      if (method === 'models.list') {
        return Promise.resolve({ models: [cachedCodexChoice().model] })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() => {
      const cached = localStorage.getItem('harness.modelCatalog.v1') ?? ''
      expect(cached).toContain('gpt-6.1-sol')
      expect(cached).not.toContain('api:gone-1')
    })
    expect(screen.queryByText(/Could not load API connections/)).toBeNull()
  })

  it('reuses startup ACP detection when Settings opens', async () => {
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
    expect(transport.request).toHaveBeenCalledWith('acp.agents', {})

    openSettings()

    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'acp.agents'),
      ).toHaveLength(1)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Back to app' }))
    openSettings()
    await act(async () => {
      await Promise.resolve()
    })
    expect(transport.request.mock.calls.filter(([method]) => method === 'acp.agents')).toHaveLength(
      1,
    )
  })

  it('does not invent Automatic choices for empty agent model catalogs', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    const capabilities = {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: false,
      approvals: false,
      userInput: false,
      autoReview: false,
      images: false,
    }
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list') {
        return Promise.resolve({
          providers: [
            {
              id: 'claude-code',
              displayName: 'Claude Code',
              installed: true,
              auth: 'authenticated',
              capabilities,
            },
            {
              id: 'cursor',
              displayName: 'Cursor',
              installed: true,
              auth: 'authenticated',
              capabilities,
            },
            {
              id: 'opencode',
              displayName: 'OpenCode',
              installed: true,
              auth: 'authenticated',
              capabilities,
            },
          ],
        })
      }
      if (method === 'models.list') {
        return Promise.resolve({
          models:
            methods['models.list'].params.parse(params).provider === 'claude-code'
              ? [
                  {
                    id: 'fable',
                    displayName: 'Fable',
                    isDefault: true,
                    reasoningEfforts: [],
                    serviceTiers: [],
                  },
                ]
              : [],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.provider', 'claude-code')

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    expect(
      await screen.findByRole('button', { name: 'Use Fable through Claude Code' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use Automatic through Cursor' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use Automatic through OpenCode' })).toBeNull()
  })

  it('updates attachment availability when the selected source changes', async () => {
    const unsupported = {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: false,
      images: false,
    }
    serverProviders = [
      ...serverProviders,
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities: unsupported,
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const { provider } = methods['models.list'].params.parse(params)
        return Promise.resolve({
          models: [
            {
              id: provider === 'codex' ? 'gpt-6.1-sol' : 'sonnet',
              displayName: provider === 'codex' ? 'GPT-5.6 Sol' : 'Sonnet 5',
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.modelPickerLayout', 'rail')

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Attach files' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Codex models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }))
    expect(await screen.findByRole('button', { name: 'Attach files' })).toBeTruthy()
  })

  it('checks socket liveness when the app regains focus', () => {
    render(<App />)

    act(() => window.dispatchEvent(new Event('focus')))

    expect(transport.ensureHealthy).toHaveBeenCalledTimes(1)
  })

  describe('provider re-check on focus', () => {
    const calls = (name: string) =>
      transport.request.mock.calls.filter(([method]) => method === name).length
    const focusLater = (ms: number) => {
      vi.setSystemTime(Date.now() + ms)
      act(() => window.dispatchEvent(new Event('focus')))
    }
    const missingCursor: TestServerProvider = {
      id: 'cursor',
      displayName: 'Cursor',
      installed: false,
      auth: 'unknown',
      problem: 'cursor-agent is not on PATH',
    }

    afterEach(() => vi.useRealTimers())

    it('scans once per 30 seconds while a provider is missing and keeps the catalog', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      serverProviders = [...serverProviders, missingCursor]
      render(<App />)
      await waitFor(() => expect(calls('models.list')).toBe(1))

      focusLater(10_000)
      expect(calls('providers.list')).toBe(1)
      focusLater(20_000)
      focusLater(1_000)
      await waitFor(() => expect(calls('providers.list')).toBe(2))
      expect(calls('models.list')).toBe(1)
    })

    it('reloads the catalog when the scan finds the missing provider', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      serverProviders = [...serverProviders, missingCursor]
      render(<App />)
      await waitFor(() => expect(calls('models.list')).toBe(1))

      serverProviders = serverProviders.map((entry) =>
        entry.id === 'cursor' ? { id: 'cursor', displayName: 'Cursor', capabilities: {} } : entry,
      )
      focusLater(30_000)

      await waitFor(() => expect(calls('providers.list')).toBe(3))
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'cursor' }),
      )
    })

    it('asks again on focus for an account that could not be confirmed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      serverProviders = serverProviders.map((entry) => ({ ...entry, auth: 'unknown' }))
      const request = transport.request.getMockImplementation()!
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'auth.status' ? Promise.reject(new Error('timed out')) : request(method, params),
      )
      render(<App />)
      expect(await screen.findByText(/Could not confirm this account/)).toBeTruthy()

      focusLater(30_000)

      await waitFor(() => expect(calls('auth.status')).toBe(2))
      expect(calls('providers.list')).toBe(1)
    })

    it('leaves providers alone on focus when everything is ready', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      render(<App />)
      await waitFor(() => expect(calls('models.list')).toBe(1))

      focusLater(60_000)

      expect(calls('providers.list')).toBe(1)
      expect(calls('auth.status')).toBe(1)
    })
  })

  it('does not expose or initialize desktop dictation', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    expect(transport.request).not.toHaveBeenCalledWith('voice.status', expect.anything())
    expect(screen.queryByRole('button', { name: 'Record voice note' })).toBeNull()
  })

  it('checks desktop voice once without waiting for an unrelated connection catalog', async () => {
    desktopShell.enabled = true
    let resolveConnections!: (value: { connections: [] }) => void
    const connections = new Promise<{ connections: [] }>((resolve) => {
      resolveConnections = resolve
    })
    let resolveAccount!: (value: { signedIn: true }) => void
    const account = new Promise<{ signedIn: true }>((resolve) => {
      resolveAccount = resolve
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'connections.list') return connections
      if (method === 'auth.status') return account
      if (method === 'voice.status') return Promise.resolve({ available: true })
      return request(method, params)
    })

    render(<App />)
    await act(async () => resolveAccount({ signedIn: true }))
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'voice.status'),
    ).toHaveLength(1)

    await act(async () => resolveConnections({ connections: [] }))
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'voice.status'),
      ).toHaveLength(1)
    })
  })

  it('shows the last voice answer at once and corrects it when the read answers', async () => {
    desktopShell.enabled = true
    localStorage.setItem('harness.voiceAvailable:codex', 'true')
    let resolveVoice!: (value: { available: boolean }) => void
    const voice = new Promise<{ available: boolean }>((resolve) => {
      resolveVoice = resolve
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'voice.status') return voice
      return request(method, params)
    })

    render(<App />)
    // `codex login status` behind voice.status can take seconds; the composer does not wait.
    expect(
      await screen.findByRole('button', { name: 'Record voice note' }, { timeout: 10_000 }),
    ).toBeTruthy()
    expect(document.querySelector('.composer-skeleton-voice')).toBeNull()
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('voice.status', expect.anything()),
    )

    await act(async () => resolveVoice({ available: false }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record voice note' })).toBeNull(),
    )
    expect(localStorage.getItem('harness.voiceAvailable:codex')).toBe('false')
  })

  it('keeps the selected nightly provider when checking voice after discovery', async () => {
    desktopShell.enabled = true
    localStorage.setItem('harness.provider', 'cursor')
    serverProviders = [
      ...serverProviders,
      { ...serverProviders[0]!, id: 'cursor', displayName: 'Cursor' },
    ]
    let resolveProviders!: (value: { providers: ServerProvider[] }) => void
    const providers = new Promise<{ providers: ServerProvider[] }>((resolve) => {
      resolveProviders = resolve
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'providers.list') return providers
      if (method === 'voice.status') return Promise.resolve({ available: false })
      return request(method, params)
    })

    render(<App />)
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('connections.list', {}))
    expect(transport.request).not.toHaveBeenCalledWith('voice.status', expect.anything())

    await act(async () => resolveProviders({ providers: contractValidServerProviders() }))
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'voice.status'),
      ).toHaveLength(1)
      expect(transport.request).toHaveBeenCalledWith('voice.status', { provider: 'cursor' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('voice.status', { provider: 'codex' })
  })
})
describe('new chats', () => {
  it('keeps composer drafts separate for new chat and each session', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'Existing work', running: false },
          { id: 'thread-2', title: 'Background', running: false },
        ],
      },
    ]
    render(<App />)
    const composer = () => screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const draft = () => composer().value

    fireEvent.change(await screen.findByPlaceholderText('Do anything'), {
      target: { value: 'New chat prompt' },
    })
    dropFile(composer(), '/work/new-chat.png')
    expect(screen.getByRole('button', { name: 'Remove new-chat.png' })).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    expect(draft()).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove new-chat.png' })).toBeNull()

    fireEvent.change(composer(), { target: { value: 'Session one prompt' } })
    dropFile(composer(), '/work/session-one.png')

    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    expect(draft()).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove session-one.png' })).toBeNull()
    fireEvent.change(composer(), { target: { value: 'Session two prompt' } })

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(draft()).toBe('New chat prompt')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove new-chat.png' })).toBeTruthy(),
    )

    fireEvent.click(screen.getByRole('button', { name: /^Existing work,/ }))
    expect(draft()).toBe('Session one prompt')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove session-one.png' })).toBeTruthy(),
    )
    expect(screen.queryByRole('button', { name: 'Remove new-chat.png' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    expect(draft()).toBe('Session two prompt')
    expect(screen.queryByRole('button', { name: 'Remove session-one.png' })).toBeNull()

    await import('./ui/pull-requests/PullRequestsView.js')
    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }))
    expect(await screen.findByRole('region', { name: 'Pull requests' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    await waitFor(() => expect(draft()).toBe('Session two prompt'))
    fireEvent.click(screen.getByRole('button', { name: /^Existing work,/ }))
    await waitFor(() => expect(draft()).toBe('Session one prompt'))
    expect(screen.getByRole('button', { name: 'Remove session-one.png' })).toBeTruthy()
  })

  it.each(['while away', 'after returning'])(
    'keeps a paste that finishes saving %s with the chat it was pasted into',
    async (timing) => {
      serverProjects = [
        {
          path: '/work/project',
          name: 'project',
          pinned: false,
          createdAt: 0,
          sessions: [
            { id: 'thread-1', title: 'Existing work', running: false },
            { id: 'thread-2', title: 'Background', running: false },
          ],
        },
      ]
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
      let finish!: (path: string | undefined) => void
      act(() =>
        composerProps().onPendingAttachment!(
          new Promise<string | undefined>((resolve) => (finish = resolve)),
        ),
      )
      fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      if (timing === 'while away') {
        await act(async () => finish('/work/pasted.png'))
        expect(screen.queryByRole('button', { name: 'Remove pasted.png' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /^Existing work,/ }))
      } else {
        fireEvent.click(screen.getByRole('button', { name: /^Existing work,/ }))
        await act(async () => finish('/work/pasted.png'))
      }
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Remove pasted.png' })).toBeTruthy(),
      )
      fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      expect(screen.queryByRole('button', { name: 'Remove pasted.png' })).toBeNull()
    },
  )

  it('preloads plan limits under StrictMode and reuses them when Account opens', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let firstUsage = true
    let firstSocketClosed = false
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'usage.summary' && firstUsage) {
        firstUsage = false
        if (firstSocketClosed) return Promise.reject(new Error('Connection to server was closed'))
      }
      return request(method, params)
    })
    transport.close.mockImplementationOnce(() => {
      firstSocketClosed = true
    })
    transport.connect
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() =>
        window.setTimeout(() => {
          for (const listener of transport.stateListeners) listener('open')
        }, 0),
      )

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(transport.close).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
      ).toHaveLength(2)
    })
    transport.request.mockClear()
    // The popup's own request never answers here, so what it shows was preloaded.
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'usage.summary' ? new Promise(() => {}) : request(method, params),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    const codexLimits = await screen.findByRole('region', { name: 'Codex' })
    expect(within(codexLimits).getByText('75% left')).toBeTruthy()
    // Opening asks once, StrictMode's replay included, and says the limits are on screen.
    await waitFor(() =>
      expect(transport.request.mock.calls.filter(([method]) => method === 'usage.summary')).toEqual(
        [['usage.summary', { provider: 'codex', intent: 'visible' }]],
      ),
    )
  })

  it('cancels trailing plan-limit refreshes after a real unmount', async () => {
    const view = render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    transport.request.mockClear()

    act(() => transport.listeners.get('usage.changed')?.({ provider: 'codex' }))
    view.unmount()
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 120)))

    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())
  })

  it('keeps installed provider limit sources separate in the account overview', async () => {
    serverProviders = [
      ...serverProviders,
      { id: 'claude-code', displayName: 'Claude Code', installed: true, auth: 'authenticated' },
      { id: 'grok', displayName: 'Grok', installed: false, auth: 'unknown' },
    ]
    render(<App />)

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 120)))
    // Only the active provider is read at launch; the others wait for the popup.
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
    ).toHaveLength(1)

    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('region', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()
    // Each installed source is asked once now that its limits are on screen.
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'visible',
      })
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'claude-code',
        intent: 'visible',
      })
    })
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
    ).toHaveLength(2)
  })

  it('keeps plan limits and asks nothing new when switching chats of one provider', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-a', title: 'First chat', provider: 'codex', createdAt: 1, running: false },
          { id: 'thread-b', title: 'Second chat', provider: 'codex', createdAt: 0, running: false },
        ],
      },
    ]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'First chat, Codex' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    expect(await screen.findByText('75% left')).toBeTruthy()
    transport.request.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Second chat, Codex' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.history',
        expect.objectContaining({ threadId: 'thread-b' }),
      ),
    )
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 120)))

    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())
    expect(screen.getByText('75% left')).toBeTruthy()
  })

  it('shows pushed plan limits without asking again', async () => {
    render(<App />)
    expect(await screen.findByText('75% left')).toBeTruthy()
    transport.request.mockClear()

    act(() =>
      transport.listeners.get('usage.limits')?.({
        source: {
          provider: 'codex',
          status: 'ready',
          limits: [{ id: 'codex:primary', label: '5 hours', usedPercent: 40 }],
          checkedAt: Date.now(),
          origin: 'live',
        },
      }),
    )

    expect(await screen.findByText('60% left')).toBeTruthy()
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())
  })

  it('refreshes usage once for active-provider change bursts', async () => {
    render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    transport.request.mockClear()

    act(() => transport.listeners.get('usage.changed')?.({ provider: 'grok' }))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 120)))
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())

    act(() => {
      transport.listeners.get('usage.changed')?.({ provider: 'codex' })
      transport.listeners.get('usage.changed')?.({ provider: 'codex' })
    })
    await waitFor(() =>
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
      ).toHaveLength(1),
    )
  })

  it('refreshes provider usage after reconnecting without a selected thread', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    transport.request.mockClear()

    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
  })

  it('refreshes the current source after switching providers and completing a turn', async () => {
    serverProviders = [
      ...serverProviders,
      { id: 'claude-code', displayName: 'Claude Code', installed: true, auth: 'authenticated' },
    ]
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'claude-thread',
            title: 'Claude thread',
            provider: 'claude-code',
            createdAt: 0,
            running: false,
          },
        ],
      },
    ]
    render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      }),
    )
    transport.request.mockClear()
    fireEvent.click(await screen.findByRole('button', { name: 'Claude thread, Claude Code' }))
    // The provider switch reads the newly active source.
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'claude-code',
        intent: 'background',
      }),
    )
    transport.request.mockClear()

    emitThreadEvent(
      'claude-thread',
      { type: 'turn.completed', turnId: 'claude-turn', status: 'completed' },
      1,
    )

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'claude-code',
        intent: 'background',
      }),
    )
    expect(transport.request).not.toHaveBeenCalledWith(
      'usage.summary',
      expect.objectContaining({ provider: 'codex' }),
    )
  })

  it('shows consecutive prompts while the new session is still starting', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'thread.start') await startGate
      return request(method, params)
    })

    render(<App />)

    const composer = await screen.findByPlaceholderText('Do anything')
    let nextPaintReached = false
    let markNextPaint: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      if (callback.name === 'markNextPaint') markNextPaint = callback
      return 1
    })
    window.requestAnimationFrame(function markNextPaint() {
      nextPaintReached = true
    })
    fireEvent.pointerEnter(composer)
    await act(async () => {
      await import('./ui/Thread.js')
    })
    fireEvent.change(composer, { target: { value: 'Start immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(nextPaintReached).toBe(false)
    expect(screen.getByTestId('thread').textContent).toContain('Start immediately')
    expect(screen.getByRole('button', { name: 'Start immediately, Codex, working' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(document.querySelector('.stage__body.is-new-session')).toBeNull()
    act(() => markNextPaint?.(0))
    expect(nextPaintReached).toBe(true)
    const threadElement = screen.getByTestId('thread')

    fireEvent.change(composer, { target: { value: 'Then do this too' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Then do this too')
    expect(transport.request).not.toHaveBeenCalledWith('thread.sendTurn', expect.anything())

    await act(async () => releaseStart?.())
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'thread.sendTurn'),
      ).toHaveLength(2)
    })
    expect(screen.getByTestId('thread')).toBe(threadElement)
    emitThreadEvent(
      'thread-1',
      { type: 'turn.completed', turnId: 'turn-1', status: 'completed' },
      1,
    )
    transport.request.mockClear()
    act(() => {
      for (const listener of transport.sequenceGapListeners) listener(2, 4)
    })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'thread-1',
        afterSeq: 1,
      }),
    )
  })

  it('names an attachment-only session from its files', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    const props = shellRenders.composer.mock.lastCall?.[0] as ComponentProps<
      typeof import('./ui/Composer.js').Composer
    >
    act(() => props.onSend('', ['/work/reference.png', 'C:\\work\\brief.pdf']))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.rename', {
        threadId: 'thread-1',
        title: 'reference.png, brief.pdf',
      })
      expect(transport.request).toHaveBeenCalledWith('backgroundModel.generateTitle', {
        threadId: 'thread-1',
        prompt: 'reference.png, brief.pdf',
        expectedTitle: 'reference.png, brief.pdf',
      })
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({
          text: '',
          attachments: ['/work/reference.png', 'C:\\work\\brief.pdf'],
        }),
      )
    })
  })

  it('replaces the prompt fallback with a generated session title', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method !== 'backgroundModel.generateTitle') return request(method, params)
      const { threadId } = methods['backgroundModel.generateTitle'].params.parse(params)
      serverProjects = serverProjects.map((entry) => {
        return {
          ...entry,
          sessions: entry.sessions.map((session) =>
            session.id === threadId ? { ...session, title: 'Fix checkout cleanup' } : session,
          ),
        }
      })
      return { title: 'Fix checkout cleanup', applied: true }
    })

    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Investigate flaky checkout cleanup' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('backgroundModel.generateTitle', {
        threadId: 'thread-1',
        prompt: 'Investigate flaky checkout cleanup',
        expectedTitle: 'Investigate flaky checkout cleanup',
      })
      expect(
        screen.getByRole('button', { name: /^Fix checkout cleanup, Codex(?:,|$)/ }),
      ).toBeTruthy()
    })
  })

  it('keeps a title the user typed while the chat was starting', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'thread.start') await startGate
      if (method !== 'backgroundModel.generateTitle') return request(method, params)
      // Like the server, only replace a title that still matches the expected one.
      const { threadId, expectedTitle } =
        methods['backgroundModel.generateTitle'].params.parse(params)
      const current = serverProjects
        .flatMap((entry) => entry.sessions)
        .find((session) => session.id === threadId)
      if (current?.title !== expectedTitle) return { title: current?.title ?? '', applied: false }
      serverProjects = serverProjects.map((entry) => ({
        ...entry,
        sessions: entry.sessions.map((session) =>
          session.id === threadId ? { ...session, title: 'Generated title' } : session,
        ),
      }))
      return { title: 'Generated title', applied: true }
    })
    const header = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >

    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    submitTurn('Investigate flaky checkout cleanup')
    await waitFor(() => expect(header().sessionId).toMatch(/^pending:/))
    act(() => header().onRenameSession(header().sessionId!, 'My checkout notes'))
    await act(async () => releaseStart?.())

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.rename', {
        threadId: 'thread-1',
        title: 'My checkout notes',
      })
      const calls = transport.request.mock.calls.map(([method]) => method)
      expect(calls.lastIndexOf('projects.list')).toBeGreaterThan(calls.indexOf('thread.rename'))
    })
    expect(header().title).toBe('My checkout notes')
    expect(rpcCount('backgroundModel.generateTitle')).toBe(0)
  })

  it('keeps a starting chat in the header across a project-list refresh', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      const result = request(method, params)
      // The server has recorded the chat, but its reply has not arrived yet.
      if (method === 'thread.start') await startGate
      // Hold the follow-up refresh so the swap to the real id stays observable.
      if (method === 'thread.rename') await new Promise(() => undefined)
      return result
    })
    const header = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >

    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    submitTurn('Investigate flaky checkout cleanup')
    await waitFor(() => expect(header().sessionId).toMatch(/^pending:/))
    const pendingId = header().sessionId
    const listed = rpcCount('projects.list')
    act(() => transport.listeners.get('providerHistory.changed')?.({ threadIds: [] }))
    await waitFor(() => expect(rpcCount('projects.list')).toBe(listed + 1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(header().sessionId).toBe(pendingId)
    expect(header().title).toBe('Investigate flaky checkout cleanup')
    await act(async () => releaseStart?.())
    await waitFor(() => expect(header().sessionId).toBe('thread-1'))
    expect(sidebarProps().projects[0]?.sessions.map(({ id }) => id)).toEqual(['thread-1'])
  })

  it('does not load server history when a chat that is still starting is selected', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()!
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'thread.start') await startGate
      return request(method, params)
    })
    const header = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >

    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    submitTurn('Investigate flaky checkout cleanup')
    await waitFor(() => expect(header().sessionId).toMatch(/^pending:/))
    const pendingId = header().sessionId!
    await act(async () => {
      await sidebarProps().onSelectSession(pendingId)
    })

    expect(transport.request).not.toHaveBeenCalledWith(
      'thread.history',
      expect.objectContaining({ threadId: pendingId }),
    )
    expect(header().sessionId).toBe(pendingId)
    await act(async () => releaseStart?.())
    await waitFor(() => expect(header().sessionId).toBe('thread-1'))
  })

  it('pins a chat that was pinned while it was still starting', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'thread.start') await startGate
      if (method !== 'thread.pin') return request(method, params)
      const { threadId, pinned } = methods['thread.pin'].params.parse(params)
      serverProjects = serverProjects.map((entry) => ({
        ...entry,
        sessions: entry.sessions.map((session) =>
          session.id === threadId ? { ...session, pinned } : session,
        ),
      }))
      return {}
    })
    const header = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >

    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    submitTurn('Investigate flaky checkout cleanup')
    await waitFor(() => expect(header().sessionId).toMatch(/^pending:/))
    act(() => header().onToggleSessionPin(header().sessionId!))
    expect(header().pinned).toBe(true)
    await act(async () => releaseStart?.())

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.pin', {
        threadId: 'thread-1',
        pinned: true,
      })
      const calls = transport.request.mock.calls.map(([method]) => method)
      expect(calls.lastIndexOf('projects.list')).toBeGreaterThan(calls.indexOf('thread.rename'))
    })
    expect(header().pinned).toBe(true)
    expect(transport.request).not.toHaveBeenCalledWith('thread.pin', {
      threadId: expect.stringMatching(/^pending:/),
      pinned: true,
    })
  })

  it('carries Stop through new-session creation and interrupts the first turn', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    transport.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'thread.start') await startGate
      return request(method, params)
    })

    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Stop this immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect(
      ((await screen.findByRole('button', { name: 'Send' })) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(transport.request).not.toHaveBeenCalledWith('thread.interrupt', expect.anything())

    await act(async () => releaseStart?.())
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.interrupt', {
        threadId: 'thread-1',
      })
    })
    const methods = transport.request.mock.calls.map(([method]) => method)
    expect(methods.indexOf('thread.sendTurn')).toBeLessThan(methods.indexOf('thread.interrupt'))
  })

  it('keeps a draft and asks for a project when sending without one', async () => {
    serverProjects = []
    render(<App />)

    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Start after I choose a project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Choose a project before sending.',
    )
    expect((composer as HTMLTextAreaElement).value).toBe('Start after I choose a project')
    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
  })

  it('keeps composer errors until dismissed and shows a later failure again', async () => {
    serverProjects = []
    render(<App />)

    const composer = await screen.findByPlaceholderText('Do anything')
    vi.useFakeTimers()
    try {
      fireEvent.change(composer, { target: { value: 'Start after I choose a project' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      expect(screen.getByRole('alert').textContent).toContain('Choose a project before sending.')
      act(() => vi.advanceTimersByTime(10_000))
      expect(screen.getByRole('alert').closest('.composer__provider-shelf')).toBeTruthy()
      fireEvent.click(
        screen.getByRole('button', { name: 'Dismiss error: Choose a project before sending.' }),
      )
      expect(screen.queryByRole('alert')).toBeNull()
      expect((composer as HTMLTextAreaElement).value).toBe('Start after I choose a project')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(screen.getByRole('alert').textContent).toContain('Choose a project before sending.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers setup without clearing a loaded-thread draft when its provider cannot run', async () => {
    serverProviders = [
      {
        ...serverProviders[0]!,
        installed: false,
        setup: { installUrl: 'https://example.test/codex', login: 'app' },
        problem: 'codex is not on PATH',
      },
    ]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Send after setup' } })
    const setup = await screen.findByRole('button', { name: 'Set up provider' })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(setup)
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('Send after setup')
  })

  it('keeps a newer sign-out when the initial account read finishes late', async () => {
    serverProviders = [{ ...serverProviders[0]!, auth: 'unknown' }]
    let finishInitial!: (account: { signedIn: boolean }) => void
    let accountReads = 0
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'auth.status') {
        accountReads += 1
        return accountReads === 1
          ? new Promise<{ signedIn: boolean }>((resolve) => (finishInitial = resolve))
          : Promise.resolve({ signedIn: true })
      }
      return method === 'auth.signOut' ? Promise.resolve({}) : request(method, params)
    })
    render(<App />)
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Stay blocked' } })
    await openProviderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await within(screen.getByRole('dialog', { name: 'Settings' })).findByRole('button', {
      name: 'Sign in',
    })
    await act(async () => finishInitial({ signedIn: true }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen
        .getAllByRole('status')
        .some((status) => status.textContent?.includes('Sign in to use this provider.')),
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(['success', 'failure', 'cancel'] as const)(
    'restores Settings after Claude sign-in ends with %s',
    async (outcome) => {
      desktopShell.enabled = true
      serverProjects = []
      serverProviders = [
        ...serverProviders,
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          installed: true,
          auth: 'unknown',
          setup: {
            installUrl: 'https://code.claude.com/docs/en/getting-started',
            login: 'provider',
          },
        },
      ]
      let claudeSignedIn = false
      const request = transport.request.getMockImplementation()
      if (!request) throw new Error('missing request mock')
      transport.request.mockImplementation((method: string, params: unknown) => {
        if (method === 'auth.status') {
          const provider = methods['auth.status'].params.parse(params).provider
          return Promise.resolve({ signedIn: provider === 'claude-code' ? claudeSignedIn : true })
        }
        if (method === 'providers.launch') {
          return Promise.resolve({ terminalId: 'term-claude-login' })
        }
        if (method === 'terminal.close') return Promise.resolve({})
        return request(method, params)
      })
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        },
      )

      render(<App />)
      await openProviderSettings()
      await screen.findByText('Claude Code')
      expect(document.querySelector('.surface-enter')?.classList.contains('is-returning')).toBe(
        false,
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
      const workspace = document.querySelector<HTMLElement>('.workspace-layout')!
      expect(workspace.classList.contains('is-panel-open')).toBe(true)
      expect(workspace.classList.contains('is-panel-expanded')).toBe(true)
      expect(await screen.findByLabelText('Claude Code login terminal')).toBeTruthy()
      await waitFor(() =>
        expect(document.querySelector<HTMLElement>('.onboarding')?.hidden).toBe(true),
      )
      expect(transport.request).toHaveBeenCalledWith('providers.launch', {
        provider: 'claude-code',
        columns: 320,
        rows: 30,
      })

      expect(screen.queryByLabelText('Login code')).toBeNull()
      if (outcome === 'cancel') {
        fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
        await waitFor(() =>
          expect(transport.request).toHaveBeenCalledWith('terminal.close', {
            terminalId: 'term-claude-login',
          }),
        )
      } else {
        claudeSignedIn = outcome === 'success'
        act(() => {
          transport.listeners.get('terminal.exit')!({
            terminalId: 'term-claude-login',
            exitCode: outcome === 'success' ? 0 : 130,
          })
        })
      }

      await screen.findByRole('dialog', { name: 'Settings' })
      // Settings replaces the terminal in place: a fade would show the chat settling behind it.
      expect(document.querySelector('.surface-enter')?.classList.contains('is-returning')).toBe(
        true,
      )
      await waitFor(() => expect(workspace.classList.contains('is-panel-open')).toBe(false))
      expect(workspace.classList.contains('is-panel-expanded')).toBe(false)
      expect(screen.queryByLabelText('Claude Code login terminal')).toBeNull()
      await waitFor(() =>
        expect(
          screen.getByText('Claude Code').closest<HTMLElement>('.provider-row')!.textContent,
        ).toContain(
          outcome === 'success'
            ? 'Signed in'
            : outcome === 'failure'
              ? 'Sign-in failed'
              : 'Sign-in canceled',
        ),
      )
      if (outcome === 'failure') {
        expect(screen.getByRole('button', { name: 'Retry sign-in' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe(
          'false',
        )
        const issue = screen.getByRole('button', { name: 'Problem details' })
        expect(issue.closest('.provider-row')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Details' }))
        expect(await screen.findByLabelText('Install terminal')).toBeTruthy()
      }
    },
  )

  it('shows a running sign-in in its one workspace terminal again from Settings', async () => {
    // Load the lazy Settings dialog, workspace panel and terminal first, so this
    // test does not depend on an earlier test having imported them.
    await import('./ui/Settings.js')
    await import('./ui/workspace/WorkspacePanel.js')
    await import('./ui/InstallTerminal.js')
    desktopShell.enabled = true
    serverProjects = []
    serverProviders = [
      ...serverProviders,
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'unknown',
        setup: {
          installUrl: 'https://code.claude.com/docs/en/getting-started',
          login: 'provider',
        },
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'auth.status') {
        const provider = methods['auth.status'].params.parse(params).provider
        return Promise.resolve({ signedIn: provider !== 'claude-code' })
      }
      if (method === 'providers.launch') return Promise.resolve({ terminalId: 'term-claude-show' })
      if (method === 'terminal.close') return Promise.resolve({})
      return request(method, params)
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    const showTerminal = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Show terminal' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
      await waitFor(() =>
        expect(screen.getAllByLabelText('Claude Code login terminal')).toHaveLength(1),
      )
      expect(screen.getAllByRole('button', { name: 'Close Claude Code login' })).toHaveLength(1)
    }

    render(<App />)
    await openProviderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByLabelText('Claude Code login terminal')).toBeTruthy()

    // Closing the tab while the CLI still runs returns to Settings, which can bring it back.
    fireEvent.click(screen.getByRole('button', { name: 'Close Claude Code login' }))
    await screen.findByRole('dialog', { name: 'Settings' })
    expect(screen.queryByLabelText('Claude Code login terminal')).toBeNull()
    await showTerminal()

    // Settings opened on top of the open terminal reaches the same one.
    await openProviderSettings()
    await showTerminal()
  }, 20_000)

  it('offers a stored custom model from an enabled nightly provider', async () => {
    const stored = '[{"provider":"cursor","modelId":"cursor-large","displayName":"Cursor Large"}]'
    serverProviders = [
      ...serverProviders,
      {
        ...serverProviders[0]!,
        id: 'cursor',
        displayName: 'Cursor',
      },
    ]
    localStorage.setItem('harness.provider', 'cursor')
    localStorage.setItem('harness.model', 'custom:cursor:cursor-large')
    localStorage.setItem('harness.customModels.v1', stored)
    render(<App />)
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    fireEvent.change(composer, { target: { value: 'Use the provider default' } })
    await waitFor(() => expect(sendButton.disabled).toBe(false))
    expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
      'Cursor Large',
    )
    expect(localStorage.getItem('harness.customModels.v1')).toBe(stored)
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({ provider: 'cursor', model: 'cursor-large' }),
      ),
    )
  })

  it('keeps a draft through provider discovery failure and recovery', async () => {
    let failing = true
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list' && failing)
        return Promise.reject(new Error('provider discovery unavailable'))
      return request(method, params)
    })
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Recover this draft' } })
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load providers. provider discovery unavailable',
    )
    failing = false
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    expect((composer as HTMLTextAreaElement).value).toBe('Recover this draft')
  })

  it('moves the composer from the centered new-chat layout after the first prompt', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    expect(document.querySelector('.stage__body.is-new-session .composer')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Design' }))

    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Start building' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(document.querySelector('.stage__body.is-new-session')).toBeNull()
    })
    expect(transport.request).toHaveBeenCalledWith(
      'thread.sendTurn',
      expect.objectContaining({ attachments: [DESIGN_BRIEF_ATTACHMENT] }),
    )
    expect(document.querySelector('.stage__conversation > .composer')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe('true')

    emitThreadEvent('thread-1', {
      type: 'item.completed',
      item: {
        id: 'design-guard',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Design mode was turned off because this request is not a website design task.',
        createdAt: 1,
      },
    })
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
      'false',
    )

    // A finished or failed run releases the toggle too, so a follow-up prompt
    // is a normal turn instead of restarting the whole design flow.
    fireEvent.click(screen.getByRole('button', { name: 'Design' }))
    emitThreadEvent('thread-1', {
      type: 'item.completed',
      item: {
        id: 'design-complete',
        turnId: 'turn-2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Website built. Preview ready at http://127.0.0.1:5173/.',
        createdAt: 2,
      },
    })
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
      'false',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Design' }))
    emitThreadEvent('thread-1', {
      type: 'item.completed',
      item: {
        id: 'dashboard-complete',
        turnId: 'turn-3',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Dashboard built. Preview ready at http://127.0.0.1:5173/.',
        createdAt: 3,
      },
    })
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
      'false',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Design' }))
    emitThreadEvent('thread-1', {
      type: 'thread.error',
      threadId: 'thread-1',
      message: 'Design mode failed: preview command is not allowed',
    })
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('sends the design brief through a provider without structured input', async () => {
    // Briefing questions are TasteCode-owned and answered by the server, so a
    // provider that never declares `userInput` must still be able to submit.
    localStorage.setItem('harness.provider', 'claude-code')
    serverProviders = [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities: { interrupt: true },
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    // Since 174d079 a provider with an empty catalog has no selectable model,
    // so the adapter's real alias list is mirrored here.
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (
        method === 'models.list' &&
        methods['models.list'].params.parse(params).provider === 'claude-code'
      ) {
        return Promise.resolve({
          models: [
            {
              id: 'fable',
              displayName: 'Fable 5',
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Design' }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Design a landing page' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ attachments: [DESIGN_BRIEF_ATTACHMENT] }),
      ),
    )
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
    expect((composer as HTMLTextAreaElement).value).toBe('')
  })

  it('passes a rejected brief-answer request back through the thread', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.respondToUserInput'
        ? Promise.reject(new Error('disconnected'))
        : request(method, params),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))

    await expect(
      threadCallbacks.answerUserInput?.('brief-1', { palette: ['Warm'] }),
    ).rejects.toThrow('disconnected')
  })

  it('starts a new session in an isolated checkout when selected', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Workspace mode' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Isolated' }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Work in parallel' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
        isolate: true,
      })
    })
    fireEvent.click(
      await within(screen.getByRole('main')).findByRole('button', {
        name: /Options for Work in parallel/,
      }),
    )
    expect(await screen.findByText('harness/thread-1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Choose project' })).toBeNull()
  })

  it('selects an isolated base branch while a shared task runs without switching its checkout', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'shared-thread',
            title: 'Shared work',
            provider: 'codex',
            createdAt: 0,
            running: true,
          },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'workspace.switchBranch'
        ? Promise.reject(new Error('The shared checkout is busy'))
        : request(method, params),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace mode' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Isolated' }))
    const picker = await screen.findByRole('button', { name: 'Choose branch' })
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'feature/shelf' }))
    await waitFor(() => expect(picker.textContent).toContain('feature/shelf'))
    submitTurn('Work independently')
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({ baseRef: 'feature/shelf', isolate: true }),
      ),
    )
    expect(transport.request).not.toHaveBeenCalledWith('workspace.switchBranch', expect.anything())
    expect(screen.queryByText('The shared checkout is busy')).toBeNull()
  })

  it('switches the project checkout from the branch shelf before starting a chat', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    const branchPicker = await screen.findByRole('button', { name: 'Choose branch' })
    await waitFor(() => expect((branchPicker as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(branchPicker)
    fireEvent.click(screen.getByRole('menuitem', { name: 'feature/shelf' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('workspace.switchBranch', {
        path: '/work/project',
        branch: 'feature/shelf',
      })
      expect(screen.getByRole('button', { name: 'Choose branch' }).textContent).toContain(
        'feature/shelf',
      )
    })
  })
  it('remembers the selected branch after reopening the project', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const app = render(<App />)
    const picker = await screen.findByRole('button', { name: 'Choose branch' })
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('menuitem', { name: 'feature/shelf' }))
    await waitFor(() => expect(picker.textContent).toContain('feature/shelf'))
    app.unmount()
    render(<App />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose branch' }).textContent).toContain(
        'feature/shelf',
      ),
    )
    submitTurn('Use the saved branch')
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.start', expect.anything()),
    )
    expect(transport.request).toHaveBeenCalledWith('workspace.switchBranch', {
      path: '/work/project',
      branch: 'feature/shelf',
    })
  })

  it('passes main to atomic task start without switching the shared checkout first', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'workspace.info'
        ? Promise.resolve({ branch: 'feature/shelf', added: 0, removed: 0, dirtyFiles: 0 })
        : request(method, params),
    )
    render(<App />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose branch' }).textContent).toContain('main'),
    )
    expect(transport.request).not.toHaveBeenCalledWith('workspace.switchBranch', expect.anything())
    submitTurn('Start on main')
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.start', expect.anything()),
    )
    expect(transport.request).toHaveBeenCalledWith(
      'thread.start',
      expect.objectContaining({ baseRef: 'main' }),
    )
    expect(transport.request).not.toHaveBeenCalledWith('workspace.switchBranch', expect.anything())
  })

  it('starts a chat on the checkout without waiting for the branch list', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'workspace.branches' ? new Promise(() => undefined) : request(method, params),
    )
    render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', { path: '/work/project' }),
    )

    submitTurn('Start right away')

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.start', expect.anything()),
    )
    expect(transport.request).toHaveBeenCalledWith(
      'thread.start',
      expect.not.objectContaining({ baseRef: expect.anything() }),
    )
  })
  it.each([
    ['other project', 'harness.branch:/work/other', 'feature/shelf', 'main'],
    ['deleted branch', 'harness.branch:/work/project', 'deleted', 'main'],
    ['new choice', 'harness.branch:/work/project', 'feature/shelf', 'feature/shelf'],
  ])('handles a saved branch for %s', async (_case, key, value, expected) => {
    localStorage.setItem(key, value)
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)
    const picker = await screen.findByRole('button', { name: 'Choose branch' })
    await waitFor(() => expect(picker.textContent).toContain(expected))
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('menuitem', { name: 'main' }))
    await waitFor(() => expect(localStorage.getItem('harness.branch:/work/project')).toBe('main'))
  })

  it('starts workspace info and branch reads together', async () => {
    const request = transport.request.getMockImplementation()!
    let resolveInfo!: (value: ResultOf<'workspace.info'>) => void
    const info = new Promise<Parameters<typeof resolveInfo>[0]>(
      (resolve) => (resolveInfo = resolve),
    )
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'workspace.info' ? info : request(method, params),
    )
    render(<App />)
    await waitForInitialWorkspace()
    await act(async () => resolveInfo({ branch: 'main', added: 0, removed: 0, dirtyFiles: 0 }))
  })
  it('refreshes workspace metadata after completion but not on submit', async () => {
    await openNewSession()
    transport.request.mockClear()
    submitTurn('Do the work')
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ threadId: 'untouched-thread', text: 'Do the work' }),
      ),
    )
    expect(rpcCount('workspace.info')).toBe(0)
    startTurn('untouched-thread', 'turn-1')
    completeTurn('untouched-thread', 'turn-1')
    await waitForWorkspace(1)
  })
  it('coalesces overlapping completion probes before refreshing workspace metadata', async () => {
    const probes = await renderWithDeferredProjectProbes()
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) completeTurn('untouched-thread', turnId)
    await waitFor(() => expect(probes).toHaveLength(1))
    expect(rpcCount('projects.list')).toBe(1)
    await act(async () => probes[0]?.resolve(projectsSnapshot(true)))
    await waitFor(() => expect(probes).toHaveLength(2))
    expect(rpcCount('projects.list')).toBe(2)
    await act(async () => probes[1]?.resolve(projectsSnapshot(false)))
    await waitForWorkspace(1)
  })
  it.each([
    'reject',
    'missing',
    'started',
    'submitted',
    'unrelated',
    'sole reject',
    'rejected before probe',
    'rejected after probe',
    'rejected after retained idle',
    'switched reject',
  ] as const)(
    'settles workspace metadata when the probe sequence ends with %s',
    async (scenario) => {
      let rejectSend!: (reason: Error) => void
      if (scenario.startsWith('rejected')) {
        const request = transport.request.getMockImplementation()!
        transport.request.mockImplementation((method: string, params: unknown) =>
          method === 'thread.sendTurn'
            ? new Promise((_, reject) => (rejectSend = reject))
            : request(method, params),
        )
      }
      if (scenario === 'switched reject') {
        serverProjects.push(
          serverProject('/work/another-project', 'Another Project', [
            { id: 'background-thread', title: 'Background', running: false },
          ]),
        )
        serverProjects[0]!.sessions.push({
          id: 'idle-thread',
          title: 'Idle work',
          running: false,
        })
      }
      const submitted = scenario === 'submitted' || scenario === 'unrelated'
      if (scenario === 'unrelated')
        serverProjects[0]!.sessions.push({
          id: 'background-thread',
          running: false,
        })
      const probes = await renderWithDeferredProjectProbes()
      if (scenario === 'switched reject') {
        startTurn('untouched-thread', 'turn-1')
        transport.request.mockClear()
        fireEvent.click(screen.getByRole('button', { name: /^Idle work,/ }))
        expect(rpcCount('workspace.info')).toBe(0)
      }
      completeTurn('untouched-thread', 'turn-1')
      await waitFor(() => expect(probes).toHaveLength(1))
      if (scenario.startsWith('rejected')) {
        if (scenario === 'rejected after retained idle') {
          completeTurn('untouched-thread', 'turn-2')
          await act(async () => probes[0]?.resolve(projectsSnapshot(false)))
          await waitFor(() => expect(probes).toHaveLength(2))
        }
        submitTurn('Rejected start')
        if (scenario === 'rejected before probe') await act(async () => rejectSend(new Error('no')))
        if (scenario !== 'rejected after retained idle')
          await act(async () => probes[0]?.resolve(projectsSnapshot(false)))
        else await act(async () => probes[1]?.reject(new Error('trailing failed')))
        if (scenario === 'rejected after probe') {
          await act(async () => rejectSend(new Error('no')))
          await waitFor(() => expect(probes).toHaveLength(2))
          await act(async () => probes[1]?.resolve(projectsSnapshot(false)))
        } else if (scenario === 'rejected after retained idle') {
          await act(async () => rejectSend(new Error('no')))
          await waitFor(() => expect(probes).toHaveLength(3))
          await act(async () => probes[2]?.resolve(projectsSnapshot(false)))
        }
        await waitForWorkspace(1)
        return
      }
      if (scenario === 'sole reject') {
        await act(async () => probes[0]?.reject(new Error('probe failed')))
        await waitFor(() => expect(probes).toHaveLength(2))
        await act(async () => probes[1]?.resolve(projectsSnapshot(false)))
      } else {
        completeTurn('untouched-thread', 'turn-2')
        if (submitted) {
          submitTurn('Start again')
          if (scenario === 'unrelated') {
            startTurn('background-thread', 'background')
            completeTurn('background-thread', 'background')
          }
        }
        await act(async () => probes[0]?.resolve(projectsSnapshot(false)))
        await waitFor(() => expect(probes).toHaveLength(2))
        if (scenario === 'switched reject') {
          fireEvent.keyDown(window, { key: 'p', metaKey: true })
          fireEvent.click(await screen.findByRole('option', { name: /^Another Project / }))
          await waitFor(() =>
            expect(transport.request).toHaveBeenCalledWith('workspace.info', {
              path: '/work/another-project',
            }),
          )
          transport.request.mockClear()
          completeTurn('background-thread', 'background')
          await act(async () => probes[1]?.reject(new Error('old project failed')))
          await waitFor(() => expect(probes).toHaveLength(3))
          await act(async () => probes[2]?.reject(new Error('new project failed')))
          await waitFor(() => expect(probes).toHaveLength(4))
          await act(async () => probes[3]?.resolve(projectsSnapshot(false)))
          await waitForWorkspace(1)
          return
        }
        if (scenario === 'started') startTurn('untouched-thread', 'turn-3')
        await act(async () =>
          scenario === 'missing'
            ? probes[1]?.resolve({ projects: [] })
            : submitted
              ? probes[1]?.resolve(projectsSnapshot(false))
              : probes[1]?.reject(new Error('probe failed')),
        )
      }
      if (scenario === 'started' || submitted) {
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
        expect(rpcCount('workspace.info')).toBe(0)
        return
      }
      await waitForWorkspace(1)
    },
  )
  it.each(['indeterminate', 'approval', 'inactive queue', 'durable queue', 'overlap'] as const)(
    'refreshes after reconnect reconciles %s as idle',
    async (scenario) => {
      const request = transport.request.getMockImplementation()!
      if (scenario === 'approval' || scenario === 'overlap')
        serverProjects[0]!.sessions[0]!.status = scenario === 'approval' ? 'approval' : 'working'
      else if (scenario === 'inactive queue' || scenario === 'durable queue')
        serverProjects[0]!.sessions.push({
          id: 'background-thread',
          title: 'Background',
          running: false,
        })
      const queuedTurn = { id: 'queued-turn', text: 'Reconnect me', attachments: [], createdAt: 1 }
      let reconnecting = false
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.sendTurn'
          ? scenario === 'indeterminate'
            ? Promise.reject(new IndeterminateRequestError('socket lost'))
            : Promise.resolve({ queued: true, queuedTurn })
          : method === 'thread.queue' && scenario === 'durable queue' && reconnecting
            ? Promise.resolve({ items: [queuedTurn], canSteer: true })
            : method === 'thread.history' && scenario === 'inactive queue' && reconnecting
              ? Promise.resolve({
                  events: [
                    {
                      seq: 1,
                      event: {
                        type: 'item.completed',
                        item: {
                          id: queuedTurn.id,
                          turnId: 'offline',
                          type: 'message',
                          role: 'user',
                          status: 'completed',
                          text: queuedTurn.text,
                          createdAt: 1,
                        },
                      },
                    },
                  ],
                  running: false,
                })
              : request(method, params),
      )
      await openNewSession()
      if (scenario === 'overlap') {
        const histories: Array<(value: { events: []; running: false }) => void> = []
        transport.request.mockImplementation((method: string, params: unknown) =>
          method === 'thread.history'
            ? new Promise((resolve) => histories.push(resolve))
            : request(method, params),
        )
        transport.request.mockClear()
        act(() => {
          for (const listener of transport.sequenceGapListeners) {
            listener(1, 2)
            listener(2, 3)
          }
        })
        await waitFor(() => expect(histories).toHaveLength(2))
        await act(async () => histories[0]?.({ events: [], running: false }))
        await act(async () => histories[1]?.({ events: [], running: false }))
        await waitForWorkspace(1)
        return
      }
      if (scenario !== 'approval') {
        if (scenario === 'inactive queue' || scenario === 'durable queue')
          startTurn('untouched-thread', 'active-turn')
        submitTurn('Reconnect me')
        await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
        if (scenario === 'inactive queue' || scenario === 'durable queue')
          fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      }
      transport.request.mockClear()
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      if (scenario === 'durable queue') {
        await waitFor(() => expect(rpcCount('thread.queue')).toBeGreaterThan(0))
        expect(rpcCount('workspace.info')).toBe(0)
        return
      }
      await waitForWorkspace(1)
    },
  )
  it.each(['delete', 'steer'] as const)('releases queued ownership after %s', async (action) => {
    const request = transport.request.getMockImplementation()!,
      queuedTurn = { id: 'queued', text: 'Queue next', attachments: [], createdAt: 1 }
    let accept!: (value: { queued: true; queuedTurn: typeof queuedTurn }) => void
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? new Promise((resolve) => {
            accept = resolve
          })
        : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'active')
    transport.request.mockClear()
    submitTurn('Queue next')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    await act(async () => accept({ queued: true, queuedTurn }))
    fireEvent.click(
      screen.getByRole('button', {
        name: action === 'delete' ? 'Remove Queue next from queue' : 'Steer',
      }),
    )
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        `thread.${action === 'delete' ? 'delete' : 'steer'}QueuedTurn`,
        { threadId: 'untouched-thread', queuedTurnId: 'queued' },
      ),
    )
    emitQueue('untouched-thread', [])
    completeTurn('untouched-thread', 'active')
    await waitForWorkspace(1)
  })
  it.each(['next', 'restored', 'historical'] as const)(
    'keeps %s queued work ahead of workspace refresh',
    async (scenario) => {
      const request = transport.request.getMockImplementation()!,
        turns = [
          { id: 'q1', text: 'First queued', attachments: [], createdAt: 1 },
          { id: 'q2', text: 'Second queued', attachments: [], createdAt: 2 },
        ]
      let sent = 0
      if (scenario === 'historical') {
        serverProjects[0]!.sessions[0]!.running = true
        transport.request.mockImplementation((method: string, params: unknown) =>
          method === 'thread.history'
            ? Promise.resolve({
                events: [
                  {
                    seq: 1,
                    event: {
                      type: 'turn.started',
                      turn: {
                        id: 'old',
                        threadId: 'untouched-thread',
                        status: 'running',
                        createdAt: 1,
                      },
                    },
                  },
                ],
                running: true,
              })
            : method === 'thread.sendTurn'
              ? Promise.resolve({ queued: true, queuedTurn: turns[sent++]! })
              : request(method, params),
        )
      } else
        transport.request.mockImplementation((method: string, params: unknown) =>
          method === 'thread.sendTurn'
            ? Promise.resolve({ queued: true, queuedTurn: turns[sent++]! })
            : request(method, params),
        )
      await openNewSession()
      if (scenario !== 'historical') startTurn('untouched-thread', 'active')
      transport.request.mockClear()
      submitTurn('First queued')
      if (scenario === 'next') submitTurn('Second queued')
      await screen.findByRole('button', {
        name: `Remove ${scenario === 'next' ? 'Second' : 'First'} queued from queue`,
      })
      if (scenario === 'next') {
        emitQueue('untouched-thread', [turns[1]!])
        startTurn('untouched-thread', 'q1-turn')
        completeTurn('untouched-thread', 'q1-turn')
      } else if (scenario === 'restored') {
        emitQueue('untouched-thread', [])
        emitQueue('untouched-thread', [turns[0]!])
        completeTurn('untouched-thread', 'active')
      } else {
        serverProjects[0]!.sessions[0]!.running = false
        completeTurn('untouched-thread', 'old')
      }
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      const remaining = scenario === 'next' ? turns[1]! : turns[0]!
      fireEvent.click(screen.getByRole('button', { name: `Remove ${remaining.text} from queue` }))
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('thread.deleteQueuedTurn', {
          threadId: 'untouched-thread',
          queuedTurnId: remaining.id,
        }),
      )
      emitQueue('untouched-thread', [])
      await waitForWorkspace(1)
    },
  )
  it('shows active chat errors in the composer and keeps dismissal scoped to that failure', async () => {
    await openNewSession()
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })
    emitThreadEvent('untouched-thread', {
      type: 'thread.error',
      threadId: 'untouched-thread',
      message: 'Model request timed out',
    })
    const error = await screen.findByRole('alert')
    expect(error.closest('.composer__provider-shelf')).toBeTruthy()
    expect(error.textContent).toBe('Model request timed out')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error: Model request timed out' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(composer.value).toBe('Keep this draft')
    expect(document.activeElement).toBe(composer)
    emitThreadEvent('untouched-thread', {
      type: 'thread.error',
      threadId: 'untouched-thread',
      message: 'Model request timed out',
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('refreshes after terminal thread errors', async () => {
    await openNewSession()
    transport.request.mockClear()
    emitThreadEvent('untouched-thread', {
      type: 'thread.error',
      threadId: 'untouched-thread',
      message: 'Design failed',
    })
    await waitForWorkspace(1)
  })
  it('gives a switched project its own unknown-result retry', async () => {
    serverProjects.push(
      serverProject('/work/another-project', 'Another Project', [
        { id: 'background-thread', title: 'Background', running: false },
      ]),
    )
    const probes = await renderWithDeferredProjectProbes()
    completeTurn('untouched-thread', 'a')
    await waitFor(() => expect(probes).toHaveLength(1))
    await act(async () => probes[0]?.reject(new Error('A failed')))
    await waitFor(() => expect(probes).toHaveLength(2))
    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    fireEvent.click(screen.getByRole('option', { name: /^Another Project / }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', {
        path: '/work/another-project',
      }),
    )
    transport.request.mockClear()
    completeTurn('background-thread', 'b')
    await act(async () => probes[1]?.reject(new Error('A retry failed')))
    await waitFor(() => expect(probes).toHaveLength(3))
    await act(async () => probes[2]?.reject(new Error('B failed')))
    await waitFor(() => expect(probes).toHaveLength(4))
    await act(async () => probes[3]?.resolve(projectsSnapshot(false)))
    await waitForWorkspace(1)
  })
  it('reconciles an inactive project owner without letting it block the active project', async () => {
    const request = transport.request.getMockImplementation()!
    serverProjects.push(
      serverProject('/work/another-project', 'Another Project', [
        { id: 'background-thread', title: 'Background', running: false },
      ]),
    )
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? Promise.reject(new IndeterminateRequestError('lost'))
        : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'a')
    submitTurn('Lost submit')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    fireEvent.click(screen.getByRole('option', { name: /^Another Project / }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', {
        path: '/work/another-project',
      }),
    )
    serverProjects[0]!.sessions[0]!.running = false
    transport.request.mockClear()
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      }),
    )
    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    fireEvent.click(screen.getByRole('option', { name: /^project /i }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', { path: '/work/project' }),
    )
    transport.request.mockClear()
    completeTurn('untouched-thread', 'a')
    await waitForWorkspace(1)
  })
  it('scopes reconnect idle consensus to the active project', async () => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'foreign', text: 'Foreign queue', attachments: [], createdAt: 1 }
    let reconnecting = false
    serverProjects.push(
      serverProject('/work/another-project', 'Another Project', [
        { id: 'background-thread', title: 'Background', running: true },
      ]),
    )
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? Promise.reject(new IndeterminateRequestError('lost'))
        : reconnecting &&
            method === 'thread.history' &&
            methods['thread.history'].params.parse(params).threadId === 'untouched-thread'
          ? Promise.resolve({ events: [], running: true })
          : reconnecting &&
              method === 'thread.queue' &&
              methods['thread.queue'].params.parse(params).threadId === 'untouched-thread'
            ? Promise.resolve({ items: [queued], canSteer: true })
            : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'a')
    submitTurn('Lost submit')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    fireEvent.click(screen.getByRole('option', { name: /^Another Project / }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('workspace.info', {
        path: '/work/another-project',
      }),
    )
    startTurn('background-thread', 'b')
    serverProjects[1]!.sessions[0]!.running = false
    transport.request.mockClear()
    reconnecting = true
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitForWorkspace(1)
  })
  it('offers a top archive toast and restores the chat with Undo', async () => {
    const nativeTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000) args[1] = 1_000
        return nativeTimeout(...args)
      },
    )

    await openNewSession()
    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    expect(await screen.findByText('Chat deleted')).toBeTruthy()
    expect(screen.getByText('Chat deleted').closest('.notice--archive')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete New session' })).toBeNull()
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: 'Delete New session' })).toBeTruthy()
    await act(async () => new Promise((resolve) => nativeTimeout(resolve, 1_050)))
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
  })

  it('saves a queued delete for the next start until Undo', async () => {
    await openNewSession()
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    await screen.findByText('Chat deleted')
    expect(JSON.parse(localStorage.getItem(PENDING_CHAT_DELETES_KEY)!)).toEqual([
      { threadId: 'untouched-thread', checkout: 'keep' },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull()
  })

  it('finishes a delete on the next start when the app quit inside the undo window', async () => {
    serverProjects[0]!.sessions.push({ id: 'kept-thread', title: 'Kept chat', createdAt: 5 })
    await openNewSession()
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.delete' ? new Promise(() => undefined) : request(method, params),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    await screen.findByText('Chat deleted')

    cleanup()
    transport.request.mockImplementation(request)
    transport.request.mockClear()
    shellRenders.sidebar.mockClear()
    render(<App />)

    await screen.findByRole('button', { name: 'Delete Kept chat' })
    await waitFor(() => expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull())
    expect(transport.request.mock.calls.filter(([method]) => method === 'thread.delete')).toEqual([
      ['thread.delete', { threadId: 'untouched-thread' }],
    ])
    const shownChats = shellRenders.sidebar.mock.calls.flatMap(([props]) =>
      (props as ComponentProps<typeof import('./ui/Sidebar.js').Sidebar>).projects.flatMap(
        (project) => project.sessions.map((session) => session.id),
      ),
    )
    expect(new Set(shownChats)).toEqual(new Set(['kept-thread']))
  })

  it('drops a saved delete for a chat that is already gone', async () => {
    localStorage.setItem(
      PENDING_CHAT_DELETES_KEY,
      JSON.stringify([{ threadId: 'gone-thread', checkout: 'keep' }]),
    )
    render(<App />)
    await screen.findByRole('button', { name: 'Delete New session' })
    await waitFor(() => expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull())
    expect(rpcCount('thread.delete')).toBe(0)
  })

  it('discards a saved isolated checkout before deleting its chat, without asking again', async () => {
    serverProjects[0]!.sessions[0]!.worktreeBranch = 'harness/untouched-thread'
    localStorage.setItem(
      PENDING_CHAT_DELETES_KEY,
      JSON.stringify([{ threadId: 'untouched-thread', checkout: 'force-discard' }]),
    )
    render(<App />)
    await waitFor(() => expect(rpcCount('thread.delete')).toBe(1))
    expect(
      transport.request.mock.calls.filter(([method]) =>
        ['thread.unsavedWork', 'thread.close', 'thread.discardWorktree', 'thread.delete'].includes(
          method,
        ),
      ),
    ).toEqual([
      ['thread.close', { threadId: 'untouched-thread' }],
      ['thread.discardWorktree', { threadId: 'untouched-thread', force: true }],
      ['thread.delete', { threadId: 'untouched-thread' }],
    ])
    expect(screen.queryByRole('dialog', { name: 'Discard isolated checkout' })).toBeNull()
  })

  it('reports a saved delete that fails and shows its chat again', async () => {
    localStorage.setItem(
      PENDING_CHAT_DELETES_KEY,
      JSON.stringify([{ threadId: 'untouched-thread', checkout: 'keep' }]),
    )
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.delete'
        ? Promise.reject(new Error('The chat is still starting.'))
        : request(method, params),
    )
    render(<App />)
    expect((await screen.findByRole('alert')).textContent).toBe('The chat is still starting.')
    expect(await screen.findByRole('button', { name: 'Delete New session' })).toBeTruthy()
    expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull()
  })

  it('keeps a delete whose request fails for the next start', async () => {
    const nativeTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000) args[1] = 50
        return nativeTimeout(...args)
      },
    )
    await openNewSession()
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.delete'
        ? Promise.reject(new Error('The chat is still starting.'))
        : request(method, params),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The chat is still starting.')
    expect(await screen.findByRole('button', { name: 'Delete New session' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(PENDING_CHAT_DELETES_KEY)!)).toEqual([
      { threadId: 'untouched-thread', checkout: 'keep' },
    ])
  })

  it('retries a delete the closed connection failed once on the next start', async () => {
    await openNewSession()
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.delete'
        ? Promise.reject(new Error('Connection closed.'))
        : request(method, params),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    await screen.findByText('Chat deleted')

    cleanup()
    await waitFor(() => expect(rpcCount('thread.delete')).toBe(1))
    expect(JSON.parse(localStorage.getItem(PENDING_CHAT_DELETES_KEY)!)).toEqual([
      { threadId: 'untouched-thread', checkout: 'keep' },
    ])

    transport.request.mockClear()
    render(<App />)
    expect((await screen.findByRole('alert')).textContent).toBe('Connection closed.')
    expect(await screen.findByRole('button', { name: 'Delete New session' })).toBeTruthy()
    expect(rpcCount('thread.delete')).toBe(1)
    expect(localStorage.getItem(PENDING_CHAT_DELETES_KEY)).toBeNull()
  })

  it('reconciles workspace ownership when a running session is archived', async () => {
    const nativeTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000) args[1] = 50
        return nativeTimeout(...args)
      },
    )

    await openNewSession()
    startTurn('untouched-thread', 'active')
    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Delete New session' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.delete', {
        threadId: 'untouched-thread',
      }),
    )
    await waitForWorkspace(1)
  })
  it('keeps a claimed steer blocked until its exact outcome', async () => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'steer-q', text: 'Steer later', attachments: [], createdAt: 1 }
    let rejectSteer!: (reason: Error) => void
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? Promise.resolve({ queued: true, queuedTurn: queued })
        : method === 'thread.steerQueuedTurn'
          ? new Promise((_, reject) => (rejectSteer = reject))
          : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'active')
    transport.request.mockClear()
    submitTurn('Steer later')
    await screen.findByRole('button', { name: 'Remove Steer later from queue' })
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    await waitFor(() => expect(rpcCount('thread.steerQueuedTurn')).toBe(1))
    emitQueue('untouched-thread', [])
    completeTurn('untouched-thread', 'active')
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(rpcCount('workspace.info')).toBe(0)
    emitQueue('untouched-thread', [queued])
    await act(async () => rejectSteer(new Error('restored')))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Steer later from queue' }))
    emitQueue('untouched-thread', [])
    await waitForWorkspace(1)
  })
  it('keeps a reconnect queue claim blocked until durable evidence', async () => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'claim-q', text: 'Claim later', attachments: [], createdAt: 1 }
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? Promise.resolve({ queued: true, queuedTurn: queued })
        : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'active')
    submitTurn('Claim later')
    await screen.findByRole('button', { name: 'Remove Claim later from queue' })
    transport.request.mockClear()
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() => expect(rpcCount('thread.queue')).toBeGreaterThan(0))
    expect(rpcCount('workspace.info')).toBe(0)
    emitQueue('untouched-thread', [queued])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claim later from queue' }))
    emitQueue('untouched-thread', [])
    await waitForWorkspace(1)
  })
  it('retries unknown queue evidence on the next completion', async () => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'stale', text: 'Offline queue', attachments: [], createdAt: 1 }
    let failing = true
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.queue' && failing
        ? Promise.reject(new Error('offline'))
        : request(method, params),
    )
    await openNewSession()
    emitQueue('untouched-thread', [queued])
    transport.request.mockClear()
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() => expect(rpcCount('thread.queue')).toBeGreaterThan(0))
    expect(rpcCount('workspace.info')).toBe(0)
    failing = false
    completeTurn('untouched-thread', 'later')
    await waitForWorkspace(1)
  })
  it.each(['clean', 'projects.list', 'thread.history', 'thread.queue'] as const)(
    'refreshes after a turn runs wholly during an outage with %s reconciliation',
    async (scenario) => {
      const request = transport.request.getMockImplementation()!
      await openNewSession()
      let fail = scenario !== 'clean'
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === scenario && fail
          ? ((fail = false), Promise.reject(new Error('transient')))
          : request(method, params),
      )
      transport.request.mockClear()
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitForWorkspace(1)
    },
  )
  it('does not clear a submit owner created during resync', async () => {
    const request = transport.request.getMockImplementation()!
    serverProjects = [
      serverProject('/work/project', 'project', [
        { id: 'untouched-thread', title: 'New session', running: false },
        { id: 'background-thread', title: 'Background', running: false, status: 'working' },
      ]),
    ]
    let accept!: (value: { queued: false; turnId: string }) => void
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? new Promise((resolve) => (accept = resolve))
        : request(method, params),
    )
    await openNewSession()
    serverProjects[0]!.sessions[1]!.status = 'ready'
    transport.request.mockClear()
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    submitTurn('During resync')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    await act(async () => accept({ queued: false, turnId: 'new' }))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(rpcCount('workspace.info')).toBe(0)
    startTurn('untouched-thread', 'new')
    completeTurn('untouched-thread', 'new')
    await waitForWorkspace(1)
  })
  it('blocks on authoritative queued status without a local queue cache', async () => {
    serverProjects = [
      serverProject('/work/project', 'project', [
        { id: 'untouched-thread', title: 'New session', running: false },
        { id: 'background-thread', title: 'Background', running: false, status: 'queued' },
      ]),
    ]
    await openNewSession()
    transport.request.mockClear()
    completeTurn('untouched-thread', 'a')
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(rpcCount('workspace.info')).toBe(0)
    serverProjects[0]!.sessions[1]!.status = 'ready'
    completeTurn('untouched-thread', 'b')
    await waitForWorkspace(1)
  })
  it.each([
    'unknown authority',
    'retained steer',
    'project failure',
    'remote claim',
    'remote deletion',
    'path return',
    'overlapping action',
    'duplicate consensus',
    'stale submission',
  ] as const)('settles final workspace audit case: %s', async (scenario) => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'audit-q', text: 'Audit queue', attachments: [], createdAt: 1 }
    if (scenario === 'unknown authority') {
      let failing = true
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.queue' && failing
          ? Promise.reject(new Error('unknown'))
          : request(method, params),
      )
      await openNewSession()
      transport.request.mockClear()
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitFor(() => expect(rpcCount('thread.queue')).toBeGreaterThan(0))
      completeTurn('untouched-thread', 'unknown')
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      failing = false
      completeTurn('untouched-thread', 'known')
      return waitForWorkspace(1)
    }
    if (scenario === 'retained steer') {
      let reject!: (error: Error) => void,
        running = true
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.steerQueuedTurn'
          ? new Promise((_, fail) => (reject = fail))
          : method === 'thread.history'
            ? Promise.resolve({ events: [], running })
            : request(method, params),
      )
      await openNewSession()
      startTurn('untouched-thread', 'active')
      emitQueue('untouched-thread', [queued])
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      await act(async () => reject(new IndeterminateRequestError('lost')))
      emitQueue('untouched-thread', [])
      transport.request.mockClear()
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitFor(() => expect(rpcCount('thread.queue')).toBeGreaterThan(0))
      running = false
      completeTurn('untouched-thread', 'active')
      return waitForWorkspace(1)
    }
    if (scenario === 'project failure') {
      let failProjects = false
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.sendTurn'
          ? Promise.reject(new IndeterminateRequestError('lost'))
          : method === 'projects.list' && failProjects
            ? Promise.reject(new Error('projects'))
            : request(method, params),
      )
      await openNewSession()
      submitTurn('Lost')
      await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
      transport.request.mockClear()
      failProjects = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitFor(() => expect(rpcCount('thread.history')).toBeGreaterThan(0))
      failProjects = false
      completeTurn('untouched-thread', 'later')
      return waitForWorkspace(1)
    }
    if (scenario === 'remote claim') {
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.steerQueuedTurn'
          ? new Promise(() => undefined)
          : request(method, params),
      )
      await openNewSession()
      startTurn('untouched-thread', 'active')
      emitQueue('untouched-thread', [queued])
      transport.request.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      emitQueue('untouched-thread', [])
      completeTurn('untouched-thread', 'active')
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      return
    }
    if (scenario === 'remote deletion') {
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.sendTurn'
          ? Promise.reject(new IndeterminateRequestError('lost'))
          : request(method, params),
      )
      await openNewSession()
      submitTurn('Lost')
      await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
      serverProjects[0]!.sessions = []
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitForWorkspace(1)
      transport.request.mockClear()
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('thread.history')).toBe(0)
      return
    }
    if (scenario === 'path return') {
      serverProjects.push(
        serverProject('/work/another-project', 'Another Project', [
          { id: 'background-thread', title: 'Background', running: false },
        ]),
      )
      const probes = await renderWithDeferredProjectProbes()
      completeTurn('untouched-thread', 'old')
      await waitFor(() => expect(probes).toHaveLength(1))
      fireEvent.keyDown(window, { key: 'p', metaKey: true })
      fireEvent.click(screen.getByRole('option', { name: /^Another Project / }))
      await waitForWorkspace(1)
      startTurn('untouched-thread', 'new')
      fireEvent.keyDown(window, { key: 'p', metaKey: true })
      fireEvent.click(screen.getByRole('option', { name: /^project /i }))
      await waitForWorkspace(2)
      transport.request.mockClear()
      await act(async () => probes[0]?.resolve(projectsSnapshot(false)))
      expect(rpcCount('workspace.info')).toBe(0)
      return
    }
    if (scenario === 'overlapping action') {
      let calls = 0
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.steerQueuedTurn'
          ? ++calls === 1
            ? new Promise(() => undefined)
            : Promise.reject(new Error('busy'))
          : request(method, params),
      )
      await openNewSession()
      startTurn('untouched-thread', 'active')
      emitQueue('untouched-thread', [queued])
      transport.request.mockClear()
      const steer = screen.getByRole('button', { name: 'Steer' })
      fireEvent.click(steer)
      fireEvent.click(steer)
      await waitFor(() => expect(rpcCount('thread.steerQueuedTurn')).toBe(2))
      emitQueue('untouched-thread', [])
      completeTurn('untouched-thread', 'active')
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      return
    }
    if (scenario === 'duplicate consensus') {
      let resolveHistory!: (value: { events: []; running: false }) => void,
        reconnecting = false
      transport.request.mockImplementation((method: string, params: unknown) =>
        reconnecting && method === 'thread.history'
          ? new Promise((resolve) => (resolveHistory = resolve))
          : request(method, params),
      )
      await openNewSession()
      transport.request.mockClear()
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await waitFor(() => expect(rpcCount('thread.history')).toBe(1))
      completeTurn('untouched-thread', 'live')
      await waitForWorkspace(1)
      await act(async () => resolveHistory({ events: [], running: false }))
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(1)
      return
    }
    let lostId = '',
      reconnectQueue: QueuedTurn[] = [],
      lost = true
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn' && lost
        ? ((lostId = methods['thread.sendTurn'].params.parse(params).clientSubmissionId!),
          Promise.reject(new IndeterminateRequestError('lost')))
        : method === 'thread.queue'
          ? Promise.resolve({ items: reconnectQueue, canSteer: true })
          : request(method, params),
    )
    await openNewSession()
    submitTurn('Lost')
    await waitFor(() => expect(lostId).not.toBe(''))
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitForWorkspace(1)
    reconnectQueue = [{ ...queued, id: lostId }]
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove Audit queue from queue' })).toBeTruthy(),
    )
    emitQueue('untouched-thread', [])
    lost = false
    transport.request.mockClear()
    submitTurn('Fresh')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    startTurn('untouched-thread', 'fresh')
    completeTurn('untouched-thread', 'fresh')
    await waitForWorkspace(1)
  })
  it('blocks a remote queue claim until reconciliation', async () => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'remote-q', text: 'Remote queue', attachments: [], createdAt: 1 }
    let resolveHistory!: (value: { events: []; running: false }) => void
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.history'
        ? new Promise((resolve) => (resolveHistory = resolve))
        : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'active')
    emitQueue('untouched-thread', [queued])
    transport.request.mockClear()
    emitQueue('untouched-thread', [])
    completeTurn('untouched-thread', 'active')
    await waitFor(() => expect(rpcCount('thread.history')).toBe(1))
    expect(rpcCount('workspace.info')).toBe(0)
    await act(async () => resolveHistory({ events: [], running: false }))
    await waitForWorkspace(1)
  })
  it('coalesces sequential live and reconnect consensus', async () => {
    const request = transport.request.getMockImplementation()!
    let resolveHistory!: (value: { events: []; running: false }) => void,
      reconnecting = false
    transport.request.mockImplementation((method: string, params: unknown) =>
      reconnecting && method === 'thread.history'
        ? new Promise((resolve) => (resolveHistory = resolve))
        : request(method, params),
    )
    await openNewSession()
    transport.request.mockClear()
    reconnecting = true
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() => expect(rpcCount('thread.history')).toBe(1))
    completeTurn('untouched-thread', 'live')
    await waitForWorkspace(1)
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    await act(async () => resolveHistory({ events: [], running: false }))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(rpcCount('workspace.info')).toBe(1)
  })
  it.each([
    'composer steer',
    'lost reply delete',
    'lost delete',
    'late terminal',
    'offline claim',
    'remote delete',
    'remote queue',
    'new chat cleanup',
  ] as const)('settles reviewed workspace ownership for %s', async (scenario) => {
    const request = transport.request.getMockImplementation()!,
      queued = { id: 'review-q', text: 'Reviewed queue', attachments: [], createdAt: 1 }
    let rejectAction!: (reason: Error) => void,
      reconnecting = false,
      sends = 0,
      lostId = ''
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? scenario === 'lost reply delete'
          ? ((lostId = methods['thread.sendTurn'].params.parse(params).clientSubmissionId!),
            Promise.reject(new IndeterminateRequestError('lost')))
          : Promise.resolve({
              queued: true,
              queuedTurn: { ...queued, id: sends++ ? 'steer-q' : queued.id },
            })
        : method === 'thread.steerQueuedTurn' && scenario === 'composer steer'
          ? new Promise(() => undefined)
          : method === 'thread.deleteQueuedTurn' && scenario === 'lost delete'
            ? new Promise((_, reject) => (rejectAction = reject))
            : reconnecting && method === 'thread.queue' && scenario === 'lost reply delete'
              ? Promise.resolve({ items: [{ ...queued, id: lostId }], canSteer: true })
              : reconnecting && method === 'thread.history' && scenario === 'offline claim'
                ? Promise.resolve({
                    events: [
                      {
                        seq: 1,
                        event: {
                          type: 'item.completed',
                          item: {
                            id: queued.id,
                            turnId: 'queued',
                            type: 'message',
                            role: 'user',
                            status: 'completed',
                            text: queued.text,
                            createdAt: 1,
                          },
                        },
                      },
                    ],
                    running: true,
                  })
                : request(method, params),
    )
    await openNewSession()
    startTurn('untouched-thread', 'active')
    if (scenario === 'remote queue' || scenario === 'new chat cleanup') {
      emitQueue('untouched-thread', [queued])
      transport.request.mockClear()
      completeTurn('untouched-thread', 'active')
      if (scenario === 'new chat cleanup') {
        fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
        expect(rpcCount('thread.delete')).toBe(0)
        expect(rpcCount('workspace.info')).toBe(0)
      }
      emitQueue('untouched-thread', [])
      return waitForWorkspace(1)
    }
    submitTurn('Reviewed queue')
    await waitFor(() => expect(rpcCount('thread.sendTurn')).toBe(1))
    await screen
      .findByRole('button', { name: /Remove Reviewed queue from queue/ })
      .catch(() => undefined)
    transport.request.mockClear()
    if (scenario === 'composer steer') {
      const composer = screen.getByPlaceholderText('Do anything')
      fireEvent.change(composer, { target: { value: 'Steer now' } })
      fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
      await waitFor(() => expect(rpcCount('thread.steerQueuedTurn')).toBe(1))
      emitQueue('untouched-thread', [])
      completeTurn('untouched-thread', 'active')
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      return
    }
    if (scenario === 'late terminal') {
      completeTurn('untouched-thread', 'old')
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
      expect(rpcCount('workspace.info')).toBe(0)
      return
    }
    if (scenario === 'remote delete') {
      serverProjects[0]!.sessions = []
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      return waitForWorkspace(1)
    }
    if (scenario === 'lost reply delete') {
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      await screen.findByRole('button', { name: /Remove Reviewed queue from queue/ })
    }
    if (scenario === 'offline claim') {
      emitQueue('untouched-thread', [])
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
      completeTurn('untouched-thread', 'queued')
      return waitForWorkspace(1)
    }
    fireEvent.click(screen.getByRole('button', { name: /Remove Reviewed queue from queue/ }))
    if (scenario === 'lost delete') {
      emitQueue('untouched-thread', [])
      await act(async () => rejectAction(new IndeterminateRequestError('lost')))
      reconnecting = true
      act(() => {
        setConnectionState('reconnecting')
        setConnectionState('open')
      })
    } else emitQueue('untouched-thread', [])
    await waitForWorkspace(1)
  })

  it('asks before discarding uncommitted work from an isolated session', async () => {
    const nativeTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000) args[1] = 50
        return nativeTimeout(...args)
      },
    )

    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'isolated-thread',
            title: 'Parallel work',
            provider: 'codex',
            createdAt: 0,
            running: false,
            worktreeBranch: 'harness/parallel',
          },
        ],
      },
    ]
    serverUnsavedWork = { isolated: true, uncommitted: true }
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Parallel work' }))
    expect(await screen.findByRole('dialog', { name: 'Discard isolated checkout' })).toBeTruthy()
    expect(transport.request).not.toHaveBeenCalledWith('thread.discardWorktree', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.close', {
        threadId: 'isolated-thread',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.discardWorktree', {
        threadId: 'isolated-thread',
        force: true,
      })
      expect(transport.request).toHaveBeenCalledWith('thread.delete', {
        threadId: 'isolated-thread',
      })
    })
  })

  it('does not send a rename for a provisional chat that never started', async () => {
    render(<App />)
    await screen.findByPlaceholderText('Do anything')
    const header = shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
      typeof import('./ui/StageHeader.js').StageHeader
    >

    act(() => header.onRenameSession('pending:failed-start', 'Never started'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(rpcCount('thread.rename')).toBe(0)
  })

  it('keeps deleting the other chats when several need a checkout confirmation', async () => {
    const nativeTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === 10_000) args[1] = 50
        return nativeTimeout(...args)
      },
    )
    const isolated = (id: string, title: string) => ({
      id,
      title,
      provider: 'codex' as const,
      createdAt: 0,
      running: false,
      worktreeBranch: `harness/${id}`,
    })
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          isolated('first-dirty', 'First dirty'),
          { id: 'clean', title: 'Clean chat', provider: 'codex', createdAt: 0, running: false },
          isolated('second-dirty', 'Second dirty'),
        ],
      },
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method !== 'thread.unsavedWork') return request(method, params)
      const dirty = methods[method].params.parse(params).threadId !== 'clean'
      return Promise.resolve({ isolated: dirty, uncommitted: dirty })
    })
    render(<App />)
    await screen.findByRole('button', { name: 'Delete Clean chat' })

    act(() => sidebarProps().onArchiveProject(['first-dirty', 'clean', 'second-dirty']))

    expect(await screen.findByText(/Deleting “First dirty” now/)).toBeTruthy()
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.delete', { threadId: 'clean' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }))
    expect(await screen.findByText(/Deleting “Second dirty” now/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }), {
      detail: 2,
    })
    expect(screen.getByText(/Deleting “Second dirty” now/)).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Discard isolated checkout' }), {
      key: 'Escape',
    })

    expect(screen.queryByRole('dialog', { name: 'Discard isolated checkout' })).toBeNull()
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.discardWorktree', {
        threadId: 'first-dirty',
        force: true,
      })
      expect(transport.request).toHaveBeenCalledWith('thread.delete', { threadId: 'first-dirty' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', {
      threadId: 'second-dirty',
    })
  })

  it('persists chat pinning from the sidebar menu', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'pin-thread',
            title: 'Keep nearby',
            provider: 'codex',
            createdAt: 0,
            running: false,
          },
        ],
      },
    ]
    render(<App />)

    fireEvent.contextMenu(await screen.findByRole('button', { name: /^Keep nearby,/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin chat' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.pin', {
        threadId: 'pin-thread',
        pinned: true,
      })
    })
    expect(screen.getByText('Pinned')).toBeTruthy()
  })

  it.each(['project rename', 'project pin', 'chat rename', 'chat pin'])(
    'restores saved values and reports a refused %s',
    async (operation) => {
      serverProjects = [
        {
          path: '/work/project',
          name: 'Project name',
          pinned: false,
          createdAt: 0,
          sessions: [
            {
              id: 'saved-thread',
              title: 'Saved title',
              provider: 'codex',
              createdAt: 0,
              running: false,
            },
          ],
        },
      ]
      const request = transport.request.getMockImplementation()!
      const method =
        operation === 'project rename'
          ? 'projects.rename'
          : operation === 'project pin'
            ? 'projects.pin'
            : operation === 'chat rename'
              ? 'thread.rename'
              : 'thread.pin'
      transport.request.mockImplementation((name: string, params: unknown) =>
        name === method ? Promise.reject(new Error('Save was refused')) : request(name, params),
      )
      render(<App />)
      if (operation.startsWith('project')) {
        fireEvent.contextMenu(await screen.findByRole('button', { name: 'Project name' }))
        fireEvent.click(
          await screen.findByRole('menuitem', {
            name: operation.endsWith('pin') ? 'Pin to top' : 'Edit name',
          }),
        )
      } else if (operation.endsWith('pin')) {
        fireEvent.contextMenu(await screen.findByRole('button', { name: /^Saved title,/ }))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin chat' }))
      } else fireEvent.click(await screen.findByRole('button', { name: 'Rename Saved title' }))
      if (operation.endsWith('rename')) {
        const input = screen.getByDisplayValue(
          operation.startsWith('project') ? 'Project name' : 'Saved title',
        )
        fireEvent.change(input, { target: { value: 'Unsaved name' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      }
      expect(await screen.findByText('Save was refused')).toBeTruthy()
      await waitFor(() => {
        expect(screen.queryByText('Unsaved name')).toBeNull()
        expect(screen.getByRole('button', { name: 'Project name' })).toBeTruthy()
        expect(screen.getByRole('button', { name: /^Saved title,/ })).toBeTruthy()
      })
      if (operation === 'chat pin') expect(screen.queryByText('Pinned')).toBeNull()
      if (operation === 'project pin') {
        fireEvent.contextMenu(screen.getByRole('button', { name: 'Project name' }))
        expect(await screen.findByRole('menuitem', { name: 'Pin to top' })).toBeTruthy()
      }
    },
  )

  it('shows changed files before restoring and offers undo afterwards', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'thread-rollback',
            title: 'Parser work',
            provider: 'codex',
            createdAt: 0,
            running: false,
          },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let historyReads = 0
    let restoreRequests = 0
    let rejectRestore!: (error: Error) => void
    let releaseRestoreHistory: (() => void) | undefined
    const restoreHistory = new Promise<{ events: never[]; running: false }>((resolve) => {
      releaseRestoreHistory = () => resolve({ events: [], running: false })
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.history' && ++historyReads === 2) return restoreHistory
      if (method === 'thread.restore' && restoreRequests++ === 0)
        return new Promise((_, reject) => (rejectRestore = reject))
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Parser work,/ }))
    fireEvent.click(
      await within(screen.getByRole('main')).findByRole('button', {
        name: 'Options for Parser work',
      }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkpoint history (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Before “Fix the parser”/ }))

    expect(await screen.findByText('src/parser.ts')).toBeTruthy()
    expect(screen.getByText('src/parser.test.ts')).toBeTruthy()
    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })
    await waitFor(() => expect(historyReads).toBe(2))
    fireEvent.click(restoreButton())
    await waitFor(() => expect(restoreRequests).toBe(1))
    await act(async () => releaseRestoreHistory?.())
    await act(async () => rejectRestore(new IndeterminateRequestError('restore reply lost')))
    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(3))
    fireEvent.click(restoreButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Undo restore' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.undoRestore', {
        threadId: 'thread-rollback',
        undo: 'undo-token',
      })
    })
    expect(
      transport.request.mock.calls
        .filter(([method]) => method === 'thread.history')
        .map(([, params]) => params),
    ).toEqual([
      { threadId: 'thread-rollback', page: NEWEST_PAGE },
      { threadId: 'thread-rollback', afterSeq: 0 },
      { threadId: 'thread-rollback', page: NEWEST_PAGE },
      { threadId: 'thread-rollback', afterSeq: 0 },
      ...Array.from({ length: 2 }, () => ({ threadId: 'thread-rollback', page: NEWEST_PAGE })),
    ])
  })

  it('persists the macOS font smoothing setting', async () => {
    render(<App />)

    expect(document.documentElement.classList.contains('is-macos-font-smoothing')).toBe(true)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))

    const toggle = screen.getByRole('switch', { name: 'Font smoothing' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(localStorage.getItem('harness.macosFontSmoothing')).toBe('false')
      expect(document.documentElement.classList.contains('is-macos-font-smoothing')).toBe(false)
    })
  })

  it('clears renderer preferences and reloads only after reset confirmation', () => {
    localStorage.setItem('harness.theme', 'dark')
    localStorage.setItem('harness.hiddenModels', '["codex:gpt-5.6-mini"]')
    localStorage.setItem('harness.profile.displayName', 'Leon')
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    render(<App />)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset app preferences' }))
    expect(localStorage.getItem('harness.theme')).toBe('dark')
    expect(reload).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reset and reload' }))
    expect(localStorage.length).toBe(0)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('opens the account Profile shortcut directly in the top settings category', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Profile' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(transport.request).toHaveBeenCalledWith('usage.history', { range: 'all' })
  })

  it('persists inbox mode and bounded inactivity settings on the server', async () => {
    serverSidebarSettings.mode = 'inbox'
    render(<App />)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    const inbox = screen.getByRole('radio', { name: 'Inbox' })
    await waitFor(() => expect(inbox.getAttribute('aria-checked')).toBe('true'))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Settle idle chats' }), { key: 'PageUp' })
    fireEvent.click(screen.getByRole('radio', { name: 'Classic' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('sidebar.updateSettings', {
        mode: 'classic',
      })
      expect(transport.request).toHaveBeenCalledWith('sidebar.updateSettings', {
        autoSettleDays: 7,
      })
    })
  })

  it('rolls back an optimistic sidebar setting when persistence fails', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let rejectUpdate: ((error: Error) => void) | undefined
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'sidebar.updateSettings') {
        return new Promise((_, reject) => {
          rejectUpdate = reject
        })
      }
      return request(method, params)
    })

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    const classic = screen.getByRole('radio', { name: 'Classic' })
    const inbox = screen.getByRole('radio', { name: 'Inbox' })
    await waitFor(() => {
      expect(classic.getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(inbox)
    expect(inbox.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      rejectUpdate?.(new Error('Could not save sidebar settings'))
      await Promise.resolve()
    })

    expect(classic.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Could not save sidebar settings')
  })

  it('does not let an older sidebar settings response overwrite a newer save', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    interface SidebarSave {
      params: ParamsOf<'sidebar.updateSettings'>
      resolve: (settings: SidebarSettings) => void
    }
    const saves: SidebarSave[] = []
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'sidebar.updateSettings') {
        return new Promise((resolve) => {
          saves.push({ params: methods[method].params.parse(params), resolve })
        })
      }
      return request(method, params)
    })

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    const classic = screen.getByRole('radio', { name: 'Classic' })
    const inbox = screen.getByRole('radio', { name: 'Inbox' })
    await waitFor(() => {
      expect(classic.getAttribute('aria-checked')).toBe('true')
    })
    fireEvent.click(inbox)
    fireEvent.click(classic)

    expect(saves.map((save) => save.params)).toEqual([{ mode: 'inbox' }, { mode: 'classic' }])
    expect(classic.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      saves[1]!.resolve({ mode: 'classic', autoSettleDays: 3 })
      await Promise.resolve()
    })
    await act(async () => {
      saves[0]!.resolve({ mode: 'inbox', autoSettleDays: 3 })
      await Promise.resolve()
    })

    expect(classic.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps resynced sidebar settings authoritative across a later failed save', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let updateCount = 0
    let rejectSecondUpdate: ((error: Error) => void) | undefined
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'sidebar.updateSettings') return request(method, params)
      updateCount += 1
      if (updateCount === 1) {
        serverSidebarSettings = methods['sidebar.settings'].result.parse({
          ...serverSidebarSettings,
          ...methods['sidebar.updateSettings'].params.parse(params),
        })
        return Promise.reject(new Error('Sidebar response was lost'))
      }
      return new Promise((_, reject) => {
        rejectSecondUpdate = reject
      })
    })

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    const classic = screen.getByRole('radio', { name: 'Classic' })
    const inbox = screen.getByRole('radio', { name: 'Inbox' })
    await waitFor(() => {
      expect(classic.getAttribute('aria-checked')).toBe('true')
    })

    // The server persisted Inbox, but the lost response makes the client roll
    // its optimistic choice back until a reconnect resyncs authoritative state.
    fireEvent.click(inbox)
    await waitFor(() => {
      expect(classic.getAttribute('aria-checked')).toBe('true')
    })
    act(() => {
      for (const listener of transport.sequenceGapListeners) listener(4, 6)
    })
    await waitFor(() => {
      expect(inbox.getAttribute('aria-checked')).toBe('true')
    })

    const days = screen.getByRole('slider', { name: 'Settle idle chats' })
    fireEvent.keyDown(days, { key: 'PageUp' })
    expect(days.getAttribute('aria-valuenow')).toBe('7')

    // A second gap read must update the confirmed base without erasing the
    // still-pending local patch layered over it.
    const readsBefore = transport.request.mock.calls.filter(
      ([method]) => method === 'sidebar.settings',
    ).length
    act(() => {
      for (const listener of transport.sequenceGapListeners) listener(7, 9)
    })
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'sidebar.settings'),
      ).toHaveLength(readsBefore + 1)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(days.getAttribute('aria-valuenow')).toBe('7')

    await act(async () => {
      rejectSecondUpdate?.(new Error('Could not save inactivity setting'))
      await Promise.resolve()
    })

    expect(inbox.getAttribute('aria-checked')).toBe('true')
    expect(days.getAttribute('aria-valuenow')).toBe('3')
  })

  it('switches sidebar versions only from settings', async () => {
    serverSidebarSettings.mode = 'classic'
    render(<App />)

    expect(screen.queryByRole('button', { name: /Switch to V[12].*sidebar/ })).toBeNull()
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Inbox' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('sidebar.updateSettings', {
        mode: 'inbox',
      })
      expect(screen.getByRole('radio', { name: 'Inbox' }).getAttribute('aria-checked')).toBe('true')
    })
  })

  it('does not rewrite unchanged saved preferences during startup', () => {
    const saved = new Map([
      ['harness.theme', 'dark'],
      ['harness.font', 'system'],
      ['harness.accent', 'ocean'],
      ['harness.backdrop', 'slate'],
      ['harness.sidebarGlass2', '42'],
      ['harness.macosFontSmoothing', 'false'],
      ['harness.terminal.open', 'false'],
      ['harness.terminal.height', '320'],
      ['harness.approval', 'full'],
    ])
    for (const [key, value] of saved) localStorage.setItem(key, value)
    const setItem = vi.spyOn(localStorage, 'setItem')

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    const redundantWrites = setItem.mock.calls.filter(
      ([key, value]) => saved.get(String(key)) === String(value),
    )
    expect(redundantWrites).toEqual([])
  })

  it('persists a missing default once under StrictMode', () => {
    const setItem = vi.spyOn(localStorage, 'setItem')

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(
      setItem.mock.calls.filter(([key, value]) => key === 'harness.theme' && value === 'system'),
    ).toHaveLength(1)
  })

  it('starts with the terminal closed even when an older version saved it as open', async () => {
    localStorage.setItem('harness.terminal.open', 'true')
    render(<App />)
    const openTerminal = await screen.findByRole('button', { name: 'Show bottom panel' })

    expect(screen.queryByTestId('bottom-terminal')).toBeNull()
    fireEvent.click(openTerminal)
    expect(await screen.findByTestId('bottom-terminal')).toBeTruthy()
  })

  it('flushes delayed workspace width persistence when the page hides', () => {
    vi.useFakeTimers()
    try {
      const setItem = vi.spyOn(localStorage, 'setItem')
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )

      expect(
        setItem.mock.calls.filter(([key]) => key === 'harness.workspacePanel.width'),
      ).toHaveLength(0)
      window.dispatchEvent(new Event('pagehide'))

      expect(
        setItem.mock.calls.filter(([key, value]) => {
          return key === 'harness.workspacePanel.width' && value === '520'
        }),
      ).toHaveLength(1)
      act(() => vi.advanceTimersByTime(120))
      expect(
        setItem.mock.calls.filter(([key]) => key === 'harness.workspacePanel.width'),
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels delayed workspace width persistence before resetting settings', async () => {
    await import('./ui/Settings.js')
    await import('./ui/workspace/WorkspacePanel.js')
    vi.useFakeTimers()
    try {
      render(<App />)
      fireEvent.click(screen.getByRole('button', { name: 'Show workspace tools' }))
      await act(async () => {
        await Promise.resolve()
      })
      openSettings()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }))

      const handle = document.querySelector<HTMLElement>('.workspace-panel__resize')!
      const layout = document.querySelector<HTMLElement>('.workspace-layout')!
      Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 900 })
      Object.defineProperty(handle, 'setPointerCapture', {
        configurable: true,
        value: vi.fn(),
      })

      fireEvent.pointerDown(handle, { clientX: 500, pointerId: 7 })
      fireEvent.pointerMove(window, { clientX: 420, pointerId: 7 })
      fireEvent.pointerUp(window, { clientX: 420, pointerId: 7 })

      fireEvent.click(screen.getByRole('button', { name: 'Reset app preferences' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reset and reload' }))
      act(() => vi.advanceTimersByTime(120))

      expect(localStorage.getItem('harness.workspacePanel.width')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists a selected appearance across app restarts', async () => {
    localStorage.setItem('harness.theme', 'dark')
    const first = render(<App />)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))

    const lightTheme = screen.getByRole('radio', { name: 'Light' })
    expect((lightTheme as HTMLInputElement).checked).toBe(false)
    fireEvent.click(lightTheme)

    await waitFor(() => {
      expect(localStorage.getItem('harness.theme')).toBe('light')
      expect(document.documentElement.dataset.theme).toBe('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('replaces the removed Codex theme with system across app restarts', async () => {
    localStorage.setItem('harness.theme', 'codex')
    const first = render(<App />)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.queryByRole('radio', { name: 'Codex' })).toBeNull()
    expect((screen.getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true)

    await waitFor(() => {
      expect(localStorage.getItem('harness.theme')).toBe('system')
      expect(document.documentElement.dataset.theme).toBe(
        window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      )
    })

    first.unmount()
    render(<App />)

    expect(localStorage.getItem('harness.theme')).toBe('system')
    expect(document.documentElement.dataset.theme).not.toBe('codex')
  })

  it('saves mode appearance independently without applying inactive edits', async () => {
    localStorage.setItem('harness.theme', 'light')
    localStorage.setItem('harness.accent.light', 'forest')
    localStorage.setItem('harness.accent.dark', 'ocean')
    localStorage.setItem('harness.backdrop.light', '#FFFFFF')
    localStorage.setItem('harness.backdrop.dark', '#111111')
    localStorage.setItem('harness.sidebarGlass2.light', '0')
    localStorage.setItem('harness.sidebarGlass2.dark', '50')
    const first = render(<App />)
    openSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    const dark = within(screen.getByRole('region', { name: 'Dark mode' }))
    fireEvent.click(dark.getByRole('combobox', { name: 'Interface font' }))
    fireEvent.click(screen.getByRole('option', { name: 'Inter' }))
    await waitFor(() => expect(localStorage.getItem('harness.font.dark')).toBe('inter'))
    expect(document.documentElement.dataset.font).toBe('system')
    expect(document.documentElement.dataset.accent).toBe('forest')
    expect(document.documentElement.style.getPropertyValue('--custom-backdrop')).toBe('#FFFFFF')
    expect(document.documentElement.dataset.glass).toBe('off')
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset.font).toBe('inter')
    expect(document.documentElement.dataset.accent).toBe('ocean')
    expect(document.documentElement.style.getPropertyValue('--custom-backdrop')).toBe('#111111')
    expect(document.documentElement.style.getPropertyValue('--rail-glass')).toBe('0.5')
    first.unmount()
    render(<App />)
    expect(document.documentElement.dataset.font).toBe('inter')
    openSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.dataset.font).toBe('system')
    expect(document.documentElement.dataset.accent).toBe('forest')
    expect(document.documentElement.dataset.glass).toBe('off')
  })

  it('persists the selected interface font', async () => {
    const first = render(<App />)
    openSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    const fontSelector = within(screen.getByRole('region', { name: 'Light mode' })).getByRole(
      'combobox',
      { name: 'Interface font' },
    )
    expect(fontSelector.textContent).toContain('System default')
    fireEvent.click(fontSelector)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'System default',
      'Geist',
      'Geist Mono',
      'Inter',
    ])
    fireEvent.click(screen.getByRole('option', { name: 'Inter' }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.font.light')).toBe('inter')
      expect(document.documentElement.dataset.font).toBe('inter')
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.font).toBe('inter')
  })

  it('loads, applies, and persists an installed interface font', async () => {
    const originalQuery = Object.getOwnPropertyDescriptor(globalThis, 'queryLocalFonts')
    const records = [
      { family: 'Atkinson Hyperlegible', fullName: 'Atkinson Hyperlegible Regular' },
      { family: 'Atkinson Hyperlegible', fullName: 'Atkinson Hyperlegible Bold' },
      { family: 'Zilla Slab', fullName: 'Zilla Slab Regular' },
    ]
    let finishScan!: (value: typeof records) => void
    const queryLocalFonts = vi.fn(
      () =>
        new Promise((resolve) => {
          finishScan = resolve
        }),
    )
    Object.defineProperty(globalThis, 'queryLocalFonts', {
      configurable: true,
      value: queryLocalFonts,
    })

    try {
      const first = render(<App />)
      openSettings()
      fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
      fireEvent.click(
        within(screen.getByRole('region', { name: 'Light mode' })).getByRole('combobox', {
          name: 'Interface font',
        }),
      )

      expect(queryLocalFonts).toHaveBeenCalledOnce()
      expect(screen.getByRole('status').textContent).toBe('Loading fonts…')
      expect(screen.queryAllByRole('option')).toHaveLength(0)
      await act(async () => finishScan(records))
      const atkinson = await screen.findByRole('option', { name: 'Atkinson Hyperlegible' })
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'System default',
        'Geist',
        'Geist Mono',
        'Inter',
        'Atkinson Hyperlegible',
        'Zilla Slab',
      ])
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search fonts' }), {
        target: { value: 'atki' },
      })
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Atkinson Hyperlegible',
      ])
      fireEvent.click(atkinson)
      await waitFor(() => {
        expect(localStorage.getItem('harness.font.light')).toBe('local:Atkinson Hyperlegible')
        expect(document.documentElement.dataset.font).toBe('local')
        expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
          '"Atkinson Hyperlegible", system-ui, sans-serif',
        )
      })

      first.unmount()
      render(<App />)
      expect(screen.queryByRole('combobox', { name: 'Interface font' })).toBeNull()
      expect(document.documentElement.dataset.font).toBe('local')
      openSettings()
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      fireEvent.keyDown(
        within(screen.getByRole('region', { name: 'Light mode' })).getByRole('combobox', {
          name: 'Interface font',
        }),
        {
          key: 'ArrowDown',
        },
      )
      expect(screen.getByRole('option', { name: 'Atkinson Hyperlegible' })).toBeTruthy()
      expect(screen.getAllByRole('option')).toHaveLength(6)
      expect(queryLocalFonts).toHaveBeenCalledOnce()
    } finally {
      if (originalQuery) Object.defineProperty(globalThis, 'queryLocalFonts', originalQuery)
      else Reflect.deleteProperty(globalThis, 'queryLocalFonts')
    }
  })

  it('persists the selected accent palette', async () => {
    const first = render(<App />)
    openSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Light mode' })).getByRole('button', {
        name: /^Accent palette:/,
      }),
    )
    const picker = within(screen.getByRole('region', { name: 'Light mode' })).getByRole('dialog', {
      name: 'Accent palette color picker',
      hidden: true,
    })
    fireEvent(picker, Object.assign(new Event('toggle'), { newState: 'open' }))
    const hex = within(picker).getByRole('textbox', {
      name: 'Accent palette hex color',
      hidden: true,
    })
    fireEvent.change(hex, { target: { value: '#E11D48' } })

    await waitFor(() => {
      expect(localStorage.getItem('harness.accent.light')).toBe('#E11D48')
      expect(document.documentElement.dataset.accent).toBe('custom')
      expect(document.documentElement.style.getPropertyValue('--custom-accent')).toBe('#E11D48')
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.accent).toBe('custom')
    expect(document.documentElement.style.getPropertyValue('--custom-accent')).toBe('#E11D48')
  })

  it('tracks OS appearance while System is selected', async () => {
    localStorage.setItem('harness.font.light', 'inter')
    localStorage.setItem('harness.font.dark', 'mono')
    const originalMatchMedia = window.matchMedia.bind(window)
    let systemIsDark = false
    const systemThemeMedia = originalMatchMedia('(prefers-color-scheme: dark)')
    vi.spyOn(systemThemeMedia, 'matches', 'get').mockImplementation(() => systemIsDark)

    vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
      query === systemThemeMedia.media ? systemThemeMedia : originalMatchMedia(query),
    )

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    fireEvent.click(screen.getByRole('radio', { name: 'System' }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.theme')).toBe('system')
      expect(document.documentElement.dataset.theme).toBe('light')
      expect(document.documentElement.dataset.font).toBe('inter')
    })

    systemIsDark = true
    act(() => {
      systemThemeMedia.dispatchEvent(
        new MediaQueryListEvent('change', {
          matches: systemIsDark,
          media: systemThemeMedia.media,
        }),
      )
    })

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.font).toBe('mono')
  })

  it.each([true, false])(
    'defaults from auto-review support (%s) without saving an implicit choice',
    async (supported) => {
      serverProviders = serverProviders.map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities, autoReview: supported },
      }))
      const first = render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain(
          supported ? 'Auto-review' : 'Full access',
        )
        expect(transport.request).toHaveBeenCalledWith('providers.list', {})
      })
      expect(localStorage.getItem('harness.approval')).toBeNull()
      expect(localStorage.getItem('harness.approvalByProvider')).toBe('{}')
      first.unmount()
      render(<App />)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain(
          supported ? 'Auto-review' : 'Full access',
        ),
      )
    },
  )

  it('keeps an explicit Ask first preference', async () => {
    localStorage.setItem('harness.approvalByProvider', JSON.stringify({ codex: 'ask' }))
    render(<App />)
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('providers.list', {}))
    expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain('Ask first')
  })

  it('shows the saved task access mode instead of the provider preference', async () => {
    localStorage.setItem('harness.approvalByProvider', JSON.stringify({ codex: 'ask' }))
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let resolveHistory:
      ((value: { events: []; running: false; approval: 'full' }) => void) | undefined
    const history = new Promise<{ events: []; running: false; approval: 'full' }>((resolve) => {
      resolveHistory = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.history' ? history : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))

    const permissions = screen.getByRole('button', { name: 'Permissions' })
    expect(within(permissions).getByRole('status').textContent).toContain('Loading permissions')
    expect(permissions.hasAttribute('disabled')).toBe(true)

    await act(async () => resolveHistory?.({ events: [], running: false, approval: 'full' }))
    await waitFor(() => expect(permissions.textContent).toContain('Full access'))
    expect(localStorage.getItem('harness.approvalByProvider')).toBe('{"codex":"ask"}')
  })

  it('falls back to Ask first and offers a retry when a chat cannot be read', async () => {
    const request = transport.request.getMockImplementation()!
    let reads = 0
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      reads += 1
      return reads === 1
        ? Promise.reject(new Error('request timed out'))
        : Promise.resolve({
            events: [completedHistoryEvent(1, 'base', 'Existing message')],
            running: false,
            approval: 'full',
          })
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))

    const retry = await screen.findByRole('button', { name: 'Retry loading: request timed out' })
    const permissions = screen.getByRole('button', { name: 'Permissions' })
    expect(within(permissions).queryByRole('status')).toBeNull()
    expect(permissions.textContent).toContain('Ask first')
    expect(permissions.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('request timed out')).toBeNull()

    fireEvent.click(retry)
    expect(await screen.findByText('Existing message')).toBeTruthy()
    await waitFor(() => expect(permissions.textContent).toContain('Full access'))
    expect(screen.queryByRole('button', { name: /^Retry loading/ })).toBeNull()
    expect(reads).toBe(2)
  })

  it('reopens a chat with its last access mode while its history reloads', async () => {
    serverProjects[0]!.sessions.push({
      id: 'second-thread',
      title: 'Second session',
      provider: 'codex',
      createdAt: 1,
      running: false,
    })
    const request = transport.request.getMockImplementation()!
    let hold = false
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      const { threadId } = methods['thread.history'].params.parse(params)
      if (hold) return new Promise(() => undefined)
      return Promise.resolve({
        events: [],
        running: false,
        approval: threadId === 'untouched-thread' ? 'full' : 'ask',
      })
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const permissions = screen.getByRole('button', { name: 'Permissions' })
    await waitFor(() => expect(permissions.textContent).toContain('Full access'))
    fireEvent.click(screen.getByRole('button', { name: /^Second session,/ }))
    await waitFor(() => expect(permissions.textContent).toContain('Ask first'))

    hold = true
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    expect(within(permissions).queryByRole('status')).toBeNull()
    expect(permissions.textContent).toContain('Full access')
  })

  it('waits for the provider list before showing the default access mode', async () => {
    render(<App />)

    const permissions = screen.getByRole('button', { name: 'Permissions' })
    expect(within(permissions).getByRole('status').textContent).toContain('Loading permissions')
    expect(permissions.querySelector('.tool--danger')).toBeNull()
    expect(permissions.hasAttribute('disabled')).toBe(true)

    await waitFor(() => expect(permissions.querySelector('.tool--review')).not.toBeNull())
    expect(permissions.textContent).toContain('Auto-review')
    expect(permissions.hasAttribute('disabled')).toBe(false)
  })

  it('keeps full access selected after the app restarts', async () => {
    const first = render(<App />)

    const permissions = screen.getByRole('button', { name: 'Permissions' })
    await waitFor(() => expect(permissions.hasAttribute('disabled')).toBe(false))
    fireEvent.click(permissions)
    fireEvent.click(screen.getByRole('menuitem', { name: /Full access/ }))

    expect(localStorage.getItem('harness.approval')).toBe('full')
    first.unmount()
    render(<App />)

    expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain('Full access')
  })

  it('keeps a separate access preference for each provider', async () => {
    serverProviders = [
      ...serverProviders,
      {
        id: 'grok',
        displayName: 'Grok',
        installed: true,
        auth: 'authenticated',
        capabilities: {
          steer: true,
          fork: false,
          interrupt: true,
          reasoningItems: true,
          approvals: true,
          userInput: false,
          autoReview: false,
          images: true,
        },
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const selectedProvider = methods['models.list'].params.parse(params).provider
        return Promise.resolve({
          models:
            selectedProvider === 'codex'
              ? [cachedCodexChoice().model]
              : [
                  {
                    id: 'grok-4.6',
                    displayName: 'Grok 4.6',
                    isDefault: true,
                    reasoningEfforts: ['low', 'high'],
                    defaultReasoningEffort: 'low',
                    serviceTiers: [],
                  },
                ],
        })
      }
      return request(method, params)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Auto-approve/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use Grok 4.6 through Grok' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain(
        'Full access',
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Full access/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain('Auto')
      expect(JSON.parse(localStorage.getItem('harness.approvalByProvider') ?? '{}')).toEqual({
        codex: 'auto',
        grok: 'full',
      })
    })
  })

  it('starts Codex sessions with its advertised auto-review mode', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'providers.list'),
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Auto-review/ }))

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Check this safely' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
      })
    })
  })

  it('pushes a mid-chat access-level change to the live thread', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Start a chat' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', expect.anything())
    })

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Full access/ }))

    expect(transport.request).toHaveBeenCalledWith('thread.setApproval', {
      threadId: 'thread-1',
      approval: 'full',
    })
  })

  it('switches the new chat project from the prompt', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'TasteCode',
        pinned: false,
        createdAt: 0,
        sessions: [],
      },
      {
        path: '/work/another-project',
        name: 'Another Project',
        pinned: false,
        createdAt: 1,
        sessions: [],
      },
    ]

    render(<App />)

    expect((await screen.findByRole('heading')).textContent).toContain(
      'What should we build in TasteCode?',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('menuitem', { name: /Another Project/ }))

    expect(screen.getByRole('heading').textContent).toContain(
      'What should we build in Another Project?',
    )
    expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toContain(
      'Another Project',
    )
  })

  it('toggles an empty project without leaving the current new chat', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'TasteCode',
        pinned: false,
        createdAt: 0,
        sessions: [],
      },
      {
        path: '/work/another-project',
        name: 'Another Project',
        pinned: false,
        createdAt: 1,
        sessions: [],
      },
    ]

    render(<App />)
    await screen.findByRole('heading', { name: 'What should we build in TasteCode?' })

    const anotherProject = screen.getByRole('button', { name: 'Another Project' })
    fireEvent.click(anotherProject)

    await waitFor(() => expect(anotherProject.getAttribute('aria-expanded')).toBe('true'))
    expect(within(anotherProject.closest('.proj')!).getByText('No chats')).toBeTruthy()
    expect(screen.getByRole('heading').textContent).toBe('What should we build in TasteCode?')
    expect(screen.getByPlaceholderText('Do anything')).toBeTruthy()

    fireEvent.click(anotherProject)
    await waitFor(() => expect(anotherProject.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.getByRole('heading').textContent).toBe('What should we build in TasteCode?')
  })

  it('keeps saved chats and only creates a new chat on the first prompt', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    fireEvent.click(within(actions!).getByRole('button', { name: 'New chat' }))

    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
    expect(document.querySelectorAll('.sessrow')).toHaveLength(1)

    const composer = document.querySelector('textarea')
    expect(composer).not.toBeNull()
    expect(document.activeElement).toBe(composer)
    fireEvent.change(composer!, { target: { value: 'Fix the sidebar' } })
    fireEvent.keyDown(composer!, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
      })
      expect(screen.getByRole('button', { name: /^Fix the sidebar,/ })).toBeTruthy()
      expect(screen.getByTestId('thread').textContent).toContain('Fix the sidebar')
    })
  })

  it('forwards model, effort, and the provider fast tier on every turn', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      switch (method) {
        case 'models.list':
          return Promise.resolve({
            models: [
              {
                id: 'gpt-6.1-sol',
                displayName: 'GPT-5.6-Sol',
                isDefault: true,
                reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                defaultReasoningEffort: 'low',
                serviceTiers: [
                  {
                    id: 'standard',
                    name: 'Balanced',
                    description: '1x speed, standard usage',
                  },
                  {
                    id: 'priority',
                    name: 'Fast',
                    description: '1.5x speed, increased usage',
                  },
                ],
              },
            ],
          })
        case 'workspace.info':
          return Promise.resolve({ branch: 'main', added: 0, removed: 0, dirtyFiles: 0 })
        case 'workspace.branches':
          return Promise.resolve({ branches: ['main'] })
        case 'auth.status':
          return Promise.resolve({ signedIn: true })
        case 'projects.list':
          return Promise.resolve({ projects: serverProjects })
        case 'thread.start':
          return Promise.resolve({ threadId: 'thread-1' })
        case 'thread.queue':
          return Promise.resolve({ items: [], canSteer: true })
        case 'thread.sendTurn':
          return Promise.resolve({ queued: false, turnId: 'turn-1' })
        default:
          return request(method, params)
      }
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable fast mode' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'End' })

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use the fast lane' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use the fast lane',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      })
    })
  })

  describe('provider defaults', () => {
    beforeEach(() => {
      localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')
      const request = transport.request.getMockImplementation()
      if (!request) throw new Error('missing request mock')
      transport.request.mockImplementation((method: string, params: unknown) => {
        if (method !== 'models.list') return request(method, params)
        return Promise.resolve({
          models: [
            {
              id: 'gpt-6.1-sol',
              displayName: 'GPT-6.1 Sol',
              isDefault: true,
              reasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: 'medium',
              serviceTiers: [],
            },
            {
              id: 'gpt-5.6-mini',
              displayName: 'GPT-5.6 Mini',
              isDefault: false,
              reasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [],
            },
          ],
        })
      })
    })

    async function waitForCatalog() {
      fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
      await screen.findByRole('button', { name: 'Use GPT-5.6 Mini through Codex' })
      fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    }

    function send(text: string) {
      const composer = screen.getByPlaceholderText('Do anything')
      fireEvent.change(composer, { target: { value: text } })
      fireEvent.keyDown(composer, { key: 'Enter' })
    }

    it('starts a new chat on the model and reasoning pinned for its provider', async () => {
      localStorage.setItem(
        'harness.providerDefaults',
        JSON.stringify({ codex: { model: 'gpt-5.6-mini', effort: 'high' } }),
      )
      render(<App />)
      await waitForCatalog()

      const actions = document.querySelector<HTMLElement>('.rail__actions')!
      fireEvent.click(within(actions).getByRole('button', { name: 'New chat' }))
      send('Use the pinned model')

      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith(
          'thread.start',
          expect.objectContaining({ provider: 'codex', model: 'gpt-5.6-mini', effort: 'high' }),
        ),
      )
    })

    it('applies defaults set in Settings to the new chat that is already open', async () => {
      render(<App />)
      await waitForCatalog()
      const actions = document.querySelector<HTMLElement>('.rail__actions')!
      fireEvent.click(within(actions).getByRole('button', { name: 'New chat' }))

      await openProviderSettings()
      const defaults = await within(
        await screen.findByRole('dialog', { name: 'Settings' }),
      ).findByRole('group', { name: 'Codex defaults' })
      const model = within(defaults).getByRole('button', { name: /^Codex default model: / })
      fireEvent.click(model)
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Codex default model' })).getByRole('button', {
          name: 'GPT-5.6 Mini',
        }),
      )
      // A model with effort levels keeps its panel open for them.
      fireEvent.click(model)
      fireEvent.click(within(defaults).getByRole('button', { name: /^Codex default access: / }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Codex default access' })).getByRole(
          'menuitemradio',
          { name: /^Ask first/ },
        ),
      )
      expect(JSON.parse(localStorage.getItem('harness.providerDefaults') ?? '{}')).toEqual({
        codex: { model: 'gpt-5.6-mini' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())

      send('Use the new defaults')
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith(
          'thread.start',
          expect.objectContaining({
            provider: 'codex',
            approval: 'ask',
            model: 'gpt-5.6-mini',
            effort: 'low',
          }),
        ),
      )
    })
  })

  it('keeps highest reasoning effort at the highest stop when switching models', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      switch (method) {
        case 'models.list':
          return Promise.resolve({
            models: [
              {
                id: 'gpt-6.1-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                reasoningEfforts: ['low', 'medium', 'high', 'max', 'ultra'],
                defaultReasoningEffort: 'low',
                serviceTiers: [],
              },
              {
                id: 'gpt-5.6-mini',
                displayName: 'GPT-5.6 Mini',
                isDefault: false,
                reasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: 'low',
                serviceTiers: [],
              },
            ],
          })
        case 'workspace.info':
          return Promise.resolve({ branch: 'main', added: 0, removed: 0, dirtyFiles: 0 })
        case 'workspace.branches':
          return Promise.resolve({ branches: ['main'] })
        case 'auth.status':
          return Promise.resolve({ signedIn: true })
        case 'projects.list':
          return Promise.resolve({ projects: serverProjects })
        case 'thread.start':
          return Promise.resolve({ threadId: 'thread-1' })
        case 'thread.queue':
          return Promise.resolve({ items: [], canSteer: true })
        case 'thread.sendTurn':
          return Promise.resolve({ queued: false, turnId: 'turn-1' })
        default:
          return request(method, params)
      }
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'End' })
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }))

    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: High',
      )
    })

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep the rank' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'auto-review',
        model: 'gpt-5.6-mini',
        effort: 'high',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Keep the rank',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-5.6-mini',
        effort: 'high',
      })
    })
  })

  it.each([false, true])(
    'keeps each chat model, design, and approval setup after switching and reloading (same model: %s)',
    async (sameModel) => {
      serverProjects[0]!.sessions = [
        { id: 'chat-a', title: 'Chat A', provider: 'codex', createdAt: 1 },
        { id: 'chat-b', title: 'Chat B', provider: 'codex', createdAt: 2 },
      ]
      const models = [
        cachedCodexChoice().model,
        {
          ...cachedCodexChoice().model,
          id: 'gpt-5.6-mini',
          displayName: 'GPT-5.6 Mini',
          isDefault: false,
        },
      ].map((model) => ({
        ...model,
        serviceTiers: [
          { id: 'standard', name: 'Standard', description: '' },
          { id: 'priority', name: 'Fast', description: '' },
        ],
      }))
      const request = transport.request.getMockImplementation()!
      const approvals = new Map<string, string>()
      transport.request.mockImplementation((method, params) => {
        if (method === 'models.list') return Promise.resolve({ models })
        if (method === 'thread.setApproval') {
          const { threadId, approval } = methods['thread.setApproval'].params.parse(params)
          approvals.set(threadId, approval)
        }
        if (method === 'thread.history') {
          const { threadId } = methods['thread.history'].params.parse(params)
          return Promise.resolve({
            events: [],
            running: false,
            approval: approvals.get(threadId) ?? 'ask',
          })
        }
        return request(method, params)
      })

      const openPicker = async () => {
        const button = await screen.findByRole('button', { name: 'Model and reasoning' })
        if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
      }
      const expectSetup = async (model: string, effort: string, fast: boolean) => {
        await openPicker()
        await waitFor(() => {
          expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
            model,
          )
          expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
            `Effort: ${effort}`,
          )
          expect(
            screen.getByRole('button', { name: fast ? 'Disable fast mode' : 'Enable fast mode' }),
          ).toBeTruthy()
          expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
            String(fast),
          )
          expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain(
            fast ? 'Auto' : 'Ask first',
          )
        })
      }
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Chat A,/ }))
      await expectSetup('5.6 Sol', 'Low', false)
      fireEvent.click(screen.getByRole('button', { name: /^Chat B,/ }))
      await openPicker()
      if (!sameModel)
        fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }))
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'End' })
      fireEvent.click(screen.getByRole('button', { name: 'Enable fast mode' }))
      fireEvent.click(screen.getByRole('button', { name: 'Design' }))
      fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
      fireEvent.click(screen.getByRole('menuitem', { name: /Auto-approve/ }))
      await expectSetup(sameModel ? '5.6 Sol' : '5.6 Mini', 'High', true)

      fireEvent.click(screen.getByRole('button', { name: /^Chat A,/ }))
      await expectSetup('5.6 Sol', 'Low', false)
      const composer = screen.getByPlaceholderText('Do anything')
      fireEvent.change(composer, { target: { value: 'Use this chat setup' } })
      fireEvent.keyDown(composer, { key: 'Enter' })
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
          text: 'Use this chat setup',
          clientSubmissionId: expect.stringMatching(/^local:/),
          threadId: 'chat-a',
          model: 'gpt-6.1-sol',
          effort: 'low',
        }),
      )
      cleanup()
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Chat B,/ }))
      await expectSetup(sameModel ? '5.6 Sol' : '5.6 Mini', 'High', true)
      fireEvent.click(screen.getByRole('button', { name: /^Chat A,/ }))
      await expectSetup('5.6 Sol', 'Low', false)
      emitThreadEvent('chat-b', {
        type: 'item.completed',
        item: {
          id: 'design-done',
          turnId: 'design-turn',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: 'Website built. Checks passed.',
          createdAt: 3,
        },
      })
      expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
        'false',
      )
      fireEvent.click(screen.getByRole('button', { name: /^Chat B,/ }))
      expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe(
        'false',
      )
      expect(JSON.parse(localStorage.getItem('harness.modelByThread:chat-b')!).designMode).toBe(
        false,
      )
    },
  )

  it('restores a chat setup after late discovery instead of the provider setup', async () => {
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')
    localStorage.setItem('harness.effort', 'low')
    const saved = { modelKey: 'codex:gpt-5.6-mini', effort: 'high', serviceTier: 'priority' }
    localStorage.setItem('harness.modelByThread:untouched-thread', JSON.stringify(saved))
    let discover!: (result: ResultOf<'models.list'>) => void
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'models.list'
        ? new Promise((resolve) => {
            discover = resolve
          })
        : request(method, params),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByRole('button', { name: 'Model and reasoning' })
    expect(JSON.parse(localStorage.getItem('harness.modelByThread:untouched-thread')!)).toEqual(
      saved,
    )
    await act(async () =>
      discover({
        models: [
          cachedCodexChoice().model,
          {
            ...cachedCodexChoice().model,
            id: 'gpt-5.6-mini',
            displayName: 'GPT-5.6 Mini',
            isDefault: false,
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
          },
        ],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        '5.6 Mini',
      )
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: High',
      )
      expect(screen.getByRole('button', { name: 'Disable fast mode' })).toBeTruthy()
    })
    expect(JSON.parse(localStorage.getItem('harness.modelByThread:untouched-thread')!)).toEqual(
      saved,
    )
  })

  it('saves a fast mode toggle from the menu to the open chat setup', async () => {
    const saved = { modelKey: 'codex:gpt-5.6-mini', effort: 'high', serviceTier: 'priority' }
    localStorage.setItem('harness.modelByThread:untouched-thread', JSON.stringify(saved))
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'models.list'
        ? Promise.resolve({
            models: [
              cachedCodexChoice().model,
              {
                ...cachedCodexChoice().model,
                id: 'gpt-5.6-mini',
                displayName: 'GPT-5.6 Mini',
                isDefault: false,
                serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
              },
            ],
          })
        : request(method, params),
    )
    const savedTier = () =>
      JSON.parse(localStorage.getItem('harness.modelByThread:untouched-thread')!).serviceTier
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    // The model picker is lazy-loaded.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Model and reasoning' }, { timeout: 10_000 }),
    )
    await screen.findByRole('button', { name: 'Disable fast mode' })

    act(() => nativeMenu.listener?.('toggleFastMode'))
    await screen.findByRole('button', { name: 'Enable fast mode' })

    await waitFor(() => expect(savedTier()).not.toBe('priority'))
  })

  it('opens a chat saved on a model Codex no longer ships and continues on the default', async () => {
    localStorage.setItem('harness.model', 'codex:gpt-5.4')
    serverProjects[0]!.sessions = [
      { id: 'chat-retired', title: 'Retired model chat', provider: 'codex', createdAt: 1 },
    ]
    localStorage.setItem(
      'harness.modelByThread:chat-retired',
      JSON.stringify({ modelKey: 'codex:gpt-5.4', effort: 'high' }),
    )
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'models.list'
        ? Promise.resolve({
            models: [
              {
                id: 'gpt-6-astra',
                displayName: 'GPT-6-Astra',
                isDefault: true,
                reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                defaultReasoningEffort: 'medium',
                serviceTiers: [],
              },
              {
                id: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
                isDefault: false,
                reasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: 'low',
                serviceTiers: [],
              },
            ],
          })
        : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Retired model chat,/ }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith(
        'thread.history',
        expect.objectContaining({ threadId: 'chat-retired' }),
      )
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        'Astra',
      )
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Carry on' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ threadId: 'chat-retired', model: 'gpt-6-astra' }),
      ),
    )
  })

  it('keeps edits made while a new chat starts after leaving the chat', async () => {
    let finishStart!: () => Promise<void>
    let savedApproval = 'full'
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'models.list') return Promise.resolve({ models: [cachedCodexChoice().model] })
      if (method === 'thread.setApproval')
        savedApproval = methods['thread.setApproval'].params.parse(params).approval
      if (method === 'thread.history')
        return Promise.resolve({ events: [], running: false, approval: savedApproval })
      if (method === 'thread.start')
        return new Promise((resolve) => {
          finishStart = async () => {
            resolve(await request(method, params))
          }
        })
      return request(method, params)
    })
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    await screen.findByRole('button', { name: 'Model and reasoning' })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Full access/ }))
    fireEvent.change(composer, { target: { value: 'New chat setup' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(finishStart).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'End' })
    fireEvent.click(screen.getByRole('button', { name: 'Design' }))
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Ask first/ }))
    expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain('Ask first')
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    await act(async () => finishStart())
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('harness.modelByThread:thread-1') ?? 'null')).toEqual({
        modelKey: 'codex:gpt-6.1-sol',
        effort: 'high',
        designMode: true,
      }),
    )
    expect(
      Object.keys(localStorage).some((key) => key.startsWith('harness.modelByThread:pending:')),
    ).toBe(false)
    expect(transport.request).toHaveBeenCalledWith('thread.setApproval', {
      threadId: 'thread-1',
      approval: 'ask',
    })
    fireEvent.click(await screen.findByRole('button', { name: /^New chat setup,/ }))
    const picker = await screen.findByRole('button', { name: 'Model and reasoning' })
    if (picker.getAttribute('aria-expanded') !== 'true') fireEvent.click(picker)
    await waitFor(() =>
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: High',
      ),
    )
    expect(screen.getByRole('button', { name: 'Design' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Permissions' }).textContent).toContain(
        'Ask first',
      ),
    )
  })

  it('restores the setup last used with a provider when returning to it', async () => {
    serverProviders = [
      ...serverProviders,
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities: {
          steer: false,
          fork: false,
          interrupt: true,
          reasoningItems: true,
          approvals: false,
          userInput: false,
          autoReview: false,
          images: false,
        },
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        if (methods['models.list'].params.parse(params).provider === 'codex') {
          return Promise.resolve({
            models: [
              {
                id: 'gpt-6.1-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                defaultReasoningEffort: 'medium',
                serviceTiers: [],
              },
            ],
          })
        }
        return Promise.resolve({
          models: [
            {
              id: 'sonnet',
              displayName: 'Sonnet 5',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [],
            },
            {
              id: 'opus',
              displayName: 'Opus 5',
              isDefault: false,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses' }],
              defaultServiceTier: 'fast',
            },
          ],
        })
      }
      return request(method, params)
    })

    // The flow below walks providers through the rail layout's provider tabs.
    localStorage.setItem('harness.modelPickerLayout', 'rail')

    render(<App />)

    // Codex: push effort to the top of Sol's ladder.
    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'End' })
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Extra High',
      )
    })

    // Claude: the top carries over to 'high'; drop it to the bottom.
    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Opus 5 through Claude Code' }))
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: High',
      )
    })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Reasoning effort' }), { key: 'Home' })
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Low',
      )
    })

    // Returning to Codex restores the remembered Extra High — the old
    // carry-over translation of 'low' would land on Low here.
    fireEvent.click(screen.getByRole('button', { name: 'Show Codex models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }))
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Extra High',
      )
    })

    // And Claude still remembers Low rather than inheriting the top again.
    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Opus 5 through Claude Code' }))
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Low',
      )
      expect(screen.getByRole('button', { name: 'Enable fast mode' })).toBeTruthy()
    })
    localStorage.removeItem('harness.modelPickerLayout')
  })

  it('restores source memory when discovery replaces a missing selected model', async () => {
    serverProviders = [
      {
        ...serverProviders[0]!,
        id: 'claude-code',
        displayName: 'Claude Code',
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'opus',
              displayName: 'Opus 5',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.model', 'codex:retired-model')
    localStorage.setItem('harness.effort', 'high')
    localStorage.setItem('harness.serviceTier', 'priority')
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({ 'claude-code': { modelKey: 'claude-code:opus', effort: 'low' } }),
    )

    render(<App />)

    await waitFor(() => {
      const modelButton = screen.getByRole('button', { name: 'Model and reasoning' })
      expect(modelButton.textContent).toContain('Opus 5')
      expect(modelButton.textContent).toContain('Low')
      expect(localStorage.getItem('harness.serviceTier')).toBeNull()
    })
  })

  it('prefers current source memory when discovery removes its selected model', async () => {
    serverProviders = [
      ...serverProviders,
      {
        ...serverProviders[0]!,
        id: 'claude-code',
        displayName: 'Claude Code',
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const claude = methods['models.list'].params.parse(params).provider === 'claude-code'
        return Promise.resolve({
          models: claude
            ? [
                {
                  id: 'sonnet',
                  displayName: 'Sonnet 5',
                  isDefault: true,
                  reasoningEfforts: ['low', 'high'],
                  defaultReasoningEffort: 'low',
                  serviceTiers: [],
                },
                {
                  id: 'opus',
                  displayName: 'Opus 5',
                  isDefault: false,
                  reasoningEfforts: ['low', 'high'],
                  defaultReasoningEffort: 'low',
                  serviceTiers: [],
                },
              ]
            : [cachedCodexChoice().model],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.provider', 'claude-code')
    localStorage.setItem('harness.model', 'claude-code:retired-model')
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({
        'claude-code': { modelKey: 'claude-code:opus', effort: 'high' },
      }),
    )

    render(<App />)

    await waitFor(() => {
      const modelButton = screen.getByRole('button', { name: 'Model and reasoning' })
      expect(modelButton.textContent).toContain('Opus 5')
      expect(modelButton.textContent).toContain('High')
      expect(localStorage.getItem('harness.model')).toBe('claude-code:opus')
    })
  })

  it('moves the complete setup to the visible fallback when hiding the selected source', async () => {
    serverProviders = [
      ...serverProviders,
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities: {
          steer: false,
          fork: false,
          interrupt: true,
          reasoningItems: true,
          approvals: false,
          userInput: false,
          autoReview: false,
          images: false,
        },
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models:
            methods['models.list'].params.parse(params).provider === 'codex'
              ? [
                  {
                    id: 'gpt-6.1-sol',
                    displayName: 'GPT-5.6 Sol',
                    isDefault: true,
                    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                    defaultReasoningEffort: 'medium',
                    serviceTiers: [
                      { id: 'standard', name: 'Balanced', description: 'Standard speed' },
                      { id: 'priority', name: 'Fast', description: 'Faster responses' },
                    ],
                    defaultServiceTier: 'standard',
                  },
                ]
              : [
                  {
                    id: 'opus',
                    displayName: 'Opus 5',
                    isDefault: true,
                    reasoningEfforts: ['low', 'high'],
                    defaultReasoningEffort: 'low',
                    serviceTiers: [],
                  },
                ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')
    localStorage.setItem('harness.effort', 'xhigh')
    localStorage.setItem('harness.serviceTier', 'priority')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        '5.6 Sol',
      )
    })
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6 Sol in model picker' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        'Opus 5',
      )
      expect(localStorage.getItem('harness.provider')).toBe('claude-code')
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use the visible fallback' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'claude-code',
        workspacePath: '/work/project',
        approval: 'full',
        model: 'opus',
        effort: 'high',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use the visible fallback',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'opus',
        effort: 'high',
      })
    })
  })

  it('has no internal model setup when every catalog model is hidden', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'gpt-6.1-sol',
              displayName: 'GPT-5.6 Sol',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
            },
          ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')
    localStorage.setItem('harness.effort', 'high')
    localStorage.setItem('harness.serviceTier', 'priority')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        '5.6 Sol',
      )
    })
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6 Sol in model picker' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.model')).toBeNull()
      expect(localStorage.getItem('harness.effort')).toBeNull()
      expect(localStorage.getItem('harness.serviceTier')).toBeNull()
    })
    transport.request.mockClear()
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Do not use a hidden model' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toBe('Do not use a hidden model')
    })
    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
  })
})

describe('sidebar chat ordering', () => {
  it('persists the order chosen by dragging a project row', async () => {
    serverProjects = [
      { path: '/work/first', name: 'First', pinned: false, createdAt: 0, sessions: [] },
      { path: '/work/second', name: 'Second', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    const source = (await screen.findByRole('button', { name: 'First' })).closest('section')!
    const target = screen.getByRole('button', { name: 'Second' }).closest('section')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 30,
      left: 0,
      right: 200,
      top: 50,
      width: 200,
      x: 0,
      y: 50,
      toJSON: () => ({}),
    })
    const dataTransfer = { dropEffect: 'none', effectAllowed: 'none', setData: vi.fn() }

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { clientY: 75, dataTransfer })
    fireEvent.drop(target, { clientY: 75, dataTransfer })

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('harness.projectOrder') ?? '[]')).toEqual([
        '/work/second',
        '/work/first',
      ])
    })
  })

  it('persists the order chosen by dragging a chat row', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-3', title: 'Third chat', running: false },
          { id: 'thread-2', title: 'Second chat', running: false },
          { id: 'thread-1', title: 'First chat', running: false },
        ],
      },
    ]

    render(<App />)

    const source = (await screen.findByRole('button', { name: /^First chat,/ })).closest('li')!
    const target = screen.getByRole('button', { name: /^Third chat,/ }).closest('li')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 88,
      height: 28,
      left: 0,
      right: 200,
      top: 60,
      width: 200,
      x: 0,
      y: 60,
      toJSON: () => ({}),
    })
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn(),
    }

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { clientY: 80, dataTransfer })
    fireEvent.drop(target, { clientY: 80, dataTransfer })

    await waitFor(() => {
      const order = SessionOrderSchema.parse(
        JSON.parse(localStorage.getItem('harness.sessionOrder.dragged') ?? '{}'),
      )
      expect(order['/work/project']).toEqual(['thread-3', 'thread-1', 'thread-2'])
    })
  })

  it('drops a chat where the rail shows it beside a lifted unread chat', async () => {
    serverProjects = [
      serverProject('/work/project', 'project', [
        { id: 'thread-b', title: 'B chat' },
        { id: 'thread-c', title: 'C chat' },
        { id: 'thread-a', title: 'A chat', status: 'ready', unread: true },
      ]),
    ]

    render(<App />)

    await screen.findByRole('button', { name: /^C chat,/ })
    expect(sessionTitles()).toEqual(['A chat', 'B chat', 'C chat'])
    dropChatRow('C chat', 'A chat', 'after')

    expect(sessionTitles()).toEqual(['A chat', 'C chat', 'B chat'])
    await waitFor(() => {
      const order = SessionOrderSchema.parse(
        JSON.parse(localStorage.getItem('harness.sessionOrder.dragged') ?? '{}'),
      )
      expect(order['/work/project']).toEqual(['thread-c', 'thread-b', 'thread-a'])
    })
  })

  it('moves to the previous and next chat in the order the rail shows', async () => {
    serverProjects = [
      serverProject('/work/one', 'One', [
        { id: 'one-a', title: 'One A' },
        { id: 'one-pinned', title: 'One pinned', pinned: true },
        { id: 'one-b', title: 'One B' },
        { id: 'one-unread', title: 'One unread', status: 'ready', unread: true },
      ]),
      { ...serverProject('/work/two', 'Two', [{ id: 'two-a', title: 'Two A' }]), pinned: true },
    ]
    const step = async (key: 'ArrowDown' | 'ArrowUp', expected: string) => {
      fireEvent.keyDown(window, { key, metaKey: true, altKey: true })
      await waitFor(() => expect(sidebarProps().activeSessionId).toBe(expected))
    }

    render(<App />)

    await screen.findByRole('button', { name: /^One pinned,/ })
    act(() => sidebarProps().onSelectSession('one-a'))
    await waitFor(() => expect(sidebarProps().activeSessionId).toBe('one-a'))
    // The rail reads: Pinned (One pinned), Two (Two A), One (One unread, One A, One B).
    await step('ArrowDown', 'one-b')
    await step('ArrowDown', 'one-pinned')
    await step('ArrowDown', 'two-a')
    await step('ArrowUp', 'one-pinned')
    await step('ArrowUp', 'one-b')
  })

  it('moves to the previous and next chat in the order the inbox shows', async () => {
    serverSidebarSettings.mode = 'inbox'
    const active = { state: 'active', keepActive: false } as const
    serverProjects = [
      serverProject('/work/one', 'One', [
        { id: 'oldest', title: 'Oldest chat', createdAt: 1, lifecycle: active },
        {
          id: 'settled',
          title: 'Settled chat',
          createdAt: 5,
          lifecycle: { state: 'settled', settledAt: 6, reason: 'manual' },
        },
        { id: 'newest', title: 'Newest chat', createdAt: 4, lifecycle: active },
      ]),
      serverProject('/work/two', 'Two', [
        { id: 'older', title: 'Older chat', createdAt: 2, lifecycle: active },
        { id: 'newer', title: 'Newer chat', createdAt: 3, lifecycle: active },
      ]),
    ]
    const step = async (key: 'ArrowDown' | 'ArrowUp', expected: string) => {
      fireEvent.keyDown(window, { key, metaKey: true, altKey: true })
      await waitFor(() => expect(sidebarProps().activeSessionId).toBe(expected))
    }

    render(<App />)

    await screen.findByRole('button', { name: /^Newest chat, One,/ })
    act(() => sidebarProps().onSelectSession('newest'))
    await waitFor(() => expect(sidebarProps().activeSessionId).toBe('newest'))
    // Active chats newest first, then settled ones.
    await step('ArrowDown', 'newer')
    await step('ArrowDown', 'older')
    await step('ArrowDown', 'oldest')
    await step('ArrowDown', 'settled')
    await step('ArrowUp', 'oldest')
  })

  it('keeps chats imported later from another provider in date order', async () => {
    // Every project's order used to be saved automatically, freezing the order
    // in which provider histories happened to arrive.
    localStorage.setItem(
      'harness.sessionOrder',
      JSON.stringify({ '/work/project': ['claude-old', 'claude-new'] }),
    )
    const claudeNew = {
      id: 'claude-new',
      title: 'Newer Claude chat',
      provider: 'claude-code' as const,
      createdAt: 3,
      running: false,
    }
    const claudeOld = {
      id: 'claude-old',
      title: 'Older Claude chat',
      provider: 'claude-code' as const,
      createdAt: 1,
      running: false,
    }
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [claudeNew, claudeOld],
      },
    ]
    const titles = [
      'Newest Codex chat',
      'Newer Claude chat',
      'Middle Codex chat',
      'Older Claude chat',
    ]
    const sidebarOrder = () =>
      screen
        .getAllByRole('button', { name: / chat, / })
        .map((button) => titles.find((title) => button.textContent?.includes(title)))

    render(<App />)

    await screen.findByRole('button', { name: /^Older Claude chat,/ })
    expect(sidebarOrder()).toEqual(['Newer Claude chat', 'Older Claude chat'])
    expect(localStorage.getItem('harness.sessionOrder')).toBeNull()

    serverProjects[0]!.sessions = [
      { id: 'codex-newest', title: 'Newest Codex chat', provider: 'codex', createdAt: 4 },
      claudeNew,
      { id: 'codex-middle', title: 'Middle Codex chat', provider: 'codex', createdAt: 2 },
      claudeOld,
    ]
    act(() => {
      transport.listeners.get('providerHistory.changed')?.({
        threadIds: ['codex-newest', 'codex-middle'],
      })
    })

    await waitFor(() => expect(sidebarOrder()).toEqual(titles))
  })
})

describe('inbox lifecycle', () => {
  it('batches lifecycle push bursts into one sidebar frame', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'newest', title: 'Newest chat', provider: 'codex', createdAt: 2, running: false },
          { id: 'older', title: 'Older chat', provider: 'codex', createdAt: 1, running: false },
        ],
      },
    ]

    render(<App />)
    fireEvent.pointerEnter(
      (await screen.findByRole('button', { name: /^Newest chat,/ })).closest('li')!,
    )
    await screen.findByRole('button', { name: 'Settle Newest chat' })
    shellRenders.sidebar.mockClear()

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const receiveLifecycle = transport.listeners.get('thread.lifecycle')
    expect(receiveLifecycle).toBeDefined()

    act(() => {
      receiveLifecycle?.({
        threadId: 'newest',
        lifecycle: { state: 'snoozed', snoozedAt: 99, wakeAt: 199 },
      })
      receiveLifecycle?.({
        threadId: 'older',
        lifecycle: { state: 'settled', settledAt: 100, reason: 'inactivity' },
      })
      receiveLifecycle?.({
        threadId: 'newest',
        lifecycle: { state: 'settled', settledAt: 101, reason: 'inactivity' },
      })
    })

    expect(frames).toHaveLength(1)
    expect(shellRenders.sidebar).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Un-settle Newest chat' })).toBeNull()
    act(() => frames[0]?.(0))
    expect(shellRenders.sidebar).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Un-settle Newest chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Un-settle Older chat' })).toBeTruthy()
  })

  it('keeps a newer project snapshot ahead of a queued lifecycle push', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'newest', title: 'Newest chat', provider: 'codex', createdAt: 1, running: false },
        ],
      },
    ]

    render(<App />)
    fireEvent.pointerEnter(
      (await screen.findByRole('button', { name: /^Newest chat,/ })).closest('li')!,
    )
    await screen.findByRole('button', { name: 'Settle Newest chat' })

    const frames: FrameRequestCallback[] = []
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const receiveLifecycle = transport.listeners.get('thread.lifecycle')
    expect(receiveLifecycle).toBeDefined()

    act(() => {
      receiveLifecycle?.({
        threadId: 'newest',
        lifecycle: { state: 'settled', settledAt: 100, reason: 'inactivity' },
      })
      for (const listener of transport.sequenceGapListeners) listener(1, 3)
    })

    await waitFor(() => {
      const projectReads = transport.request.mock.calls.filter(
        ([method]) => method === 'projects.list',
      )
      expect(projectReads.length).toBeGreaterThan(1)
      expect(screen.getByRole('button', { name: 'Settle Newest chat' })).toBeTruthy()
    })
    expect(cancelFrame).toHaveBeenCalledWith(1)
    act(() => frames[0]?.(0))
    expect(screen.getByRole('button', { name: 'Settle Newest chat' })).toBeTruthy()
  })

  it('flushes lifecycle pushes when an animation frame does not run', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'newest', title: 'Newest chat', provider: 'codex', createdAt: 1, running: false },
        ],
      },
    ]

    render(<App />)
    fireEvent.pointerEnter(
      (await screen.findByRole('button', { name: /^Newest chat,/ })).closest('li')!,
    )
    await screen.findByRole('button', { name: 'Settle Newest chat' })

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.useFakeTimers()
    try {
      act(() => {
        transport.listeners.get('thread.lifecycle')?.({
          threadId: 'newest',
          lifecycle: { state: 'settled', settledAt: 100, reason: 'inactivity' },
        })
      })

      act(() => vi.advanceTimersByTime(99))
      expect(screen.queryByRole('button', { name: 'Un-settle Newest chat' })).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('button', { name: 'Un-settle Newest chat' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles the selected chat and advances to the next active chat', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'newest', title: 'Newest chat', provider: 'codex', createdAt: 2, running: false },
          { id: 'older', title: 'Older chat', provider: 'codex', createdAt: 1, running: false },
        ],
      },
    ]

    render(<App />)
    const newest = await screen.findByRole('button', { name: /^Newest chat,/ })
    fireEvent.pointerEnter(newest.closest('li')!)
    fireEvent.click(newest)
    fireEvent.click(screen.getByRole('button', { name: 'Settle Newest chat' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.settle', { threadId: 'newest' })
      expect(
        screen.getByRole('button', { name: /^Older chat,/ }).closest('li')?.classList,
      ).toContain('is-selected')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Un-settle Newest chat' }))
    expect(transport.request).toHaveBeenCalledWith('thread.unsettle', { threadId: 'newest' })
  })

  it('bulk settles selected threads and advances beyond the whole selection', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'newest', title: 'Newest chat', provider: 'codex', createdAt: 3, running: false },
          { id: 'middle', title: 'Middle chat', provider: 'codex', createdAt: 2, running: false },
          { id: 'oldest', title: 'Oldest chat', provider: 'codex', createdAt: 1, running: false },
        ],
      },
    ]

    render(<App />)
    const newest = await screen.findByRole('button', { name: /^Newest chat,/ })
    const middle = screen.getByRole('button', { name: /^Middle chat,/ })
    fireEvent.click(newest)
    fireEvent.click(newest, { metaKey: true })
    fireEvent.click(middle, { metaKey: true })
    fireEvent.contextMenu(middle)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settle 2 threads' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.settle', { threadId: 'newest' })
      expect(transport.request).toHaveBeenCalledWith('thread.settle', { threadId: 'middle' })
      expect(
        screen.getByRole('button', { name: /^Oldest chat,/ }).closest('li')?.classList,
      ).toContain('is-selected')
    })
  })

  it('uses the viewed project as the preferred new-thread destination', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/alpha',
        name: 'Alpha',
        pinned: false,
        createdAt: 0,
        sessions: [],
      },
      {
        path: '/work/beta',
        name: 'Beta',
        pinned: false,
        createdAt: 1,
        sessions: [],
      },
    ]

    render(<App />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Sidebar project filter' }))
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    const picker = await screen.findByRole('dialog', {
      name: 'Choose a project for the new thread',
    })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['New thread in Beta/work/beta', 'New thread in Alpha/work/alpha'])
  })

  it('stops emphasizing completed work after it is opened', async () => {
    serverSidebarSettings.mode = 'inbox'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'ready',
            title: 'Ready chat',
            provider: 'codex',
            createdAt: 1,
            running: false,
            status: 'ready',
            unread: true,
            lifecycle: { state: 'active', keepActive: false, wokeAt: 1 },
          },
        ],
      },
    ]

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ready chat, project, Codex, Done' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Ready chat, project, Codex, Done' })).toBeNull()
      expect(screen.getByRole('button', { name: /^Ready chat, project,/ })).toBeTruthy()
      expect(screen.queryByText('Woke')).toBeNull()
    })
  })
})

describe('global shortcuts', () => {
  it('keeps Debug unlocked across restarts until the shortcut locks it', async () => {
    shortcutPlatform.macOS = true
    localStorage.setItem('harness.onboarding.v1', 'done')
    const debugShortcut = { key: 'Î', code: 'KeyD', metaKey: true, altKey: true, shiftKey: true }
    const openSettings = async () => {
      await screen.findByRole('button', { name: 'Account' })
      fireEvent.keyDown(window, { key: ',', metaKey: true })
      return screen.findByRole('dialog', { name: 'Settings' })
    }

    const first = render(<App />)
    await screen.findByRole('button', { name: 'Account' })
    fireEvent.keyDown(window, debugShortcut)
    expect(localStorage.getItem('harness.debugSettings')).toBe('on')
    first.unmount()

    const second = render(<App />)
    let settings = await openSettings()
    expect(within(settings).getByRole('button', { name: 'Debug' })).toBeTruthy()
    fireEvent.keyDown(window, debugShortcut)
    expect(within(settings).queryByRole('button', { name: 'Debug' })).toBeNull()
    expect(localStorage.getItem('harness.debugSettings')).toBeNull()
    second.unmount()

    render(<App />)
    settings = await openSettings()
    expect(within(settings).queryByRole('button', { name: 'Debug' })).toBeNull()
  })

  it.each([true, false])('forces onboarding from Debug (macOS: %s)', async (macOS) => {
    shortcutPlatform.macOS = macOS
    localStorage.setItem('harness.onboarding.v1', 'done')
    render(<App />)
    await screen.findByRole('button', { name: 'Account' })
    const modifier = macOS ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(window, { key: ',', ...modifier })
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(settings).queryByRole('button', { name: 'Debug' })).toBeNull()
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ...modifier, shiftKey: true })
    expect(within(settings).queryByRole('button', { name: 'Debug' })).toBeNull()
    const debugShortcut = { key: 'Î', code: 'KeyD', ...modifier, altKey: true, shiftKey: true }
    fireEvent.keyDown(window, debugShortcut)
    fireEvent.click(await within(settings).findByRole('button', { name: 'Debug' }))
    expect(screen.getByRole('button', { name: 'Force onboarding' })).toBeTruthy()
    fireEvent.keyDown(window, debugShortcut)
    expect(within(settings).queryByRole('button', { name: 'Debug' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Force onboarding' })).toBeNull()
    fireEvent.keyDown(window, debugShortcut)
    fireEvent.click(await screen.findByRole('button', { name: 'Force onboarding' }))
    await screen.findByRole('heading', { name: 'Welcome to TasteCode' })
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your name' }), {
      target: { value: 'Blue Emi' },
    })
    expect(localStorage.getItem('harness.profile.displayName')).toBe('Blue Emi')
    expect(document.querySelector('.account__name')?.textContent).toBe('Blue Emi')
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }))
    fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }))
    expect(localStorage.getItem('harness.theme')).toBe('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(screen.queryByRole('dialog', { name: 'Choose your look' })).toBeNull()
    expect(localStorage.getItem('harness.onboarding.v1')).toBe('done')
  })

  it.each([true, false])(
    'opens newest sessions with platform shortcuts (macOS: %s)',
    async (macOS) => {
      shortcutPlatform.macOS = macOS
      const modifier = macOS ? { metaKey: true } : { ctrlKey: true }
      serverProjects = [
        {
          path: '/work/other',
          name: 'Other',
          pinned: false,
          createdAt: 0,
          sessions: [{ id: 'other', title: 'Other session', createdAt: 100 }],
        },
        {
          path: '/work/top',
          name: 'Top',
          pinned: true,
          createdAt: 1,
          sessions: Array.from({ length: 9 }, (_, index) => ({
            id: `recent-${index}`,
            title: `Recent ${index}`,
            createdAt: index,
          })),
        },
      ]
      render(<App />)
      await screen.findByRole('button', { name: 'Top' })
      for (const [key, id] of [
        ['1', 'recent-8'],
        ['9', 'recent-0'],
      ]) {
        fireEvent.keyDown(window, { key, ...modifier })
        await waitFor(() =>
          expect(transport.request).toHaveBeenCalledWith(
            'thread.history',
            expect.objectContaining({ threadId: id }),
          ),
        )
      }
      transport.request.mockClear()
      fireEvent.keyDown(window, { key: '2', metaKey: !macOS, ctrlKey: macOS })
      fireEvent.keyDown(window, { key: '2', ...modifier, shiftKey: true })
      expect(transport.request).not.toHaveBeenCalledWith(
        'thread.history',
        expect.objectContaining({ threadId: 'recent-7' }),
      )
      fireEvent.keyDown(window, { key: ',', metaKey: true })
      await screen.findByRole('dialog', { name: 'Settings' })
      fireEvent.keyDown(window, { key: '2', ...modifier })
      expect(transport.request).not.toHaveBeenCalledWith(
        'thread.history',
        expect.objectContaining({ threadId: 'recent-7' }),
      )
    },
  )

  it('runs sidebar and terminal actions from the native menu', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    expect(nativeMenu.syncShortcuts).toHaveBeenCalledWith(
      expect.objectContaining({
        toggleSidebar: { key: 'b', primary: true },
        toggleTerminal: { key: 'j', primary: true },
      }),
    )

    act(() => nativeMenu.listener?.('toggleSidebar'))
    expect(document.querySelector('.shell')?.classList).toContain('is-narrow')

    act(() => nativeMenu.listener?.('toggleTerminal'))
    expect(await screen.findByTestId('terminal-pane')).toBeTruthy()
  })

  it('keeps open Settings from re-rendering when unrelated shell state changes', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    await screen.findByRole('dialog', { name: 'Settings' })
    await act(async () => {
      await Promise.resolve()
    })
    utilityRenders.settings.mockClear()
    appRenders.mockClear()

    act(() => nativeMenu.listener?.('toggleSidebar'))

    expect(document.querySelector('.shell')?.classList).toContain('is-narrow')
    expect(appRenders).toHaveBeenCalled()
    expect(utilityRenders.settings).not.toHaveBeenCalled()
  })
  it('keeps the bottom panel closed when it remounts after the active project is removed', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    serverProjects.push({
      path: '/work/other',
      name: 'Other',
      pinned: false,
      createdAt: 1,
      sessions: [],
    })
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'projects.remove') {
        serverProjects = serverProjects.filter((project) => project.path !== '/work/project')
        return Promise.resolve({})
      }
      return request(method, params)
    })
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    act(() => nativeMenu.listener?.('toggleTerminal'))
    // The first open lazy-loads the panel module.
    await screen.findByTestId('terminal-pane', {}, { timeout: 15_000 })
    act(() => nativeMenu.listener?.('toggleTerminal'))
    act(() => dispatchTransitionEnd(screen.getByTestId('bottom-terminal'), 'transform'))
    await waitFor(() =>
      expect(screen.getByTestId('bottom-terminal').classList.contains('is-parked')).toBe(true),
    )

    act(() => sidebarProps().onRemoveProject('/work/project'))
    await waitFor(() => expect(composerProps().projectPath).toBe('/work/other'))
    const remounted = await screen.findByTestId('bottom-terminal')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(remounted.classList.contains('is-open')).toBe(false)
    expect(screen.queryByTestId('terminal-pane')).toBeNull()
  }, 20_000)

  it('keeps a parked bottom panel parked behind the pull requests view', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    act(() => nativeMenu.listener?.('toggleTerminal'))
    // The first open lazy-loads the panel module.
    await screen.findByTestId('terminal-pane', {}, { timeout: 15_000 })
    act(() => nativeMenu.listener?.('toggleTerminal'))
    act(() => dispatchTransitionEnd(screen.getByTestId('bottom-terminal'), 'transform'))
    await waitFor(() =>
      expect(screen.getByTestId('bottom-terminal').classList.contains('is-parked')).toBe(true),
    )
    const panel = screen.getByTestId('bottom-terminal')
    const opens = terminalOpenRequests()

    // The pull requests view covers the stage; the bottom panel waits behind it.
    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }))
    expect(await screen.findByRole('region', { name: 'Pull requests' })).toBeTruthy()
    expect(panel.isConnected).toBe(true)
    expect(panel.closest('.stage__body')?.hasAttribute('hidden')).toBe(true)

    await act(async () => {
      await sidebarProps().onSelectSession('untouched-thread')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('bottom-terminal')).toBe(panel)
    expect(panel.classList.contains('is-parked')).toBe(true)
    expect(panel.closest('.stage__body')?.hasAttribute('hidden')).toBe(false)
    expect(terminalOpenRequests()).toBe(opens)
  }, 20_000)

  it('keeps an open bottom terminal and its shell across the pull requests view', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    await import('./ui/pull-requests/PullRequestsView.js')
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    act(() => nativeMenu.listener?.('toggleTerminal'))
    const pane = await screen.findByTestId('terminal-pane', {}, { timeout: 15_000 })
    const opens = terminalOpenRequests()

    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }))
    expect(await screen.findByRole('region', { name: 'Pull requests' })).toBeTruthy()
    await act(async () => {
      await sidebarProps().onSelectSession('untouched-thread')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('terminal-pane')).toBe(pane)
    expect(screen.getByTestId('bottom-terminal').classList.contains('is-open')).toBe(true)
    expect(terminalOpenRequests()).toBe(opens)
  }, 20_000)

  it('runs sidebar and terminal actions from the visible top-bar menu', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    fireEvent.click(screen.getByRole('button', { name: 'Options for New chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Toggle sidebar' }))
    expect(document.querySelector('.shell')?.classList).toContain('is-narrow')

    fireEvent.click(screen.getByRole('button', { name: 'Options for New chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Toggle terminal' }))
    expect(await screen.findByTestId('terminal-pane')).toBeTruthy()
  })

  it('opens a searchable palette for actions, projects, and chats', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'TasteCode',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Fix keyboard flow', running: false }],
      },
      {
        path: '/work/another-project',
        name: 'Another Project',
        pinned: false,
        createdAt: 1,
        sessions: [{ id: 'thread-2', title: 'Polish the sidebar', running: false }],
      },
    ]

    render(<App />)
    await screen.findByRole('button', { name: 'Another Project' })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    const search = await screen.findByRole('textbox', { name: 'Search commands' })
    expect(document.activeElement).toBe(search)
    expect(screen.getByRole('option', { name: /Settings/ })).toBeTruthy()
    expect(document.querySelector('.shortcut')).toBeNull()
    expect(
      screen.getByRole('option', { name: /^Another Project \/work\/another-project$/ }),
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: /Polish the sidebar/ })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'polish sidebar' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Polish the sidebar,/ }).classList).toContain(
      'is-active',
    )
  })

  it('opens the editable keybind settings from the command palette', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const search = await screen.findByRole('textbox', { name: 'Search commands' })
    fireEvent.change(search, { target: { value: 'keyboard' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(settings).getByRole('heading', { name: 'Keybinds' })).toBeTruthy()
    expect(within(settings).getByText('Command palette')).toBeTruthy()
    const commandPalette = within(settings).getByRole('button', {
      name: 'Change Command palette keybind',
    })
    expect(commandPalette.querySelector('kbd')?.title).toBe('⌘K')
    expect(commandPalette.querySelector('[data-shortcut-icon="command"]')).toBeTruthy()

    fireEvent.keyDown(settings, { key: 'n', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()

    fireEvent.keyDown(settings, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('persists a custom keybind and updates both behavior and shortcut hints', async () => {
    const view = render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Keybinds' }))
    const recorder = screen.getByRole('button', { name: 'Change New chat keybind' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: 'g', metaKey: true })

    expect(recorder.querySelector('kbd')?.title).toBe('⌘G')
    expect(recorder.querySelector('[data-shortcut-icon="command"]')).toBeTruthy()
    expect(recorder.querySelector('.keybind-shortcut__key')?.textContent).toBe('G')
    expect(localStorage.getItem('harness.keybindings.v1')).toContain('newChat')
    view.unmount()

    transport.request.mockClear()
    render(<App />)
    const newChat = await screen.findByRole('button', { name: 'New chat' })
    expect(newChat.getAttribute('aria-keyshortcuts')).toBe('Meta+G Control+G')

    fireEvent.keyDown(window, { key: 'n', metaKey: true })
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })

    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
    expect(composerProps().newSession).toBe(true)
  })

  it('runs a keybind saved on a number key instead of opening a recent chat', async () => {
    localStorage.setItem(
      'harness.keybindings.v1',
      JSON.stringify({ version: 1, bindings: { newChat: { key: '1', primary: true } } }),
    )
    await openNewSession()
    expect(composerProps().newSession).toBe(false)

    fireEvent.keyDown(window, { key: '1', metaKey: true })
    await waitFor(() => expect(composerProps().newSession).toBe(true))
  })

  it('refuses a number key in the keybind recorder and keeps it opening recent chats', async () => {
    serverProjects[0]!.sessions.push({ id: 'recent-thread', title: 'Recent chat', createdAt: 5 })
    await openNewSession()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Keybinds' }))
    const recorder = screen.getByRole('button', { name: 'Change New chat keybind' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: '1', metaKey: true })

    expect(screen.getByRole('alert').textContent).toBe('Already used by Open recent chat.')
    expect(localStorage.getItem('harness.keybindings.v1')).toBeNull()
    fireEvent.keyDown(recorder, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()

    fireEvent.keyDown(window, { key: '1', metaKey: true })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.history',
        expect.objectContaining({ threadId: 'recent-thread' }),
      ),
    )
    expect(composerProps().newSession).toBe(false)
  })

  it('opens the project switcher directly without rendering a top project control', async () => {
    serverSidebarSettings.mode = 'classic'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'untouched-thread', title: 'New session', running: false }],
      },
      {
        path: '/work/another-project',
        name: 'Another Project',
        pinned: false,
        createdAt: 1,
        sessions: [],
      },
    ]
    render(<App />)

    await screen.findByRole('button', { name: /^New session,/ })
    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    expect(within(actions!).queryByText('⌘N')).toBeNull()
    expect(within(actions!).queryByText('⌘⇧O')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull()

    fireEvent.keyDown(window, { key: 'p', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Switch project' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.queryByRole('option', { name: /New session/ })).toBeNull()
  })

  it.each(
    ['macOS', 'Windows', 'Linux'].flatMap((platform) =>
      ASSIGNED_DEFAULT_SHORTCUTS.map((binding) => ({ ...binding, platform })),
    ),
  )('dispatches $label from the composer on $platform', async ({ shortcut, platform }) => {
    shortcutPlatform.macOS = platform === 'macOS'
    render(<App />)

    await screen.findByRole('button', { name: /^New session,/ })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep this draft intact' } })
    expect(
      fireEvent.keyDown(composer, {
        key: shortcut.key,
        ...(shortcutPlatform.macOS ? { metaKey: shortcut.primary } : { ctrlKey: shortcut.primary }),
        altKey: shortcut.alt,
        shiftKey: shortcut.shift,
      }),
    ).toBe(false)
  })

  it('toggles the terminal from the composer without changing its draft', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByRole('button', { name: 'Show bottom panel' })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep this draft intact' } })

    fireEvent.keyDown(composer, { key: 'j', metaKey: true })
    expect(screen.getByRole('button', { name: 'Hide bottom panel' })).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft intact')

    const terminalInput = document.createElement('textarea')
    const terminalPane = await screen.findByTestId('terminal-pane')
    terminalPane.append(terminalInput)
    fireEvent.keyDown(terminalInput, { key: 'j', metaKey: true })
    expect(screen.getByRole('button', { name: 'Show bottom panel' })).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft intact')
  })

  it('routes the terminal shortcut to the selected right sidebar terminal', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Right' }))
    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('workspace')
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' })

    const bottomTerminal = screen.getByRole('button', { name: 'Show bottom panel' })
    expect(bottomTerminal.getAttribute('aria-keyshortcuts')).toBeNull()
    fireEvent.keyDown(composer, { key: 'j', metaKey: true })

    const sideTerminal = await screen.findByTestId('terminal-pane')
    expect(sideTerminal).toBeTruthy()
    await waitFor(() => {
      const workspaceTerminal = document.querySelector('.workspace-terminal')
      expect(workspaceTerminal?.querySelector('.terminal-pane--workspace')).toBeTruthy()
    })
    expect(document.querySelector('.workspace-panel')?.classList).toContain('is-open')
    expect(screen.getByRole('button', { name: 'Show bottom panel' })).toBe(bottomTerminal)

    fireEvent.keyDown(composer, { key: 'j', metaKey: true })
    await waitFor(() =>
      expect(document.querySelector('.workspace-panel')?.classList).not.toContain('is-open'),
    )
    expect(document.querySelectorAll('.workspace-panel [role="tab"]')).toHaveLength(1)

    fireEvent.keyDown(composer, { key: 'j', metaKey: true })
    await waitFor(() =>
      expect(document.querySelector('.workspace-panel')?.classList).toContain('is-open'),
    )
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1)
  })

  it('opens the bottom terminal before a chat starts', async () => {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, 'bottom')
    render(<App />)

    await screen.findByRole('button', { name: /^New session,/ })
    expect(document.querySelector('.stage__body')?.classList).toContain('is-new-session')
    const composer = screen.getByPlaceholderText('Do anything')
    expect(screen.getByRole('button', { name: 'Show bottom panel' })).toBeTruthy()

    fireEvent.keyDown(composer, { key: 'j', metaKey: true })

    const terminal = await screen.findByTestId('terminal-pane')
    expect(terminal.textContent).toBe('/work/project')
    expect(terminal.closest('.bottom-terminal')).toBeTruthy()
    expect(document.querySelector('.stage__body')?.classList).toContain('has-terminal')
    expect(document.querySelector('.workspace-panel:not(.workspace-panel--bottom)')).toBeNull()
  })

  it('opens global app surfaces from the composer', async () => {
    render(<App />)

    await screen.findByRole('button', { name: /^New session,/ })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep this draft intact' } })

    fireEvent.keyDown(composer, { key: 'k', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Command palette' }), { key: 'Escape' })

    fireEvent.keyDown(composer, { key: ',', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), {
      key: ',',
      metaKey: true,
    })
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft intact')
  })
})

describe('live sessions', () => {
  it('starts each entered session with a fresh thread view', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'First chat', running: false },
          { id: 'thread-2', title: 'Second chat', running: false },
        ],
      },
    ]

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^First chat,/ }))
    const firstView = screen.getByTestId('thread')

    fireEvent.click(screen.getByRole('button', { name: /^Second chat,/ }))

    await waitFor(() => expect(screen.getByTestId('thread')).not.toBe(firstView))
  })

  it('keeps a rename made while a provisional session is starting', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let resolveStart: ((value: { threadId: string }) => void) | undefined
    const start = new Promise<{ threadId: string }>((resolve) => {
      resolveStart = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.start' ? start : request(method, params),
    )

    render(<App />)
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('providers.list', {}))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Initial request' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Initial request' }))
    const input = screen.getByDisplayValue('Initial request')
    fireEvent.change(input, { target: { value: 'My custom title' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(transport.request).not.toHaveBeenCalledWith('thread.rename', {
      threadId: expect.stringMatching(/^pending:/),
      title: 'My custom title',
    })
    await act(async () => resolveStart?.({ threadId: 'thread-1' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.rename', {
        threadId: 'thread-1',
        title: 'My custom title',
      })
    })
  })

  it('says the composer is stopping instead of asking for a project folder', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Old chat', running: false }],
      },
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn' || method === 'thread.interrupt'
        ? new Promise(() => {})
        : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Old chat,/ }))
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'A slow turn' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(composer.getAttribute('placeholder')).toBe('Stopping…')
    expect(screen.queryByPlaceholderText('Add a project folder first')).toBeNull()
  })

  it('keeps an old-chat submission above a colder history response', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Old chat', running: false }],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let resolveHistory!: (value: { events: []; running: false }) => void
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.history'
        ? new Promise((resolve) => (resolveHistory = resolve))
        : method === 'thread.sendTurn'
          ? new Promise(() => {})
          : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Old chat,/ }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Continue immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Continue immediately')
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    const startedAt = screen.getByTestId('thread').getAttribute('data-started-at')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(transport.request).toHaveBeenCalledWith('thread.interrupt', { threadId: 'thread-1' })

    await act(async () => resolveHistory({ events: [], running: false }))
    expect(screen.getByTestId('thread').textContent).toContain('Continue immediately')
    expect(screen.getByTestId('thread').getAttribute('data-started-at')).toBe(startedAt)
  })
  it.each([
    ['turn', 'accepted'],
    ['turn', 'rejected'],
    ['queue', 'accepted'],
    ['queue', 'rejected'],
  ] as const)(
    'settles an indeterminate %s as %s only after reconnect history',
    async (kind, outcome) => {
      serverProjects = [
        {
          path: '/work/project',
          name: 'project',
          pinned: false,
          createdAt: 0,
          sessions: [
            { id: 'thread-1', title: 'Existing work', running: false },
            { id: 'thread-2', title: 'Background', running: false },
          ],
        },
      ]
      const request = transport.request.getMockImplementation()!
      let historyCount = 0
      const resyncs: Array<(value: { events: unknown[]; running: boolean }) => void> = []
      let rejectSend!: (error: Error) => void
      const started = {
        seq: 1,
        event: {
          type: 'turn.started',
          turn: { id: 't', threadId: 'thread-1', status: 'running', createdAt: 1 },
        },
      } as const
      const reconnect = () =>
        act(() => {
          for (const listener of transport.stateListeners) listener('reconnecting')
          for (const listener of transport.stateListeners) listener('open')
        })
      transport.request.mockImplementation((method: string, params: unknown) =>
        method === 'thread.sendTurn'
          ? new Promise((_, reject) => (rejectSend = reject))
          : method === 'thread.history' && historyCount++ > 0
            ? new Promise((resolve) => resyncs.push(resolve))
            : request(method, params),
      )
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
      if (kind === 'queue') emitThreadEvent('thread-1', started.event)
      const composer = screen.getByPlaceholderText('Do anything')
      const draft = () => (composer as HTMLTextAreaElement).value
      if (kind === 'queue') await (reconnect(), waitFor(() => expect(resyncs).toHaveLength(1)))
      dropFile(composer, '/work/retry.png')
      fireEvent.change(composer, { target: { value: 'Submit exactly once' } })
      fireEvent.keyDown(composer, { key: 'Enter' })
      const sendCall = transport.request.mock.calls.find(([method]) => method === 'thread.sendTurn')
      if (!sendCall) throw new Error('missing thread.sendTurn call')
      const submissionId = methods['thread.sendTurn'].params.parse(sendCall[1]).clientSubmissionId!
      const accepted = {
        seq: 2,
        event: {
          type: 'item.completed',
          item: {
            id: submissionId,
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: 'Submit exactly once',
            createdAt: 1,
          },
        },
      } as const
      await act(async () => rejectSend(new IndeterminateRequestError('socket lost')))
      if (kind === 'queue')
        await act(async () => resyncs[0]?.({ events: [started], running: true }))
      else reconnect()
      await waitFor(() => expect(resyncs).toHaveLength(kind === 'queue' ? 2 : 1))
      expect([
        kind === 'queue'
          ? screen.queryByLabelText('Queued prompts')?.textContent
          : screen.getByTestId('thread').textContent,
        draft(),
      ]).toEqual([expect.stringContaining('Submit exactly once'), ''])
      if (kind === 'turn' && outcome === 'accepted') emitThreadEvent('thread-1', started.event)
      await act(async () =>
        resyncs.at(-1)?.({
          events:
            outcome === 'rejected' && kind === 'turn'
              ? [started]
              : outcome === 'accepted' && kind === 'queue'
                ? [accepted]
                : [],
          running: kind === 'queue',
        }),
      )
      if (outcome === 'accepted') {
        emitThreadEvent('thread-1', accepted.event)
        expect([
          draft(),
          within(screen.getByTestId('thread')).getByText('Submit exactly once').dataset.itemId,
        ]).toEqual(['', submissionId])
      } else {
        expect([
          within(screen.getByTestId('thread')).queryByText('Submit exactly once'),
          kind === 'turn' ? screen.queryByText('Working') : null,
          draft(),
        ]).toEqual([null, null, 'Submit exactly once'])
        expect(screen.getByRole('button', { name: 'Remove retry.png' })).toBeTruthy()
      }
      if (kind !== 'queue') return
      finishQueueAnimations()
      expect(screen.queryByLabelText('Queued prompts')).toBeNull()
      if (outcome === 'accepted') return
      fireEvent.change(composer, { target: { value: 'Edited queue' } })
      fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Existing work/ }))
      expect(draft()).toBe('Edited queue')
      fireEvent.change(composer, { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Existing work/ }))
      expect(draft()).toBe('')
    },
  )

  it('restores the draft and removes its optimistic row when the server rejects a turn', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'Old chat', running: false },
          { id: 'thread-2', title: 'Background', running: false },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let rejectSend: ((reason: Error) => void) | undefined
    const pendingSend = new Promise((_, reject) => {
      rejectSend = reject
    })
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn' ? pendingSend : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Old chat,/ }))
    await waitForInitialWorkspace()
    transport.request.mockClear()
    const composer = screen.getByPlaceholderText('Do anything')
    dropFile(composer, '/work/reference.png')
    fireEvent.change(composer, { target: { value: 'Keep this if restore wins' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Keep this if restore wins')
    expect(screen.getByText('Working')).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('')

    await act(async () => {
      rejectSend?.(new Error('cannot start a turn while restoring a checkpoint'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('thread').textContent).not.toContain('Keep this if restore wins')
      expect((composer as HTMLTextAreaElement).value).toBe('Keep this if restore wins')
      expect(screen.getByRole('button', { name: 'Remove reference.png' })).toBeTruthy()
    })
    expect(screen.queryByText('Working')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(
      'cannot start a turn while restoring a checkpoint',
    )
    expect(rpcCount('workspace.info')).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference.png' }))
    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Old chat,/ }))
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this if restore wins')
    expect(screen.queryByRole('button', { name: 'Remove reference.png' })).toBeNull()
  })

  it('queues Enter submissions while the active session is running', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Existing work', running: false }],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let resolveSend: ((result: unknown) => void) | undefined
    const sendResult = new Promise((resolve) => {
      resolveSend = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.sendTurn') {
        return sendResult
      }
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })

    const composer = screen.getByPlaceholderText('Do anything')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    fireEvent.change(composer, { target: { value: 'Queue this next' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByLabelText('Queued prompts').textContent).toContain('Queue this next')
    expect(screen.getByTestId('thread').textContent).not.toContain('Queue this next')

    let submissionId = ''
    await waitFor(() => {
      const call = transport.request.mock.calls.find(([method]) => method === 'thread.sendTurn')
      submissionId = call
        ? methods['thread.sendTurn'].params.parse(call[1]).clientSubmissionId!
        : ''
      expect(submissionId).toMatch(/^local:/)
    })
    await act(async () =>
      resolveSend?.({
        queued: true,
        queuedTurn: {
          id: submissionId,
          text: 'Queue this next',
          attachments: [],
          createdAt: 1,
        },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Queue this next from queue' }))
    expect(transport.request).toHaveBeenCalledWith('thread.deleteQueuedTurn', {
      threadId: 'thread-1',
      queuedTurnId: submissionId,
    })
  })

  it('returns an edited queued prompt to its chat when the user switches chats mid-delete', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'Existing work', running: false },
          { id: 'thread-2', title: 'Other work', running: false },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()!
    let resolveSend: ((result: unknown) => void) | undefined
    const sendResult = new Promise((resolve) => {
      resolveSend = resolve
    })
    let resolveDelete: ((result: unknown) => void) | undefined
    const deleteResult = new Promise((resolve) => {
      resolveDelete = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.sendTurn') return sendResult
      if (method === 'thread.deleteQueuedTurn') return deleteResult
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Queue this next' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    let submissionId = ''
    await waitFor(() => {
      const call = transport.request.mock.calls.find(([method]) => method === 'thread.sendTurn')
      submissionId = call
        ? methods['thread.sendTurn'].params.parse(call[1]).clientSubmissionId!
        : ''
      expect(submissionId).toMatch(/^local:/)
    })
    await act(async () =>
      resolveSend?.({
        queued: true,
        queuedTurn: { id: submissionId, text: 'Queue this next', attachments: [], createdAt: 1 },
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit Queue this next' }))
    await act(async () => {
      await sidebarProps().onSelectSession('thread-2')
    })
    await act(async () => resolveDelete?.({}))
    await act(async () => {
      await sidebarProps().onSelectSession('thread-1')
    })

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
        'Queue this next',
      ),
    )
  })

  it('keeps rapid queued prompts ordered when acknowledgements arrive backwards', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Existing work', running: false }],
      },
    ]
    const request = transport.request.getMockImplementation()!
    const sends: Array<
      (value: {
        queued: true
        queuedTurn: { id: string; text: string; attachments: string[]; createdAt: number }
      }) => void
    > = []
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn'
        ? new Promise((resolve) => sends.push(resolve))
        : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })
    const composer = screen.getByPlaceholderText('Do anything')
    for (const text of ['First queued', 'Second queued']) {
      fireEvent.change(composer, { target: { value: text } })
      fireEvent.keyDown(composer, { key: 'Enter' })
    }
    await waitFor(() => expect(sends).toHaveLength(2))

    await act(async () =>
      sends[1]?.({
        queued: true,
        queuedTurn: { id: 'second', text: 'Second queued', attachments: [], createdAt: 2 },
      }),
    )
    finishQueueAnimations()
    expect(
      Array.from(document.querySelectorAll('.queue-row__text'), (row) => row.textContent),
    ).toEqual(['First queued', 'Second queued'])
    await act(async () =>
      sends[0]?.({
        queued: true,
        queuedTurn: { id: 'first', text: 'First queued', attachments: [], createdAt: 1 },
      }),
    )
    finishQueueAnimations()

    expect(
      Array.from(document.querySelectorAll('.queue-row__text'), (row) => row.textContent),
    ).toEqual(['First queued', 'Second queued'])
  })

  it('returns the active chat to an idle presentation immediately after Stop', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Existing work', running: false }],
      },
    ]

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(transport.request).toHaveBeenCalledWith('thread.interrupt', { threadId: 'thread-1' })

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Working')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull()

    // The turn actually ending is what clears it.
    emitThreadEvent('thread-1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'interrupted',
    })
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('steers the active turn with Ctrl+Enter instead of leaving a queued prompt', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [{ id: 'thread-1', title: 'Existing work', running: false }],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let submissionId = ''
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.history') {
        return Promise.resolve({
          events: [
            {
              seq: 1,
              event: {
                type: 'turn.started',
                turn: {
                  id: 'turn-1',
                  threadId: 'thread-1',
                  status: 'running',
                  createdAt: 0,
                },
              },
            },
          ],
          running: true,
        })
      }
      if (method === 'thread.sendTurn') {
        submissionId = methods[method].params.parse(params).clientSubmissionId!
        return Promise.resolve({
          queued: true,
          queuedTurn: {
            id: submissionId,
            text: 'Use this direction now',
            attachments: [],
            createdAt: 1,
          },
        })
      }
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.queue', { threadId: 'thread-1' }),
    )
    act(() => {
      transport.listeners.get('thread.queue')?.({
        threadId: 'thread-1',
        items: [],
        canSteer: true,
      })
    })
    expect(screen.queryByText('Next message')).toBeNull()

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use this direction now' } })
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })
    expect(screen.queryByLabelText('Queued prompts')).toBeNull()

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use this direction now',
        clientSubmissionId: submissionId,
      }),
    )
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.steerQueuedTurn', {
        threadId: 'thread-1',
        queuedTurnId: submissionId,
      })
    })
    emitThreadEvent('thread-1', {
      type: 'item.completed',
      item: {
        id: submissionId,
        turnId: 'turn-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Use this direction now',
        createdAt: 1,
      },
    })
    expect(screen.getByText('Use this direction now').getAttribute('data-item-id')).toBe(
      submissionId,
    )
    expect(screen.queryByLabelText('Queued prompts')).toBeNull()
  })

  it('shows the most recently active session first', async () => {
    serverSidebarSettings.mode = 'classic'
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-2', title: 'Newer session', running: false },
          { id: 'thread-1', title: 'Older session', running: false },
        ],
      },
    ]

    render(<App />)

    await screen.findByRole('button', { name: /^Newer session,/ })
    expect(sessionTitles()).toEqual(['Newer session', 'Older session'])

    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })

    expect(sessionTitles()).toEqual(['Older session', 'Newer session'])
  })

  it('folds streamed deltas once per animation frame', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')
    emitThreadEvent('untouched-thread', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'untouched-thread', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 0,
      },
    })
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    requestFrame.mockClear()
    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'Hel',
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'lo',
    })

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('thread').textContent).not.toContain('Hello')
    act(() => frames[0]?.(16))
    expect(screen.getByTestId('thread').textContent).toContain('Hello')
  })

  it('keeps cached background deltas off display frames and flushes them on selection', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'foreground', title: 'Foreground', running: false },
          { id: 'background', title: 'Background', running: false },
        ],
      },
    ]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Background,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'background',
        page: NEWEST_PAGE,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Foreground,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'foreground',
        page: NEWEST_PAGE,
      }),
    )

    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    requestFrame.mockClear()
    emitThreadEvent(
      'background',
      {
        type: 'turn.started',
        turn: {
          id: 'background-turn',
          threadId: 'background',
          status: 'running',
          createdAt: 1,
        },
      },
      1,
    )
    emitThreadEvent(
      'background',
      {
        type: 'item.started',
        item: {
          id: 'background-item',
          turnId: 'background-turn',
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: 2,
        },
      },
      2,
    )
    emitThreadEvent(
      'background',
      {
        type: 'item.delta',
        turnId: 'background-turn',
        itemId: 'background-item',
        textDelta: 'Hidden work',
      },
      3,
    )

    expect(requestFrame).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    expect(screen.getByTestId('thread').textContent).toContain('Hidden work')
  })

  it('keeps static shell regions out of streamed-frame renders', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')
    emitThreadEvent('untouched-thread', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'untouched-thread', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 0,
      },
    })

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    shellRenders.sidebar.mockClear()
    shellRenders.stageHeader.mockClear()
    shellRenders.composer.mockClear()
    appRenders.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'Hello',
    })
    act(() => frames[0]?.(16))

    expect(shellRenders.sidebar).not.toHaveBeenCalled()
    expect(shellRenders.stageHeader).not.toHaveBeenCalled()
    expect(shellRenders.composer).not.toHaveBeenCalled()
    expect(appRenders).not.toHaveBeenCalled()
  })

  it('keeps open utility surfaces out of streamed-frame renders', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')
    emitThreadEvent('untouched-thread', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'untouched-thread', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 0,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show bottom panel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }))
    await screen.findByTestId('terminal-pane')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    utilityRenders.commandPalette.mockClear()
    utilityRenders.terminalPane.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'first',
    })
    act(() => frames.shift()?.(16))

    expect(utilityRenders.commandPalette).not.toHaveBeenCalled()
    expect(utilityRenders.terminalPane).not.toHaveBeenCalled()

    fireEvent.keyDown(palette, { key: 'Escape' })
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    await screen.findByRole('dialog', { name: 'Settings' })
    await act(async () => {
      await Promise.resolve()
    })
    utilityRenders.settings.mockClear()
    utilityRenders.terminalPane.mockClear()
    appRenders.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: ' second',
    })
    act(() => frames.shift()?.(32))

    // Settings can finish its own lazy-load effects here. The streamed frame
    // must not render its App owner or the already-mounted terminal.
    expect(appRenders).not.toHaveBeenCalled()
    expect(utilityRenders.terminalPane).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    await screen.findByRole('dialog', { name: 'Search all chats' })
    utilityRenders.sessionSearch.mockClear()
    utilityRenders.terminalPane.mockClear()
    appRenders.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: ' third',
    })
    act(() => frames.shift()?.(48))

    expect(utilityRenders.sessionSearch).not.toHaveBeenCalled()
    expect(utilityRenders.terminalPane).not.toHaveBeenCalled()
    expect(appRenders).not.toHaveBeenCalled()
  })

  it('opens and closes the terminal without snapshot transition flashes', async () => {
    const startViewTransition = vi.fn()
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')

    const terminalToggle = screen.getByRole('button', { name: 'Show bottom panel' })
    expect(screen.queryByTestId('bottom-terminal')).toBeNull()
    fireEvent.click(terminalToggle)
    fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }))
    await screen.findByTestId('terminal-pane')
    const bottomTerminal = screen.getByTestId('bottom-terminal')
    const composer = document.querySelector('.stage__conversation > .composer')
    expect(composer).not.toBeNull()
    expect(
      composer!.compareDocumentPosition(bottomTerminal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Hide bottom panel' }))
    act(() => dispatchTransitionEnd(bottomTerminal, 'transform'))
    await waitFor(() => {
      const terminal = screen.queryByTestId('bottom-terminal')
      expect(terminal?.classList.contains('is-open') ?? false).toBe(false)
    })
    const parkedTerminal = screen.getByTestId('bottom-terminal')
    expect(parkedTerminal.classList.contains('is-parked')).toBe(true)
    expect(parkedTerminal.getAttribute('aria-hidden')).toBe('true')
    expect(parkedTerminal.hasAttribute('inert')).toBe(true)

    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('does not animate the prompt when the bottom terminal opens', async () => {
    const animation = {
      id: '',
      cancel: vi.fn(),
      finished: Promise.resolve(),
    } as unknown as Animation
    const animate = vi.fn(() => animation)
    const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate,
    })

    try {
      render(<App />)
      await screen.findByRole('button', { name: /^New session,/ })

      fireEvent.click(screen.getByRole('button', { name: 'Show bottom panel' }))
      await screen.findByTestId('bottom-terminal')

      expect(
        animate.mock.instances.some(
          (element) => element instanceof Element && element.closest('.composer') !== null,
        ),
      ).toBe(false)
    } finally {
      if (originalAnimate) {
        Object.defineProperty(Element.prototype, 'animate', originalAnimate)
      } else {
        Reflect.deleteProperty(Element.prototype, 'animate')
      }
    }
  })

  it('opens chat search without rerendering the app shell', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /^New session,/ })
    const branchPicker = await screen.findByRole('button', { name: 'Choose branch' })
    await waitFor(() => expect((branchPicker as HTMLButtonElement).disabled).toBe(false))
    appRenders.mockClear()

    const opener = screen.getByRole('button', { name: 'Search chats' })
    opener.focus()
    fireEvent.click(opener)

    const search = await screen.findByRole('combobox', { name: 'Search every chat' })
    expect(appRenders).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus to the keyboard shortcut opener after closing chat search', async () => {
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    composer.focus()

    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    const search = await screen.findByRole('combobox', { name: 'Search every chat' })
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Search all chats' })).toBeNull(),
    )
    expect(document.activeElement).toBe(composer)
  })

  it('runs a search jump once instead of again on every return to the chat', async () => {
    serverProjects = [
      serverProject('/work/project', 'project', [
        { id: 'chat-a', title: 'Chat A' },
        { id: 'chat-b', title: 'Chat B' },
      ]),
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'search.sessions'
        ? Promise.resolve({
            results: [
              {
                projectPath: '/work/project',
                projectName: 'project',
                threadId: 'chat-a',
                threadTitle: 'Chat A',
                turnId: 'turn-old',
                provider: 'codex',
                createdAt: 0,
                snippet: [{ text: 'needle', highlighted: true }],
              },
            ],
            nextCursor: null,
          })
        : request(method, params),
    )
    render(<App />)
    await screen.findByRole('button', { name: /^Chat A,/ })

    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'needle' },
    })
    fireEvent.click(await screen.findByRole('option', { name: /^Chat A, project,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-a'))
    const jump = threadCallbacks.searchJump
    expect(jump).toMatchObject({ turnId: 'turn-old' })
    // The thread lands on the hit and says so.
    act(() => threadCallbacks.searchJumpDone?.(jump!.request))

    fireEvent.click(screen.getByRole('button', { name: /^Chat B,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-b'))
    fireEvent.click(screen.getByRole('button', { name: /^Chat A,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-a'))
    // A fresh entry opens at the end rather than at the old hit.
    expect(threadCallbacks.searchJump).toBeUndefined()

    // Choosing the same hit again is a new jump.
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'needle' },
    })
    fireEvent.click(await screen.findByRole('option', { name: /^Chat A, project,/ }))
    await waitFor(() => expect(threadCallbacks.searchJump).toMatchObject({ turnId: 'turn-old' }))
    expect(threadCallbacks.searchJump!.request).not.toBe(jump!.request)
  })

  it('drops a search jump when the user leaves the chat before it lands', async () => {
    serverProjects = [
      serverProject('/work/project', 'project', [
        { id: 'chat-a', title: 'Chat A' },
        { id: 'chat-b', title: 'Chat B' },
      ]),
    ]
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'search.sessions'
        ? Promise.resolve({
            results: [
              {
                projectPath: '/work/project',
                projectName: 'project',
                threadId: 'chat-a',
                threadTitle: 'Chat A',
                turnId: 'turn-old',
                provider: 'codex',
                createdAt: 0,
                snippet: [{ text: 'needle', highlighted: true }],
              },
            ],
            nextCursor: null,
          })
        : request(method, params),
    )
    render(<App />)
    await screen.findByRole('button', { name: /^Chat A,/ })

    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'needle' },
    })
    fireEvent.click(await screen.findByRole('option', { name: /^Chat A, project,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-a'))
    expect(threadCallbacks.searchJump).toMatchObject({ turnId: 'turn-old' })

    // The thread is still reading older turns when the user moves on.
    fireEvent.click(screen.getByRole('button', { name: /^Chat B,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-b'))
    fireEvent.click(screen.getByRole('button', { name: /^Chat A,/ }))
    await waitFor(() => expect(threadCallbacks.threadId).toBe('chat-a'))

    // Coming back later is a fresh entry, not the abandoned jump.
    expect(threadCallbacks.searchJump).toBeUndefined()
  })

  it('keeps app shortcuts from acting behind chat search', async () => {
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    composer.focus()
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    const search = await screen.findByRole('combobox', { name: 'Search every chat' })
    const stageHeader = () =>
      shellRenders.stageHeader.mock.lastCall![0] as ComponentProps<
        typeof import('./ui/StageHeader.js').StageHeader
      >
    const sessionBefore = stageHeader().sessionId

    fireEvent.keyDown(search, { key: '1', metaKey: true })
    expect(stageHeader().sessionId).toBe(sessionBefore)
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'k', metaKey: true })
    act(() => nativeMenu.listener?.('commandPalette', 'accelerator'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.queryByRole('textbox', { name: 'Search commands' })).toBeNull()
    expect(document.activeElement).toBe(search)
  })

  it('returns focus to inbox search after the command palette opener unmounts', async () => {
    serverSidebarSettings.mode = 'inbox'
    render(<App />)
    const inboxSearch = await screen.findByRole('textbox', { name: 'Search threads' })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const commandSearch = await screen.findByRole('textbox', { name: 'Search commands' })
    fireEvent.change(commandSearch, { target: { value: 'search all chats' } })
    fireEvent.keyDown(commandSearch, { key: 'Enter' })
    const sessionSearch = await screen.findByRole('combobox', { name: 'Search every chat' })

    fireEvent.keyDown(sessionSearch, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Search all chats' })).toBeNull(),
    )
    expect(document.activeElement).toBe(inboxSearch)
  })

  it('flushes pending deltas before a completion event', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')
    emitThreadEvent('untouched-thread', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'untouched-thread', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 0,
      },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'Hello',
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.completed',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        createdAt: 0,
      },
    })

    expect(screen.getByTestId('thread').textContent).toContain('Hello')
  })

  it('does not replay a pending delta twice when history finishes loading', async () => {
    const defaultRequest = transport.request.getMockImplementation()!
    let resolveHistory: ((value: { events: []; running: false }) => void) | undefined
    const history = new Promise<{ events: []; running: false }>((resolve) => {
      resolveHistory = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.history' ? history : defaultRequest(method, params),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await screen.findByTestId('thread')

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    emitThreadEvent('untouched-thread', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'untouched-thread', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 0,
      },
    })
    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'Hello',
    })

    await act(async () => resolveHistory?.({ events: [], running: false }))
    expect(screen.getByTestId('thread').textContent?.match(/Hello/g)).toHaveLength(1)
    act(() => frames[0]?.(16))
    expect(screen.getByTestId('thread').textContent?.match(/Hello/g)).toHaveLength(1)
  })

  it('keeps background session state and distinguishes work from attention', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'First session', running: false },
          { id: 'thread-2', title: 'Second session', running: false },
        ],
      },
    ]

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^First session,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('thread-1', {
      type: 'item.started',
      item: {
        id: 'item-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: 'First result',
        createdAt: 0,
      },
    })

    const working = screen.getByRole('button', { name: 'First session, Codex, working' })
    expect(working.querySelector('.sess__spinner > .tabler-icon-loader-2')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Second session,/ }))
    emitThreadEvent('thread-2', {
      type: 'turn.started',
      turn: { id: 'turn-2', threadId: 'thread-2', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('thread-2', {
      type: 'approval.requested',
      request: {
        id: 'approval-1',
        kind: 'command',
        command: 'pnpm test',
        createdAt: 0,
      },
    })

    const attention = screen.getByRole('button', {
      name: 'Second session, Codex, waiting for approval',
    })
    expect(attention.querySelector('.sess__status-dot.is-attention')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'First session, Codex, working' }))
    await waitFor(() => expect(screen.getByText('First result')).toBeTruthy())

    emitThreadEvent('thread-1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'completed',
    })
    expect(screen.getByRole('button', { name: 'First session, Codex' })).toBeTruthy()
  })

  it('marks a chat whose agent asks the user a question as waiting, open or not', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'First session', running: false },
          { id: 'thread-2', title: 'Second session', running: false },
        ],
      },
    ]

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^First session,/ }))
    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })
    emitThreadEvent('thread-1', {
      type: 'user_input.requested',
      request: {
        id: 'question-1',
        turnId: 'turn-1',
        createdAt: 0,
        autoResolutionMs: null,
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Which option?',
            allowOther: true,
            secret: false,
            options: null,
          },
        ],
      },
    })

    const waiting = screen.getByRole('button', { name: 'First session, Codex, needs attention' })
    expect(waiting.querySelector('.sess__status-dot.is-attention')).not.toBeNull()
    expect(waiting.querySelector('.sess__spinner')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Second session,/ }))
    const background = screen.getByRole('button', {
      name: 'First session, Codex, needs attention',
    })
    expect(background.querySelector('.sess__status-dot.is-attention')).not.toBeNull()

    emitThreadEvent('thread-1', { type: 'user_input.resolved', id: 'question-1' })
    const answered = screen.getByRole('button', { name: 'First session, Codex, working' })
    expect(answered.querySelector('.sess__spinner')).not.toBeNull()
  })

  it('keeps running chats above newly unread completed chats', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'idle-thread', title: 'Idle chat', running: false },
          { id: 'background-thread', title: 'Background chat', running: false },
          { id: 'running-thread', title: 'Running chat', running: true },
        ],
      },
    ]

    render(<App />)
    await screen.findByRole('button', { name: 'Running chat, Codex, working' })
    expect(sessionTitles()).toEqual(['Running chat', 'Idle chat', 'Background chat'])

    emitThreadEvent('background-thread', {
      type: 'turn.started',
      turn: {
        id: 'background-turn',
        threadId: 'background-thread',
        status: 'running',
        createdAt: 0,
      },
    })
    expect(sessionTitles()).toEqual(['Background chat', 'Running chat', 'Idle chat'])

    emitThreadEvent('background-thread', {
      type: 'turn.completed',
      turnId: 'background-turn',
      status: 'completed',
    })
    expect(sessionTitles()).toEqual(['Running chat', 'Background chat', 'Idle chat'])
    expect(
      screen
        .getByRole('button', { name: 'Background chat, Codex, ready, unread' })
        .querySelector('.sess__status-dot.is-success'),
    ).not.toBeNull()
  })
})

function dropFile(composer: HTMLElement, path: string) {
  const file = new File(['test'], path.split('/').at(-1) ?? 'attachment')
  const descriptor = Object.getOwnPropertyDescriptor(window, 'harness')
  Object.defineProperty(window, 'harness', {
    configurable: true,
    value: {
      ...window.harness,
      droppedFilePath: (candidate: File) => (candidate === file ? path : undefined),
    },
  })
  try {
    fireEvent.drop(composer.closest('.composer__box')!, {
      dataTransfer: { files: [file], types: ['Files'] },
    })
  } finally {
    if (descriptor) Object.defineProperty(window, 'harness', descriptor)
    else Reflect.deleteProperty(window, 'harness')
  }
}

function finishQueueAnimations() {
  for (const row of document.querySelectorAll<HTMLElement>(
    '.queue-row:not([data-queue-phase="present"])',
  )) {
    fireEvent.animationEnd(row)
  }
}

function emitThreadEvent(threadId: string, event: DomainEvent, seq?: number) {
  act(() => {
    transport.listeners.get('thread.event')?.({ threadId, event, seq })
  })
}

function completedHistoryEvent(seq: number, id: string, text: string) {
  return {
    seq,
    event: {
      type: 'item.completed' as const,
      item: {
        id,
        turnId: 'turn-1',
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'completed' as const,
        text,
        createdAt: seq,
      },
    },
  }
}

function emitQueue(
  threadId: string,
  items: Array<{ id: string; text: string; attachments: string[]; createdAt: number }>,
) {
  act(() => {
    transport.listeners.get('thread.queue')?.({ threadId, items, canSteer: true })
  })
}

function sessionTitles(): string[] {
  return Array.from(document.querySelectorAll('.sess__title'), (node) => node.textContent ?? '')
}

function dropChatRow(sourceTitle: string, targetTitle: string, position: 'before' | 'after') {
  const row = (title: string) =>
    screen.getByRole('button', { name: new RegExp(`^${title},`) }).closest('li')!
  const source = row(sourceTitle)
  const target = row(targetTitle)
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 200, 28))
  const dataTransfer = { dropEffect: 'none', effectAllowed: 'none', setData: vi.fn() }
  const clientY = position === 'before' ? 65 : 85

  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { clientY, dataTransfer })
  fireEvent.drop(target, { clientY, dataTransfer })
}

describe('reopening a session', () => {
  it('retries deferred provider history when a queued turn ends before its first replay returns', async () => {
    const request = transport.request.getMockImplementation()!
    let reads = 0
    let release!: () => void
    transport.request.mockImplementation((method, params) => {
      if (method !== 'thread.history') return request(method, params)
      reads += 1
      const response = {
        events: [
          completedHistoryEvent(1, 'base', 'Existing message'),
          ...(reads >= 3 ? [completedHistoryEvent(2, 'outside', 'Outside provider reply')] : []),
        ],
        running: reads === 2,
        approval: 'ask',
      }
      if (reads === 2)
        return new Promise((resolve) => {
          release = () => resolve(response)
        })
      return Promise.resolve(response)
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    expect(await screen.findByText('Existing message')).toBeTruthy()
    startTurn('untouched-thread', 'local-turn')
    act(() => {
      transport.listeners.get('providerHistory.changed')?.({ threadIds: ['untouched-thread'] })
    })
    completeTurn('untouched-thread', 'local-turn')
    startTurn('untouched-thread', 'queued-turn')
    completeTurn('untouched-thread', 'queued-turn')
    expect(reads).toBe(2)
    await act(async () => release())
    expect(await screen.findByText('Outside provider reply')).toBeTruthy()
    expect(reads).toBe(3)
  })

  it('keeps deferred provider history when a queued turn starts during its replay', async () => {
    const request = transport.request.getMockImplementation()!
    let reads = 0
    transport.request.mockImplementation((method, params) => {
      if (method !== 'thread.history') return request(method, params)
      reads += 1
      return Promise.resolve({
        events: [
          completedHistoryEvent(1, 'base', 'Existing message'),
          ...(reads >= 3 ? [completedHistoryEvent(2, 'outside', 'Outside provider reply')] : []),
        ],
        running: reads === 2,
        approval: 'ask',
      })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    expect(await screen.findByText('Existing message')).toBeTruthy()
    startTurn('untouched-thread', 'local-turn')
    act(() => {
      transport.listeners.get('providerHistory.changed')?.({ threadIds: ['untouched-thread'] })
    })
    completeTurn('untouched-thread', 'local-turn')
    startTurn('untouched-thread', 'queued-turn')
    await waitFor(() => expect(reads).toBe(2))
    expect(screen.queryByText('Outside provider reply')).toBeNull()
    completeTurn('untouched-thread', 'queued-turn')
    expect(await screen.findByText('Outside provider reply')).toBeTruthy()
    expect(reads).toBe(3)
  })

  it.each(['turn.completed', 'thread.error'] as const)(
    'replays deferred provider history after %s',
    async (completion) => {
      const request = transport.request.getMockImplementation()!
      let changed = false
      transport.request.mockImplementation((method, params) => {
        if (method !== 'thread.history') return request(method, params)
        return Promise.resolve({
          events: [
            completedHistoryEvent(1, 'base', 'Existing message'),
            ...(changed ? [completedHistoryEvent(2, 'outside', 'Outside provider reply')] : []),
          ],
          running: false,
          approval: 'ask',
        })
      })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
      expect(await screen.findByText('Existing message')).toBeTruthy()
      startTurn('untouched-thread', 'local-turn')
      await screen.findByText('Working')
      transport.request.mockClear()
      changed = true
      act(() => {
        transport.listeners.get('providerHistory.changed')?.({ threadIds: ['untouched-thread'] })
        transport.listeners.get('providerHistory.changed')?.({ threadIds: ['untouched-thread'] })
      })
      expect(rpcCount('thread.history')).toBe(0)
      if (completion === 'turn.completed') completeTurn('untouched-thread', 'local-turn')
      else
        emitThreadEvent('untouched-thread', {
          type: 'thread.error',
          threadId: 'untouched-thread',
          message: 'Stopped',
        })
      expect(await screen.findByText('Outside provider reply')).toBeTruthy()
      expect(screen.getAllByText('Existing message')).toHaveLength(1)
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'thread.history'),
      ).toEqual([['thread.history', { threadId: 'untouched-thread', page: NEWEST_PAGE }]])
    },
  )

  /**
   * Asserting on the request rather than on rendered rows: happy-dom gives
   * every element zero size and has no ResizeObserver, so the virtualiser
   * measures nothing and renders nothing. That replaying these events rebuilds
   * the conversation is covered in thread-store.test.ts, where it is the actual
   * logic rather than a rendering side effect.
   */
  it('asks the server what already happened rather than showing an empty pane', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))

    // The conversation used to exist only in the events this client had
    // personally seen, so switching or reloading showed nothing.
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      })
    })
    expect(screen.queryByRole('dialog', { name: 'Account and plan limits' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    const account = await screen.findByRole('dialog', { name: 'Account and plan limits' })
    expect(await within(account).findByText('75% left')).toBeTruthy()
  })

  it('uses a visible same-source model when the remembered one is hidden', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'gpt-6.1-sol',
              displayName: 'GPT-5.6 Sol',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              serviceTiers: [],
            },
            {
              id: 'gpt-5.6-mini',
              displayName: 'GPT-5.6 Mini',
              isDefault: false,
              reasoningEfforts: ['low', 'high'],
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.provider', 'claude-code')
    localStorage.setItem('harness.model', 'custom:claude-code:opus')
    localStorage.setItem(
      'harness.customModels.v1',
      JSON.stringify([{ provider: 'claude-code', modelId: 'opus', displayName: 'Opus 5' }]),
    )
    localStorage.setItem(
      'harness.modelVisibility.v2',
      JSON.stringify({
        overrides: { 'codex:gpt-5.6-mini': { visible: false, at: 1 } },
        firstSeen: {},
      }),
    )
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({ codex: { modelKey: 'codex:gpt-5.6-mini' } }),
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        'Opus 5',
      )
    })
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        '5.6 Sol',
      )
    })

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep this model' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'untouched-thread',
        text: 'Keep this model',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-6.1-sol',
        effort: 'low',
      })
    })
  })

  it('keeps a server-bound API session active while provider discovery is pending', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          {
            id: 'api-thread',
            title: 'API thread',
            provider: 'api',
            createdAt: 0,
            running: false,
          },
        ],
      },
    ]
    let releaseModels!: () => void
    const modelsGate = new Promise<void>((resolve) => {
      releaseModels = resolve
    })
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list') {
        return modelsGate.then(() => ({ providers: serverProviders }))
      }
      return request(method, params)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'API thread, API connection' }))
    await waitFor(() => {
      expect(localStorage.getItem('harness.provider')).toBe('api')
      expect(screen.queryByRole('button', { name: 'Model and reasoning' })).toBeNull()
    })

    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Use the session provider' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      const optimistic = screen.getByText('Use the session provider').getAttribute('data-item-id')
      expect(optimistic).toMatch(/^local:/)
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'api-thread',
        text: 'Use the session provider',
        clientSubmissionId: optimistic,
      })
    })
    await act(async () => {
      releaseModels()
      await modelsGate
    })
  })

  it('restores the exact ACP model and effort for its session and new chats', async () => {
    serverProviders = [
      ...serverProviders,
      { ...serverProviders[0]!, id: 'acp', displayName: 'ACP agent' },
    ]
    serverProjects = [
      {
        ...serverProjects[0]!,
        sessions: [
          {
            id: 'acp-thread',
            title: 'ACP thread',
            provider: 'acp',
            agent: 'kimi',
            createdAt: 0,
            running: false,
          },
        ],
      },
    ]
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({ 'acp:kimi': { modelKey: 'acp:kimi:model-x', effort: 'high' } }),
    )
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) => {
      if (method === 'acp.agents')
        return Promise.resolve({
          agents: [{ id: 'kimi', name: 'Kimi CLI', installed: true, verified: true }],
        })
      if (method === 'models.list' && methods['models.list'].params.parse(params).agent === 'kimi')
        return Promise.resolve({
          models: [
            {
              id: 'model-x',
              displayName: 'Model X',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              serviceTiers: [],
            },
          ],
        })
      return request(method, params)
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'ACP thread, Kimi CLI' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain(
        'Model X',
      ),
    )
    expect(JSON.parse(localStorage.getItem('harness.modelBySource') ?? '{}')).toMatchObject({
      'acp:kimi': { modelKey: 'acp:kimi:model-x', effort: 'high' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Start with Kimi' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({
          provider: 'acp',
          agent: 'kimi',
          model: 'model-x',
          effort: 'high',
        }),
      ),
    )
  })

  it('does not display a fallback from another provider after hiding the session source', async () => {
    serverProviders = [
      ...serverProviders,
      {
        ...serverProviders[0]!,
        id: 'claude-code',
        displayName: 'Claude Code',
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const claude = methods['models.list'].params.parse(params).provider === 'claude-code'
        return Promise.resolve({
          models: [
            {
              id: claude ? 'opus' : 'gpt-6.1-sol',
              displayName: claude ? 'Opus 5' : 'GPT-5.6 Sol',
              isDefault: true,
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'low',
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })
    localStorage.setItem('harness.model', 'codex:gpt-6.1-sol')

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6 Sol in model picker' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Model and reasoning' })).toBeNull()
      expect(localStorage.getItem('harness.provider')).toBe('codex')
    })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Stay with the session provider' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'untouched-thread',
        text: 'Stay with the session provider',
        clientSubmissionId: expect.stringMatching(/^local:/),
      })
    })
  })

  it('catches up only the missing durable suffix when the transport detects a push gap', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let historyRead = 0
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.history') {
        historyRead += 1
        return Promise.resolve(
          historyRead === 1
            ? { events: [completedHistoryEvent(7, 'base', 'Durable base')], running: false }
            : {
                events: [completedHistoryEvent(9, 'suffix', 'Missing suffix')],
                running: false,
              },
        )
      }
      return request(method, params)
    })

    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      })
    })
    expect(await screen.findByText('Durable base')).toBeTruthy()
    emitThreadEvent(
      'untouched-thread',
      {
        type: 'item.completed',
        item: {
          id: 'live',
          turnId: 'turn-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: 'Durable live event',
          createdAt: 8,
        },
      },
      8,
    )
    transport.request.mockClear()

    act(() => {
      for (const listener of transport.sequenceGapListeners) listener(4, 6)
    })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        afterSeq: 8,
      })
      expect(transport.request).toHaveBeenCalledWith('thread.queue', {
        threadId: 'untouched-thread',
      })
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      })
      expect(transport.request).toHaveBeenCalledWith('projects.list', {})
      expect(transport.request).toHaveBeenCalledWith('sidebar.settings', {})
    })
    const text = screen.getByTestId('thread').textContent
    expect(text).toContain('Durable base')
    expect(text).toContain('Durable live event')
    expect(text).toContain('Missing suffix')
  })

  it('reloads an evicted history after visiting more sessions than the inactive cache retains', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: Array.from({ length: 5 }, (_, index) => ({
          id: `thread-${index + 1}`,
          title: `Thread ${index + 1}`,
          running: false,
        })),
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      const { threadId } = methods['thread.history'].params.parse(params)
      const index = Number(threadId.slice('thread-'.length))
      return Promise.resolve({
        events: [completedHistoryEvent(index, `${threadId}-item`, `History ${index}`)],
        running: false,
      })
    })

    render(<App />)
    for (let index = 1; index <= 5; index += 1) {
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Thread ${index},`) }))
      expect(await screen.findByText(`History ${index}`)).toBeTruthy()
    }

    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /^Thread 1,/ }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'thread-1',
        page: NEWEST_PAGE,
      })
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      'thread.history',
      expect.objectContaining({ threadId: 'thread-1', afterSeq: expect.any(Number) }),
    )
  })

  it('reloads an oversized background reply from durable history before completion', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'foreground', title: 'Foreground', running: false },
          { id: 'background', title: 'Background', running: false },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      const { threadId } = methods['thread.history'].params.parse(params)
      return Promise.resolve({
        events: [completedHistoryEvent(1, `${threadId}-base`, `${threadId} base`)],
        running: false,
      })
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Background,/ }))
    expect(await screen.findByText('background base')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Foreground,/ }))
    expect(await screen.findByText('foreground base')).toBeTruthy()

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    emitThreadEvent(
      'background',
      {
        type: 'turn.started',
        turn: {
          id: 'background-turn',
          threadId: 'background',
          status: 'running',
          createdAt: 2,
        },
      },
      2,
    )
    emitThreadEvent(
      'background',
      {
        type: 'item.started',
        item: {
          id: 'background-stream',
          turnId: 'background-turn',
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: 3,
        },
      },
      3,
    )
    emitThreadEvent(
      'background',
      {
        type: 'item.delta',
        turnId: 'background-turn',
        itemId: 'background-stream',
        textDelta: 'x'.repeat(300 * 1024),
      },
      4,
    )
    act(() => frames.shift()?.(performance.now()))

    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'background',
        page: NEWEST_PAGE,
      })
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      'thread.history',
      expect.objectContaining({ threadId: 'background', afterSeq: expect.any(Number) }),
    )
  })

  it('applies a cached background session suffix when it is reopened', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'project',
        pinned: false,
        createdAt: 0,
        sessions: [
          { id: 'thread-1', title: 'Foreground', running: false },
          { id: 'thread-2', title: 'Background', running: false },
        ],
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let foregroundReads = 0
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      const { threadId } = methods['thread.history'].params.parse(params)
      if (threadId !== 'thread-1') return Promise.resolve({ events: [], running: false })
      foregroundReads += 1
      return Promise.resolve({
        events: [
          foregroundReads === 1
            ? completedHistoryEvent(4, 'base', 'Cached base')
            : completedHistoryEvent(5, 'suffix', 'Background suffix'),
        ],
        running: false,
      })
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Foreground,/ }))
    expect(await screen.findByText('Cached base')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
    await waitFor(() =>
      expect(screen.getByTestId('thread').textContent).not.toContain('Cached base'),
    )
    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /^Foreground,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'thread-1',
        afterSeq: 4,
      }),
    )
    const text = screen.getByTestId('thread').textContent
    expect(text).toContain('Cached base')
    expect(text).toContain('Background suffix')
  })

  it('does not advance past a deferred delta and ignores duplicate durable pushes', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    let historyRead = 0
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'thread.history') return request(method, params)
      historyRead += 1
      return Promise.resolve(
        historyRead === 1
          ? {
              events: [
                {
                  seq: 1,
                  event: {
                    type: 'turn.started' as const,
                    turn: {
                      id: 'turn-1',
                      threadId: 'untouched-thread',
                      status: 'running' as const,
                      createdAt: 1,
                    },
                  },
                },
                {
                  seq: 2,
                  event: {
                    type: 'item.started' as const,
                    item: {
                      id: 'streaming',
                      turnId: 'turn-1',
                      type: 'message' as const,
                      role: 'assistant' as const,
                      status: 'started' as const,
                      text: '',
                      createdAt: 2,
                    },
                  },
                },
              ],
              running: true,
            }
          : {
              events: [
                {
                  seq: 3,
                  event: {
                    type: 'item.delta' as const,
                    turnId: 'turn-1',
                    itemId: 'streaming',
                    textDelta: 'Once',
                  },
                },
              ],
              running: true,
            },
      )
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      }),
    )
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    transport.request.mockClear()

    const delta = {
      type: 'item.delta' as const,
      turnId: 'turn-1',
      itemId: 'streaming',
      textDelta: 'Once',
    }
    emitThreadEvent('untouched-thread', delta, 3)
    emitThreadEvent('untouched-thread', delta, 3)
    emitThreadEvent('untouched-thread', { ...delta, textDelta: ' stale' }, 2)
    act(() => {
      for (const listener of transport.sequenceGapListeners) listener(4, 6)
    })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        afterSeq: 2,
      }),
    )
    expect(screen.getByText('Once').textContent).toBe('Once')
    act(() => frames.shift()?.(performance.now()))
    expect(screen.getByText('Once').textContent).toBe('Once')
    expect(screen.queryByText(/stale/)).toBeNull()
  })

  it('resyncs active server-owned state after reconnecting mid-stream', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        page: NEWEST_PAGE,
      })
    })
    transport.request.mockClear()

    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
        afterSeq: 0,
      })
      expect(transport.request).toHaveBeenCalledWith('thread.queue', {
        threadId: 'untouched-thread',
      })
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        provider: 'codex',
        intent: 'background',
      })
      expect(transport.request).toHaveBeenCalledWith('projects.list', {})
      expect(transport.request).toHaveBeenCalledWith('sidebar.settings', {})
    })
  })

  it('keeps newer durable and live events when an older history load resolves last', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    const historyResolvers: Array<
      (value: { events: Array<{ seq: number; event: DomainEvent }>; running: boolean }) => void
    > = []
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.history') {
        return new Promise((resolve) => historyResolvers.push(resolve))
      }
      return request(method, params)
    })

    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /^New session,/ }))
    await waitFor(() => expect(historyResolvers).toHaveLength(1))
    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })
    await waitFor(() => expect(historyResolvers).toHaveLength(2))

    emitThreadEvent('untouched-thread', {
      type: 'item.completed',
      item: {
        id: 'live-item',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Live during reconnect',
        createdAt: 3,
      },
    })
    emitThreadEvent('untouched-thread', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'completed',
    })

    interface HistoryEnvelope {
      seq: number
      event: DomainEvent
    }
    const historyEvent = (id: string, text: string): HistoryEnvelope => ({
      seq: 1,
      event: {
        type: 'item.completed',
        item: {
          id,
          turnId: 'turn-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text,
          createdAt: 1,
        },
      },
    })
    await act(async () =>
      historyResolvers[1]?.({ events: [historyEvent('newer', 'Newer history')], running: true }),
    )
    await act(async () =>
      historyResolvers[0]?.({ events: [historyEvent('older', 'Older history')], running: false }),
    )

    const text = screen.getByTestId('thread').textContent
    expect(text).toContain('Newer history')
    expect(text).toContain('Live during reconnect')
    expect(text).not.toContain('Older history')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})

describe('connection recovery regressions', () => {
  it.each(['push gap', 'reconnect'] as const)(
    'recovers an idle cached background chat after %s',
    async (reason) => {
      serverProjects[0]!.sessions = [
        { id: 'a', title: 'Foreground', running: false },
        { id: 'b', title: 'Background', running: false },
      ]
      const request = transport.request.getMockImplementation()!
      let lost = false
      transport.request.mockImplementation((method, params) => {
        if (method !== 'thread.history') return request(method, params)
        const { threadId, afterSeq } = methods['thread.history'].params.parse(params)
        const events =
          threadId === 'a'
            ? [completedHistoryEvent(1, 'a-base', 'Foreground base')]
            : [
                completedHistoryEvent(1, 'b-base', 'Background base'),
                ...(lost
                  ? [
                      completedHistoryEvent(2, 'missing', 'Recovered background message'),
                      completedHistoryEvent(3, 'live', 'Background live message'),
                    ]
                  : []),
              ]
        return Promise.resolve({
          events: events.filter(({ seq }) => seq > (afterSeq ?? 0)),
          running: false,
        })
      })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Background,/ }))
      await screen.findByText('Background base')
      fireEvent.click(screen.getByRole('button', { name: /^Foreground,/ }))
      await screen.findByText('Foreground base')
      transport.request.mockClear()
      lost = true
      act(() => {
        if (reason === 'push gap') {
          for (const listener of transport.sequenceGapListeners) listener(2, 3)
        } else {
          setConnectionState('reconnecting')
          setConnectionState('open')
        }
      })
      emitThreadEvent('b', completedHistoryEvent(3, 'live', 'Background live message').event, 3)
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('thread.history', {
          threadId: 'b',
          afterSeq: 1,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: /^Background,/ }))
      expect(await screen.findByText('Recovered background message')).toBeTruthy()
      expect(screen.getAllByText('Background live message')).toHaveLength(1)
    },
  )

  it('retries a failed account check on reconnect and allows a new chat', async () => {
    serverProviders = [{ ...serverProviders[0]!, auth: 'unknown' }]
    const request = transport.request.getMockImplementation()!
    let online = false
    transport.request.mockImplementation((method, params) => {
      if (method === 'auth.status')
        return online
          ? Promise.resolve({ signedIn: true })
          : Promise.reject(new Error('Connection lost'))
      return request(method, params)
    })
    render(<App />)
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Send after reconnect' } })
    await screen.findByText(
      'Could not confirm this account, but you can still send. Connection lost',
    )
    // An account that could not be confirmed does not lock the composer.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    online = true
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Could not confirm this account, but you can still send. Connection lost',
        ),
      ).toBeNull(),
    )
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ text: 'Send after reconnect' }),
      ),
    )
  })

  it('asks again from the account notice without opening Settings or locking Send', async () => {
    serverProviders = [{ ...serverProviders[0]!, auth: 'unknown' }]
    const request = transport.request.getMockImplementation()!
    let reads = 0
    let answerRetry!: (account: { signedIn: boolean }) => void
    transport.request.mockImplementation((method, params) => {
      if (method === 'auth.status') {
        reads += 1
        return reads === 1
          ? Promise.reject(new Error('CLI did not respond within the time limit'))
          : new Promise((resolve) => {
              answerRetry = resolve
            })
      }
      return request(method, params)
    })
    render(<App />)
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Send while unconfirmed' },
    })
    const notice =
      'Could not confirm this account, but you can still send. CLI did not respond within the time limit'
    await screen.findByText(notice)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(reads).toBe(2))
    // The retry is still reading; Send stays available meanwhile.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('dialog', { name: /settings/i })).toBeNull()
    await act(async () => answerRetry({ signedIn: true }))
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull())
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('opens Send while a slow account check is still reading, and the answer still decides', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      serverProviders = [{ ...serverProviders[0]!, auth: 'unknown' }]
      const request = transport.request.getMockImplementation()!
      let answer: ((account: { signedIn: boolean }) => void) | undefined
      transport.request.mockImplementation((method, params) =>
        method === 'auth.status'
          ? new Promise((resolve) => {
              answer = resolve
            })
          : request(method, params),
      )
      render(<App />)
      fireEvent.change(screen.getByPlaceholderText('Do anything'), {
        target: { value: 'Send while reading' },
      })
      const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
      await waitFor(() => expect(answer).toBeTypeOf('function'))
      expect(send().disabled).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(ACCOUNT_CHECK_SEND_GRACE_MS)
      })
      expect(send().disabled).toBe(false)
      expect(screen.queryByText(/Could not confirm this account/)).toBeNull()

      // A signed-out answer that arrives later still asks for setup.
      await act(async () => answer!({ signedIn: false }))
      await waitFor(() => expect(send().disabled).toBe(true))
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an old failed account reply after the reconnect check succeeds', async () => {
    serverProviders = [{ ...serverProviders[0]!, auth: 'unknown' }]
    const request = transport.request.getMockImplementation()!
    let rejectOld!: (error: Error) => void
    let reads = 0
    transport.request.mockImplementation((method, params) => {
      if (method === 'auth.status')
        return ++reads === 1
          ? new Promise((_, reject) => {
              rejectOld = reject
            })
          : Promise.resolve({ signedIn: true })
      return request(method, params)
    })
    render(<App />)
    fireEvent.change(screen.getByPlaceholderText('Do anything'), {
      target: { value: 'Keep ready' },
    })
    await waitFor(() => expect(reads).toBe(1))
    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect(reads).toBe(2)
    await act(async () => rejectOld(new Error('Old connection failed')))
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/Old connection failed/)).toBeNull()
  })

  it('shows a notice when an approval reply cannot be sent', async () => {
    const request = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method, params) =>
      method === 'thread.respondToApproval'
        ? Promise.reject(new Error('Connection lost'))
        : request(method, params),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    await waitFor(() => expect(threadCallbacks.decideApproval).toBeTypeOf('function'))
    act(() => threadCallbacks.decideApproval!('approval-1', 'approve'))
    expect(await screen.findByText('Could not send the approval. Connection lost')).toBeTruthy()
    expect(transport.request).toHaveBeenCalledWith('thread.respondToApproval', {
      threadId: 'untouched-thread',
      approvalId: 'approval-1',
      decision: 'approve',
    })
  })
})

describe('send availability for a connection-backed model', () => {
  // An API connection has no vendor CLI, so no provider status describes it.
  // Each state the user can fix in Settings must say setup-required rather than
  // unavailable, whose only action cannot change the outcome.
  const resolve = (connections: ModelConnection[]) =>
    resolveSendAvailability({
      catalog: 'ready',
      serverBoundSession: false,
      selectedChoice: connectionChoice('nan-1'),
      connections,
      providerStatuses: [],
      accountCheck: { provider: 'codex', state: 'ready' },
    })

  it('is ready when its connection is enabled and has a credential', () => {
    expect(resolve([modelConnection()])).toBe('ready')
  })

  it('does not bypass a disabled known connection for an existing session', () => {
    expect(
      resolveSendAvailability({
        catalog: 'ready',
        serverBoundSession: true,
        selectedChoice: connectionChoice('nan-1'),
        connections: [modelConnection({ enabled: false })],
        providerStatuses: [],
        accountCheck: { provider: 'api', state: 'ready' },
      }),
    ).toBe('setup-required')
  })

  it('needs setup when its connection is disabled', () => {
    expect(resolve([modelConnection({ enabled: false })])).toBe('setup-required')
  })

  it('needs setup when its connection has no credential', () => {
    expect(resolve([modelConnection({ credentialConfigured: false })])).toBe('setup-required')
  })

  it('needs setup when its connection is no longer listed', () => {
    expect(resolve([modelConnection({ id: 'other-1' })])).toBe('setup-required')
  })
})

// Last in this file: it resets the module registry so App starts with the
// workspace panel unloaded, the way a fresh window opens it on first use.
describe('workspace panel loading', () => {
  it('keeps a Temporary chat across the first update after a cold /side', async () => {
    vi.resetModules()
    const { App: ColdApp } = await import('./App.js')
    // Spies from earlier tests can leave frames that never run, and Temporary
    // chat starts and sends on the next frame.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    )
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame))
    localStorage.setItem('harness.models.cache', serializeModelCatalogCache([cachedCodexChoice()]))
    const fallback = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (
        method === 'thread.history' &&
        methods['thread.history'].params.parse(params).threadId === 'untouched-thread'
      ) {
        return Promise.resolve({
          events: [
            {
              seq: 1,
              event: {
                type: 'item.completed',
                item: {
                  id: 'main-user',
                  turnId: 'main-turn',
                  type: 'message',
                  role: 'user',
                  status: 'completed',
                  text: 'Fix the build',
                  createdAt: 1,
                },
              },
            },
          ],
          running: false,
        })
      }
      if (method === 'sideChat.start') return Promise.resolve({ threadId: 'side-1' })
      if (
        method === 'thread.history' &&
        methods['thread.history'].params.parse(params).threadId === 'side-1'
      ) {
        return Promise.resolve({ events: [], running: false })
      }
      return fallback(method, params)
    })
    const calls = (method: string) =>
      transport.request.mock.calls.filter(([called]) => called === method)

    render(<ColdApp />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: '/side why did it fail?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    // The first load of the panel's modules is slow in a reset registry.
    await waitFor(
      () =>
        expect(transport.request).toHaveBeenCalledWith(
          'thread.sendTurn',
          expect.objectContaining({ threadId: 'side-1', text: 'why did it fail?' }),
        ),
      { timeout: 15_000 },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace tools' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show workspace tools' }))
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

    expect(calls('sideChat.close')).toEqual([])
    expect(calls('sideChat.start')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Message temporary chat' })).toBeTruthy()
  }, 30_000)
})

describe('feedback entry points', () => {
  function enableFeedback() {
    const base = transport.request.getMockImplementation()!
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'feedback.status'
        ? Promise.resolve({ enabled: true })
        : method === 'feedback.preview'
          ? Promise.resolve({ payload: '{}', redactions: 0 })
          : base(method, params),
    )
  }

  it('stays hidden when this build has no feedback inbox', async () => {
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const commandSearch = await screen.findByRole(
      'textbox',
      { name: 'Search commands' },
      { timeout: 10_000 },
    )
    fireEvent.change(commandSearch, { target: { value: 'send feedback' } })
    expect(screen.queryByText('Send feedback…')).toBeNull()
    fireEvent.keyDown(commandSearch, { key: 'Escape' })
    expect(transport.request.mock.calls.some(([method]) => method === 'feedback.status')).toBe(true)
    expect(composer).toBeTruthy()
  })

  it('opens the dialog from the palette and from /feedback without sending anything', async () => {
    enableFeedback()
    render(<App />)
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const commandSearch = await screen.findByRole(
      'textbox',
      { name: 'Search commands' },
      { timeout: 10_000 },
    )
    fireEvent.change(commandSearch, { target: { value: 'send feedback' } })
    await screen.findByText('Send feedback…')
    fireEvent.keyDown(commandSearch, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog', { name: 'Send feedback' })
    fireEvent.keyDown(within(dialog).getByLabelText('Message'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send feedback' })).toBeNull())

    fireEvent.change(composer, { target: { value: '/feedback the export button does nothing' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    const fromCommand = await screen.findByRole('dialog', { name: 'Send feedback' })
    expect(within(fromCommand).getByLabelText('Message')).toHaveProperty(
      'value',
      'the export button does nothing',
    )
    expect(transport.request.mock.calls.some(([method]) => method === 'feedback.submit')).toBe(
      false,
    )
    expect(transport.request.mock.calls.some(([method]) => method === 'thread.start')).toBe(false)
  })
})
