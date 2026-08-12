// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DomainEvent } from '@harness/contracts'
import type { ComponentProps } from 'react'
import { App } from './App.js'
import { DESIGN_BRIEF_ATTACHMENT } from './design-agent/briefing.js'
import { serializeModelCatalogCache } from './model-catalog-cache.js'
import type { ModelChoice } from './model-catalog.js'
import { IndeterminateRequestError } from './transport.js'

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  listeners: new Map<string, (data: unknown) => void>(),
  stateListeners: new Set<(state: string) => void>(),
  sequenceGapListeners: new Set<(expected: number, received: number) => void>(),
  urls: [] as string[],
  connect: vi.fn(),
  close: vi.fn(),
  ensureHealthy: vi.fn(),
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

vi.mock('./transport.js', () => ({
  IndeterminateRequestError: class IndeterminateRequestError extends Error {
    override name = 'IndeterminateRequestError'
  },
  isIndeterminateRequestError: (error: unknown) =>
    error instanceof Error && error.name === 'IndeterminateRequestError',
  Transport: class {
    constructor(url: string) {
      transport.urls.push(url)
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
      return () => {
        transport.listeners.delete(channel)
      }
    }
    onState(listener: (state: string) => void) {
      transport.stateListeners.add(listener)
      return () => {
        transport.stateListeners.delete(listener)
      }
    }
    onSequenceGap(listener: (expected: number, received: number) => void) {
      transport.sequenceGapListeners.add(listener)
      return () => {
        transport.sequenceGapListeners.delete(listener)
      }
    }
    request(method: string, params: unknown) {
      return transport.request(method, params)
    }
  },
}))

vi.mock('./ui/highlighter.js', () => {
  const plugin = {
    type: 'code-highlighter',
    name: 'test-highlighter',
    getSupportedLanguages: () => [],
    getThemes: () => [],
    supportsLanguage: () => true,
    highlight: () => ({ tokens: [] }),
  }
  return {
    onHighlighterChange: () => () => {},
    shikiPlugin: plugin,
    plainCodePlugin: plugin,
    warmHighlighter: () => {},
  }
})

// App tests exercise session routing, while Thread's own tests cover its
// virtualized renderer. happy-dom intentionally renders no virtual rows.
vi.mock('./ui/Thread.js', () => ({
  Thread: (props: {
    items: { id: string; text?: string }[]
    running: boolean
    activeTurn?: { id: string; startedAt: number }
  }) => (
    <div data-testid="thread" data-started-at={props.activeTurn?.startedAt}>
      {props.items.map((item) => (
        <span key={item.id} data-item-id={item.id}>
          {item.text}
        </span>
      ))}
      {props.running && props.activeTurn ? <span>Working</span> : null}
    </div>
  ),
}))

vi.mock('./ui/Sidebar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Sidebar.js')>()
  const { memo } = await import('react')
  const Sidebar = memo((props: ComponentProps<typeof original.Sidebar>) => {
    shellRenders.sidebar()
    return <original.Sidebar {...props} />
  })
  return { ...original, Sidebar }
})

vi.mock('./ui/Composer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Composer.js')>()
  const { memo } = await import('react')
  const Composer = memo((props: ComponentProps<typeof original.Composer>) => {
    shellRenders.composer()
    return <original.Composer {...props} />
  })
  return { ...original, Composer }
})

vi.mock('./ui/StageHeader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/StageHeader.js')>()
  const { memo } = await import('react')
  const StageHeader = memo((props: ComponentProps<typeof original.StageHeader>) => {
    shellRenders.stageHeader()
    return <original.StageHeader {...props} />
  })
  return { ...original, StageHeader }
})

vi.mock('./ui/CommandPalette.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/CommandPalette.js')>()
  const { memo } = await import('react')
  const CommandPalette = memo((props: ComponentProps<typeof original.CommandPalette>) => {
    utilityRenders.commandPalette()
    return <original.CommandPalette {...props} />
  })
  return { ...original, CommandPalette }
})

vi.mock('./ui/Settings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/Settings.js')>()
  const { memo } = await import('react')
  const Settings = memo((props: ComponentProps<typeof original.Settings>) => {
    utilityRenders.settings()
    return <original.Settings {...props} />
  })
  return { ...original, Settings }
})

