// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  DetectedAccountHome,
  MethodName,
  ProviderAccount,
  ProviderStatus,
  ResultOf,
} from '@harness/contracts'
import { TestTransport } from '../test-transport.js'
import {
  AddAccountSection,
  FoundAccountsSection,
  IgnoredSignInsSection,
  ProviderAccountRows,
} from './ProviderAccounts.js'

const bridge = vi.hoisted(() => ({
  isDesktop: false,
  pickFolder: vi.fn(),
  revealPath: vi.fn(),
}))
vi.mock('../bridge.js', () => bridge)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

const codex: ProviderStatus = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  auth: 'authenticated',
  capabilities: {
    steer: false,
    fork: false,
    interrupt: false,
    reasoningItems: false,
    approvals: false,
    images: false,
    multipleAccounts: true,
  },
}
const claude: ProviderStatus = { ...codex, id: 'claude-code', displayName: 'Claude Code' }

const defaultAccount = (provider: ProviderAccount['provider']): ProviderAccount => ({
  id: 'default',
  provider,
  label: 'Default',
  managed: false,
  email: 'me@example.com',
  plan: 'pro',
})
const work: ProviderAccount = {
  id: 'work-1a2b3c',
  provider: 'codex',
  label: 'Work',
  home: 'C:\\TasteCode\\accounts\\codex\\work-1a2b3c',
  managed: true,
  createdAt: 2,
}
const brought: ProviderAccount = {
  id: 'side-4d5e6f',
  provider: 'codex',
  label: 'Side',
  home: 'D:\\codex-side',
  managed: false,
  createdAt: 3,
}

