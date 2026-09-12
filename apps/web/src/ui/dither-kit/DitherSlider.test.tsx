// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DitherSlider } from './DitherSlider.js'

type Draw = {
  x: number
  style: string
}

function createCanvasContext(draws: Draw[]) {
  let fillStyle = ''
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn((x: number) => {
      draws.push({ x, style: fillStyle })
    }),
    imageSmoothingEnabled: true,
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value)
    },
  } as unknown as CanvasRenderingContext2D
}

function getAlpha(style: string): number {
  return Number(style.slice(style.lastIndexOf(',') + 1, -1))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(42)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 100,
    top: 100,
    right: 300,
    bottom: 142,
    left: 100,
    width: 200,
    height: 42,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DitherSlider', () => {
  it('moves a finite bright dither spotlight with the pointer', () => {
    const textureDraws: Draw[] = []
    const bloomDraws: Draw[] = []
    const textureContext = createCanvasContext(textureDraws)
    const bloomContext = createCanvasContext(bloomDraws)

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return this.classList.contains('dither-slider__texture') ? textureContext : bloomContext
    })

    render(
      <div className="model-selector__slider">
        <DitherSlider active={false} />
      </div>,
    )

    fireEvent.pointerMove(window, { clientX: 150, clientY: 121 })
    act(() => vi.advanceTimersByTime(180))
    textureDraws.length = 0

    fireEvent.pointerMove(window, { clientX: 150, clientY: 121 })
    act(() => vi.advanceTimersByTime(16))
    const leftSpot = textureDraws.filter((draw) => getAlpha(draw.style) > 0.5)
    expect(leftSpot.length).toBeGreaterThan(0)

    textureDraws.length = 0
    fireEvent.pointerMove(window, { clientX: 250, clientY: 121 })
    act(() => vi.advanceTimersByTime(16))
    const rightSpot = textureDraws.filter((draw) => getAlpha(draw.style) > 0.5)
    expect(rightSpot.length).toBeGreaterThan(0)
    expect(rightSpot.reduce((sum, draw) => sum + draw.x, 0) / rightSpot.length).toBeGreaterThan(
      leftSpot.reduce((sum, draw) => sum + draw.x, 0) / leftSpot.length,
    )

    fireEvent.pointerOut(window, { relatedTarget: null })
    act(() => vi.advanceTimersByTime(160))
    expect(vi.getTimerCount()).toBe(0)
  })
})
