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
    const icon = nativeImage.createFromPath(options.iconPath).resize({ width: 20, height: 20 })
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
