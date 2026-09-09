// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderStatus, ProviderUpdate } from '@harness/contracts'
import { TestTransport } from '../test-transport.js'
import { resetInstalls } from '../provider-install.js'
import {
  ProviderUpdateCheck,
  ProviderUpdateControl,
  ProviderUpdateNotice,
} from './ProviderUpdates.js'

vi.mock('./InstallTerminal.js', () => ({ InstallTerminal: () => <div>Update output</div> }))

const provider: ProviderStatus = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  auth: 'unknown',
}
const available: ProviderUpdate = {
  provider: 'codex',
  displayName: 'Codex',
  currentVersion: '0.9.0',
  latestVersion: '0.11.0',
  updateAvailable: true,
  canUpdate: true,
  updateUrl: 'https://developers.openai.com/codex/cli',
}
afterEach(() => {
  cleanup()
  resetInstalls()
  localStorage.clear()
})

describe('provider update surfaces', () => {
  it('shows version changes and runs an update with progress and verified success', async () => {
    let updated = false
    const onUpdated = vi.fn()
    const transport = new TestTransport((method) => {
      if (method === 'providers.update') return { terminalId: 'update' }
      return {
        updates: [
          { ...available, currentVersion: updated ? '0.11.0' : '0.9.0', updateAvailable: !updated },
        ],
      }
    })
    render(
      <>
        <ProviderUpdateCheck transport={transport} />
        <ProviderUpdateControl provider={provider} transport={transport} onUpdated={onUpdated} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(screen.getByText('0.9.0 → 0.11.0')).toBeTruthy()
    expect(
      (await screen.findByRole('button', { name: 'Updating…' })).hasAttribute('disabled'),
    ).toBe(true)
    updated = true
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 0 }))
    expect(await screen.findByText('Updated to 0.11.0')).toBeTruthy()
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('shows errors and exposes terminal output without declaring success', async () => {
    const transport = new TestTransport((method) =>
      method === 'providers.update' ? { terminalId: 'update' } : { updates: [available] },
    )
    render(
      <>
        <ProviderUpdateCheck transport={transport} />
        <ProviderUpdateControl provider={provider} transport={transport} onUpdated={() => {}} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await screen.findByRole('button', { name: 'Updating…' })
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 1 }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Update failed. Open details and try again.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('Update output')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry update' })).toBeTruthy()
  })

  it('offers a guide for manually managed installs and no button for current versions', async () => {
    let update = { ...available, canUpdate: false }
    const transport = new TestTransport(() => ({ updates: [update] }))
    render(
      <>
        <ProviderUpdateCheck transport={transport} />
        <ProviderUpdateControl provider={provider} transport={transport} onUpdated={() => {}} />
      </>,
    )
    expect((await screen.findByRole('link', { name: 'Update guide' })).getAttribute('href')).toBe(
      available.updateUrl,
    )
    update = { ...update, updateAvailable: false }
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Update guide' })).toBeNull())
  })

  it('groups releases into one toast and opens Providers', async () => {
    const onOpen = vi.fn()
    const transport = new TestTransport(() => ({
      updates: [available, { ...available, provider: 'grok', displayName: 'Grok' }],
    }))
    render(<ProviderUpdateNotice transport={transport} onOpenProviders={onOpen} />)
    expect(await screen.findByText('2 provider updates available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View updates' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem('harness.providerUpdates.dismissed')!)).toEqual({
      codex: '0.11.0',
      grok: '0.11.0',
    })
  })

  it('remembers dismissal across remounts but not across new releases', async () => {
    let latestVersion = '0.11.0'
    const makeTransport = () =>
      new TestTransport(() => ({ updates: [{ ...available, latestVersion }] }))
    const first = render(
      <ProviderUpdateNotice transport={makeTransport()} onOpenProviders={() => {}} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss provider updates' }))
    first.unmount()
    const second = render(
      <ProviderUpdateNotice transport={makeTransport()} onOpenProviders={() => {}} />,
    )
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'View updates' })).toBeNull()
    second.unmount()
    latestVersion = '0.12.0'
    render(<ProviderUpdateNotice transport={makeTransport()} onOpenProviders={() => {}} />)
    expect(await screen.findByText('Codex 0.12.0 is available')).toBeTruthy()
  })

  it('waits while a more urgent notice is visible', async () => {
    const transport = new TestTransport(() => ({ updates: [available] }))
    const view = render(
      <ProviderUpdateNotice transport={transport} onOpenProviders={() => {}} suppressed />,
    )
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'View updates' })).toBeNull()
    view.rerender(<ProviderUpdateNotice transport={transport} onOpenProviders={() => {}} />)
    expect(await screen.findByRole('button', { name: 'View updates' })).toBeTruthy()
  })
})