vi.mock('./ui/SessionSearch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/SessionSearch.js')>()
  const { memo } = await import('react')
  const SessionSearch = memo((props: ComponentProps<typeof original.SessionSearch>) => {
    utilityRenders.sessionSearch()
    return <original.SessionSearch {...props} />
  })
  return { ...original, SessionSearch }
})

vi.mock('./ui/TerminalPane.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui/TerminalPane.js')>()
  const { memo } = await import('react')
  const TerminalPane = memo((props: ComponentProps<typeof original.TerminalPane>) => {
    utilityRenders.terminalPane()
    return <div data-testid="terminal-pane">{props.threadId}</div>
  })
  return { ...original, TerminalPane }
})

vi.mock('./bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge.js')>()),
  isMacOS: () => {
    // App samples the platform once per render, so this catches root work
    // without adding test-only instrumentation to production code.
    appRenders()
    return true
  },
}))

vi.mock('./voice-recorder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./voice-recorder.js')>()),
  canCaptureVoice: () => true,
}))

/** What the server reports. Projects live there now, not in localStorage. */
let serverProjects: unknown[] = []
let serverProviders: unknown[] = []
let serverUnsavedWork = { isolated: false, uncommitted: false }
let serverSidebarSettings: {
  mode: 'classic' | 'inbox'
  autoSettleDays: number | null
} = { mode: 'classic', autoSettleDays: 3 }

function contractValidServerProjects(): unknown[] {
  return serverProjects.map((project) => {
    if (typeof project !== 'object' || project === null) return project
    const record = project as Record<string, unknown>
    if (!Array.isArray(record.sessions)) return project
    return {
      ...record,
      sessions: record.sessions.map((session) =>
        typeof session === 'object' && session !== null
          ? { provider: 'codex', createdAt: 0, ...session }
          : session,
      ),
    }
  })
}

