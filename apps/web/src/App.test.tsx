// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  methods,
  type DomainEvent,
  type ParamsOf,
  type QueuedTurn,
  type ResultOf,
} from '@harness/contracts'
import { StrictMode, type ComponentProps } from 'react'
import { z } from 'zod'
import { App } from './App.js'
import type { NativeMenuAction } from './bridge.js'
import { DESIGN_BRIEF_ATTACHMENT } from './design-agent/briefing.js'
import { serializeModelCatalogCache } from './model-catalog-cache.js'
import type { ModelChoice } from './model-catalog.js'
import { KEYBINDING_DEFINITIONS, type Shortcut } from './shortcuts.js'
import { TERMINAL_PLACEMENT_KEY } from './terminal-placement.js'
import { IndeterminateRequestError, type ConnectionState } from './transport.js'
import { resetInstalls } from './provider-install.js'
import { mockKeyboardModifierState } from './test-keyboard.js'

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
  state: 'open' as ConnectionState,
  connect: vi.fn(),
  close: vi.fn(),
  ensureHealthy: vi.fn(() => Promise.resolve()),
}))

const shellRenders = vi.hoisted(() => ({
  composer: vi.fn(),
  sidebar: vi.fn(),
  stageHeader: vi.fn(),
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
  listener: undefined as ((action: NativeMenuAction) => void) | undefined,
  syncShortcuts: vi.fn(),
}))
type ThreadProps = ComponentProps<(typeof import('./ui/Thread.js'))['Thread']>
interface ThreadCallbacks {
  answerUserInput: ThreadProps['onAnswerUserInput'] | undefined
  undoChanges: ThreadProps['onUndoChanges'] | undefined
}
const threadCallbacks = vi.hoisted<ThreadCallbacks>(() => ({
  answerUserInput: undefined,
  undoChanges: undefined,
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
      return (
        <div
          data-testid="thread"
          data-started-at={frame.activeTurn?.startedAt}
          ref={() => {
            threadCallbacks.answerUserInput = props.onAnswerUserInput
            threadCallbacks.undoChanges = props.onUndoChanges
          }}
        >
          {items.map((base, index) => (
            <span key={base.id} data-item-id={base.id}>
              {liveItems?.get(index)?.item.text ?? base.text}
            </span>
          ))}
          {frame.running && !props.stopping && frame.activeTurn ? <span>Working</span> : null}
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
      shellRenders.sidebar()
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
      shellRenders.stageHeader()
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
  onNativeMenuAction: (listener: (action: NativeMenuAction) => void) => {
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
  utilityRenders.commandPalette.mockClear()
  utilityRenders.sessionSearch.mockClear()
  utilityRenders.settings.mockClear()
  utilityRenders.terminalPane.mockClear()
  transport.listeners.clear()
  transport.stateListeners.clear()
  transport.sequenceGapListeners.clear()
  transport.urls.length = 0
  threadCallbacks.answerUserInput = undefined
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

function cachedCodexChoice(): ModelChoice {
  return {
    key: 'codex:gpt-5.6-sol',
    provider: 'codex',
    sourceName: 'Codex',
    mark: 'openai',
    model: {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      isDefault: true,
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
      serviceTiers: [],
    },
  }
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

describe('web client', () => {
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

  it('persists curated model defaults only after the first catalog arrives', async () => {
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
    expect(localStorage.getItem('harness.hiddenModels')).toBeNull()

    releaseModels({
      models: [
        {
          id: 'gpt-5.6-sol',
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

    await waitFor(() =>
      expect(localStorage.getItem('harness.hiddenModels')).toBe('["codex:gpt-5.5"]'),
    )
  })

  it.each(['failed', 'empty'] as const)(
    'waits for every installed beta catalog when one is %s',
    async (claudeCatalog) => {
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
            images: false,
          },
        },
      ]
      const request = transport.request.getMockImplementation()
      if (!request) throw new Error('missing request mock')
      transport.request.mockImplementation((method: string, params: unknown) => {
        if (method !== 'models.list') return request(method, params)
        if (methods['models.list'].params.parse(params).provider === 'claude-code') {
          return claudeCatalog === 'failed'
            ? Promise.reject(new Error('Claude catalog unavailable'))
            : Promise.resolve({ models: [] })
        }
        return Promise.resolve({
          models: [
            {
              id: 'gpt-5.5',
              displayName: 'GPT-5.5',
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [],
            },
          ],
        })
      })

      render(<App />)

      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith('models.list', {
          provider: 'claude-code',
        }),
      )
      expect(localStorage.getItem('harness.hiddenModels')).toBeNull()
    },
  )

  it('keeps a visibility edit made while live discovery is pending', async () => {
    localStorage.setItem('harness.modelVisibilityVersion', '3')
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
    fireEvent.click(await screen.findByRole('button', { name: 'Models' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Include GPT-5.6 Sol in model picker' }),
    )

    await waitFor(() =>
      expect(localStorage.getItem('harness.hiddenModels')).toBe('["codex:gpt-5.6-sol"]'),
    )
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

    await waitFor(() => expect(screen.getByText('GPT-5.5')).toBeTruthy())
    expect(localStorage.getItem('harness.hiddenModels')).toBe('["codex:gpt-5.6-sol"]')
  })

  it('never replaces a saved model-visibility choice with curated defaults', async () => {
    const saved = '["codex:gpt-5.6-sol"]'
    localStorage.setItem('harness.modelVisibilityVersion', '3')
    localStorage.setItem('harness.hiddenModels', saved)
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list'
        ? Promise.resolve({
            models: [
              {
                id: 'gpt-5.6-sol',
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
    expect(localStorage.getItem('harness.hiddenModels')).toBe(saved)
  })

  it('migrates an existing profile to the exact public-beta model defaults once', async () => {
    localStorage.setItem('harness.hiddenModels', '["codex:gpt-5.3-codex-spark"]')
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'models.list'
        ? Promise.resolve({
            models: [
              cachedCodexChoice().model,
              {
                id: 'gpt-5.2',
                displayName: 'GPT-5.2',
                isDefault: false,
                reasoningEfforts: [],
                serviceTiers: [],
              },
              {
                id: 'gpt-5.3-codex-spark',
                displayName: 'GPT-5.3-Codex-Spark',
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
      expect(localStorage.getItem('harness.hiddenModels')).toBe('["codex:gpt-5.2"]'),
    )
    expect(localStorage.getItem('harness.modelVisibilityVersion')).toBe('3')
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

    expect(screen.getByText('Loading projects…').closest('[role="status"]')).not.toBeNull()
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

  it('opens the workspace directly on first launch', async () => {
    localStorage.removeItem('harness.provider')

    render(<App />)

    expect(screen.queryByText('Set up TasteCode')).toBeNull()
    expect(document.querySelector('.shell')).not.toBeNull()
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'codex' })
    })
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
    await waitFor(() => expect(document.querySelector('.workspace-panel')).toBeTruthy())

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
    localStorage.setItem('harness.model', 'gpt-5.6-sol')
    localStorage.setItem('harness.effort', 'high')
    localStorage.setItem('harness.serviceTier', 'priority')
    localStorage.setItem(
      'harness.modelBySource',
      JSON.stringify({ codex: { modelKey: 'codex:gpt-5.6-sol', serviceTier: 'priority' } }),
    )

    render(<App />)

    expect(screen.queryByText('Loading models…')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Model and reasoning' }))
    expect(
      await screen.findByRole('button', { name: 'Use gpt-5.6-sol through Codex' }),
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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')

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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', { provider: 'codex' })
    })
    await act(async () => {
      rejectModels(new Error('provider unavailable'))
      await failedDiscovery.catch(() => undefined)
    })
    await waitFor(() => {
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('gpt-5.6-sol')
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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')
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
        baseRef: 'main',
        approval: 'auto-review',
        model: 'gpt-5.6-sol',
        effort: 'high',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use what the UI shows',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-5.6-sol',
        effort: 'high',
      })
    })
  })

  it('never fetches ACP agent models in the beta scope', async () => {
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

    // The catalog settles once the direct providers answered.
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      'models.list',
      expect.objectContaining({ provider: 'acp' }),
    )
  })

  it('discovers models only for picker-eligible installed providers', async () => {
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
    const parkedProviderRequest = new Promise<never>(() => {})
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'models.list') return request(method, params)
      const input = methods['models.list'].params.parse(params)
      if (!['codex', 'claude-code', 'grok'].includes(input.provider)) {
        return parkedProviderRequest
      }
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
    expect(directProviders).toEqual(['codex', 'claude-code', 'grok'])
  })

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
      expect(localStorage.getItem('harness.modelCatalog.v1')).toContain('gpt-5.6-sol')
    })
  })

  it('defers ACP agent detection until Settings opens', async () => {
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
    expect(transport.request).not.toHaveBeenCalledWith('acp.agents', {})

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
              id: provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
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

  it('does not expose or initialize desktop dictation', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    expect(transport.request).not.toHaveBeenCalledWith('voice.status', expect.anything())
    expect(screen.queryByRole('button', { name: 'Record voice note' })).toBeNull()
  })

  it('checks desktop voice status once after its connection catalog settles', async () => {
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
    ).toHaveLength(0)

    await act(async () => resolveConnections({ connections: [] }))
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'voice.status'),
      ).toHaveLength(1)
    })
  })

  it('checks voice only for the fallback provider when connections win startup', async () => {
    desktopShell.enabled = true
    localStorage.setItem('harness.provider', 'cursor')
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
      expect(transport.request).toHaveBeenCalledWith('voice.status', { provider: 'codex' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('voice.status', { provider: 'cursor' })
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

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Usage,/ }))
    const codexLimits = await screen.findByRole('region', { name: 'Codex' })
    expect(within(codexLimits).getByText('75% left')).toBeTruthy()
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())
  })

  it('cancels trailing plan-limit refreshes after a real unmount', async () => {
    const view = render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' }),
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

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' })
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'claude-code' })
    })
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', { provider: 'grok' })

    transport.request.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Usage,/ }))
    expect(await screen.findByRole('region', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', expect.anything())
  })

  it('refreshes usage once for active-provider change bursts', async () => {
    render(<App />)
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' }),
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
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' }),
    )
    transport.request.mockClear()

    act(() => {
      setConnectionState('reconnecting')
      setConnectionState('open')
    })

    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' }),
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
        provider: 'claude-code',
      }),
    )
    transport.request.mockClear()
    fireEvent.click(await screen.findByRole('button', { name: 'Claude thread, Claude Code' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('usage.summary', {
        threadId: 'claude-thread',
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
        threadId: 'claude-thread',
      }),
    )
    expect(transport.request).not.toHaveBeenCalledWith('usage.summary', { provider: 'codex' })
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
    openSettings()
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
      openSettings()
      await screen.findByText('Claude Code')
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
      const workspace = document.querySelector<HTMLElement>('.workspace-layout')!
      expect(workspace.classList.contains('is-panel-open')).toBe(true)
      expect(workspace.classList.contains('is-panel-expanded')).toBe(true)
      expect(await screen.findByLabelText('Claude Code login terminal')).toBeTruthy()
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
      await waitFor(() => expect(workspace.classList.contains('is-panel-open')).toBe(false))
      expect(workspace.classList.contains('is-panel-expanded')).toBe(false)
      expect(screen.queryByLabelText('Claude Code login terminal')).toBeNull()
      await waitFor(() =>
        expect(
          screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')!.textContent,
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

  it('preserves a parked custom model without blocking a catalogless beta source', async () => {
    const parked = '[{"provider":"cursor","modelId":"cursor-large","displayName":"Cursor Large"}]'
    localStorage.setItem('harness.provider', 'cursor')
    localStorage.setItem('harness.model', 'custom:cursor:cursor-large')
    localStorage.setItem('harness.customModels.v1', parked)
    render(<App />)
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    fireEvent.change(composer, { target: { value: 'Use the provider default' } })
    await waitFor(() => expect(sendButton.disabled).toBe(false))
    expect(screen.queryByText('Cursor Large')).toBeNull()
    expect(localStorage.getItem('harness.customModels.v1')).toBe(parked)
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        'thread.start',
        expect.objectContaining({ provider: 'codex' }),
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
        baseRef: 'main',
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive New session' }))
    expect(await screen.findByText('Archived chat')).toBeTruthy()
    expect(screen.getByText('Archived chat').closest('.notice--archive')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archive New session' })).toBeNull()
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: 'Archive New session' })).toBeTruthy()
    await act(async () => new Promise((resolve) => nativeTimeout(resolve, 1_050)))
    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', expect.anything())
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive New session' }))
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
      if (scenario === 'new chat cleanup')
        fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
      else emitQueue('untouched-thread', [])
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

    fireEvent.click(await screen.findByRole('button', { name: 'Archive Parallel work' }))
    expect(await screen.findByRole('dialog', { name: 'Discard isolated checkout' })).toBeTruthy()
    expect(transport.request).not.toHaveBeenCalledWith('thread.discardWorktree', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and archive' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }))
    await waitFor(() => expect(restoreRequests).toBe(1))
    await act(async () => releaseRestoreHistory?.())
    await act(async () => rejectRestore(new IndeterminateRequestError('restore reply lost')))
    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(3))
    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }))
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
      { threadId: 'thread-rollback' },
      { threadId: 'thread-rollback', afterSeq: 0 },
      { threadId: 'thread-rollback' },
      { threadId: 'thread-rollback', afterSeq: 0 },
      ...Array.from({ length: 2 }, () => ({ threadId: 'thread-rollback' })),
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
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))

    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Profile' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeTruthy()
  })

  it('persists inbox mode and bounded inactivity settings on the server', async () => {
    serverSidebarSettings.mode = 'inbox'
    render(<App />)

    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    const inbox = screen.getByRole('radio', { name: 'V2 Inbox' })
    await waitFor(() => expect(inbox.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getByRole('radio', { name: 'V1 Classic' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-settle days' }), {
      target: { value: '7' },
    })

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

    const classic = screen.getByRole('radio', { name: 'V1 Classic' })
    const inbox = screen.getByRole('radio', { name: 'V2 Inbox' })
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

    const classic = screen.getByRole('radio', { name: 'V1 Classic' })
    const inbox = screen.getByRole('radio', { name: 'V2 Inbox' })
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

    const classic = screen.getByRole('radio', { name: 'V1 Classic' })
    const inbox = screen.getByRole('radio', { name: 'V2 Inbox' })
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

    const days = screen.getByRole('spinbutton', { name: 'Auto-settle days' })
    fireEvent.change(days, { target: { value: '7' } })
    expect((days as HTMLInputElement).value).toBe('7')

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
    expect((days as HTMLInputElement).value).toBe('7')

    await act(async () => {
      rejectSecondUpdate?.(new Error('Could not save inactivity setting'))
      await Promise.resolve()
    })

    expect(inbox.getAttribute('aria-checked')).toBe('true')
    expect((days as HTMLInputElement).value).toBe('3')
  })

  it('switches sidebar versions only from settings', async () => {
    serverSidebarSettings.mode = 'classic'
    render(<App />)

    expect(screen.queryByRole('button', { name: /Switch to V[12].*sidebar/ })).toBeNull()
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('radio', { name: 'V2 Inbox' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('sidebar.updateSettings', {
        mode: 'inbox',
      })
      expect(screen.getByRole('radio', { name: 'V2 Inbox' }).getAttribute('aria-checked')).toBe(
        'true',
      )
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
      'Geist',
      'Geist Mono',
      'Inter',
      'System default',
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
        'Atkinson Hyperlegible',
        'Geist',
        'Geist Mono',
        'Inter',
        'System default',
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
    const accentOptions = within(picker).getByRole('group', {
      name: 'Accent palette presets',
      hidden: true,
    })
    expect(within(accentOptions).getAllByRole('button', { hidden: true })).toHaveLength(7)
    fireEvent.click(within(accentOptions).getByRole('button', { name: 'Ocean', hidden: true }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.accent.light')).toBe('ocean')
      expect(document.documentElement.dataset.accent).toBe('ocean')
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.accent).toBe('ocean')
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
    expect(permissions.textContent).toContain('Loading…')
    expect(permissions.hasAttribute('disabled')).toBe(true)

    await act(async () => resolveHistory?.({ events: [], running: false, approval: 'full' }))
    await waitFor(() => expect(permissions.textContent).toContain('Full access'))
    expect(localStorage.getItem('harness.approvalByProvider')).toBe('{"codex":"ask"}')
  })

  it('keeps full access selected after the app restarts', () => {
    const first = render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
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
        baseRef: 'main',
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

  it('keeps an untouched session out of the sidebar until the first prompt', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    fireEvent.click(within(actions!).getByRole('button', { name: 'New chat' }))

    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
    // Deleted rather than closed: a session nobody typed into is bookkeeping,
    // not history, and closing would leave it in the rail forever.
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(0))

    const composer = document.querySelector('textarea')
    expect(composer).not.toBeNull()
    expect(document.activeElement).toBe(composer)
    fireEvent.change(composer!, { target: { value: 'Fix the sidebar' } })
    fireEvent.keyDown(composer!, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        baseRef: 'main',
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
                id: 'gpt-5.6-sol',
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
        baseRef: 'main',
        approval: 'auto-review',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      })
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Use the fast lane',
        clientSubmissionId: expect.stringMatching(/^local:/),
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      })
    })
  })

  it('keeps highest reasoning effort at the highest stop when switching models', async () => {
    localStorage.setItem('harness.modelVisibilityVersion', '3')
    localStorage.setItem('harness.hiddenModels', '[]')
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      switch (method) {
        case 'models.list':
          return Promise.resolve({
            models: [
              {
                id: 'gpt-5.6-sol',
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
        baseRef: 'main',
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
                id: 'gpt-5.6-sol',
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
                    id: 'gpt-5.6-sol',
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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')
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
        baseRef: 'main',
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
              id: 'gpt-5.6-sol',
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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')
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
        JSON.parse(localStorage.getItem('harness.sessionOrder') ?? '{}'),
      )
      expect(order['/work/project']).toEqual(['thread-3', 'thread-1', 'thread-2'])
    })
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
  it.each([true, false])('forces onboarding from Debug (macOS: %s)', async (macOS) => {
    shortcutPlatform.macOS = macOS
    localStorage.setItem('harness.onboarding.v1', 'done')
    render(<App />)
    await screen.findByRole('button', { name: 'Account' })
    const modifier = macOS ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ...modifier, shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Debug' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Î', code: 'KeyD', ...modifier, altKey: true, shiftKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Force onboarding' }))
    await screen.findByRole('heading', { name: 'Welcome to TasteCode' })
    fireEvent.click(screen.getByRole('button', { name: /^Begin setup/ }))
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
    expect(screen.queryByRole('dialog', { name: 'Pick your look' })).toBeNull()
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
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })
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
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Default terminal location' }))
    fireEvent.click(screen.getByRole('option', { name: 'Right sidebar' }))
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
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Foreground,/ }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'foreground',
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
    expect(working.querySelector('.sess__spinner.tabler-icon-loader-2')).not.toBeNull()

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
        .querySelector('.sess__unread-dot'),
    ).not.toBeNull()
  })
})

