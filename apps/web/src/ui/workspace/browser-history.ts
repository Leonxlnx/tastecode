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
// Query parameters that carry sign-in codes, tokens or keys; they never reach storage.
const SECRET_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'id_token',
  'key',
  'sig',
  'signature',
  'auth',
  'session',
  'password',
  'otp',
  'jwt',
])
// Names that carry a secret wherever they appear, as in api_key, refresh_token or X-Amz-Signature.
const SECRET_PARAM_PART =
  /token|secret|passw|signature|credential|api[-_]?key|private[-_]?key|session[-_]?id/
// A removed value this short also turns up in ordinary titles, so a title is not judged by it.
const MIN_SECRET_IN_TITLE = 6

function secretParam(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_PARAMS.has(lower) || SECRET_PARAM_PART.test(lower)
}

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
  const reportedAt = page.href
  // A password, a sign-in code or a token in the address would otherwise sit in storage in
  // plain text. The fragment can carry tokens too (implicit sign-in), so only an app's route
  // in it is kept, without its secrets.
  const removed = [decode(page.username), decode(page.password)]
  for (const [name, value] of new URLSearchParams(page.hash.slice(1)))
    if (secretParam(name)) removed.push(value)
  page.username = ''
  page.password = ''
  page.hash = appRoute(page.hash)
  // A copy: deleting from the live parameters while walking them would skip one.
  for (const [name, value] of Array.from(page.searchParams)) {
    if (!secretParam(name)) continue
    removed.push(value)
    page.searchParams.delete(name)
  }
  const key = pageKey(page)
  const visits = readBrowserHistory()
  const earlier = visits.find((visit) => pageKey(webPage(visit.url)) === key)
  // Chromium names an untitled page after its address, which the row already shows. That
  // is the address before the secrets came out, so the title must not bring them back.
  const reported = title.trim()
  const untitled = [reportedAt, browserVisitAddress(reportedAt), browserVisitAddress(page.href)]
  const ownTitle =
    untitled.includes(reported) ||
    removed.some((value) => value.length >= MIN_SECRET_IN_TITLE && reported.includes(value))
      ? ''
      : reported
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

/**
 * The address a row shows: the page without its scheme, and no bare trailing
 * slash. An app's route stays, since it is the page; an anchor does not.
 */
export function browserVisitAddress(url: string): string {
  const page = webPage(url)
  if (!page) return url
  const path = page.pathname === '/' ? '' : page.pathname
  return `${page.host}${path}${page.search}${appRoute(page.hash)}`
}

/**
 * A fragment that is a single-page app's route, `#/settings` or `#!/inbox`,
 * with its secret parameters taken out. Any other fragment is an anchor or a
 * sign-in response, and becomes empty.
 */
function appRoute(hash: string): string {
  if (!/^#!?\//.test(hash)) return ''
  const queryAt = hash.indexOf('?')
  if (queryAt === -1) return hash
  const query = new URLSearchParams(hash.slice(queryAt + 1))
  for (const [name] of Array.from(query)) if (secretParam(name)) query.delete(name)
  const kept = query.toString()
  return `${hash.slice(0, queryAt)}${kept ? `?${kept}` : ''}`
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function webPage(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** An anchor moves within a page, so it does not make another row; an app's route does. */
function pageKey(page: URL | undefined): string | undefined {
  if (!page) return undefined
  return `${page.origin}${page.pathname}${page.search}${appRoute(page.hash)}`
}
