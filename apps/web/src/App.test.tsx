// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DomainEvent } from '@harness/contracts'
import { App } from './App.js'
import { DESIGN_BRIEF_ATTACHMENT } from './design-agent/briefing.js'

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  listeners: new Map<string, (data: unknown) => void>(),
  stateListeners: new Set<(state: string) => void>(),
  urls: [] as string[],
  connect: vi.fn(),
  close: vi.fn(),
}))

vi.mock('./transport.js', () => ({
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
    request(method: string, params: unknown) {
      return transport.request(method, params)
    }
  },
}))

vi.mock('./ui/highlighter.js', () => ({
  warmHighlighter: () => {},
}))

// App tests exercise session routing, while Thread's own tests cover its
// virtualized renderer. happy-dom intentionally renders no virtual rows.
vi.mock('./ui/Thread.js', () => ({
  Thread: (props: {
    items: { id: string; text?: string }[]
    running: boolean
    activeTurn?: { id: string }
  }) => (
    <div data-testid="thread">
      {props.items.map((item) => (
        <span key={item.id}>{item.text}</span>
      ))}
      {props.running && props.activeTurn ? <span>Working</span> : null}
    </div>
  ),
}))

vi.mock('./bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge.js')>()),
  isMacOS: () => true,
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

beforeEach(() => {
  transport.listeners.clear()
  transport.stateListeners.clear()
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
        return Promise.resolve({ projects: serverProjects })
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

describe('web client', () => {
  it('discovers models separately for each installed ACP agent', async () => {
    const request = transport.request.getMockImplementation()
    if (!request) throw new Error('missing request mock')
    transport.request.mockImplementation((method: string, params: unknown) => {
      if (method === 'acp.agents') {
        return Promise.resolve({
          agents: [
            { id: 'gemini', name: 'Gemini CLI', installed: true, verified: true },
            { id: 'kimi', name: 'Kimi CLI', installed: true, verified: true },
          ],
        })
      }
      if (method === 'models.list' && (params as { provider?: string }).provider === 'acp') {
        const agent = (params as { agent: string }).agent
        return Promise.resolve({
          models: [
            {
              id: `${agent}-model`,
              displayName: `${agent} model`,
              isDefault: true,
              reasoningEfforts: [],
              serviceTiers: [],
            },
          ],
        })
      }
      return request(method, params)
    })

    render(<App />)

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'acp',
        agent: 'gemini',
      })
      expect(transport.request).toHaveBeenCalledWith('models.list', {
        provider: 'acp',
        agent: 'kimi',
      })
    })
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
    expect(screen.getByRole('button', { name: 'Start immediately, working' })).toBeTruthy()
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

    emitThreadEvent('thread-1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'completed',
    })
    await waitFor(() =>
      expect(
        transport.request.mock.calls.filter(([method]) => method === 'usage.summary'),
      ).toHaveLength(3),
    )
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

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Keep nearby' }))
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

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Parser work' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'Undo restore' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.undoRestore', {
        threadId: 'thread-rollback',
        undo: 'undo-token',
      })
    })
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
      expect(screen.getByRole('button', { name: 'Fix the sidebar' })).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' }))
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Extra High',
      )
    })

    // And Claude still remembers Low rather than inheriting the top again.
    fireEvent.click(screen.getByRole('button', { name: 'Use Opus 5 through Claude Code' }))
    await waitFor(() => {
      expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
        'Effort: Low',
      )
    })
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

    const source = (await screen.findByRole('button', { name: 'First chat' })).closest('li')!
    const target = screen.getByRole('button', { name: 'Third chat' }).closest('li')!
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
    fireEvent.click(screen.getByRole('button', { name: 'New Thread' }))

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
    fireEvent.click(await screen.findByRole('button', { name: 'Ready chat, project, Done' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Ready chat, project, Done' })).toBeNull()
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
    await screen.findByRole('button', { name: 'Polish the sidebar' })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    const search = screen.getByRole('textbox', { name: 'Search commands' })
    expect(document.activeElement).toBe(search)
    expect(screen.getByRole('option', { name: /Settings/ })).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /^Another Project \/work\/another-project$/ }),
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: /Polish the sidebar/ })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'polish sidebar' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Polish the sidebar' }).classList).toContain(
      'is-active',
    )
  })

  it('opens the project switcher directly and keeps its shortcut out of the picker', async () => {
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

    await screen.findByRole('button', { name: 'New session' })
    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    expect(within(actions!).getByText('⌘N')).toBeTruthy()
    expect(within(actions!).getByText('⌘⇧O')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Project' }).textContent).not.toContain('⌘P')

    fireEvent.keyDown(window, { key: 'p', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Switch project' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.queryByRole('option', { name: /New session/ })).toBeNull()
  })

  it('runs common shortcuts and never intercepts them from the composer', async () => {
    render(<App />)

    await screen.findByRole('button', { name: 'New session' })
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
  it('shows an old-chat submission and working controls before the server resumes it', async () => {
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
    const pendingSend = new Promise(() => {})
    transport.request.mockImplementation((method: string, params: unknown) =>
      method === 'thread.sendTurn' ? pendingSend : request(method, params),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Old chat' }))
    const composer = screen.getByPlaceholderText('Do anything')
    fireEvent.change(composer, { target: { value: 'Continue immediately' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(screen.getByTestId('thread').textContent).toContain('Continue immediately')
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
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
    fireEvent.click(await screen.findByRole('button', { name: 'Existing work' }))
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

    await act(async () =>
      resolveSend?.({
        queued: true,
        queuedTurn: {
          id: 'queued-1',
          text: 'Queue this next',
          attachments: [],
          createdAt: 1,
        },
      }),
    )
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.sendTurn', {
        threadId: 'thread-1',
        text: 'Queue this next',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Queue this next from queue' }))
    expect(transport.request).toHaveBeenCalledWith('thread.deleteQueuedTurn', {
      threadId: 'thread-1',
      queuedTurnId: 'queued-1',
    })
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
    fireEvent.click(await screen.findByRole('button', { name: 'Existing work' }))
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
        return Promise.resolve({
          queued: true,
          queuedTurn: {
            id: 'queued-steer',
            text: 'Use this direction now',
            attachments: [],
            createdAt: 1,
          },
        })
      }
      return request(method, params)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Existing work' }))
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
      }),
    )
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.steerQueuedTurn', {
        threadId: 'thread-1',
        queuedTurnId: 'queued-steer',
      })
    })
    expect(screen.getByTestId('thread').textContent).toContain('Use this direction now')
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

    await screen.findByRole('button', { name: 'Newer session' })
    expect(sessionTitles()).toEqual(['Newer session', 'Older session'])

    emitThreadEvent('thread-1', {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 0 },
    })

    expect(sessionTitles()).toEqual(['Older session', 'Newer session'])
  })

  it('folds streamed deltas once per animation frame', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }))
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

  it('flushes pending deltas before a completion event', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }))
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

    fireEvent.click(await screen.findByRole('button', { name: 'First session' }))
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

    const working = screen.getByRole('button', { name: 'First session, working' })
    expect(working.querySelector('.sess__spinner')?.textContent).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏')

    fireEvent.click(screen.getByRole('button', { name: 'Second session' }))
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
      name: 'Second session, waiting for approval',
    })
    expect(attention.querySelector('.sess__status-dot.is-attention')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'First session, working' }))
    await waitFor(() => expect(screen.getByText('First result')).toBeTruthy())

    emitThreadEvent('thread-1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'completed',
    })
    expect(screen.getByRole('button', { name: 'First session' })).toBeTruthy()
  })
})

function emitThreadEvent(threadId: string, event: DomainEvent) {
  act(() => {
    transport.listeners.get('thread.event')?.({ threadId, event })
  })
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

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

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
})
