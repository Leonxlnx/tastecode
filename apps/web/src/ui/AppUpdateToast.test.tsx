// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  appUpdateInstallState,
  reportRunningChats,
  requestAppUpdateInstall,
  resetAppUpdateInstallForTests,
  setAppUpdateInstallGate,
} from '../app-update-install.js'
import type { AppUpdateState } from '../bridge.js'
import { AppUpdateToast } from './AppUpdateToast.js'

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  install: vi.fn(),
  listener: undefined as ((state: AppUpdateState) => void) | undefined,
}))
vi.mock('../bridge.js', () => ({
  appUpdateState: bridge.read,
  installAppUpdate: bridge.install,
  reportRunningAgents: () => {},
  reportStartupMilestone: () => {},
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    bridge.listener = listener
    return () => {}
  },
}))

const ready: AppUpdateState = { status: 'ready', currentVersion: '0.1.2', version: '0.5.0' }
const confirm = vi.fn(() => true)
// A closing notice stays in the DOM until its fade ends, which happy-dom never runs.
const openNotice = () => document.querySelector('.notice--app-update[data-state="open"]')

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

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  cleanup()
  resetAppUpdateInstallForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('says nothing until an update is ready, then offers Update', async () => {
  bridge.read.mockResolvedValue({ ...ready, status: 'downloading', progress: 40 })
  render(<AppUpdateToast />)
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()
  act(() => bridge.listener?.(ready))
  expect(await screen.findByText('TasteCode 0.5.0 is ready')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
})

it('restarts into the update at once when no agent is running', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue(ready)
  render(<AppUpdateToast />)
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  await waitFor(() => expect(gate.calls).toEqual(['install']))
  expect(gate.stopRunningChats).not.toHaveBeenCalled()
  expect(screen.getByText('Restarting TasteCode…')).toBeTruthy()
})

it('asks in the notice before stopping running agents, then stops them and restarts', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue(ready)
  reportRunningChats(2)
  render(<AppUpdateToast />)
  const update = await screen.findByRole('button', { name: 'Update' })
  update.focus()
  fireEvent.click(update)

  expect(await screen.findByText('2 chats still running')).toBeTruthy()
  // The choice that stops nothing takes the focus, so a stray Enter stops nothing.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'When they finish' }))
  expect(gate.calls).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: 'Stop and update' }))
  await waitFor(() => expect(gate.calls).toEqual(['stop', 'install']))
  expect(confirm).not.toHaveBeenCalled()
})

it('waits for the running agents when asked to, and closes', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue(ready)
  reportRunningChats(1)
  render(<AppUpdateToast />)
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  fireEvent.click(await screen.findByRole('button', { name: 'When they finish' }))
  expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 1 })
  await waitFor(() => expect(openNotice()).toBeNull())
  expect(gate.calls).toEqual([])
})

it('closes the question without stopping anything', async () => {
  const gate = serverGate(0)
  bridge.read.mockResolvedValue(ready)
  reportRunningChats(1)
  render(<AppUpdateToast />)
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel update' }))
  expect(appUpdateInstallState()).toEqual({ phase: 'idle' })
  await waitFor(() => expect(openNotice()).toBeNull())
  expect(gate.calls).toEqual([])
})

it('remembers a dismissed version, and shows the next one', async () => {
  bridge.read.mockResolvedValue(ready)
  const first = render(<AppUpdateToast />)
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss update notice' }))
  await waitFor(() => expect(openNotice()).toBeNull())
  first.unmount()

  render(<AppUpdateToast />)
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()
  act(() => bridge.listener?.({ ...ready, version: '0.5.1' }))
  expect(await screen.findByText('TasteCode 0.5.1 is ready')).toBeTruthy()
})

it('asks here when the sidebar button is clicked, even after a dismissal', async () => {
  serverGate(0)
  localStorage.setItem('harness.appUpdate.dismissedVersion', '0.5.0')
  bridge.read.mockResolvedValue(ready)
  reportRunningChats(3)
  render(<AppUpdateToast />)
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => requestAppUpdateInstall())
  expect(await screen.findByText('3 chats still running')).toBeTruthy()
})

it('leaves the question to Settings while it is open, and the news to another notice', async () => {
  serverGate(0)
  bridge.read.mockResolvedValue(ready)
  const view = render(<AppUpdateToast quiet />)
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()

  reportRunningChats(1)
  await act(async () => requestAppUpdateInstall())
  // A question is not news: it shows next to another notice.
  expect(await screen.findByText('1 chat still running')).toBeTruthy()
  view.rerender(<AppUpdateToast hidden />)
  await waitFor(() => expect(openNotice()).toBeNull())
})
