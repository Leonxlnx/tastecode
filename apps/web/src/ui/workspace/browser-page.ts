/** What a Browser tab knows about the page it shows, for its tab label. */
export type BrowserPageInfo = { url: string; title: string }

/** The page title, else its host, else "New tab" for a tab that has loaded nothing. */
export function browserPageLabel(page: BrowserPageInfo | undefined): string {
  const title = page?.title.trim()
  if (title) return title
  if (page?.url) {
    try {
      const host = new URL(page.url).host
      if (host) return host
    } catch {
      // Not a URL the guest would report; fall through.
    }
  }
  return 'New tab'
}
