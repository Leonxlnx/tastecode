import { Menu, type BrowserWindow, type WebContents } from 'electron'

export function configureImageContextMenu(contents: WebContents, window: BrowserWindow): void {
  contents.on('context-menu', (_event, params) => {
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
