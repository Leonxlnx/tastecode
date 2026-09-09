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
 * even then, this watchdog reads the main frame's native visibility state at
 * a slow interval and heals a visible-but-hidden mismatch with a hide/show
 * cycle, which re-attaches the compositor without waking renderer JavaScript.
 */

type WatchedWindow = {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  hide(): void
  show(): void
  on?(event: WatchdogWindowEvent, listener: () => void): unknown
  removeListener?(event: WatchdogWindowEvent, listener: () => void): unknown
  webContents: { mainFrame: { readonly visibilityState: string } }
}

type WatchdogWindowEvent = 'focus' | 'blur' | 'show' | 'hide' | 'restore' | 'minimize' | 'closed'

const WATCHDOG_INTERVAL_MS = 15_000

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
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {}

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const lifecycleEvents: WatchdogWindowEvent[] = [
    'focus',
    'blur',
    'show',
    'hide',
    'restore',
    'minimize',
    'closed',
  ]
  const observesWindowState =
    typeof window.on === 'function' && typeof window.removeListener === 'function'
  const eligible = () =>
    !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused()

  const schedule = () => {
    clearTimeout(timer)
    timer = undefined
    if (stopped) return
    // BrowserWindow emits every eligibility change. Leave no timer behind
    // while the app is in the background; older test doubles without events
    // keep a cheap native-state poll, but still never wake their renderer.
    if (!eligible() && observesWindowState) return
    timer = setTimeout(check, intervalMs)
  }

  const check = () => {
    if (stopped) return
    timer = undefined
    if (!eligible()) {
      schedule()
      return
    }
    try {
      const pageVisibility = window.webContents.mainFrame.visibilityState
      if (typeof pageVisibility !== 'string') throw new TypeError('Invalid page visibility')
      if (stopped || !eligible()) return
      const nudge = needsCompositorNudge({
        destroyed: false,
        visible: true,
        minimized: false,
        focused: true,
        pageVisibility,
      })
      if (!nudge) return
      onLog('window visible but page hidden; re-attaching the compositor')
      window.hide()
      window.show()
    } catch {
      // A destroyed frame is handled by Electron's lifecycle.
    } finally {
      schedule()
    }
  }

  const onWindowStateChange = () => schedule()
  if (observesWindowState) {
    for (const event of lifecycleEvents) window.on!(event, onWindowStateChange)
  }
  schedule()

  return () => {
    stopped = true
    clearTimeout(timer)
    timer = undefined
    if (observesWindowState) {
      for (const event of lifecycleEvents) window.removeListener!(event, onWindowStateChange)
    }
  }
}
