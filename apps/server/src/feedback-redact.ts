/**
 * Redaction for text that leaves the machine as user feedback.
 *
 * The secret patterns mirror the desktop diagnostics scrubber
 * (`apps/desktop/src/local-diagnostics.ts`); the server cannot import desktop
 * code, and feedback needs two things diagnostics does not: a count for the
 * preview, and stripping every file path from text TasteCode attaches on its
 * own. Every replacement is counted so the dialog can say what changed.
 */

const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g
const STANDALONE_SECRET =
  /(?<![A-Za-z0-9_])(?:sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{16,}|sk_live_[0-9A-Za-z]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){2}|fb_[A-Za-z0-9_]{8,})(?![A-Za-z0-9_])/g
const SCHEME_SECRET = /(?<![A-Za-z0-9_])(bearer)(\s+)[^\s[]\S*/gi
const BASIC_AUTH_SECRET = /(?<![A-Za-z0-9_])(authorization\s*[:=]\s*basic\s+)[^\s[]\S*/gi
// One flat prefix class: nested repetition here backtracks exponentially on
// long words such as commit hashes.
const KEYED_SECRET =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*?(?:token|api[_-]?key|password|passwd|secret))(?![A-Za-z0-9_])(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"']+/gi
const URL_CREDENTIAL = /(\b[a-z][\w+.-]*:\/\/[^\s:@/]*:)(?!\[redacted\]@)[^\s@/]+@/gi
/** Long opaque runs that mix letters and digits: session ids, signed blobs. */
const LONG_OPAQUE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g
const WEB_URL = /\bhttps?:\/\/[^\s"'<>()]+/gi
const FILE_URL = /\bfile:\/\/[^\s"'<>]*/gi
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?]*/g
const UNC_PATH = /\\\\[^\s\\"'<>]+\\[^\s"'<>|*?]*/g
const HOME_RELATIVE = /(?<![\w./\\-])~[\\/][^\s"'<>|*?]*/g
// Two or more segments, not the path part of a URL (preceded by a host, ':' or '/').
const POSIX_PATH = /(?<![\w.:/~\\-])\/(?:[^\s/:"'<>|]+\/)+[^\s/:"'<>|]*/g
/** Control characters other than tab and newline. */
const CONTROL = /[^\P{Cc}\t\n]/gu

export const ERROR_EXCERPT_MAX = 1500

export type Redacted = { text: string; redactions: number }

type Counter = { count: number }

function replaceCounted(
  text: string,
  pattern: RegExp,
  counter: Counter,
  replacement: (match: string, ...groups: string[]) => string | undefined,
): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    const groups = rest.filter((value): value is string => typeof value === 'string')
    const next = replacement(match, ...groups)
    if (next === undefined || next === match) return match
    counter.count += 1
    return next
  })
}

function redactSecrets(text: string, counter: Counter): string {
  let next = replaceCounted(text, PRIVATE_KEY, counter, () => '[redacted]')
  next = replaceCounted(next, STANDALONE_SECRET, counter, () => '[redacted]')
  next = replaceCounted(next, URL_CREDENTIAL, counter, (_match, prefix) => `${prefix}[redacted]@`)
  next = replaceCounted(next, BASIC_AUTH_SECRET, counter, (_match, prefix) => `${prefix}[redacted]`)
  next = replaceCounted(
    next,
    SCHEME_SECRET,
    counter,
    (_match, scheme, space) => `${scheme}${space}[redacted]`,
  )
  next = replaceCounted(next, KEYED_SECRET, counter, (_match, key, separator) => {
    return `${key}${separator}[redacted]`
  })
  return replaceCounted(next, LONG_OPAQUE, counter, (match) =>
    /[A-Za-z]/.test(match) && /\d/.test(match) && !/^[0-9a-f-]+$/i.test(match)
      ? '[redacted]'
      : undefined,
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keeps sentence punctuation that a greedy path match swallowed. */
function asPath(match: string): string {
  return `<path>${/[:,.;)\]]+$/.exec(match)?.[0] ?? ''}`
}

/**
 * Matches a known absolute path with either slash style, ignoring case. With
 * `whole`, the match runs on to the end of the path token, so nothing below a
 * workspace survives either.
 */
function pathPattern(value: string, whole: boolean): RegExp | undefined {
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed.length < 3) return undefined
  const source = trimmed
    .split(/[\\/]+/)
    .map(escapeRegExp)
    .join('[\\\\/]+')
  const end = `(?![^\\\\/\\s"'<>|*?):,;\\]])`
  return new RegExp(whole ? `${source}${end}[^\\s"'<>|*?]*` : `${source}${end}`, 'gi')
}

function replaceKnownPaths(
  text: string,
  paths: readonly string[],
  counter: Counter,
  replacement: ((match: string) => string) | undefined,
): string {
  let next = text
  const unique = [...new Set(paths.filter(Boolean))].sort((a, b) => b.length - a.length)
  for (const known of unique) {
    const pattern = pathPattern(known, replacement === undefined)
    if (pattern) next = replaceCounted(next, pattern, counter, replacement ?? asPath)
  }
  return next
}

function finish(text: string, max: number): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length <= max) return cleaned
  const marker = ' ... [truncated]'
  return `${cleaned.slice(0, Math.max(0, max - marker.length)).trimEnd()}${marker}`
}

/**
 * Text TasteCode attaches on its own (an error it showed). No path, query
 * string, email or secret-shaped value survives: the user did not type it,
 * so the "no file path leaves the machine" promise applies in full.
 */
export function redactAttachedText(
  text: string,
  options: { home: string; workspaces: readonly string[]; max?: number },
): Redacted {
  const counter: Counter = { count: 0 }
  let next = redactSecrets(text, counter)
  next = replaceCounted(next, FILE_URL, counter, asPath)
  next = replaceCounted(next, WEB_URL, counter, (url) => {
    const cut = url.search(/[?#]/)
    return cut < 0 ? undefined : `${url.slice(0, cut)}?[redacted]`
  })
  next = replaceKnownPaths(next, [...options.workspaces, options.home], counter, undefined)
  next = replaceCounted(next, HOME_RELATIVE, counter, asPath)
  next = replaceCounted(next, UNC_PATH, counter, asPath)
  next = replaceCounted(next, DRIVE_PATH, counter, asPath)
  next = replaceCounted(next, POSIX_PATH, counter, asPath)
  next = replaceCounted(next, EMAIL, counter, () => '[email]')
  return { text: finish(next, options.max ?? ERROR_EXCERPT_MAX), redactions: counter.count }
}

/**
 * Text the user typed. They see it in the preview, so paths and emails stay
 * as written; only secret-shaped values and the home folder name are removed.
 */
export function redactUserText(text: string, options: { home: string; max: number }): Redacted {
  const counter: Counter = { count: 0 }
  let next = redactSecrets(text, counter)
  next = replaceKnownPaths(next, [options.home], counter, () => '~')
  return { text: finish(next, options.max), redactions: counter.count }
}

/** Short metadata values: secrets and home removed, one line, capped. */
export function redactLabel(text: string, options: { home: string; max: number }): Redacted {
  const redacted = redactUserText(text.replace(/\s+/g, ' '), { home: options.home, max: 4000 })
  return {
    text: redacted.text.length > options.max ? redacted.text.slice(0, options.max) : redacted.text,
    redactions: redacted.redactions,
  }
}
