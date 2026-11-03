// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBackground } from '../app-background.js'
import { resetEffectMotionForTests } from '../app-background-motion.js'
import { AppBackgroundLayer } from './AppBackgroundLayer.js'

/** The fake context: every WebGL method the renderer calls, as a spy. */
interface Gl {
  [method: string]: ReturnType<typeof vi.fn>
}

/** Just enough of WebGL for the renderer to compile, link and draw. */
function fakeWebGl(): Gl {
  const answers = new Map<string, unknown>([
    ['isContextLost', false],
    ['createShader', {}],
    ['getShaderParameter', true],
    ['createProgram', {}],
    ['getProgramParameter', true],
    ['createBuffer', {}],
    ['getAttribLocation', 0],
    ['getUniformLocation', {}],
    ['getExtension', null],
  ])
  const methods: Gl = {}
  return new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      // Constants such as COMPILE_STATUS.
      if (/^[A-Z_\d]+$/.test(key)) return key
      target[key] ??= vi.fn(() => answers.get(key))
      return target[key]
    },
  })
}

let resize: ((width: number) => void) | undefined

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    resize = (width) =>
      this.callback(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
  }
  disconnect() {
    resize = undefined
  }
  unobserve() {}
}

const effect: AppBackground = {
  mode: 'effect',
  effect: 'halftone',
  material: 'acrylic',
  image: undefined,
  dim: 50,
  blur: 14,
}

let gl: Gl | null

beforeEach(() => {
  gl = fakeWebGl()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl' ? gl : null) as unknown as HTMLCanvasElement['getContext'])
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
})

afterEach(() => {
  cleanup()
  resetEffectMotionForTests()
  Reflect.deleteProperty(document, 'hasFocus')
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resize = undefined
})

function canvasOf(container: HTMLElement) {
  const layer = container.querySelector<HTMLElement>('.app-bg')!
  const canvas = layer.querySelector<HTMLCanvasElement>('canvas.app-bg__motion')!
  return { layer, canvas }
}

describe('the moving effect', () => {
  it('draws the effect on a canvas sized to the window and drops the still tile', () => {
    const { container } = render(<AppBackgroundLayer background={effect} />)
    const { layer, canvas } = canvasOf(container)
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(layer.dataset['motion']).toBe('')
    // The tile stays handed over, for if the canvas stops.
    expect(layer.style.getPropertyValue('--app-bg-pattern')).toMatch(/^url\(/)
    expect(gl?.['drawArrays']).not.toHaveBeenCalled()

    act(() => resize?.(1200))
    expect([canvas.width, canvas.height]).toEqual([1200, 448])
    expect([canvas.style.width, canvas.style.height]).toEqual(['1200px', '448px'])
    expect(gl?.['drawArrays']).toHaveBeenCalledTimes(1)
    expect(gl?.['uniform1f']).toHaveBeenCalledWith(expect.anything(), 1)
  })

  it('draws Dither one buffer pixel per cell', () => {
    const { container } = render(
      <AppBackgroundLayer background={{ ...effect, effect: 'dither' }} />,
    )
    const { canvas } = canvasOf(container)
    act(() => resize?.(1000))
    expect([canvas.width, canvas.height]).toEqual([500, 224])
    expect([canvas.style.width, canvas.style.height]).toEqual(['1000px', '448px'])
  })

  it('redraws in a new text colour when the theme changes', async () => {
    const { container } = render(<AppBackgroundLayer background={effect} />)
    act(() => resize?.(800))
    const { canvas } = canvasOf(container)
    const style = vi.spyOn(globalThis, 'getComputedStyle')
    style.mockReturnValue({ color: 'rgb(255, 0, 0)' } as CSSStyleDeclaration)
    document.documentElement.dataset['theme'] = 'light'
    await act(async () => {})
    expect(style).toHaveBeenCalledWith(canvas)
    expect(gl?.['uniform3f']).toHaveBeenLastCalledWith(expect.anything(), 1, 0, 0)
    delete document.documentElement.dataset['theme']
  })

  it('falls back to the still tile when the context is lost', () => {
    const { container } = render(<AppBackgroundLayer background={effect} />)
    const { layer, canvas } = canvasOf(container)
    act(() => resize?.(800))
    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost'))
    })
    expect(layer.dataset['motion']).toBeUndefined()
    expect(gl?.['deleteProgram']).toHaveBeenCalledTimes(1)
  })

  it('keeps the still tile where WebGL is missing', () => {
    gl = null
    const { container } = render(<AppBackgroundLayer background={effect} />)
    const { layer } = canvasOf(container)
    expect(layer.dataset['motion']).toBeUndefined()
    expect(layer.style.getPropertyValue('--app-bg-pattern')).toMatch(/^url\(/)
  })

  it('lets the GL objects go when the effect changes or the layer leaves', () => {
    const view = render(<AppBackgroundLayer background={effect} />)
    act(() => resize?.(800))
    view.rerender(<AppBackgroundLayer background={{ ...effect, effect: 'dither' }} />)
    expect(gl?.['deleteProgram']).toHaveBeenCalledTimes(1)
    expect(canvasOf(view.container).layer.dataset['motion']).toBe('')
    view.rerender(<AppBackgroundLayer background={{ ...effect, mode: 'none' }} />)
    expect(gl?.['deleteProgram']).toHaveBeenCalledTimes(2)
  })
})

describe('the moving effect behind Settings', () => {
  it('stops while Settings covers the window and moves again after it', () => {
    const view = render(<AppBackgroundLayer background={effect} />)
    expect(view.container.querySelector('canvas.app-bg__motion')).not.toBeNull()

    view.rerender(<AppBackgroundLayer background={effect} covered />)
    // The still tile shows; nothing draws behind an opaque Settings.
    expect(view.container.querySelector('canvas.app-bg__motion')).toBeNull()
    expect(view.container.querySelector('.app-bg')!.hasAttribute('data-motion')).toBe(false)

    view.rerender(<AppBackgroundLayer background={effect} covered={false} />)
    expect(view.container.querySelector('canvas.app-bg__motion')).not.toBeNull()
  })
})
