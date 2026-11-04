import { useEffect, useLayoutEffect, useRef } from 'react'
import { readAppBackground } from './app-background.js'
import { isDesktop, setDesktopWindowChrome, type WindowChrome } from './bridge.js'

type Theme = WindowChrome['theme']

/** Used only when the page cannot be read, e.g. before the stylesheet applies. */
const FALLBACK = {
  light: { background: '#fdfdfd', caption: '#fcfcfc', symbol: '#27272a' },
  dark: { background: '#0f0f0f', caption: '#131313', symbol: '#f4f4f5' },
} satisfies Record<Theme, Omit<WindowChrome, 'theme'>>

/**
 * The caption colour while a window background is on: fully transparent, so
 * the native caption buttons show the page's see-through title bar (and the
 * background behind it) instead of an opaque box.
 */
export const SEE_THROUGH_CAPTION = '#00000000'

const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i
const SRGB =
  /^color\(\s*srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i

/**
 * #rrggbb for an opaque computed CSS colour, undefined for a transparent or
 * translucent one. Computed styles serialize as rgb()/rgba(), or color(srgb …)
 * for an sRGB color-mix(); anything else goes through a 1px canvas.
 */
export function opaqueHex(color: string): string | undefined {
  const value = color.trim()
  const rgb = RGB.exec(value)
  if (rgb) {
    if (!opaque(rgb[4])) return undefined
    return hex([rgb[1], rgb[2], rgb[3]].map(Number))
  }
  const srgb = SRGB.exec(value)
  if (srgb) {
    if (!opaque(srgb[4])) return undefined
    return hex([srgb[1], srgb[2], srgb[3]].map((channel) => Number(channel) * 255))
  }
  return canvasHex(value)
}

function opaque(alpha: string | undefined): boolean {
  if (alpha === undefined) return true
  const value = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)
  return value >= 0.999
}

function hex(channels: number[]): string {
  return `#${channels
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function canvasHex(color: string): string | undefined {
  if (!color || color === 'transparent') return undefined
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data
    return alpha === 255 ? hex([red, green, blue]) : undefined
  } catch {
    return undefined
  }
}

/** The colour painted at a viewport point: the first opaque background from the topmost element up. */
export function backgroundAt(x: number, y: number): string | undefined {
  let element = document.elementFromPoint(x, y)
  while (element) {
    const color = opaqueHex(getComputedStyle(element).backgroundColor)
    if (color) return color
    element = element.parentElement
  }
  return undefined
}

/**
 * What native chrome must match right now: the background under the caption
 * buttons (top right), the title-bar symbol colour and the page background,
 * and whether the page shows what is behind the window.
 */
export function readWindowChrome(theme: Theme): WindowChrome {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'color:var(--titlebar-symbol,var(--text));background-color:var(--bg);' +
    'border-top:0 solid var(--bg-rail)'
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const symbol = opaqueHex(style.color)
  const background = opaqueHex(style.backgroundColor)
  const rail = opaqueHex(style.borderTopColor)
  probe.remove()
  const fallback = FALLBACK[theme]
  // With a window background (app-background.css) nothing under the buttons
  // is opaque unless something covers the title bar, as Settings does.
  const appBackground = document.documentElement.dataset['appBg']
  const chrome: WindowChrome = {
    theme,
    background: background ?? fallback.background,
    caption:
      backgroundAt(window.innerWidth - 2, 2) ??
      (appBackground !== undefined ? SEE_THROUGH_CAPTION : (rail ?? fallback.caption)),
    symbol: symbol ?? fallback.symbol,
  }
  // Only Transparent leaves the page itself see-through; a picture or an
  // effect paints its own opaque layer, so the window behind it stays solid.
  // Read from the choice rather than data-app-bg, which arrives with a lazy
  // chunk: at startup the first report would otherwise turn a window that
  // opened clear solid for a moment. The shell clears it only where the OS
  // draws a material, and the page stays opaque until the layer applies.
  //
  // The translucent sidebar (data-glass) keeps an opaque window colour: clearing it let
  // the OS material (light on Windows 11) wash the dark sidebar grey with Window
  // background set to None (Leon, 2026-11-04). Only Transparent shows the desktop.
  if (readAppBackground().mode === 'transparent') chrome.seeThrough = true
  return chrome
}

/**
 * Keeps the desktop caption buttons on the colour the page paints under them.
 * Runs when the theme or `surface` (a key for whatever decides what sits under
 * the title bar) changes, never per render. Must be called after the hooks
 * that apply the theme, accent, backdrop and glass to the document.
 *
 * The page is read once, in the animation frame that paints the change, so
 * the caption still turns with the page. Reading inside the commit as well
 * forced a style and layout pass there (about 30 ms when Settings opens) that
 * the frame then recalculated after the probe and the effects touched the
 * document again.
 *
 * A window background is applied by a lazily loaded layer, after the render
 * that chose it, so its root attribute is watched as well.
 */
export function useWindowChrome(theme: Theme, surface: string): void {
  const sent = useRef<string | undefined>(undefined)
  const current = useRef<Theme>(theme)
  useLayoutEffect(() => {
    current.current = theme
    if (!isDesktop) return
    const frame = requestAnimationFrame(() => reportWindowChrome(theme, sent))
    return () => cancelAnimationFrame(frame)
  }, [theme, surface])
  useEffect(() => {
    if (!isDesktop || typeof MutationObserver === 'undefined') return
    let frame: number | undefined
    const observer = new MutationObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        reportWindowChrome(current.current, sent)
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      // The sidebar glass turning on or off changes whether the window is see-through.
      attributeFilter: ['data-app-bg', 'data-glass'],
    })
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [])
}

function reportWindowChrome(theme: Theme, sent: { current: string | undefined }): void {
  const chrome = readWindowChrome(theme)
  const key = JSON.stringify(chrome)
  if (key === sent.current) return
  sent.current = key
  void setDesktopWindowChrome(chrome).catch(() => {
    if (sent.current === key) sent.current = undefined
  })
}
