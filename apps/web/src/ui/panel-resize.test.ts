// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginPanelResize } from './panel-resize.js'

const feedback = vi.hoisted(() => vi.fn())
vi.mock('../haptics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../haptics.js')>()),
  appHapticsEnabled: () => true,
  performAppHaptic: feedback,
}))

let cancel: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => window.clearTimeout(frame))
})

afterEach(() => {
  cancel?.()
  cancel = undefined
  feedback.mockClear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function start(style: CSSStyleDeclaration | undefined) {
  const onFinish = vi.fn()
  cancel = beginPanelResize(
    { clientX: 500, clientY: 0, timeStamp: 0 },
    {
      axis: 'clientX',
      initialSize: 400,
      minSize: 280,
      maxSize: 600,
      style,
      property: 'width',
      onFinish,
    },
  )
  return onFinish
}

function move(clientX: number) {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX }))
}

describe('panel resize', () => {
  it.each(['pointerup', 'pointercancel', 'blur'])(
    '%s commits the last queued size once',
    (type) => {
      const style = document.createElement('div').style
      const onFinish = start(style)
      move(450)
      move(0)
      expect(style.width).toBe('')

      window.dispatchEvent(new Event(type))
      expect(style.width).toBe('600px')
      expect(onFinish).toHaveBeenCalledExactlyOnceWith(600, true)
      expect(feedback).toHaveBeenCalledExactlyOnceWith('alignment')
      move(700)
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(16)
      expect(style.width).toBe('600px')
      expect(onFinish).toHaveBeenCalledOnce()
    },
  )

  it('disposal keeps the last painted size and drops pending and later movement', () => {
    const style = document.createElement('div').style
    const onFinish = start(style)
    move(420)
    vi.advanceTimersByTime(16)
    expect(style.width).toBe('480px')
    move(0)
    cancel?.()
    move(700)
    vi.advanceTimersByTime(16)
    window.dispatchEvent(new Event('pointerup'))
    expect(style.width).toBe('480px')
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(480, false)
  })

  it('does not give tracking feedback when the panel surface is absent', () => {
    const onFinish = start(undefined)
    move(0)
    window.dispatchEvent(new Event('pointerup'))
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(600, true)
    expect(feedback).not.toHaveBeenCalled()
  })
})
