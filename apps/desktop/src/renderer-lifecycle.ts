import type { WebContents } from 'electron'

export function configureRendererLifecycle(
  contents: Pick<WebContents, 'on' | 'reload' | 'isDestroyed'>,
  options: {
    cancelCaptures: () => void
    isQuitting: () => boolean
    onRepeatedCrash: () => void
  },
): void {
  let recovered = false
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) options.cancelCaptures()
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
