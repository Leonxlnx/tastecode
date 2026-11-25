import { preloadWhenIdle } from './idle-preload.js'

/**
 * Loads the monospace face (--font-mono) in an idle moment. The browser fetches
 * a web font only when text set in it is first laid out; for the transcript
 * that was the commit of the first chat opened, so the font arrived after the
 * rows were measured and every row was laid out again before the first paint.
 * Loaded ahead, the first layout already uses it. Only faces covering Latin
 * text load (the text argument of FontFaceSet.load defaults to a space); other
 * scripts still load when they appear. A failed load is dropped: the font then
 * loads on first use, as before.
 */
export function preloadMonospaceFont(): () => void {
  return preloadWhenIdle(async () => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts || typeof fonts.load !== 'function') return
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
    if (family) await fonts.load(`1em ${family}`)
  })
}
