import type { WebContents } from 'electron'

export function configurePreviewNavigation(
  contents: Pick<WebContents, 'on'>,
  previewUrl: string,
): void {
  contents.on('will-navigate', (event, url) => {
    if (!allowsPreviewNavigation(previewUrl, url)) event.preventDefault()
  })
  contents.on('will-redirect', (details) => {
    if (details.isMainFrame && !allowsPreviewNavigation(previewUrl, details.url))
      details.preventDefault()
  })
}

export function allowsPreviewNavigation(previewUrl: string, navigationUrl: string): boolean {
  // A throw here would skip preventDefault in the navigation handler — deny.
  try {
    return new URL(navigationUrl).origin === new URL(previewUrl).origin
  } catch {
    return false
  }
}
