// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MethodName, ProviderAccount, ProviderStatus, ResultOf } from '@harness/contracts'
import { TestTransport } from '../test-transport.js'
import { ProviderAccountsSection } from './ProviderAccounts.js'

const bridge = vi.hoisted(() => ({
  isDesktop: false,
  pickFolder: vi.fn(),
  revealPath: vi.fn(),
}))
vi.mock('../bridge.js', () => bridge)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

function serve(initial: ProviderAccount[]) {
  let accounts = initial
  let active: ResultOf<'accounts.list'>['active'] = {}
  const transport = new TestTransport((method: MethodName, params: unknown) => {
    const p = params as Record<string, unknown>
    switch (method) {
      case 'accounts.list':
        return { accounts, active }
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

const calls = (transport: TestTransport, method: MethodName) =>
  transport.requests.filter((request) => request.method === method).map(({ params }) => params)

describe('Provider accounts in Settings', () => {
  it('offers only the add button while every provider has its default account alone', async () => {
    const transport = serve([defaultAccount('claude-code'), defaultAccount('codex')])
    render(<ProviderAccountsSection transport={transport} providers={[claude, codex]} />)

    expect(await screen.findByRole('button', { name: 'Add account' })).toBeTruthy()
    expect(screen.getByText(/Sign in to Claude Code or Codex more than once/)).toBeTruthy()
    await waitFor(() => expect(calls(transport, 'accounts.list')).toHaveLength(1))
    expect(screen.queryByText('Default')).toBeNull()
  })

  it('lists a provider’s accounts once it has two, and sets one active', async () => {
    const transport = serve([defaultAccount('codex'), { ...work, email: 'work@example.com' }])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)

    expect(await screen.findByText('Codex · Work')).toBeTruthy()
    expect(screen.getByText('Codex · Default')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Use Work for new Codex chats' }))
    await waitFor(() =>
      expect(calls(transport, 'accounts.setActive')).toEqual([
        { provider: 'codex', accountId: 'work-1a2b3c' },
      ]),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use Default for new Codex chats' })).toBeTruthy(),
    )
  })

  it('gives an account that has not signed in one action, Sign in, and Set active in its menu', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)

    const row = (await screen.findByText('Codex · Work')).closest<HTMLElement>('.provider-row')!
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
    render(
      <ProviderAccountsSection transport={transport} providers={[codex]} onOpenTerminal={opened} />,
    )

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
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    const form = screen.getByRole('form', { name: 'Add account' })
    expect(
      within(form).getByText(/copies your Codex settings into it, never your sign-in/),
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
    expect(await screen.findByText('Codex · Work')).toBeTruthy()

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
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)
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

  it('renames an account', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const form = screen.getByRole('form', { name: 'Rename Work' })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Client' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Codex · Client')).toBeTruthy()
    expect(calls(transport, 'accounts.rename')).toEqual([
      { provider: 'codex', accountId: 'work-1a2b3c', label: 'Client' },
    ])
  })

  it('removes an account and keeps its folder, after a confirmation', async () => {
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work account actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))

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
    await waitFor(() => expect(screen.queryByText('Codex · Work')).toBeNull())
  })

  it('deletes a managed folder only as its own confirmed action', async () => {
    const transport = serve([defaultAccount('codex'), work, brought])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)

    // The default account and a brought folder have no Delete folder.
    fireEvent.click(await screen.findByRole('button', { name: 'Default account actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Remove account' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete folder' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Side account actions' }))
    expect(screen.getByRole('menuitem', { name: 'Remove account' })).toBeTruthy()
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
})