function dropFile(composer: HTMLElement, path: string) {
  const file = new File(['test'], path.split('/').at(-1) ?? 'attachment')
  Object.defineProperty(file, 'path', { value: path })
  fireEvent.drop(composer.closest('.composer__box')!, { dataTransfer: { files: [file] } })
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
      ).toEqual([['thread.history', { threadId: 'untouched-thread' }]])
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
      })
    })
    expect(screen.queryByText('75% left')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByText('75% left')).toBeTruthy()
  })

  it('uses a visible same-source model when the remembered one is hidden', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        return Promise.resolve({
          models: [
            {
              id: 'gpt-5.6-sol',
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
    localStorage.setItem('harness.hiddenModels', JSON.stringify(['codex:gpt-5.6-mini']))
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
        model: 'gpt-5.6-sol',
        effort: 'low',
      })
    })
  })

  it('keeps a server-bound API session active while beta discovery is pending', async () => {
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

  it('preserves exact parked ACP memory without offering its loaded source', async () => {
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
      JSON.stringify({
        'acp:kimi': { modelKey: 'acp:kimi:model-x', effort: 'high' },
      }),
    )

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'ACP thread, Kimi CLI' }))
    await screen.findByText('Provider unavailable')
    expect(screen.queryByRole('button', { name: 'Model and reasoning' })).toBeNull()
    expect(JSON.parse(localStorage.getItem('harness.modelBySource') ?? '{}')).toMatchObject({
      'acp:kimi': { modelKey: 'acp:kimi:model-x', effort: 'high' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    const composer = screen.getByPlaceholderText('Do anything')
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    fireEvent.change(composer, { target: { value: 'Start on the beta source' } })
    await waitFor(() => expect(sendButton.disabled).toBe(false))
    fireEvent.keyDown(composer, { key: 'Enter' })
    const betaStart = expect.objectContaining({ provider: 'codex' })
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('thread.start', betaStart))
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
              id: claude ? 'opus' : 'gpt-5.6-sol',
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
    localStorage.setItem('harness.model', 'codex:gpt-5.6-sol')

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
        threadId: 'untouched-thread',
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
        threadId: 'untouched-thread',
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
