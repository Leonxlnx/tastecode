// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backgroundAt, opaqueHex, readWindowChrome, useWindowChrome } from './window-chrome.js'

const bridge = vi.hoisted(() => ({ setChrome: vi.fn((_chrome: unknown) => Promise.resolve()) }))
vi.mock('./bridge.js', () => ({
  isDesktop: true,
  setDesktopWindowChrome: bridge.setChrome,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  bridge.setChrome.mockClear()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
})

describe('opaqueHex', () => {
  it.each([
    ['rgb(252, 252, 252)', '#fcfcfc'],
    ['rgb(19 19 19)', '#131313'],
    ['rgba(242, 245, 249, 1)', '#f2f5f9'],
    ['color(srgb 0.94902 0.960784 0.976471)', '#f2f5f9'],
    ['color(srgb 1 1 1 / 1)', '#ffffff'],
  ])('reads %s', (color, hex) => {
    expect(opaqueHex(color)).toBe(hex)
  })

  it.each([
    'rgba(0, 0, 0, 0)',
    'rgba(255, 255, 255, 0.5)',
    'color(srgb 1 1 1 / 0.4)',
    'transparent',
  ])('treats %s as nothing painted', (color) => {
    expect(opaqueHex(color)).toBeUndefined()
  })
})

describe('backgroundAt', () => {
  it('walks up from the topmost element to the first opaque background', () => {
    const bar = document.createElement('header')
    bar.style.backgroundColor = 'rgb(245, 245, 246)'
    const region = document.createElement('div')
    region.style.backgroundColor = 'rgba(0, 0, 0, 0)'
    bar.append(region)
    document.body.append(bar)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(region)
    expect(backgroundAt(1200, 2)).toBe('#f5f5f6')
  })
})

describe('readWindowChrome', () => {
  it('takes the caption colour from what is painted under the caption buttons', () => {
    const settingsBar = document.createElement('div')
    settingsBar.style.backgroundColor = 'rgb(245, 245, 246)'
    document.body.append(settingsBar)
    const point = vi.spyOn(document, 'elementFromPoint').mockReturnValue(settingsBar)
    const chrome = readWindowChrome('light')
    expect(point).toHaveBeenCalledWith(window.innerWidth - 2, 2)
    expect(chrome.caption).toBe('#f5f5f6')
    expect(chrome.theme).toBe('light')
    expect(chrome.symbol).toMatch(/^#[0-9a-f]{6}$/)
    expect(chrome.background).toMatch(/^#[0-9a-f]{6}$/)
    // The probe that resolves the tokens leaves nothing behind.
    expect(document.body.children).toHaveLength(1)
  })

  it('falls back to the theme colours when nothing opaque is under the buttons', () => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    expect(readWindowChrome('dark').caption).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('useWindowChrome', () => {
  function Shell(props: { theme: 'light' | 'dark'; surface: string; frame: number }) {
    useWindowChrome(props.theme, props.surface)
    return <div data-frame={props.frame} />
  }

  /** Animation frames run only when the test paints one. */
  function frames() {
    const queue = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queue.set(++next, callback)
      return next
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => void queue.delete(id))
    return {
      paint() {
        const due = [...queue.values()]
        queue.clear()
        for (const callback of due) callback(performance.now())
      },
    }
  }

  it('reports once per change of theme or surface, not per render', () => {
    const frame = frames()
    const bar = document.createElement('div')
    bar.style.backgroundColor = 'rgb(252, 252, 252)'
    document.body.append(bar)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(bar)
    const view = render(<Shell theme="light" surface="chat" frame={0} />)
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(1)
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'light', caption: '#fcfcfc' }),
    )

    // A streamed frame re-renders the app root; nothing changed, nothing is sent.
    for (let index = 1; index <= 50; index++) {
      view.rerender(<Shell theme="light" surface="chat" frame={index} />)
      frame.paint()
    }
    expect(bridge.setChrome).toHaveBeenCalledTimes(1)

    bar.style.backgroundColor = 'rgb(245, 245, 246)'
    view.rerender(<Shell theme="light" surface="settings" frame={51} />)
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(2)
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.objectContaining({ caption: '#f5f5f6' }),
    )

    bar.style.backgroundColor = 'rgb(19, 19, 19)'
    view.rerender(<Shell theme="dark" surface="settings" frame={52} />)
    frame.paint()
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', caption: '#131313' }),
    )
  })

  it('reads the page in the frame that paints a change, never inside the commit', () => {
    const frame = frames()
    const point = vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    const view = render(<Shell theme="light" surface="chat" frame={0} />)
    frame.paint()
    point.mockClear()

    // Opening Settings: the commit must not force style and layout for the caption.
    view.rerender(<Shell theme="light" surface="settings" frame={1} />)
    expect(point).not.toHaveBeenCalled()
    // Closing it again before the frame: only the surface that is painted is read.
    view.rerender(<Shell theme="light" surface="chat" frame={2} />)
    frame.paint()
    expect(point).toHaveBeenCalledTimes(1)
  })
})
