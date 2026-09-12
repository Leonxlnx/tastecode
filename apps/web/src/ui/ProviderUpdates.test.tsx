// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUpdate } from '@harness/contracts'
import { TestTransport } from '../test-transport.js'
import { resetInstalls } from '../provider-install.js'
import { ProviderUpdateCheck, ProviderUpdateNotice } from './ProviderUpdates.js'

vi.mock('./InstallTerminal.js', () => ({ InstallTerminal: () => <div>Update output</div> }))

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

function finishNoticeExit(container: HTMLElement) {
  const notice = container.querySelector('.notice')!
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: 'opacity' })
  fireEvent(notice, event)
}

describe('provider update toast', () => {
  it('starts, tracks and verifies an update entirely within the toast', async () => {
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
    const view = render(<ProviderUpdateNotice transport={transport} onUpdated={onUpdated} />)
    const notice = within(view.container.querySelector('.notice') ?? view.container)
    fireEvent.click(await notice.findByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Updating…')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Dismiss provider updates' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(
      transport.requests.filter((request) => request.method === 'providers.update'),
    ).toHaveLength(1)
    updated = true
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 0 }))
    expect(await screen.findByText('Updated to 0.11.0')).toBeTruthy()
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    view.rerender(<ProviderUpdateNotice transport={transport} onUpdated={() => onUpdated()} />)
    expect(onUpdated).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss provider updates' }))
    finishNoticeExit(view.container)
    expect(screen.queryByText('Updated to 0.11.0')).toBeNull()
  })

  it('keeps progress and success when the provider settings panel closes', async () => {
    let updated = false
    const transport = new TestTransport((method) =>
      method === 'providers.update'
        ? { terminalId: 'update' }
        : {
            updates: [
              {
                ...available,
                updateAvailable: !updated,
                currentVersion: updated ? '0.11.0' : '0.9.0',
              },
            ],
          },
    )
    const onUpdated = vi.fn()
    const view = render(
      <>
        <ProviderUpdateCheck transport={transport} />
        <ProviderUpdateNotice transport={transport} onUpdated={onUpdated} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await screen.findByText('Updating…')
    view.rerender(
      <>
        <ProviderUpdateNotice transport={transport} onUpdated={onUpdated} />
      </>,
    )
    expect(screen.getByText('Updating…')).toBeTruthy()
    updated = true
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 0 }))
    expect(await screen.findByText('Updated to 0.11.0')).toBeTruthy()
  })

  it('shows failure, output and retry in the toast without declaring success', async () => {
    const transport = new TestTransport((method) =>
      method === 'providers.update' ? { terminalId: 'update' } : { updates: [available] },
    )
    render(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await screen.findByText('Updating…')
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 1 }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Update failed. Open details and try again.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('Update output')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Updating…')).toBeTruthy()
    expect(
      transport.requests.filter((request) => request.method === 'providers.update'),
    ).toHaveLength(2)
  })

  it('does not claim success when the version is unchanged after a zero exit', async () => {
    const onUpdated = vi.fn()
    const transport = new TestTransport((method) =>
      method === 'providers.update' ? { terminalId: 'update' } : { updates: [available] },
    )
    render(<ProviderUpdateNotice transport={transport} onUpdated={onUpdated} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await screen.findByText('Updating…')
    act(() => transport.emit('terminal.exit', { terminalId: 'update', exitCode: 0 }))
    expect(await screen.findByText('Update failed')).toBeTruthy()
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('offers managed-install guides and excludes providers already on the latest version', async () => {
    const transport = new TestTransport(() => ({
      updates: [
        { ...available, canUpdate: false },
        { ...available, provider: 'grok', displayName: 'Grok', updateAvailable: false },
      ],
    }))
    render(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    expect((await screen.findByRole('link', { name: 'Update guide' })).getAttribute('href')).toBe(
      available.updateUrl,
    )
    expect(screen.queryByText('Grok')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('groups releases in one toast with a separate action for each provider', async () => {
    const transport = new TestTransport((method) =>
      method === 'providers.update'
        ? { terminalId: 'grok-update' }
        : {
            updates: [available, { ...available, provider: 'grok', displayName: 'Grok' }],
          },
    )
    render(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    const grok = await screen.findByLabelText('Grok update')
    expect(document.querySelectorAll('.notice--provider-update')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Update' })).toHaveLength(2)
    fireEvent.click(within(grok).getByRole('button', { name: 'Update' }))
    expect(await within(grok).findByText('Updating…')).toBeTruthy()
    expect(
      transport.requests.find((request) => request.method === 'providers.update')?.params,
    ).toMatchObject({ provider: 'grok' })
    expect(
      within(screen.getByLabelText('Codex update')).getByRole('button', {
        name: 'Update',
      }),
    ).toBeTruthy()
  })

  it('remembers a dismissed release and reopens it from the compact Providers footer', async () => {
    const transport = new TestTransport(() => ({ updates: [available] }))
    const first = render(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss provider updates' }))
    first.unmount()
    render(
      <>
        <ProviderUpdateCheck transport={transport} />
        <ProviderUpdateNotice transport={transport} onUpdated={() => {}} />
      </>,
    )
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1 update available' }))
    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy()
    expect(
      document.querySelector('.provider-updates-check')?.querySelectorAll('button'),
    ).toHaveLength(2)
  })

  it('shows a new release after an older release was dismissed', async () => {
    localStorage.setItem('harness.providerUpdates.dismissed', JSON.stringify({ codex: '0.10.0' }))
    const transport = new TestTransport(() => ({ updates: [available] }))
    render(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    expect(await screen.findByText('0.9.0 → 0.11.0')).toBeTruthy()
  })

  it('resumes the toast when a higher priority notice clears', async () => {
    const transport = new TestTransport(() => ({ updates: [available] }))
    const view = render(
      <ProviderUpdateNotice transport={transport} onUpdated={() => {}} suppressed />,
    )
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    view.rerender(<ProviderUpdateNotice transport={transport} onUpdated={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy()
  })

  it('reports update check errors without a false up-to-date label', async () => {
    const transport = new TestTransport(() => {
      throw new Error('offline')
    })
    render(<ProviderUpdateCheck transport={transport} />)
    expect(await screen.findByText('Could not check for updates. Try again.')).toBeTruthy()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(screen.queryByText('Up to date')).toBeNull()
  })
})
