// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZoomHud } from './ZoomHud.js'

const zoom = vi.hoisted(() => ({
  listener: undefined as ((factor: number) => void) | undefined,
  set: vi.fn(async () => undefined),
}))

vi.mock('../bridge.js', () => ({
  onAppZoomChange: (listener: (factor: number) => void) => {
    zoom.listener = listener
    return () => {
      zoom.listener = undefined
    }
  },
  setAppZoom: zoom.set,
}))

afterEach(() => {
  zoom.listener = undefined
  vi.clearAllMocks()
})

describe('ZoomHud', () => {
  it('shows the current percentage and exposes zoom controls', () => {
    render(<ZoomHud />)

    act(() => zoom.listener?.(1.1))

    expect(screen.getByLabelText('App zoom 110%').textContent).toContain('110%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(zoom.set).toHaveBeenNthCalledWith(1, 'out')
    expect(zoom.set).toHaveBeenNthCalledWith(2, 'reset')
  })
})
