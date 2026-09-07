import { Menu, nativeImage, Tray } from 'electron'

export function tryCreateBackgroundTray(options: {
  appName: string
  iconPath: string
  onOpen: () => void
  onQuit: () => void
  onUnavailable: (error: unknown) => void
}): Tray | undefined {
  let tray: Tray | undefined
  try {
    // An empty icon renders no recovery surface, the same failure as no host:
    // report it instead of hiding the window with nothing to bring it back.
    const icon = nativeImage.createFromPath(options.iconPath).resize({ width: 20, height: 20 })
    if (icon.isEmpty()) {
      throw new Error(
        `System tray icon missing or unreadable at ${options.iconPath}: reinstall ${options.appName} to restore the tray icon.`,
      )
    }
    tray = new Tray(icon)
    tray.setToolTip(options.appName)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${options.appName}`, click: options.onOpen },
        { type: 'separator' },
        { label: `Quit ${options.appName}`, click: options.onQuit },
      ]),
    )
    tray.on('click', options.onOpen)
    return tray
  } catch (error) {
    tray?.destroy()
    options.onUnavailable(error)
    return undefined
  }
}
