type ApplicationPresence = {
  setActivationPolicy: (policy: 'regular' | 'accessory' | 'prohibited') => void
}

type WindowPresence = {
  setFocusable: (focusable: boolean) => void
  setHiddenInMissionControl: (hidden: boolean) => void
  setMovable: (movable: boolean) => void
  setSkipTaskbar: (skip: boolean) => void
}

type ApplicationPresentation = ApplicationPresence & {
  focus: () => void
}

type WindowPresentation = WindowPresence & {
  focus: () => void
  isMinimized: () => boolean
  restore: () => void
  show: () => void
}

/** Reassert the main window's ordinary desktop-app behavior whenever the OS
 *  activates or presents it, so a transient hidden or inert state cannot persist. */
export function restoreMainWindowPresence(
  platform: NodeJS.Platform,
  application: ApplicationPresence,
  window: WindowPresence,
): void {
  if (platform === 'darwin') {
    application.setActivationPolicy('regular')
    window.setHiddenInMissionControl(false)
  }
  if (platform === 'darwin' || platform === 'win32') window.setSkipTaskbar(false)
  window.setFocusable(true)
  window.setMovable(true)
}

/** Present the existing main window in response to an explicit user action. */
export function presentMainWindow(
  platform: NodeJS.Platform,
  application: ApplicationPresentation,
  window: WindowPresentation,
): void {
  restoreMainWindowPresence(platform, application, window)
  if (window.isMinimized()) window.restore()
  window.show()
  application.focus()
  window.focus()
}
