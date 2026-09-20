// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../bridge.js'
import { AppUpdateNotice } from './AppUpdateNotice.js'

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  off: vi.fn(),
  openExternal: vi.fn(),
  listener: undefined as ((state: AppUpdateState) => void) | undefined,
}))
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  appUpdateState: bridge.read,
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

it('keeps a live update over a stale initial read and only opens review on click', async () => {
  let finish!: (state: AppUpdateState) => void
  bridge.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const review = vi.fn()
  const view = render(<AppUpdateNotice onReview={review} />)
  expect(screen.queryByText(/ready to install/)).toBeNull()
  const ready: AppUpdateState = {
    status: 'ready',
    currentVersion: '0.1.0-beta.6',
    version: '0.1.0-beta.7',
  }
  act(() => bridge.listener?.(ready))
  await act(async () => finish({ status: 'idle', currentVersion: ready.currentVersion }))
  expect(screen.getByText('TasteCode 0.1.0-beta.7 is ready to install.')).toBeTruthy()
  expect(review).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review update' }))
  expect(review).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Later' }))
  expect(view.container.querySelector('.notice')?.getAttribute('data-state')).toBe('closing')
  act(() => bridge.listener?.(ready))
  expect(view.container.querySelector('.notice')?.getAttribute('data-state')).toBe('closing')
  act(() => bridge.listener?.({ ...ready, version: '0.1.0-beta.8' }))
  expect(screen.getByText('TasteCode 0.1.0-beta.8 is ready to install.')).toBeTruthy()
  view.unmount()
  expect(bridge.off).toHaveBeenCalledOnce()
})

it('points manual packages at the releases page without an install path', async () => {
  bridge.read.mockResolvedValue({ status: 'manual', currentVersion: '0.1.0-beta.8' })
  const review = vi.fn()
  const view = render(<AppUpdateNotice onReview={review} />)
  await vi.waitFor(() => expect(bridge.read).toHaveBeenCalledOnce())

  act(() =>
    bridge.listener?.({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
    }),
  )
  expect(screen.queryByText(/available to download/)).toBeNull()

  act(() =>
    bridge.listener?.({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0-beta.9',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    }),
  )
  expect(screen.getByText('TasteCode 0.1.0-beta.9 is available to download.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Review update' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(bridge.openExternal).toHaveBeenCalledWith(
    'https://github.com/Leonxlnx/tastecode/releases/latest',
  )
  expect(review).not.toHaveBeenCalled()

  // A deb that reports no releases URL still lands on the releases page.
  act(() =>
    bridge.listener?.({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0-beta.10',
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(bridge.openExternal).toHaveBeenLastCalledWith(
    'https://github.com/Leonxlnx/tastecode/releases/latest',
  )

  fireEvent.click(screen.getByRole('button', { name: 'Later' }))
  expect(view.container.querySelector('.notice')?.getAttribute('data-state')).toBe('closing')
  view.unmount()
})
