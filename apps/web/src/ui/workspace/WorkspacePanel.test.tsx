// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const idleTransport = { on: () => () => undefined } as unknown as Transport

afterEach(() => {
  cleanup()
  haptics.performAppHaptic.mockClear()
  haptics.prepareAppHaptics.mockClear()
})

describe('WorkspacePanel', () => {
  it('finishes closing immediately when reduced motion removes the transition', async () => {
    const onClosed = vi.fn()
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
        }) as MediaQueryList,
    )

    render(
      <WorkspacePanel
        open={false}
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onClosed={onClosed}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )

    await waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
    matchMedia.mockRestore()
  })

  it('gives resize detents only while the panel is tracking', () => {
    const onWidthChange = vi.fn()
    const { container } = render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
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
    container.className = 'workspace-layout'
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 900 })
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })

    fireEvent.pointerEnter(handle)
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 7 })
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 7 })

    expect(onWidthChange).toHaveBeenCalledWith(480)
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 7 })
    expect(onWidthChange).toHaveBeenLastCalledWith(540)
    expect(haptics.prepareAppHaptics).toHaveBeenCalled()
    expect(haptics.performAppHaptic).toHaveBeenCalledWith('alignment')

    fireEvent.blur(window)
    const widthCalls = onWidthChange.mock.calls.length
    fireEvent.pointerMove(window, { clientX: 380, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledTimes(widthCalls)
  })

  it('closes the sidebar when its final tab closes', async () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
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

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    rerender(
      <WorkspacePanel
        open={false}
        expanded={false}
        width={400}
        transport={idleTransport}
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
    fireEvent.transitionEnd(document.querySelector('.workspace-panel')!, {
      propertyName: 'transform',
    })
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull()
  })

  it('keeps panel controls inside the workspace chrome', () => {
    const onClose = vi.fn()
    const onExpandedChange = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
      />,
    )

    for (const title of ['Review', 'Terminal', 'Browser', 'Files', 'Temporary chat']) {
      expect(screen.getByRole('button', { name: title }).querySelector('svg')).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide workspace tools' }))
    expect(onExpandedChange).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('routes a workspace shell exit through the terminal tab close path', async () => {
    const onClose = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
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

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Exit terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
  })

  it.each(['Browser', 'Terminal', 'Files'] as const)(
    'opens independent %s tabs and closes one with the middle mouse button',
    async (tool) => {
      render(
        <WorkspacePanel
          open
          expanded={false}
          width={400}
          transport={idleTransport}
          theme="dark"
          sideChatParentStatus="idle"
          sideChatStartOptions={{ approval: 'ask' }}
          nativeSurfacesVisible
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onExpandedChange={vi.fn()}
          onWidthChange={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: tool }))
      await waitFor(() => expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Add workspace tab' }))
      fireEvent.click(screen.getByRole('menuitem', { name: tool }))
      await waitFor(() => expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(2))

      fireEvent(
        screen.getAllByRole('tab', { name: tool })[0]!,
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      )
      expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(1)
    },
  )

  it('opens one reusable Browser tab for design preview captures', async () => {
    let captureListener: ((value: unknown) => void) | undefined
    const transport = {
      on: vi.fn((channel: string, listener: (value: unknown) => void) => {
        if (channel === 'preview.captureRequested') captureListener = listener
        return () => undefined
      }),
    } as unknown as Transport
    const onOpen = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={transport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={onOpen}
        onClose={vi.fn()}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )
    await waitFor(() => expect(captureListener).toBeDefined())

    act(() =>
      captureListener?.({
        requestId: '00000000-0000-4000-8000-000000000001',
        url: 'https://example.com/',
        viewports: [{ width: 1_280, height: 800 }],
      }),
    )
    expect(screen.queryByRole('tab', { name: 'Browser' })).toBeNull()

    const request = (requestId: string) => ({
      requestId,
      url: 'http://127.0.0.1:4173/',
      viewports: [{ width: 1_280, height: 800 }],
    })
    act(() => captureListener?.(request('00000000-0000-4000-8000-000000000001')))
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Browser' })).toHaveLength(1))

    act(() => captureListener?.(request('00000000-0000-4000-8000-000000000002')))
    expect(screen.getAllByRole('tab', { name: 'Browser' })).toHaveLength(1)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