function serve(initial: ProviderAccount[], found: DetectedAccountHome[] = []) {
  let accounts = initial
  let active: ResultOf<'accounts.list'>['active'] = {}
  const transport = new TestTransport((method: MethodName, params: unknown) => {
    const p = params as Record<string, unknown>
    switch (method) {
      case 'accounts.list':
        return { accounts, active }
      case 'accounts.detect':
        return { found }
      case 'accounts.create': {
        const created: ProviderAccount = {
          id: 'new-000000',
          provider: p.provider as ProviderAccount['provider'],
          label: String(p.label),
          home: 'C:\\TasteCode\\accounts\\codex\\new-000000',
          managed: true,
        }
        accounts = [...accounts, created]
        return { account: created }
      }
      case 'accounts.rename':
        accounts = accounts.map((account) =>
          account.id === p.accountId ? { ...account, label: String(p.label) } : account,
        )
        return { account: accounts.find((account) => account.id === p.accountId) }
      case 'accounts.remove':
        accounts = accounts.filter((account) => account.id !== p.accountId)
        return {}
      case 'accounts.setActive':
        active = { ...active, [String(p.provider)]: String(p.accountId) }
        return {}
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  return transport
}

/** An account's whole name, as "Codex · Work", which its parts make up. */
const named = (text: string) => (_: string, element: Element | null) =>
  element?.classList.contains('account-name') === true && element.textContent === text

const calls = (transport: TestTransport, method: MethodName) =>
  transport.requests.filter((request) => request.method === method).map(({ params }) => params)

describe('Provider accounts in Settings', () => {
  it('offers Add account with what accounts are for, and no rows of its own', async () => {
    const transport = serve([defaultAccount('claude-code'), defaultAccount('codex')])
    render(
      <AddAccountSection transport={transport} providers={[claude, codex]} onAdded={vi.fn()} />,
    )

    expect(await screen.findByRole('button', { name: 'Add account' })).toBeTruthy()
    expect(screen.getByText(/Sign in to Claude Code or Codex more than once/)).toBeTruthy()
    expect(screen.queryByText(/Default/)).toBeNull()
  })

  it('lists a provider’s further accounts under it, never the default one, and sets one active', async () => {
    const transport = serve([defaultAccount('codex'), { ...work, email: 'work@example.com' }])
    render(<ProviderAccountRows transport={transport} provider={codex} />)

    expect(await screen.findByText(named('Codex · Work'))).toBeTruthy()
    // The provider's own row is its default account.
    expect(screen.queryByText(named('Codex · Default'))).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Codex · Work' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Use Work for new Codex chats' }))
    await waitFor(() =>
      expect(calls(transport, 'accounts.setActive')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c' },
      ]),
    )
    expect(await screen.findByText('Active')).toBeTruthy()
  })

  it('draws nothing while the default account is the only one', async () => {
    const transport = serve([defaultAccount('codex')])
    const { container } = render(<ProviderAccountRows transport={transport} provider={codex} />)
    await waitFor(() => expect(calls(transport, 'accounts.list')).toHaveLength(1))
    expect(container.textContent).toBe('')
  })

  it('gives an account that has not signed in one action, Sign in, and Set active in its menu', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountRows transport={transport} provider={codex} />)

    const row = (await screen.findByText(named('Codex · Work'))).closest<HTMLElement>(
      '.provider-row',
    )!
    expect(row.textContent).toContain('Not signed in')
    const action = row.querySelector('.provider-account__action')!
    expect([...action.children].map((child) => child.textContent)).toEqual(['Sign in'])
    // The menu comes before the action on every row, so the menus line up.
    expect(row.querySelector('.provider-account__more + .provider-account__action')).toBe(action)

    fireEvent.click(within(row).getByRole('button', { name: 'Work account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set active' }))
    await waitFor(() =>
      expect(calls(transport, 'accounts.setActive')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c' },
      ]),
    )
    // Sign in keeps the slot; the status says new chats start here.
    expect(await within(row).findByText('Active · Not signed in')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Work account actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Set active' })).toBeNull()
  })

  it('signs an account in through its own sign-in terminal and reads who it is', async () => {
    let signedIn = false
    const base = serve([defaultAccount('codex'), work])
    const transport = new TestTransport(async (method, params) => {
      if (method === 'providers.launch') return { terminalId: 'login-work' }
      if (method === 'terminal.status') throw new Error('not in this test')
      if (method === 'auth.status') {
        // The server keeps what this check names as the account's identity.
        signedIn = true
        return { signedIn: true, email: 'work@example.com' }
      }
      const answer = await base.request(method, params as never)
      if (method !== 'accounts.list' || !signedIn) return answer
      const listed = answer as ResultOf<'accounts.list'>
      return {
        ...listed,
        accounts: listed.accounts.map((account) =>
          account.id === work.id ? { ...account, email: 'work@example.com' } : account,
        ),
      }
    })
    const opened = vi.fn()
    render(<ProviderAccountRows transport={transport} provider={codex} onOpenTerminal={opened} />)

    // The default account is signed in already, so only Work offers a sign-in.
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Work' }))
    expect(screen.queryByRole('button', { name: 'Sign in to Default' })).toBeNull()
    await waitFor(() =>
      expect(calls(transport, 'providers.launch')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c', columns: 320, rows: 30 },
      ]),
    )
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith({
        provider: 'codex',
        accountId: 'work-1a2b3c',
        displayName: 'Codex · Work',
        installKey: 'login:codex@work-1a2b3c',
      }),
    )
    expect(screen.getByRole('button', { name: 'Cancel signing in to Work' })).toBeTruthy()

    transport.emit('terminal.exit', { terminalId: 'login-work', exitCode: 0 })
    await waitFor(() =>
      expect(calls(transport, 'auth.status')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c' },
      ]),
    )
    expect(await screen.findByText('work@example.com')).toBeTruthy()
  })

  it('adds a managed account and one in a folder the user already has', async () => {
    const transport = serve([defaultAccount('codex')])
    const onAdded = vi.fn()
    render(<AddAccountSection transport={transport} providers={[codex]} onAdded={onAdded} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    const form = screen.getByRole('form', { name: 'Add account' })
    expect(
      within(form).getByText(
        'TasteCode makes a new, empty folder for this account, so Codex starts there with its default settings. Sign in once it is added.',
      ),
    ).toBeTruthy()
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Work  ' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Add account' }))
    await waitFor(() =>
      expect(calls(transport, 'accounts.create')).toEqual([
        { provider: 'codex', label: 'Work', home: { kind: 'managed' } },
      ]),
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add account' })).toBeNull())
    // Its provider comes along, so the new account has a row to sit under.
    expect(onAdded).toHaveBeenCalledWith('codex')

    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    const second = screen.getByRole('form', { name: 'Add account' })
    fireEvent.change(within(second).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Side' },
    })
    fireEvent.click(within(second).getByRole('radio', { name: 'Existing folder' }))
    const submit = within(second).getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(second).getByRole('textbox', { name: 'Folder path' }), {
      target: { value: 'D:\\codex-side' },
    })
    fireEvent.click(submit)
    await waitFor(() =>
      expect(calls(transport, 'accounts.create').at(-1)).toEqual({
        provider: 'codex',
        label: 'Side',
        home: { kind: 'existing', path: 'D:\\codex-side' },
      }),
    )
  })

  it('shows what the server refused in the form', async () => {
    const transport = serve([defaultAccount('codex')])
    const request = transport.request.bind(transport)
    vi.spyOn(transport, 'request').mockImplementation((method, params) =>
      method === 'accounts.create'
        ? Promise.reject(new Error('Another account is already called "Work".'))
        : request(method, params),
    )
    render(<AddAccountSection transport={transport} providers={[codex]} onAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Work' } })
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Add account' })).getByRole('button', {
        name: 'Add account',
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Another account is already called "Work".',
    )
    expect(screen.getByRole('form', { name: 'Add account' })).toBeTruthy()
  })

  it('renames an account where its name stands, from its pencil or its menu', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountRows transport={transport} provider={codex} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Work' }))
    const field = screen.getByRole('textbox', { name: 'Name of Codex account' })
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'Client' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText(named('Codex · Client'))).toBeTruthy()
    expect(calls(transport, 'accounts.rename')).toEqual([
      { provider: 'codex', accountId: 'work-1a2b3c', label: 'Client' },
    ])

    // The menu starts the same field; Escape puts the name back and goes no further.
    fireEvent.click(screen.getByRole('button', { name: 'Client account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const again = screen.getByRole('textbox', { name: 'Name of Codex account' })
    fireEvent.change(again, { target: { value: 'Other' } })
    expect(fireEvent.keyDown(again, { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(named('Codex · Client'))).toBeTruthy()
    expect(calls(transport, 'accounts.rename')).toHaveLength(1)
  })

  it('keeps the name open with the reason when the server refuses it', async () => {
    const transport = serve([defaultAccount('codex'), work])
    const request = transport.request.bind(transport)
    vi.spyOn(transport, 'request').mockImplementation((method, params) =>
      method === 'accounts.rename'
        ? Promise.reject(new Error('Another account is already called "Default".'))
        : request(method, params),
    )
    render(<ProviderAccountRows transport={transport} provider={codex} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Work' }))
    const field = screen.getByRole('textbox', { name: 'Name of Codex account' })
    fireEvent.change(field, { target: { value: 'Default' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Another account is already called "Default".',
    )
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(field)
  })

  it('removes an account with its minus and keeps its folder, after a confirmation', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountRows transport={transport} provider={codex} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Codex · Work' }))

    // The dialog loads on first use.
    const dialog = await screen.findByRole(
      'alertdialog',
      { name: 'Remove Work?' },
      { timeout: 5000 },
    )
    expect(within(dialog).getByText(/The folder stays as it is/)).toBeTruthy()
    expect(within(dialog).getByText('work-1a2b3c')).toBeTruthy()
    expect(calls(transport, 'accounts.remove')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove account' }))

    await waitFor(() =>
      expect(calls(transport, 'accounts.remove')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c' },
      ]),
    )
    await waitFor(() => expect(screen.queryByText(named('Codex · Work'))).toBeNull())
  })

  it('deletes a managed folder only as its own confirmed action', async () => {
    const transport = serve([defaultAccount('codex'), work, brought])
    render(<ProviderAccountRows transport={transport} provider={codex} />)

    // A brought folder has no Delete folder; removing is the minus, not the menu.
    fireEvent.click(await screen.findByRole('button', { name: 'Side account actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Remove account' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete folder' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Work account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete folder' }))
    const dialog = await screen.findByRole(
      'alertdialog',
      { name: 'Delete Work and its folder?' },
      { timeout: 5000 },
    )
    expect(within(dialog).getByText(/This cannot be undone/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls(transport, 'accounts.remove')).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Work account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete folder' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete folder',
      }),
    )
    await waitFor(() =>
      expect(calls(transport, 'accounts.remove')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c', deleteHome: true },
      ]),
    )
  })

  it('offers sign-ins found on the computer and adds one as it is, with its provider', async () => {
    const found: DetectedAccountHome[] = [
      { provider: 'codex', home: '/Users/me/.codex-side', label: 'Side', lastUsed: Date.now() },
      // Only providers that can run as more accounts and are on this machine are offered.
      { provider: 'grok', home: '/Users/me/.grok-2', label: '2' },
    ]
    const transport = serve([defaultAccount('codex')])
    const onAdded = vi.fn()
    render(
      <FoundAccountsSection
        transport={transport}
        providers={[codex]}
        found={found}
        onAdded={onAdded}
      />,
    )

    const section = await screen.findByRole('region', { name: 'Found on this computer' })
    expect(section.textContent).toContain('Codex · Side')
    expect(section.textContent).toContain('Found in .codex-side · used just now')
    expect(section.textContent).not.toContain('.grok-2')

    fireEvent.click(within(section).getByRole('button', { name: 'Add Codex · Side' }))
    await waitFor(() =>
      expect(calls(transport, 'accounts.create')).toEqual([
        {
          provider: 'codex',
          label: 'Side',
          home: { kind: 'existing', path: '/Users/me/.codex-side' },
        },
      ]),
    )
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('codex'))
    expect(within(section).getByText('Added')).toBeTruthy()
    expect(within(section).queryByRole('button', { name: 'Ignore Codex · Side' })).toBeNull()
  })

  it('ignores a found sign-in for good, and keeps it folded under Ignored until taken back', () => {
    const side: DetectedAccountHome = {
      provider: 'codex',
      home: '/Users/me/.codex-side',
      label: 'Side',
    }
    const transport = serve([defaultAccount('codex')])
    render(
      <FoundAccountsSection
        transport={transport}
        providers={[codex]}
        found={[side]}
        onAdded={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ignore Codex · Side' }))
    expect(JSON.parse(localStorage.getItem('harness.ignoredSignIns.v1')!)).toEqual([
      'codex /Users/me/.codex-side',
    ])
    cleanup()

    render(<IgnoredSignInsSection providers={[codex]} ignored={[side]} />)
    const toggle = screen.getByRole('button', { name: /^Ignored/ })
    expect(toggle.textContent).toBe('Ignored1')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Codex · Side')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Codex · Side')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unignore Codex · Side' }))
    expect(JSON.parse(localStorage.getItem('harness.ignoredSignIns.v1')!)).toEqual([])
  })

  it('shows neither section when there is nothing found or ignored', () => {
    const transport = serve([defaultAccount('codex')])
    const { container } = render(
      <>
        <FoundAccountsSection
          transport={transport}
          providers={[codex]}
          found={[]}
          onAdded={vi.fn()}
        />
        <IgnoredSignInsSection providers={[codex]} ignored={[]} />
      </>,
    )
    expect(container.textContent).toBe('')
  })
})