beforeEach(() => {
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
        return Promise.resolve({ providers: serverProviders })
      case 'models.list':
        return Promise.resolve({ models: [] })
      case 'workspace.info':
        return Promise.resolve({ branch: 'main', added: 0, removed: 0, dirtyFiles: 0 })
      case 'workspace.branches':
        return Promise.resolve({ branches: ['main', 'feature/shelf'] })
      case 'workspace.switchBranch':
        return Promise.resolve({
          branch: (params as { branch: string }).branch,
          added: 0,
          removed: 0,
          dirtyFiles: 0,
        })
      case 'auth.status':
        return Promise.resolve({ signedIn: true })
      case 'projects.list':
        return Promise.resolve({ projects: contractValidServerProjects() })
      case 'sidebar.settings':
        return Promise.resolve(serverSidebarSettings)
      case 'sidebar.updateSettings':
        serverSidebarSettings = {
          ...serverSidebarSettings,
          ...(params as Partial<typeof serverSidebarSettings>),
        }
        return Promise.resolve(serverSidebarSettings)
      case 'thread.history':
        return Promise.resolve({ events: [], running: false })
      case 'thread.queue':
        return Promise.resolve({ items: [], canSteer: true })
      case 'thread.settle':
        return Promise.resolve({
          lifecycle: { state: 'settled', settledAt: 100, reason: 'manual' },
        })
      case 'thread.unsettle':
      case 'thread.unsnooze':
        return Promise.resolve({ lifecycle: { state: 'active', keepActive: false } })
      case 'thread.snooze':
        return Promise.resolve({
          lifecycle: {
            state: 'snoozed',
            snoozedAt: 100,
            wakeAt: (params as { wakeAt: number }).wakeAt,
          },
        })
      case 'thread.setKeepActive':
        return Promise.resolve({
          lifecycle: {
            state: 'active',
            keepActive: (params as { keepActive: boolean }).keepActive,
          },
        })
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
        const { threadId } = params as { threadId: string }
        serverProjects = serverProjects.map((project) => {
          const p = project as { sessions: Array<{ id: string }> }
          return { ...p, sessions: p.sessions.filter((s) => s.id !== threadId) }
        })
        return Promise.resolve({})
      }
      case 'thread.start': {
        // The real server records the session as it starts it, so the next
        // listing has to show it or the rail would stay empty.
        const { workspacePath, isolate } = params as { workspacePath: string; isolate?: boolean }
        serverProjects = serverProjects.map((project) => {
          const p = project as { path: string; sessions: unknown[] }
          if (p.path !== workspacePath) return p
          return {
            ...p,
            sessions: [
              ...p.sessions,
              {
                id: 'thread-1',
                title: 'New session',
                provider: 'codex',
                createdAt: 1,
                running: false,
                ...(isolate ? { worktreeBranch: 'harness/thread-1' } : {}),
              },
            ],
          }
        })
        return Promise.resolve({ threadId: 'thread-1' })
      }
      case 'thread.rename': {
        const { threadId, title } = params as { threadId: string; title: string }
        serverProjects = serverProjects.map((project) => {
          const p = project as { sessions: Array<{ id: string }> }
          return {
            ...p,
            sessions: p.sessions.map((s) => (s.id === threadId ? { ...s, title } : s)),
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
  fireEvent.click(screen.getByRole('menuitem', { name: /Settings/ }))
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

describe('web client', () => {
  it('opens the workspace directly on first launch', async () => {
    localStorage.removeItem('harness.provider')

    render(<App />)

    expect(screen.queryByText('Set up Personal Harness')).toBeNull()
    expect(document.querySelector('.shell')).not.toBeNull()
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.status', { provider: 'codex' })
    })
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
    // prettier-ignore
    const rejected = (fireEvent.click(screen.getByRole('button', { name: /^New session,/ })), await screen.findByPlaceholderText('Do anything'))
    // prettier-ignore
    fireEvent.keyDown((fireEvent.change(rejected, { target: { value: 'Rejected draft' } }), rejected), { key: 'Enter' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    expect(screen.getByRole('button', { name: 'Use gpt-5.6-sol through Codex' })).toBeTruthy()
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

  it('shows a validated model snapshot while discovery refreshes in the background', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
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

  it('keeps a custom bootstrap out of the recovered server catalog cache', async () => {
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
      const cache = localStorage.getItem('harness.modelCatalog.v1')
      expect(cache).not.toBeNull()
      expect(cache).not.toContain('private-model')
    })
  })

  it('unblocks a verified cached source without waiting on another provider catalog', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    serverProviders = [
      ...serverProviders,
      { ...(serverProviders[0] as Record<string, unknown>), id: 'grok', displayName: 'Grok' },
    ]
    let releaseProviders!: () => void
    const providersGate = new Promise<void>((resolve) => {
      releaseProviders = resolve
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'providers.list')
        return providersGate.then(() => ({ providers: serverProviders }))
      if (method === 'models.list' && (params as { provider: string }).provider === 'grok')
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

    const modelButton = screen.getByRole('button', { name: 'Model and reasoning' })
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
    expect(screen.getByRole('status').textContent).toContain('Checking providers')
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
        approval: 'ask',
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
            (params as { provider?: string }).provider === 'claude-code'
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
    expect(screen.getByRole('button', { name: 'Use Fable through Claude Code' })).toBeTruthy()
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
      ...(serverProviders as Array<Record<string, unknown>>),
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
        const provider = (params as { provider: string }).provider
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

  it('reconnects when a newly opened mobile link changes the access token', async () => {
    window.location.hash = '#access_token=first-token'
    render(<App />)

    expect(transport.urls.at(-1)).toBe('ws://127.0.0.1:4311/?token=first-token')
    await waitFor(() => {
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'projects.list'),
      ).toHaveLength(1)
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'models.list'),
      ).toHaveLength(1)
    })

    await act(async () => {
      window.location.hash = '#access_token=second-token'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    await waitFor(() => {
      expect(transport.urls.at(-1)).toBe('ws://127.0.0.1:4311/?token=second-token')
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'projects.list'),
      ).toHaveLength(2)
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'models.list'),
      ).toHaveLength(2)
    })
    expect(transport.close).toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
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
})
describe('new chats', () => {
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
    fireEvent.change(composer, { target: { value: 'Start immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Start immediately')
    expect(screen.getByRole('button', { name: 'Start immediately, Codex, working' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(document.querySelector('.stage__body.is-new-session')).toBeNull()
    expect(transport.request).toHaveBeenCalledWith('usage.summary', { provider: 'codex' })
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
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
      ).toHaveLength(2)
    })
    expect(screen.getByTestId('thread')).toBe(threadElement)

    // prettier-ignore
    emitThreadEvent('thread-1', { type: 'turn.completed', turnId: 'turn-1', status: 'completed' }, 1)
    await waitFor(() =>
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
      ).toHaveLength(3),
    )
    transport.request.mockClear()
    // prettier-ignore
    act(() => { for (const listener of transport.sequenceGapListeners) listener(2, 4) })
    // prettier-ignore
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('thread.history', { threadId: 'thread-1', afterSeq: 1 }))
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

  it('offers setup without clearing a loaded-thread draft when its provider cannot run', async () => {
    serverProviders = [
      {
        ...(serverProviders[0] as Record<string, unknown>),
        installed: false,
        setup: { installUrl: 'https://example.test/codex', login: 'app' },
        problem: 'codex is not on PATH',
      },
    ]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^New session,/ }))
    const composer = await screen.findByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Send after setup' } })
    const setup = await screen.findByRole('button', { name: 'Set up a provider' })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(setup)
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('Send after setup')
  })

  it('keeps a newer sign-out when the initial account read finishes late', async () => {
    serverProviders = [{ ...(serverProviders[0] as object), auth: 'unknown' }]
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
    await screen.findByRole('button', { name: 'Sign in' })
    await act(async () => finishInitial({ signedIn: true }))
    expect(screen.getByRole('status').textContent).toContain('Provider setup required')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

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
    const setup = await screen.findByRole('button', { name: 'Set up a provider' })
    expect(screen.getByRole('status').textContent).toContain('Provider unavailable')
    failing = false
    fireEvent.click(setup)
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
    expect(document.querySelector('.stage__body > .composer')).not.toBeNull()
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
    // Briefing questions are Harness-owned and answered by the server, so a
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
        (params as { provider?: string }).provider === 'claude-code'
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

  it('starts a new session in an isolated checkout when selected', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Workspace mode' }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Work in parallel' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'ask',
        isolate: true,
      })
    })
    expect(await screen.findAllByText('harness/thread-1')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Choose project' })).toBeNull()
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

  it('asks before discarding uncommitted work from an isolated session', async () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin chat' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.pin', {
        threadId: 'pin-thread',
        pinned: true,
      })
    })
    expect(screen.getByText('Pinned')).toBeTruthy()
  })

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
    let releaseRestoreHistory: (() => void) | undefined
    const restoreHistory = new Promise<{ events: never[]; running: false }>((resolve) => {
      releaseRestoreHistory = () => resolve({ events: [], running: false })
    })
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'thread.history' && ++historyReads === 2) return restoreHistory
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Parser work,/ }))
    fireEvent.click(await screen.findByRole('button', { name: '1 checkpoint' }))
    fireEvent.click(screen.getByRole('button', { name: /Before “Fix the parser”/ }))

    expect(await screen.findByText('src/parser.ts')).toBeTruthy()
    expect(screen.getByText('src/parser.test.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.restore', {
        threadId: 'thread-rollback',
        checkpointId: 7,
      })
    })
    await waitFor(() => expect(historyReads).toBe(2))
    act(() => {
      for (const listener of transport.stateListeners) listener('reconnecting')
      for (const listener of transport.stateListeners) listener('open')
    })
    await waitFor(() => expect(historyReads).toBe(3))
    expect(
      transport.request.mock.calls.filter(([method]) => method === 'thread.history').at(-1)?.[1],
    ).toEqual({ threadId: 'thread-rollback' })
    await act(async () => releaseRestoreHistory?.())
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
      { threadId: 'thread-rollback' },
      { threadId: 'thread-rollback' },
      { threadId: 'thread-rollback' },
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

  it('opens the account Profile shortcut directly in the top settings category', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }))

    const inbox = screen.getByRole('radio', { name: 'V2 Inbox' })
    expect(inbox.getAttribute('aria-checked')).toBe('true')
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
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }))

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
    const saves: Array<{
      params: unknown
      resolve: (settings: typeof serverSidebarSettings) => void
    }> = []
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'sidebar.updateSettings') {
        return new Promise((resolve) => {
          saves.push({ params, resolve })
        })
      }
      return request(method, params)
    })

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }))

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
        serverSidebarSettings = {
          ...serverSidebarSettings,
          ...(params as Partial<typeof serverSidebarSettings>),
        }
        return Promise.reject(new Error('Sidebar response was lost'))
      }
      return new Promise((_, reject) => {
        rejectSecondUpdate = reject
      })
    })

    render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }))
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

  it('persists a selected appearance across app restarts', async () => {
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

  it('persists the selected interface font', async () => {
    const first = render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(
      within(screen.getByRole('group', { name: 'Interface font' })).getAllByRole('button'),
    ).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: /System/ }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.font')).toBe('system')
      expect(document.documentElement.dataset.font).toBe('system')
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.font).toBe('system')
  })

  it('persists the selected accent palette', async () => {
    const first = render(<App />)
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(
      within(screen.getByRole('group', { name: 'Accent palette' })).getAllByRole('button'),
    ).toHaveLength(7)
    fireEvent.click(screen.getByRole('button', { name: /Ocean/ }))

    await waitFor(() => {
      expect(localStorage.getItem('harness.accent')).toBe('ocean')
      expect(document.documentElement.dataset.accent).toBe('ocean')
    })

    first.unmount()
    render(<App />)

    expect(document.documentElement.dataset.accent).toBe('ocean')
  })

  it('tracks OS appearance while System is selected', async () => {
    const originalMatchMedia = window.matchMedia.bind(window)
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    let systemIsDark = false
    const systemThemeMedia = {
      get matches() {
        return systemIsDark
      },
      media: '(prefers-color-scheme: dark)',
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    } as unknown as MediaQueryList

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
    })

    systemIsDark = true
    act(() =>
      listeners.forEach((listener) => listener({ matches: systemIsDark } as MediaQueryListEvent)),
    )

    expect(document.documentElement.dataset.theme).toBe('dark')
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

  it('starts Codex sessions with its advertised auto-review mode', async () => {
    serverProjects = [
      { path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [] },
    ]
    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('providers.list', {})
    })
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
        name: 'Personal Harness',
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
      'What should we build in Personal Harness?',
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
    fireEvent.change(composer!, { target: { value: 'Fix the sidebar' } })
    fireEvent.keyDown(composer!, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'ask',
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
        approval: 'ask',
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
        approval: 'ask',
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
        if ((params as { provider: string }).provider === 'codex') {
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
        ...(serverProviders[0] as Record<string, unknown>),
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
        ...(serverProviders[0] as Record<string, unknown>),
        id: 'claude-code',
        displayName: 'Claude Code',
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const claude = (params as { provider: string }).provider === 'claude-code'
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
            (params as { provider: string }).provider === 'codex'
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
    fireEvent.click(await screen.findByRole('switch', { name: 'Show any models from Codex' }))
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
        approval: 'ask',
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
    fireEvent.click(await screen.findByRole('switch', { name: 'Show any models from Codex' }))
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
      const order = JSON.parse(localStorage.getItem('harness.sessionOrder') ?? '{}') as Record<
        string,
        string[]
      >
      expect(order['/work/project']).toEqual(['thread-3', 'thread-1', 'thread-2'])
    })
  })
})

