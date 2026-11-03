// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backgroundAt,
  opaqueHex,
  readWindowChrome,
  SEE_THROUGH_CAPTION,
  useWindowChrome,
} from './window-chrome.js'

const bridge = vi.hoisted(() => ({ setChrome: vi.fn((_chrome: unknown) => Promise.resolve()) }))
vi.mock('./bridge.js', () => ({
  isDesktop: true,
  setDesktopWindowChrome: bridge.setChrome,
}))
const choice = vi.hoisted(() => ({ mode: 'none' }))
vi.mock('./app-background.js', () => ({ readAppBackground: () => ({ mode: choice.mode }) }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  bridge.setChrome.mockClear()
  choice.mode = 'none'
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-app-bg')
  document.documentElement.removeAttribute('data-glass')
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

  it('clears the caption buttons over the see-through title bar of a window background', () => {
    document.documentElement.dataset['appBg'] = 'image'
    const bar = document.createElement('header')
    bar.style.backgroundColor = 'rgba(19, 19, 19, 0.6)'
    document.body.append(bar)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(bar)
    const chrome = readWindowChrome('dark')
    expect(chrome.caption).toBe(SEE_THROUGH_CAPTION)
    // Only the caption: the symbols and the page background stay opaque colours.
    expect(chrome.symbol).toMatch(/^#[0-9a-f]{6}$/)
    expect(chrome.background).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('asks the shell to clear the window only for Transparent', () => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    expect(readWindowChrome('dark')).not.toHaveProperty('seeThrough')
    choice.mode = 'transparent'
    document.documentElement.dataset['appBg'] = 'transparent'
    const chrome = readWindowChrome('dark')
    expect(chrome.seeThrough).toBe(true)
    expect(chrome.caption).toBe(SEE_THROUGH_CAPTION)
    // The opaque page colour still travels, for when Transparent is turned off.
    expect(chrome.background).toMatch(/^#[0-9a-f]{6}$/)
    // A picture or an effect paints its own opaque layer over the window.
    for (const mode of ['image', 'effect']) {
      choice.mode = mode
      document.documentElement.dataset['appBg'] = mode
      expect(readWindowChrome('dark')).not.toHaveProperty('seeThrough')
    }
  })

  it('clears the window behind the dark translucent sidebar, not the light one', () => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    document.documentElement.dataset['glass'] = 'off'
    expect(readWindowChrome('dark')).not.toHaveProperty('seeThrough')
    document.documentElement.dataset['glass'] = 'on'
    // Dark leaves body and .shell__body clear behind the sidebar (app.css).
    expect(readWindowChrome('dark').seeThrough).toBe(true)
    // Light keeps its chrome opaque.
    expect(readWindowChrome('light')).not.toHaveProperty('seeThrough')
  })

  it('keeps a window that opened clear clear before the lazy layer applies', () => {
    // At startup the choice is known before data-app-bg reaches the page.
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    choice.mode = 'transparent'
    expect(readWindowChrome('dark').seeThrough).toBe(true)
  })

  it('keeps the caption opaque where something opaque covers the title bar', () => {
    document.documentElement.dataset['appBg'] = 'effect'
    const settingsBar = document.createElement('div')
    settingsBar.style.backgroundColor = 'rgb(245, 245, 246)'
    document.body.append(settingsBar)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(settingsBar)
    expect(readWindowChrome('light').caption).toBe('#f5f5f6')
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

  it('reports again once the lazily applied window background reaches the page', async () => {
    const frame = frames()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    render(<Shell theme="dark" surface="chat" frame={0} />)
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(1)
    expect(bridge.setChrome).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ caption: SEE_THROUGH_CAPTION }),
    )

    document.documentElement.dataset['appBg'] = 'image'
    // MutationObserver callbacks run as a microtask.
    await Promise.resolve()
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(2)
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', caption: SEE_THROUGH_CAPTION }),
    )

    document.documentElement.removeAttribute('data-app-bg')
    await Promise.resolve()
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(3)
    expect(bridge.setChrome).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ caption: SEE_THROUGH_CAPTION }),
    )
  })

  it('tells the shell when Transparent starts and stops showing the desktop', async () => {
    const frame = frames()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    render(<Shell theme="dark" surface="chat" frame={0} />)
    frame.paint()
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ seeThrough: true }),
    )

    // Settings › Window background › Transparent: the choice is stored, then
    // the layer marks the page.
    choice.mode = 'transparent'
    document.documentElement.dataset['appBg'] = 'transparent'
    await Promise.resolve()
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(2)
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.objectContaining({ seeThrough: true, caption: SEE_THROUGH_CAPTION }),
    )

    // Image keeps the clear caption but paints an opaque layer: the window
    // must turn solid again, so this is a change worth reporting.
    choice.mode = 'image'
    document.documentElement.dataset['appBg'] = 'image'
    await Promise.resolve()
    frame.paint()
    expect(bridge.setChrome).toHaveBeenCalledTimes(3)
    expect(bridge.setChrome).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ seeThrough: true }),
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
