// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZoomHud, type ZoomHudServices } from './ZoomHud.js'

let zoomListener: ((factor: number) => void) | undefined
const setAppZoom = vi.fn<ZoomHudServices['setAppZoom']>(async () => undefined)
const services = {
  onAppZoomChange: (listener: (factor: number) => void) => {
    zoomListener = listener
    return () => {
      zoomListener = undefined
    }
  },
  setAppZoom,
} satisfies ZoomHudServices

afterEach(() => {
  zoomListener = undefined
  vi.clearAllMocks()
})

describe('ZoomHud', () => {
  it('shows the current percentage and exposes zoom controls', () => {
    render(<ZoomHud services={services} />)

    act(() => zoomListener?.(1.1))

    expect(screen.getByLabelText('App zoom 110%').textContent).toContain('110%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(setAppZoom).toHaveBeenNthCalledWith(1, 'out')
    expect(setAppZoom).toHaveBeenNthCalledWith(2, 'reset')
  })
})
