// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport.js'

const haptics = vi.hoisted(() => ({
  performAppHaptic: vi.fn(),
  prepareAppHaptics: vi.fn(),
}))

vi.mock('../../haptics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../haptics.js')>()),
  appHapticsEnabled: () => true,
  performAppHaptic: haptics.performAppHaptic,
  prepareAppHaptics: haptics.prepareAppHaptics,
}))

vi.mock('./WorkspaceTerminal.js', () => ({
  WorkspaceTerminal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Exit terminal
    </button>
  ),
}))

import { WorkspacePanel } from './WorkspacePanel.js'

afterEach(() => {
  cleanup()
  haptics.performAppHaptic.mockClear()
  haptics.prepareAppHaptics.mockClear()
})

describe('WorkspacePanel', () => {
  it('gives resize detents only while the panel is tracking', () => {
    const onWidthChange = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={{} as Transport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onExpandedChange={vi.fn()}
        onWidthChange={onWidthChange}
      />,
    )

    const handle = screen.getByRole('separator', { name: 'Resize workspace tools' })
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })

    fireEvent.pointerEnter(handle)
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 7 })
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 7 })

    expect(onWidthChange).toHaveBeenCalledWith(480)
    expect(haptics.prepareAppHaptics).toHaveBeenCalled()
    expect(haptics.performAppHaptic).toHaveBeenCalledWith('alignment')

    fireEvent.blur(window)
    const widthCalls = onWidthChange.mock.calls.length
    fireEvent.pointerMove(window, { clientX: 380, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledTimes(widthCalls)
  })

  it('closes the sidebar when its final tab closes', async () => {
    const onClose = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={{} as Transport}
        projectPath="/workspace/project"
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Terminal Open the session shell/ }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('routes a workspace shell exit through the terminal tab close path', async () => {
    const onClose = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={{} as Transport}
        projectPath="/workspace/project"
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Terminal Open the session shell/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Exit terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull()
  })
})