describe('inbox lifecycle', () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /^Newest chat,/ }))
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
    fireEvent.change(await screen.findByRole('combobox', { name: 'Sidebar project filter' }), {
      target: { value: '/work/beta' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    const picker = screen.getByRole('dialog', { name: 'Choose a project for the new thread' })
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
  it('opens a searchable palette for actions, projects, and chats', async () => {
    serverProjects = [
      {
        path: '/work/project',
        name: 'Personal Harness',
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
    await screen.findByRole('button', { name: /^Polish the sidebar,/ })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    const search = screen.getByRole('textbox', { name: 'Search commands' })
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

  it('runs common shortcuts and never intercepts them from the composer', async () => {
    render(<App />)

    await screen.findByRole('button', { name: /^New session,/ })
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Keep this draft intact' } })
    fireEvent.keyDown(composer, { key: 'n', metaKey: true })
    fireEvent.keyDown(composer, { key: 'k', metaKey: true })
    fireEvent.keyDown(composer, { key: ',', metaKey: true })

    expect(transport.request).not.toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft intact')

    composer.blur()
    fireEvent.keyDown(window, { key: 'n', metaKey: true })
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })

    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    expect(document.activeElement).toBe(composer)

    composer.blur()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })
})

describe('live sessions', () => {
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
    // prettier-ignore
    transport.request.mockImplementation((method: string, params: unknown) => method === 'thread.history' ? new Promise((resolve) => (resolveHistory = resolve)) : method === 'thread.sendTurn' ? new Promise(() => {}) : request(method, params))

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Old chat,/ }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Continue immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Continue immediately')
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    const startedAt = screen.getByTestId('thread').getAttribute('data-started-at')

    await act(async () => resolveHistory({ events: [], running: false }))
    expect(screen.getByTestId('thread').textContent).toContain('Continue immediately')
    expect(screen.getByTestId('thread').getAttribute('data-started-at')).toBe(startedAt)
  })

  // prettier-ignore
  it.each([['turn', 'accepted'], ['turn', 'rejected'], ['queue', 'accepted'], ['queue', 'rejected']] as const)(
    'settles an indeterminate %s as %s only after reconnect history',
    async (kind, outcome) => {
      // prettier-ignore
      serverProjects = [{ path: '/work/project', name: 'project', pinned: false, createdAt: 0, sessions: [{ id: 'thread-1', title: 'Existing work', running: false }, { id: 'thread-2', title: 'Background', running: false }] }]
      const request = transport.request.getMockImplementation()!
      let historyCount = 0
      const resyncs: Array<(value: { events: unknown[]; running: boolean }) => void> = []
      let rejectSend!: (error: Error) => void
      // prettier-ignore
      const started = { seq: 1, event: { type: 'turn.started', turn: { id: 't', threadId: 'thread-1', status: 'running', createdAt: 1 } } } as const
      // prettier-ignore
      const reconnect = () => act(() => { for (const listener of transport.stateListeners) listener('reconnecting'); for (const listener of transport.stateListeners) listener('open') })
      // prettier-ignore
      transport.request.mockImplementation((method: string, params: unknown) => method === 'thread.sendTurn' ? new Promise((_, reject) => (rejectSend = reject)) : method === 'thread.history' && historyCount++ > 0 ? new Promise((resolve) => resyncs.push(resolve)) : request(method, params))
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^Existing work,/ }))
      if (kind === 'queue') emitThreadEvent('thread-1', started.event)
      const composer = screen.getByPlaceholderText('Do anything')
      const draft = () => (composer as HTMLTextAreaElement).value
      if (kind === 'queue') await (reconnect(), waitFor(() => expect(resyncs).toHaveLength(1)))
      dropFile(composer, '/work/retry.png')
      fireEvent.change(composer, { target: { value: 'Submit exactly once' } })
      fireEvent.keyDown(composer, { key: 'Enter' })
      // prettier-ignore
      const submissionId = (transport.request.mock.calls.find(([method]) => method === 'thread.sendTurn')?.[1] as { clientSubmissionId: string }).clientSubmissionId
      // prettier-ignore
      const accepted = { seq: 2, event: { type: 'item.completed', item: { id: submissionId, turnId: 'turn-1', type: 'message', role: 'user', status: 'completed', text: 'Submit exactly once', createdAt: 1 } } } as const
      await act(async () => rejectSend(new IndeterminateRequestError('socket lost')))
      if (kind === 'queue') await act(async () => resyncs[0]?.({ events: [started], running: true }))
      else reconnect()
      await waitFor(() => expect(resyncs).toHaveLength(kind === 'queue' ? 2 : 1))
      // prettier-ignore
      expect([kind === 'queue' ? screen.queryByLabelText('Queued prompts')?.textContent : screen.getByTestId('thread').textContent, draft()]).toEqual([expect.stringContaining('Submit exactly once'), ''])
      if (kind === 'turn' && outcome === 'accepted') emitThreadEvent('thread-1', started.event)
      // prettier-ignore
      await act(async () => resyncs.at(-1)?.({ events: outcome === 'rejected' && kind === 'turn' ? [started] : outcome === 'accepted' && kind === 'queue' ? [accepted] : [], running: kind === 'queue' }))
      if (outcome === 'accepted') {
        emitThreadEvent('thread-1', accepted.event)
        // prettier-ignore
        expect([draft(), screen.getByText('Submit exactly once').dataset.itemId]).toEqual(['', submissionId])
      } else {
        // prettier-ignore
        expect([within(screen.getByTestId('thread')).queryByText('Submit exactly once'), kind === 'turn' ? screen.queryByText('Working') : null, draft()]).toEqual([null, null, 'Submit exactly once'])
        expect(screen.getByRole('button', { name: 'Remove retry.png' })).toBeTruthy()
      }
      if (kind !== 'queue') return
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
      submissionId = (call?.[1] as { clientSubmissionId?: string }).clientSubmissionId ?? ''
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
    expect(
      Array.from(document.querySelectorAll('.queue-row__text'), (row) => row.textContent),
    ).toEqual(['First queued', 'Second queued'])
    await act(async () =>
      sends[0]?.({
        queued: true,
        queuedTurn: { id: 'first', text: 'First queued', attachments: [], createdAt: 1 },
      }),
    )

    expect(
      Array.from(document.querySelectorAll('.queue-row__text'), (row) => row.textContent),
    ).toEqual(['First queued', 'Second queued'])
  })

  it('acknowledges Stop instead of looking inert until the turn unwinds', async () => {
    // Providers can take a second or two to stop. With no acknowledged state
    // the button looked dead, so people pressed it repeatedly and concluded
    // that stopping does not work.
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

    // Pending: named so, and no longer clickable — one interrupt is enough.
    const stopping = await screen.findByRole('button', { name: 'Stopping…' })
    expect((stopping as HTMLButtonElement).disabled).toBe(true)

    // The turn actually ending is what clears it.
    emitThreadEvent('thread-1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'interrupted',
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull())
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
        submissionId = (params as { clientSubmissionId?: string }).clientSubmissionId ?? ''
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

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await screen.findByTestId('terminal-pane')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })

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
    utilityRenders.settings.mockClear()
    utilityRenders.terminalPane.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: ' second',
    })
    act(() => frames.shift()?.(32))

    expect(utilityRenders.settings).not.toHaveBeenCalled()
    expect(utilityRenders.terminalPane).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    await screen.findByRole('dialog', { name: 'Search all chats' })
    utilityRenders.sessionSearch.mockClear()
    utilityRenders.terminalPane.mockClear()

    emitThreadEvent('untouched-thread', {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: ' third',
    })
    act(() => frames.shift()?.(48))

    expect(utilityRenders.sessionSearch).not.toHaveBeenCalled()
    expect(utilityRenders.terminalPane).not.toHaveBeenCalled()
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
    const commandSearch = screen.getByRole('textbox', { name: 'Search commands' })
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
    expect(working.querySelector('.sess__spinner')?.textContent).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏')

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
})

