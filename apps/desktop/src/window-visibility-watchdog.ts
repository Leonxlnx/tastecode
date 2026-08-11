/**
 * Windows' compositor can wrongly conclude the main window is invisible and
 * stop painting it: the window sits on screen showing only its background
 * colour while the page keeps running with document.visibilityState 'hidden'.
 * Diagnosed over CDP against a live black window — DOM complete, renderer
 * healthy, focus true, paint off. It is intermittent, which is why it read as
 * "the app worked a moment ago and went black".
 *
 * Two defences. The occlusion tracker that causes most of it is switched off
 * in main.ts (CalculateNativeWinOcclusion). And because the state was observed
 * even then, this watchdog asks the page what it believes at a slow interval
 * and heals a visible-but-hidden mismatch with a hide/show cycle, which
 * re-attaches the compositor.
 */

type WatchedWindow = {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  hide(): void
  show(): void
  webContents: { executeJavaScript(code: string): Promise<unknown> }
}

export const WATCHDOG_INTERVAL_MS = 15_000

/** Decides whether a heal is needed; pure so the policy is testable. */
export function needsCompositorNudge(state: {
  destroyed: boolean
  visible: boolean
  minimized: boolean
  focused: boolean
  pageVisibility: string
}): boolean {
  return (
    !state.destroyed &&
    state.visible &&
    !state.minimized &&
    state.focused &&
    state.pageVisibility === 'hidden'
  )
}

export function startVisibilityWatchdog(
  window: WatchedWindow,
  onLog: (line: string) => void,
  intervalMs = WATCHDOG_INTERVAL_MS,
): () => void {
  let stopped = false
  const timer = setInterval(() => {
    void (async () => {
      if (stopped || window.isDestroyed()) return
      let pageVisibility: string
      try {
        pageVisibility = (await window.webContents.executeJavaScript(
          'document.visibilityState',
        )) as string
      } catch {
        return
      }
      if (stopped || window.isDestroyed()) return
      const nudge = needsCompositorNudge({
        destroyed: false,
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        focused: window.isFocused(),
        pageVisibility,
      })
      if (!nudge) return
      onLog('window visible but page hidden; re-attaching the compositor')
      window.hide()
      window.show()
    })()
  }, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
