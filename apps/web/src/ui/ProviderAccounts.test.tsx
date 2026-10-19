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
    const transport = serve([defaultAccount('codex'), work])
    render(<ProviderAccountsSection transport={transport} providers={[codex]} />)

    expect(await screen.findByText('Work')).toBeTruthy()
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Not signed in')).toBeTruthy()

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
    expect(await screen.findByText('Work')).toBeTruthy()

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
    expect(await screen.findByText('Client')).toBeTruthy()
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
    await waitFor(() => expect(screen.queryByText('Work')).toBeNull())
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
