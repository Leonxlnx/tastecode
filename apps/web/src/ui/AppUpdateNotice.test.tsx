// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../bridge.js'
import { AppUpdateNotice } from './AppUpdateNotice.js'

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  off: vi.fn(),
  install: vi.fn(),
  check: vi.fn(),
  openExternal: vi.fn(),
  listener: undefined as ((state: AppUpdateState) => void) | undefined,
}))
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  appUpdateState: bridge.read,
  installAppUpdate: bridge.install,
  checkForAppUpdates: bridge.check,
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    bridge.listener = listener
    return bridge.off
  },
  openExternalUrl: bridge.openExternal,
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows download progress, keeps live readiness, and installs only on click', async () => {
  let finish!: (state: AppUpdateState) => void
  bridge.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  bridge.install.mockResolvedValue(true)
  const view = render(<AppUpdateNotice />)
  expect(screen.queryByRole('button')).toBeNull()
  const ready: AppUpdateState = {
    status: 'ready',
    currentVersion: '0.1.0-beta.6',
    version: '0.1.0-beta.7',
  }
  act(() => bridge.listener?.({ ...ready, status: 'downloading', progress: 42 }))
  expect(
    screen
      .getByRole('button', { name: 'Downloading TasteCode update (42%)' })
      .hasAttribute('disabled'),
  ).toBe(true)
  expect(screen.getByText('42%')).toBeTruthy()
  expect(bridge.install).not.toHaveBeenCalled()
  act(() => bridge.listener?.(ready))
  await act(async () => finish({ status: 'idle', currentVersion: ready.currentVersion }))
  const button = screen.getByRole('button', { name: 'Restart to update TasteCode to 0.1.0-beta.7' })
  expect(bridge.install).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(button))
  expect(bridge.install).toHaveBeenCalledOnce()
  view.unmount()
  expect(bridge.off).toHaveBeenCalledOnce()
})

it('points manual packages at the releases page without an install path', async () => {
  bridge.read.mockResolvedValue({ status: 'manual', currentVersion: '0.1.0-beta.8' })
  render(<AppUpdateNotice />)
  await vi.waitFor(() => expect(bridge.read).toHaveBeenCalledOnce())

  // A manual check with nothing newer renders no button.
  act(() => bridge.listener?.({ status: 'manual', currentVersion: '0.1.0-beta.8' }))
  expect(screen.queryByRole('button')).toBeNull()

  act(() =>
    bridge.listener?.({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0-beta.9',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/tag/v0.1.0-beta.9',
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Download TasteCode 0.1.0-beta.9' }))
  expect(bridge.openExternal).toHaveBeenCalledWith(
    'https://github.com/Leonxlnx/tastecode/releases/tag/v0.1.0-beta.9',
  )
  expect(bridge.install).not.toHaveBeenCalled()

  // A deb that reports no releases URL still lands on the releases page.
  act(() =>
    bridge.listener?.({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0-beta.10',
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Download TasteCode 0.1.0-beta.10' }))
  expect(bridge.openExternal).toHaveBeenLastCalledWith(
    'https://github.com/Leonxlnx/tastecode/releases/latest',
  )
})

it('keeps failed actions retryable and hides the button when the app is current', async () => {
  const ready: AppUpdateState = { status: 'ready', currentVersion: '1.0.0', version: '1.0.1' }
  bridge.read.mockResolvedValue(ready)
  bridge.install.mockRejectedValue(new Error('IPC unavailable'))
  bridge.check.mockImplementation(async () => {
    bridge.listener?.({ ...ready, status: 'current' })
    return { ...ready, status: 'current' }
  })
  render(<AppUpdateNotice />)
  fireEvent.click(await screen.findByRole('button', { name: /Restart to update/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry TasteCode update' }))
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
  expect(bridge.check).toHaveBeenCalledOnce()
  act(() => bridge.listener?.({ ...ready, status: 'error', error: 'Download failed' }))
  expect(screen.getByRole('button', { name: 'Retry TasteCode update' }).title).toContain(
    'Download failed',
  )
})

it('makes a failed manual release check visible and retryable', async () => {
  bridge.read.mockResolvedValue({
    status: 'error',
    currentVersion: '0.1.0-beta.8',
    error: 'GitHub release check failed with HTTP 403.',
    releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases',
  })
  bridge.check.mockResolvedValue({ status: 'manual', currentVersion: '0.1.0-beta.8' })
  render(<AppUpdateNotice />)

  const retry = await screen.findByRole('button', { name: 'Retry TasteCode update' })
  expect(retry.title).toBe('GitHub release check failed with HTTP 403. Click to retry.')
  fireEvent.click(retry)

  await waitFor(() => expect(bridge.check).toHaveBeenCalledOnce())
  expect(bridge.openExternal).not.toHaveBeenCalled()
})
