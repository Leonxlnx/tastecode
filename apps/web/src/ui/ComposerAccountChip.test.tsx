// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProviderAccount, ResultOf } from '@harness/contracts'
import { TestTransport } from '../test-transport.js'
import { ComposerAccountChip } from './ComposerAccountChip.js'

afterEach(cleanup)

const defaultAccount: ProviderAccount = {
  id: 'default',
  provider: 'codex',
  label: 'Default',
  managed: false,
}
const work: ProviderAccount = {
  id: 'work-1a2b3c',
  provider: 'codex',
  label: 'Work',
  home: 'C:\\TasteCode\\accounts\\codex\\work-1a2b3c',
  managed: true,
}

function serve(accounts: ProviderAccount[]) {
  let active: ResultOf<'accounts.list'>['active'] = {}
  return new TestTransport((method, params) => {
    if (method === 'accounts.list') return { accounts, active }
    if (method === 'accounts.setActive') {
      const p = params as { provider: string; accountId: string }
      active = { ...active, [p.provider]: p.accountId }
      return {}
    }
    throw new Error(`unexpected ${method}`)
  })
}

describe('ComposerAccountChip', () => {
  it('stays away while the provider has its default account alone', async () => {
    const transport = serve([defaultAccount])
    const { container } = render(<ComposerAccountChip transport={transport} provider="codex" />)
    await waitFor(() =>
      expect(transport.requests.filter((r) => r.method === 'accounts.list')).toHaveLength(1),
    )
    expect(container.textContent).toBe('')
  })

  it('names the account a new chat starts on and makes another one active', async () => {
    const transport = serve([defaultAccount, work])
    render(<ComposerAccountChip transport={transport} provider="codex" />)

    const trigger = await screen.findByRole('button', { name: 'New chat account' })
    expect(trigger.textContent).toContain('Default')
    fireEvent.click(trigger)
    const workItem = await screen.findByRole('menuitem', { name: /Work/ })
    // Work has not named who it is yet; the default account's sign-in shows elsewhere.
    expect(workItem.textContent).toContain('Not signed in')
    expect(screen.getByRole('menuitem', { name: /Default/ }).textContent).not.toContain(
      'Not signed in',
    )
    fireEvent.click(workItem)

    await waitFor(() =>
      expect(
        transport.requests.filter((r) => r.method === 'accounts.setActive').map((r) => r.params),
      ).toEqual([{ provider: 'codex', accountId: 'work-1a2b3c' }]),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New chat account' }).textContent).toContain(
        'Work',
      ),
    )
  })
})
