// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Profiler } from 'react'
import { Sidebar } from './Sidebar.js'
import type { AccountLimitsState } from './AccountLimits.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'

const hapticMocks = vi.hoisted(() => ({
  perform: vi.fn(),
  prepare: vi.fn(),
}))
const performHaptic = hapticMocks.perform
const prepareHaptics = hapticMocks.prepare
const droppedProjectFolderPaths = vi.hoisted(() =>
  vi.fn<(files: ArrayLike<File>) => Promise<string[]>>(),
)

vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  canDropProjectFolders: true,
  droppedProjectFolderPaths,
  isMacOS: () => true,
}))

vi.mock('../haptics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../haptics.js')>()),
  appHapticsSupported: () => true,
  performAppHaptic: hapticMocks.perform,
  prepareAppHaptics: hapticMocks.prepare,
}))

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
  performHaptic.mockClear()
  prepareHaptics.mockClear()
  droppedProjectFolderPaths.mockReset()
})

const session = (id: string, title: string) => ({
  id,
  title,
  provider: 'codex' as const,
  createdAt: 1,
  status: 'idle' as const,
  lifecycle: { state: 'active' as const, keepActive: false },
  unread: false,
})

function renderProjectCatalog(
  projects: Array<{ path: string; name: string; sessions: [] }>,
  active?: string,
  usageStates?: AccountLimitsState[],
  projectsLoading?: boolean,
) {
  const content = (active: string | undefined, loading = projectsLoading) => (
    <Sidebar
      projects={projects}
      projectsLoading={loading}
      activeProjectPath={active}
      activeSessionId={undefined}
      account={undefined}
      providerName="Codex"
      usageStates={usageStates}
      collapsed={false}
      width={248}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
      onAddProject={vi.fn()}
      onNewSession={vi.fn()}
      onSelectSession={vi.fn()}
      onRenameProject={vi.fn()}
      onRemoveProject={vi.fn()}
      onTogglePin={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
      onArchiveProject={vi.fn()}
      onReorderSession={vi.fn()}
      onOpenSearch={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
  const view = render(content(active))
  return {
    ...view,
    navigate: (active?: string) => view.rerender(content(active)),
    finishLoading: () => view.rerender(content(active, false)),
  }
}

describe('Sidebar chat actions', () => {
  it('shows placeholder projects instead of an empty list while projects load', () => {
    const view = renderProjectCatalog([], undefined, undefined, true)

    expect(screen.getByRole('status').textContent).toBe('Loading projects…')
    expect(screen.queryByText('Nothing here yet.')).toBeNull()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()

    view.finishLoading()
    expect(screen.queryByText('Loading projects…')).toBeNull()
    expect(screen.getByText('Nothing here yet.')).toBeTruthy()
  })

  it('holds the inbox rail in place while its module loads', async () => {
    render(
      <Sidebar
        projects={[]}
        projectsLoading
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        mode="inbox"
        inbox={{
          onSettle: vi.fn(),
          onUnsettle: vi.fn(),
          onSnooze: vi.fn(),
          onUnsnooze: vi.fn(),
          onKeepActive: vi.fn(),
        }}
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(screen.getByText('Loading threads…')).toBeTruthy()
    expect(document.querySelector('.inbox-skeleton-toolbar')).not.toBeNull()

    expect(await screen.findByRole('textbox', { name: 'Search threads' })).toBeTruthy()
    expect(document.querySelector('.inbox-skeleton-toolbar')).toBeNull()
    expect(screen.getByText('Loading threads…')).toBeTruthy()
  })

  it('hides unavailable plan limits while the account component is loading', () => {
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    }
    renderProjectCatalog([], undefined, [
      {
        provider: 'grok',
        status: 'ready',
        summary: {
          session: usage,
          today: usage,
          limits: [],
          limitSource: { provider: 'grok', status: 'unavailable' },
        },
      },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))

    const dialog = screen.getByRole('dialog', { name: 'Account and plan limits' })
    expect(within(dialog).queryByRole('region', { name: 'Plan limits' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Edit profile' })).toBeTruthy()
  })

  it('opens on the plan limits while they are still loading', () => {
    renderProjectCatalog([], undefined, [{ provider: 'codex', status: 'loading' }])

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))

    const dialog = screen.getByRole('dialog', { name: 'Account and plan limits' })
    const limits = within(dialog).getByRole('region', { name: 'Plan limits' })
    expect(dialog.firstElementChild).toBe(limits)
    expect(limits.getAttribute('aria-busy')).toBe('true')
    expect(within(dialog).queryByRole('button', { name: /Usage/ })).toBeNull()
    expect(document.activeElement).toBe(limits)
  })

  it('labels the card meter with its provider and marks a source whose limits are unknown', () => {
    const totals = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    }
    const ready = (
      provider: AccountLimitsState['provider'],
      usedPercent: number,
    ): AccountLimitsState => ({
      provider,
      status: 'ready',
      summary: {
        session: totals,
        today: totals,
        limits: [],
        limitSource: { provider, status: 'ready', limits: [{ label: 'Weekly', usedPercent }] },
      },
    })
    const meter = () => document.querySelector<HTMLElement>('.account__usage')
    const view = renderProjectCatalog([], undefined, [ready('codex', 0), ready('grok', 40)])

    // The tightest limit wins and says whose it is.
    expect(meter()?.title).toBe('Grok · Weekly · 60% left')
    expect(meter()?.querySelector('.account__usage-value')?.textContent).toBe('60% left')
    expect(meter()?.querySelector('svg.account__usage-mark')).not.toBeNull()
    expect(meter()?.querySelector('.account__usage-unknown')).toBeNull()

    // A provider that failed with nothing on record, or was not read yet,
    // might be the tighter one: the known figure stays and says so.
    view.unmount()
    const second = renderProjectCatalog([], undefined, [
      ready('codex', 60),
      { provider: 'claude-code', status: 'error', message: 'Claude usage request failed.' },
      {
        provider: 'grok',
        status: 'ready',
        summary: {
          session: totals,
          today: totals,
          limits: [],
          limitSource: { provider: 'grok', status: 'unavailable', reason: 'failed' },
        },
      },
    ])
    expect(meter()?.title).toBe('Codex · Weekly · 40% left · Claude Code and Grok limits unknown')
    expect(meter()?.querySelector('.account__usage-unknown')).not.toBeNull()

    // A first read still running is not unknown yet, and a source without
    // plan limits is known to have none.
    second.unmount()
    renderProjectCatalog([], undefined, [
      ready('codex', 60),
      { provider: 'claude-code', status: 'loading' },
      {
        provider: 'grok',
        status: 'ready',
        summary: {
          session: totals,
          today: totals,
          limits: [],
          limitSource: { provider: 'grok', status: 'unavailable', reason: 'noPlan' },
        },
      },
    ])
    expect(meter()?.title).toBe('Codex · Weekly · 40% left')
    expect(meter()?.querySelector('.account__usage-unknown')).toBeNull()
  })

  it('shows no figure while every source with limits is unknown', () => {
    renderProjectCatalog([], undefined, [
      { provider: 'claude-code', status: 'error', message: 'Claude usage request failed.' },
    ])
    expect(document.querySelector('.account__usage')).toBeNull()
    expect(document.querySelector('.account__name')?.textContent).toBe('Local profile')
  })

  it('draws the card avatar as the photo, else the generated seal for the profile', () => {
    const view = (profileIdentity: ProfileIdentityPreferences | undefined) => (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        profileIdentity={profileIdentity}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    const avatar = () => document.querySelector<HTMLElement>('.account__avatar')!
    const seal = () => avatar().querySelector<SVGSVGElement>('svg.generated-avatar')

    const rendered = render(view({ displayName: 'Alex Rivera' }))
    expect(seal()).not.toBeNull()
    expect(avatar().textContent).toBe('')
    const alex = seal()!.innerHTML

    // The card strikes the same seal as the profile page: the chosen seed wins over the name.
    rendered.rerender(view({ displayName: 'Alex Rivera', avatarSeed: 'tide' }))
    expect(seal()!.innerHTML).not.toBe(alex)

    // Another name draws another seal; a profile without one still gets a seal.
    rendered.rerender(view({ displayName: 'Leon' }))
    expect(seal()!.innerHTML).not.toBe(alex)
    rendered.rerender(view({ displayName: '' }))
    expect(seal()).not.toBeNull()
    rendered.rerender(view(undefined))
    expect(seal()).not.toBeNull()
    expect(document.querySelector('.account__name')?.textContent).toBe('Local profile')

    rendered.rerender(
      view({ displayName: 'Alex Rivera', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
    )
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
    expect(seal()).toBeNull()
  })

  it('shows a divider below the fixed actions only after the project list scrolls', () => {
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const actions = document.querySelector('.rail__actions')
    const body = document.querySelector<HTMLElement>('.rail__body')
    expect(actions?.classList.contains('is-scrolled')).toBe(false)
    if (!body) throw new Error('Missing sidebar body')

    body.scrollTop = 12
    fireEvent.scroll(body)
    expect(actions?.classList.contains('is-scrolled')).toBe(true)

    body.scrollTop = 0
    fireEvent.scroll(body)
    expect(actions?.classList.contains('is-scrolled')).toBe(false)
  })

  it('uses the classic account footer in the inbox sidebar', async () => {
    const onAddProject = vi.fn()
    const onOpenSettings = vi.fn()
    const view = (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={{ signedIn: true, email: 'private@example.com', plan: 'Pro' }}
        providerName="Codex"
        usageStates={[
          {
            status: 'ready',
            provider: 'codex',
            summary: {
              session: {
                inputTokens: 800,
                cachedInputTokens: 0,
                outputTokens: 200,
                reasoningTokens: 0,
                totalTokens: 1_000,
              },
              today: {
                inputTokens: 4_000,
                cachedInputTokens: 0,
                outputTokens: 1_000,
                reasoningTokens: 0,
                totalTokens: 5_000,
              },
              limits: [{ label: '7 days', usedPercent: 85 }],
              limitSource: {
                provider: 'codex',
                status: 'ready',
                limits: [{ label: '7 days', usedPercent: 85 }],
              },
            },
          },
        ]}
        onRetryUsage={vi.fn()}
        mode="inbox"
        inbox={{
          onSettle: vi.fn(),
          onUnsettle: vi.fn(),
          onSnooze: vi.fn(),
          onUnsnooze: vi.fn(),
          onKeepActive: vi.fn(),
        }}
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={onAddProject}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    )

    const rendered = render(view)
    for (const [usedPercent, expected, low] of [
      [11, '89% left', false],
      [79.9, '20% left', false],
      [85, '15% left', true],
      [100, '0% left', true],
    ] as const) {
      rendered.rerender({
        ...view,
        props: {
          ...view.props,
          usageStates: [
            {
              ...view.props.usageStates[0],
              summary: {
                ...view.props.usageStates[0].summary,
                limitSource: {
                  provider: 'codex',
                  status: 'ready',
                  limits: [{ label: '7 days', usedPercent }],
                },
              },
            },
          ],
        },
      })
      expect(document.querySelector('.account__usage-value')?.textContent).toBe(expected)
      expect(document.querySelector('.account__meter')?.hasAttribute('data-low')).toBe(low)
    }
    rendered.rerender({
      ...view,
      props: { ...view.props, usageStates: [{ provider: 'codex', status: 'loading' }] },
    })
    expect(document.querySelector('.account__usage')).toBeNull()
    rendered.rerender(view)

    expect(screen.queryByRole('button', { name: /Switch to V[12]/ })).toBeNull()
    expect(await screen.findByRole('textbox', { name: 'Search threads' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeTruthy()
    expect(document.querySelector('.account__name')?.textContent).toBe('Local profile')
    const accountTrigger = screen.getByRole('button', { name: 'Account' })
    expect(accountTrigger.querySelector('.account__usage-value')?.textContent).toBe('15% left')
    expect(accountTrigger.querySelector('.account__usage')?.getAttribute('title')).toBe(
      'Codex · 7 days · 15% left',
    )
    expect(accountTrigger.querySelector('.account__usage .account__usage-mark')).not.toBeNull()
    expect(
      accountTrigger.querySelector<HTMLElement>('.account__meter > span')?.style.transform,
    ).toBe('scaleX(0.15)')
    expect(accountTrigger.getAttribute('aria-expanded')).toBe('false')
    // The gear beside the card opens Settings without going through the popup.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenLastCalledWith()
    expect(accountTrigger.getAttribute('aria-expanded')).toBe('false')
    onOpenSettings.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onAddProject).toHaveBeenCalledOnce()
    fireEvent.click(accountTrigger)
    expect(accountTrigger.getAttribute('aria-expanded')).toBe('true')
    const accountDialog = screen.getByRole('dialog', { name: 'Account and plan limits' })
    expect(accountDialog).toBeTruthy()
    expect(accountDialog.classList.contains('menu--compact')).toBe(true)
    expect(accountDialog.classList.contains('menu--settings')).toBe(true)
    // The limits show straight away; there is no second "Usage … left" row
    // repeating them under the list.
    const limits = await within(accountDialog).findByRole('region', { name: 'Codex' })
    expect(within(accountDialog).queryByRole('button', { name: /Usage/ })).toBeNull()
    expect(within(limits).getByText('7 days')).toBeTruthy()
    expect(within(accountDialog).getAllByText('15% left')).toHaveLength(1)
    const limitBar = screen.getByRole('progressbar', { name: 'Codex 7 days left' })
    expect(limitBar.getAttribute('aria-valuenow')).toBe('15')
    expect(limitBar.querySelector<HTMLElement>(':scope > *')!.style.width).toBe('15%')
    expect(document.activeElement).toBe(
      within(accountDialog).getByRole('region', { name: 'Plan limits' }),
    )

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    const accountActions = screen
      .getAllByRole('button')
      .filter((button) => ['Edit profile', 'Settings'].includes(button.textContent ?? ''))
    for (const item of accountActions) expect(item.querySelector('svg')).not.toBeNull()
    expect(accountDialog.firstElementChild?.classList.contains('account-menu__usage')).toBe(true)
    expect(accountDialog.lastElementChild?.classList.contains('account-menu__actions')).toBe(true)
    expect(
      within(accountDialog.lastElementChild as HTMLElement).getByRole('button', {
        name: 'Edit profile',
      }),
    ).toBeTruthy()
    expect(
      within(accountDialog.lastElementChild as HTMLElement).getByRole('button', {
        name: 'Settings',
      }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    expect(onOpenSettings).toHaveBeenCalledWith('profile')
    expect(accountTrigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Account' }))

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Account and plan limits' })).getByRole('button', {
        name: /Settings/,
      }),
    )
    expect(onOpenSettings).toHaveBeenCalledTimes(2)
    expect(onOpenSettings).toHaveBeenLastCalledWith()
  })

  it('shows pinned chats once at the top and unpins them from their row menu', () => {
    const onToggleSessionPin = vi.fn()
    const pinned = { ...session('thread-1', 'Pinned chat'), pinned: true }
    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'TasteCode',
            sessions: [pinned, session('thread-2', 'Regular chat')],
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onToggleSessionPin={onToggleSessionPin}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.getAllByText('Pinned chat')).toHaveLength(1)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pinned chat, Codex' }))
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.querySelector('svg')).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin chat' }))
    expect(onToggleSessionPin).toHaveBeenCalledWith('thread-1')
  })

  it('adds all folders dropped on the sidebar with clear drop feedback', async () => {
    const onAddDroppedProjects = vi.fn()
    droppedProjectFolderPaths.mockResolvedValue(['/work/first', '/work/second'])
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onAddDroppedProjects={onAddDroppedProjects}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const rail = screen.getByRole('navigation')
    const files = [new File([], 'first'), new File([], 'second')]
    const dataTransfer = { files, types: ['Files'], dropEffect: 'none' }

    fireEvent.dragEnter(rail, { dataTransfer })
    expect(screen.getByRole('status').textContent).toContain('Drop folders to add projects')
    expect(rail.classList).toContain('is-folder-drop-target')

    expect(fireEvent.dragOver(rail, { dataTransfer })).toBe(false)
    fireEvent.drop(rail, { dataTransfer })

    expect(screen.queryByRole('status')).toBeNull()
    await waitFor(() =>
      expect(onAddDroppedProjects).toHaveBeenCalledWith(['/work/first', '/work/second']),
    )
    expect(droppedProjectFolderPaths).toHaveBeenCalledWith(files)
  })

  it('does not add anything when a drop contains no folders', async () => {
    const onAddDroppedProjects = vi.fn()
    droppedProjectFolderPaths.mockResolvedValue([])
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onAddDroppedProjects={onAddDroppedProjects}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    fireEvent.drop(screen.getByRole('navigation'), {
      dataTransfer: { files: [new File([], 'notes.txt')], types: ['Files'], dropEffect: 'none' },
    })

    await waitFor(() => expect(droppedProjectFolderPaths).toHaveBeenCalledOnce())
    expect(onAddDroppedProjects).not.toHaveBeenCalled()
  })

  it('closes an open sidebar from the mobile backdrop', () => {
    const onClose = vi.fn()

    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close sidebar' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reveals a collapsed sidebar only while the pointer is at the window edge', () => {
    const { container } = render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const slot = container.querySelector('.rail-slot')
    const rail = container.querySelector('nav')
    const edge = container.querySelector('.rail__edge')
    expect(slot?.classList).toContain('is-collapsed')
    expect(slot?.classList).not.toContain('is-revealed')
    expect(rail?.hasAttribute('inert')).toBe(true)

    fireEvent.mouseEnter(edge!)
    expect(slot?.classList).toContain('is-revealed')
    expect(rail?.hasAttribute('inert')).toBe(false)

    // Leaving hides only after a grace period, so the pointer can travel to
    // the title bar toggle without the flyout flickering away.
    vi.useFakeTimers()
    try {
      // Coming to rest anywhere in the rail's column keeps it, however the
      // pointer got there — this is the path to the title bar toggle.
      fireEvent.mouseLeave(slot!)
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')

      // Moving away arms the hide once. Carrying on moving must not postpone
      // it, or the rail would stay out until the mouse came to a full stop.
      fireEvent.mouseMove(window, { clientX: 900, clientY: 400 })
      act(() => {
        vi.advanceTimersByTime(60)
      })
      fireEvent.mouseMove(window, { clientX: 905, clientY: 405 })
      fireEvent.mouseMove(window, { clientX: 910, clientY: 410 })
      act(() => {
        vi.advanceTimersByTime(80)
      })
      expect(slot?.classList).not.toContain('is-revealed')
      expect(rail?.hasAttribute('inert')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals at the edge without re-rendering the sidebar tree', () => {
    const phases: string[] = []
    const { container } = render(
      <Profiler id="sidebar" onRender={(_, phase) => phases.push(phase)}>
        <Sidebar
          projects={[]}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed
          width={248}
          onWidthChange={vi.fn()}
          onClose={vi.fn()}
          onAddProject={vi.fn()}
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onTogglePin={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveProject={vi.fn()}
          onReorderSession={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </Profiler>,
    )
    phases.length = 0

    fireEvent.mouseEnter(container.querySelector('.rail__edge')!)

    expect(container.querySelector('.rail-slot')?.classList).toContain('is-revealed')
    expect(phases).toEqual([])
  })

  it('keeps a revealed rail in place while the pointer travels to the toggle', () => {
    const view = (collapsed: boolean) => (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={collapsed}
        width={240}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    const { container, rerender } = render(view(true))
    const slot = container.querySelector('.rail-slot')
    fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
    expect(slot?.classList).toContain('is-revealed')

    vi.useFakeTimers()
    try {
      // Aiming at the title bar toggle leaves the slot but stays at the rail.
      fireEvent.mouseLeave(slot!)
      fireEvent.mouseMove(window, { clientX: 300, clientY: 12 })
      // And once it comes to rest there, with no further moves at all.
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')

      // Pressing it docks the rail open for good: no collapsed flyout left.
      rerender(view(false))
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).not.toContain('is-collapsed')
      expect(slot?.classList).not.toContain('is-revealed')

      // Well clear of the rail it retracts as before.
      rerender(view(true))
      fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
      expect(slot?.classList).toContain('is-revealed')
      fireEvent.mouseMove(window, { clientX: 900, clientY: 400 })
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).not.toContain('is-revealed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rail folded by dragging does not spring back out under the pointer', () => {
    const onClose = vi.fn()
    const view = (collapsed: boolean) => (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={collapsed}
        width={248}
        onWidthChange={vi.fn()}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    const { container, rerender } = render(view(false))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    vi.useFakeTimers()
    try {
      // Fold it and let go with the pointer resting on the reveal strip.
      fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 80, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientX: 3, pointerId: 1 })
      expect(onClose).toHaveBeenCalledOnce()
      rerender(view(true))

      const slot = container.querySelector('.rail-slot')
      // Hovering the strip during the wait is ignored.
      fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(slot?.classList).not.toContain('is-revealed')

      // Once it passes, a pointer still parked there gets its reveal.
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resizes a revealed rail without collapsing it', () => {
    const onClose = vi.fn()
    const onWidthChange = vi.fn()
    const { container } = render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed
        width={248}
        onWidthChange={onWidthChange}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    // A collapsed rail has no drag edge until it is revealed.
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
    fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    // Dragging it narrow keeps the reveal: there is nothing left to collapse.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 60, pointerId: 1 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onWidthChange).toHaveBeenCalledWith(240)

    // Widening carries the pointer clear of the rail, which must not retract it.
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(handle, { clientX: 248, pointerId: 2 })
      fireEvent.pointerMove(handle, { clientX: 420, pointerId: 2 })
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(container.querySelector('.rail-slot')?.classList).toContain('is-revealed')
      fireEvent.pointerUp(handle, { clientX: 420, pointerId: 2 })
      expect(onWidthChange).toHaveBeenCalledWith(420)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resizes with pointer or keyboard and collapses below the threshold', () => {
    const onClose = vi.fn()
    const onWidthChange = vi.fn()
    render(
      <div className="shell">
        <Sidebar
          projects={[]}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={false}
          width={248}
          onWidthChange={onWidthChange}
          onClose={onClose}
          onAddProject={vi.fn()}
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onTogglePin={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveProject={vi.fn()}
          onReorderSession={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>,
    )

    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const shell = handle.closest<HTMLElement>('.shell')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenCalledWith(256)

    // Dragging a little past the stop clamps at the minimum instead of
    // squeezing the content, and does not collapse.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 })
    expect(onWidthChange).toHaveBeenCalledWith(240)
    expect(onClose).not.toHaveBeenCalled()

    // Far past the stop the rail folds as a preview; pulling back while still
    // holding unfolds it again, and releasing keeps it open at that width.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 2 })
    expect(onClose).not.toHaveBeenCalled()
    expect(shell?.hasAttribute('data-rail-fold-preview')).toBe(true)
    expect(shell?.style.getPropertyValue('--rail-w')).not.toBe('0px')
    fireEvent.pointerMove(handle, { clientX: 270, pointerId: 2 })
    expect(shell?.hasAttribute('data-rail-fold-preview')).toBe(false)
    fireEvent.pointerUp(handle, { clientX: 270, pointerId: 2 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onWidthChange).toHaveBeenCalledWith(270)

    // Releasing while folded makes the collapse real.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 3 })
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 3 })
    fireEvent.pointerUp(handle, { clientX: 80, pointerId: 3 })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('releases a sidebar resize when native window movement cancels its pointer', () => {
    const onWidthChange = vi.fn()
    render(
      <div className="shell">
        <Sidebar
          projects={[]}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={false}
          width={248}
          onWidthChange={onWidthChange}
          onClose={vi.fn()}
          onAddProject={vi.fn()}
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onTogglePin={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveProject={vi.fn()}
          onReorderSession={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>,
    )
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const shell = handle.closest('.shell')

    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 7 })
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 7 })
    expect(shell?.hasAttribute('data-resizing')).toBe(true)

    fireEvent.pointerCancel(handle, { clientX: 320, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledWith(320)
    expect(shell?.hasAttribute('data-resizing')).toBe(false)

    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledTimes(1)
  })

  it('clears an active resize when the sidebar closes before pointer release', () => {
    const view = (collapsed: boolean) => (
      <div className="shell">
        <Sidebar
          projects={[]}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={collapsed}
          width={248}
          onWidthChange={vi.fn()}
          onClose={vi.fn()}
          onAddProject={vi.fn()}
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onTogglePin={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveProject={vi.fn()}
          onReorderSession={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>
    )
    const { rerender } = render(view(false))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const shell = handle.closest('.shell')

    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 8 })
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 8 })
    expect(shell?.hasAttribute('data-rail-fold-preview')).toBe(true)

    rerender(view(true))
    expect(shell?.hasAttribute('data-rail-fold-preview')).toBe(false)
    expect(shell?.hasAttribute('data-resizing')).toBe(false)
  })
})
