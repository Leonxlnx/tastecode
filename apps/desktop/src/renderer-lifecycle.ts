import type { WebContents } from 'electron'

export function configureRendererLifecycle(
  contents: Pick<WebContents, 'on' | 'reload' | 'isDestroyed'>,
  options: {
    cancelCaptures: () => void
    /** The page was replaced, so state tied to the old page's listeners is stale. */
    onPageReplaced: () => void
    isQuitting: () => boolean
    onRepeatedCrash: () => void
  },
): void {
  let recovered = false
  // Not did-start-navigation: Electron emits it before will-navigate gets to
  // block a same-window link, and a blocked navigation leaves the old page
  // loaded. did-navigate fires only for a committed main-frame document,
  // reloads included.
  contents.on('did-navigate', () => {
    options.cancelCaptures()
    options.onPageReplaced()
  })
  contents.on('destroyed', options.cancelCaptures)
  contents.on('render-process-gone', () => {
    options.cancelCaptures()
    if (options.isQuitting() || contents.isDestroyed()) return
    // Only one automatic retry per window. A broken preload or startup route
    // must not keep restarting the renderer without the user's consent.
    if (recovered) {
      options.onRepeatedCrash()
      return
    }
    recovered = true
    contents.reload()
  })
}
