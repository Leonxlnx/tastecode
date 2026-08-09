// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DitherAreaChart } from './DitherAreaChart.js'

type Draw = { y: number }

function createCanvasContext(draws: Draw[]) {
  return {
    clearRect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn((_x: number, y: number) => draws.push({ y })),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    imageSmoothingEnabled: true,
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
  vi.stubGlobal(
    'Path2D',
    class FakePath2D {
      constructor(_path?: string) {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DitherAreaChart', () => {
  it('paints a 4px ordered field that thins toward the bottom of each area', () => {
    const textureDraws: Draw[] = []
    const bloomDraws: Draw[] = []
    const textureContext = createCanvasContext(textureDraws)
    const bloomContext = createCanvasContext(bloomDraws)

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return this.classList.contains('dither-area-chart__texture') ? textureContext : bloomContext
    })

    render(
      <DitherAreaChart
        series={[
          {
            provider: 'codex',
            areaPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
            areaTop: 0,
            areaBottom: 100,
          },
        ]}
        viewBoxWidth={100}
        viewBoxHeight={100}
        plotLeft={0}
        plotRight={100}
      />,
    )

    const upperDots = textureDraws.filter((draw) => draw.y < 50)
    const lowerDots = textureDraws.filter((draw) => draw.y >= 50)
    expect(textureContext.clip).toHaveBeenCalledOnce()
    expect(upperDots.length).toBeGreaterThan(lowerDots.length)
    expect(bloomContext.drawImage).toHaveBeenCalled()
  })
})
