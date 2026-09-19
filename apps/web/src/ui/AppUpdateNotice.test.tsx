// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../bridge.js'
import { AppUpdateNotice } from './AppUpdateNotice.js'

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  off: vi.fn(),
  listener: undefined as ((state: AppUpdateState) => void) | undefined,
}))
vi.mock('../bridge.js', () => ({
  appUpdateState: bridge.read,
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    bridge.listener = listener
    return bridge.off
  },
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
