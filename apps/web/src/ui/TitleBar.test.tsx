// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.harness
})

function stubWindowControlBridge() {
  const harness = {
    windowControl: vi.fn(async () => {}),
    windowIsMaximized: vi.fn(async () => false),
    onWindowMaximizedChange: vi.fn(() => () => {}),
  }
  window.harness = harness as unknown as NonNullable<Window['harness']>
  return harness
}

describe('TitleBar', () => {
  it('keeps workspace tools out of native window chrome', () => {
    const onToggleRail = vi.fn()
    render(<TitleBar collapsed={false} onToggleRail={onToggleRail} />)

    const toggle = screen.getByRole('button', { name: 'Hide sidebar' })
    expect(toggle.getAttribute('type')).toBe('button')
    expect(document.querySelector('.titlebar__drag-region')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    fireEvent.click(toggle)
    expect(onToggleRail).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /workspace/i })).toBeNull()
  })

  it('renders caption buttons on Linux when the bridge exposes window control', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    const harness = stubWindowControlBridge()
    render(<TitleBar collapsed={false} onToggleRail={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Minimize' }))
    expect(harness.windowControl).toHaveBeenCalledWith('minimize')
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    expect(harness.windowControl).toHaveBeenCalledWith('toggle-maximize')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(harness.windowControl).toHaveBeenCalledWith('close')
  })

  it('hides caption buttons on Linux without a bridge', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    render(<TitleBar collapsed={false} onToggleRail={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('hides caption buttons off Linux even with a bridge', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    stubWindowControlBridge()
    render(<TitleBar collapsed={false} onToggleRail={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})
