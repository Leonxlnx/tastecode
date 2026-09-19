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
  listener: undefined as ((state: AppUpdateState) => void) | undefined,
}))
vi.mock('../bridge.js', () => ({
  appUpdateState: bridge.read,
  installAppUpdate: bridge.install,
  checkForAppUpdates: bridge.check,
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    bridge.listener = listener
    return bridge.off
  },
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
