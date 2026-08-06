// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DitherWaveform } from './DitherWaveform.js'

function createCanvasContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    imageSmoothingEnabled: true,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(28)
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DitherWaveform', () => {
  it('turns louder microphone levels into a denser dither field', () => {
    const textureContext = createCanvasContext()
    const bloomContext = createCanvasContext()

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return this.classList.contains('dither-waveform__texture') ? textureContext : bloomContext
    })

    const { rerender } = render(<DitherWaveform levels={Array(48).fill(0)} />)
    const quietDots = vi.mocked(textureContext.fillRect).mock.calls.length
    vi.mocked(textureContext.fillRect).mockClear()

    rerender(<DitherWaveform levels={Array(48).fill(1)} />)

    expect(textureContext.fillRect).toHaveBeenCalled()
    expect(vi.mocked(textureContext.fillRect).mock.calls.length).toBeGreaterThan(quietDots)
    expect(bloomContext.drawImage).toHaveBeenCalled()
  })
})
