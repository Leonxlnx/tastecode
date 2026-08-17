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
  }
}

const canvasGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(28)
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (canvasGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasGetContext)
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
  }
})

describe('DitherWaveform', () => {
  it('turns louder microphone levels into a denser dither field', () => {
    const textureContext = createCanvasContext()
    const bloomContext = createCanvasContext()

    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        return this.classList.contains('dither-waveform__texture') ? textureContext : bloomContext
      }),
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
