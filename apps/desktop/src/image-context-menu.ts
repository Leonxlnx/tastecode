import { clipboard, Menu, shell, type BrowserWindow, type WebContents } from 'electron'

export function configureImageContextMenu(contents: WebContents, window: BrowserWindow): void {
  contents.on('context-menu', (_event, params) => {
    if (params.linkURL) {
      const url = params.linkURL
      const canOpen = /^https?:\/\//i.test(url)
      Menu.buildFromTemplate([
        {
          label: 'Open',
          enabled: canOpen,
          click: () => {
            if (canOpen) void shell.openExternal(url).catch(() => {})
          },
        },
        { type: 'separator' },
        { label: 'Copy Link', click: () => clipboard.writeText(url) },
      ]).popup({ window })
      return
    }

    if (params.mediaType !== 'image' || !params.hasImageContents) return

    Menu.buildFromTemplate([
      {
        label: 'Copy Image',
        click: () => {
          if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y)
        },
      },
    ]).popup({ window })
  })
}
