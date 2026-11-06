// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { paintWhiteGround, scalePng } from './white-ground.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * One RGBA pixel behind a 2D context. A new canvas starts transparent, and a transparent source
 * pixel drawn over it leaves what is underneath, as source-over compositing does.
 */
function onePixel() {
  let pixel = [0, 0, 0, 0]
  const calls: string[] = []
  const context = {
    fillStyle: '',
    fillRect: vi.fn(() => {
      calls.push('fillRect')
      if (context.fillStyle === '#fff') pixel = [255, 255, 255, 255]
    }),
    drawImage: vi.fn(() => calls.push('drawImage')),
  }
  return { context, calls, pixel: () => pixel }
}

it('turns a transparent page pixel white', () => {
  const canvas = onePixel()
  paintWhiteGround(canvas.context as unknown as CanvasRenderingContext2D, 1, 1)
  canvas.context.drawImage()
  expect(canvas.pixel()).toEqual([255, 255, 255, 255])
})

it('draws a capture narrower than the limit on white too, instead of passing it through', async () => {
  const canvas = onePixel()
  vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
  vi.spyOn(Image.prototype, 'naturalWidth', 'get').mockReturnValue(300)
  vi.spyOn(Image.prototype, 'naturalHeight', 'get').mockReturnValue(200)
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(canvas.context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,b24td2hpdGU=',
  )

  await expect(scalePng('data:image/png;base64,dHJhbnNwYXJlbnQ=', 1280)).resolves.toBe(
    'b24td2hpdGU=',
  )
  const drawn = getContext.mock.contexts[0] as HTMLCanvasElement
  expect([drawn.width, drawn.height]).toEqual([300, 200])
  expect(canvas.calls).toEqual(['fillRect', 'drawImage'])
  expect(canvas.pixel()).toEqual([255, 255, 255, 255])
})
