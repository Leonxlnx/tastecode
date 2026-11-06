import { z } from 'zod'

/**
 * The pages the user opened in Browser tabs, newest first, for the Recently
 * used list on a new tab. It stays on this device, in the renderer's storage,
 * and works the same whichever provider a chat uses. Losing it only empties
 * the list.
 */
export type BrowserVisit = { url: string; title: string; visitedAt: number }

const BROWSER_HISTORY_KEY = 'harness.browserHistory'
const BROWSER_HISTORY_LIMIT = 50
// Some pages keep their whole document in the URL; that is not worth a slot.
const MAX_URL_LENGTH = 2_048
const MAX_TITLE_LENGTH = 300

const BrowserHistorySchema = z.array(
  z.object({ url: z.string(), title: z.string(), visitedAt: z.number() }),
)

const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cachedVisits: readonly BrowserVisit[] = []

function storedHistory(): string | null {
  try {
    return localStorage.getItem(BROWSER_HISTORY_KEY)
  } catch {
    return null
  }
}

function parseHistory(raw: string | null): readonly BrowserVisit[] {
  if (raw === null) return []
  try {
    const saved = BrowserHistorySchema.safeParse(JSON.parse(raw))
    return saved.success ? saved.data.filter(({ url }) => webPage(url)) : []
  } catch {
    return []
  }
}

/** Keeps its identity until the stored list changes, for useSyncExternalStore. */
export function readBrowserHistory(): readonly BrowserVisit[] {
  const raw = storedHistory()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedVisits = parseHistory(raw)
  }
  return cachedVisits
}

/** Another window writing the same storage arrives as a storage event. */
export function subscribeBrowserHistory(onChange: () => void): () => void {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * Puts a page at the top of the list. A later page in the same document, or the
 * same page again, moves its row instead of adding one; a title that is not
 * known yet keeps the one already saved.
 */
export function rememberBrowserVisit(url: string, title: string, now = Date.now()): void {
  const page = webPage(url)
  if (!page || page.href.length > MAX_URL_LENGTH) return
  // A password in the address would otherwise sit in storage in plain text.
  page.username = ''
  page.password = ''
  const key = pageKey(page)
  const visits = readBrowserHistory()
  const earlier = visits.find((visit) => pageKey(webPage(visit.url)) === key)
  // Chromium names an untitled page after its address, which the row already shows.
  const reported = title.trim()
  const ownTitle = reported === browserVisitAddress(page.href) ? '' : reported
  const visit: BrowserVisit = {
    url: page.href,
    title: ownTitle.slice(0, MAX_TITLE_LENGTH) || (earlier?.title ?? ''),
    visitedAt: now,
  }
  const next = [visit, ...visits.filter((other) => other !== earlier)]
  try {
    localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(next.slice(0, BROWSER_HISTORY_LIMIT)))
  } catch {
    // Storage is blocked or full: the page still opened, it only goes unlisted.
    return
  }
  for (const listener of listeners) listener()
}

/** The address a row shows: the page without its scheme, and no bare trailing slash. */
export function browserVisitAddress(url: string): string {
  const page = webPage(url)
  if (!page) return url
  const path = page.pathname === '/' ? '' : page.pathname
  return `${page.host}${path}${page.search}`
}

function webPage(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** A fragment moves within a page, so it does not make another row. */
function pageKey(page: URL | undefined): string | undefined {
  if (!page) return undefined
  return `${page.origin}${page.pathname}${page.search}`
}