function dropFile(composer: HTMLElement, path: string) {
  const file = new File(['test'], path.split('/').at(-1) ?? 'attachment')
  Object.defineProperty(file, 'path', { value: path })
  fireEvent.drop(composer.closest('.composer__box')!, { dataTransfer: { files: [file] } })
}

function emitThreadEvent(threadId: string, event: DomainEvent, seq?: number) {
  act(() => {
    transport.listeners.get('thread.event')?.({ threadId, event, seq })
  })
}

function completedHistoryEvent(seq: number, id: string, text: string) {
  // prettier-ignore
  return { seq, event: { type: 'item.completed' as const, item: { id, turnId: 'turn-1', type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, text, createdAt: seq } } }
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
        ...(serverProjects[0] as Record<string, unknown>),
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
        ...(serverProviders[0] as Record<string, unknown>),
        id: 'claude-code',
        displayName: 'Claude Code',
      },
    ]
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'models.list') {
        const claude = (params as { provider: string }).provider === 'claude-code'
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
    fireEvent.click(await screen.findByRole('switch', { name: 'Show any models from Codex' }))
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
      const { threadId } = params as { threadId: string }
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
    fireEvent.click(await screen.findByRole('button', { name: 'Foreground' }))
    expect(await screen.findByText('Cached base')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Background' }))
    await waitFor(() =>
      expect(screen.getByTestId('thread').textContent).not.toContain('Cached base'),
    )
    transport.request.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Foreground' }))

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
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }))
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
    // prettier-ignore
    emitThreadEvent('untouched-thread', { type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    const historyEvent = (id: string, text: string): { seq: number; event: DomainEvent } => ({
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
