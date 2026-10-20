// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  INSTALL_SETTLE_MS,
  reportRunningChats,
  resetAppUpdateInstallForTests,
  setAppUpdateInstallGate,
} from '../app-update-install.js'
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
  resetAppUpdateInstallForTests()
  vi.useRealTimers()
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
  act(() => bridge.listener?.({ ...ready, status: 'preparing' }))
  expect(
    screen.getByRole('button', { name: 'Preparing TasteCode update' }).hasAttribute('disabled'),
  ).toBe(true)
  expect(screen.queryByText('100%')).toBeNull()
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

function serverGate(running = 0) {
  const calls: string[] = []
  const gate = {
    calls,
    runningChats: vi.fn(async () => running),
    stopRunningChats: vi.fn(async () => {
      calls.push('stop')
    }),
  }
  setAppUpdateInstallGate(gate)
  bridge.install.mockImplementation(async () => {
    calls.push('install')
    return true
  })
  return gate
}

it('installs at once when no chat is running', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue({ status: 'ready', currentVersion: '1.0.0', version: '1.0.1' })
  reportRunningChats(0)
  render(<AppUpdateNotice />)
  fireEvent.click(await screen.findByRole('button', { name: /Restart to update/ }))
  await waitFor(() => expect(bridge.install).toHaveBeenCalledOnce())
  expect(gate.runningChats).toHaveBeenCalledOnce()
  expect(gate.stopRunningChats).not.toHaveBeenCalled()
})

it('waits for running chats and installs by itself when the last one ends', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue({ status: 'ready', currentVersion: '1.0.0', version: '1.0.1' })
  reportRunningChats(2)
  render(<AppUpdateNotice />)
  const restart = await screen.findByRole('button', { name: /Restart to update/ })
  restart.focus()
  fireEvent.click(restart)
  const waiting = await screen.findByRole('button', {
    name: 'Installs when 2 chats finish. Update options',
  })
  expect(waiting.title).toBe('Installs when 2 chats finish')
  expect(waiting.textContent).toBe('2')
  expect(document.activeElement).toBe(waiting)
  expect(bridge.install).not.toHaveBeenCalled()

  act(() => reportRunningChats(1))
  expect(
    screen.getByRole('button', { name: 'Installs when 1 chat finishes. Update options' }),
  ).toBeTruthy()
  vi.useFakeTimers()
  act(() => reportRunningChats(0))
  await act(async () => vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS))
  expect(gate.runningChats).toHaveBeenCalledOnce()
  expect(bridge.install).toHaveBeenCalledOnce()
  expect(gate.stopRunningChats).not.toHaveBeenCalled()
  expect(
    screen
      .getByRole('button', { name: 'Restart to update TasteCode to 1.0.1' })
      .getAttribute('aria-busy'),
  ).toBe('true')
})

it('stops the running chats after one confirmation on Install now', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue({ status: 'ready', currentVersion: '1.0.0', version: '1.0.1' })
  reportRunningChats(2)
  render(<AppUpdateNotice />)
  fireEvent.click(await screen.findByRole('button', { name: /Restart to update/ }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'Installs when 2 chats finish. Update options' }),
  )
  expect(screen.getByText('Installs when 2 chats finish')).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: /Install now/ }))
  expect(gate.stopRunningChats).not.toHaveBeenCalled()
  const stop = screen.getByRole('menuitem', { name: 'Stop 2 chats and install' })
  expect(stop.className).toContain('menu__item--danger')
  // The safe choice takes the focus the clicked item lost.
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Keep waiting' })),
  )
  // Keep waiting goes back without stopping anything.
  fireEvent.click(screen.getByRole('menuitem', { name: 'Keep waiting' }))
  expect(gate.stopRunningChats).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: /Install now/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Stop 2 chats and install' }))
  await waitFor(() => expect(gate.calls).toEqual(['stop', 'install']))
})

it('puts the install off on Install later', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue({ status: 'ready', currentVersion: '1.0.0', version: '1.0.1' })
  reportRunningChats(1)
  render(<AppUpdateNotice />)
  fireEvent.click(await screen.findByRole('button', { name: /Restart to update/ }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'Installs when 1 chat finishes. Update options' }),
  )
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Install later' }))
  expect(await screen.findByRole('button', { name: /Restart to update/ })).toBeTruthy()
  vi.useFakeTimers()
  act(() => reportRunningChats(0))
  await act(async () => vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS * 4))
  expect(gate.runningChats).not.toHaveBeenCalled()
  expect(bridge.install).not.toHaveBeenCalled()
})
