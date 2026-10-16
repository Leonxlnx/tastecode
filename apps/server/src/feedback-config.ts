import { readFileSync } from 'node:fs'
import { configFile } from './product-paths.js'

/**
 * Where user feedback goes. The key is a Trecko public submit key: it can
 * only add entries to one team's inbox, but it still must never reach git,
 * logs, the renderer or a child process.
 */
export type FeedbackEndpoint = { readonly url: string; readonly key: string }

/** What the server learned at startup. `invalid` means a value was present but unusable. */
export type FeedbackConfig = { endpoint?: FeedbackEndpoint; invalid?: boolean }

export const FEEDBACK_URL_ENV = 'TASTECODE_FEEDBACK_URL'
export const FEEDBACK_KEY_ENV = 'TASTECODE_FEEDBACK_KEY'
/** A packaged build passes the path of its generated endpoint file here. */
export const FEEDBACK_CONFIG_ENV = 'TASTECODE_FEEDBACK_CONFIG'
/** Leon's local file, also used by `pnpm dev`. */
export const FEEDBACK_CONFIG_FILE = 'trecko-feedback.env'

const KEY_PATTERN = /^fb_[A-Za-z0-9_]{8,96}$/
const MAX_CONFIG_BYTES = 4096

type RawEndpoint = { url?: string | undefined; key?: string | undefined }

/**
 * Reads the endpoint once at startup and removes every feedback variable from
 * the environment. Agent CLIs, terminals and git all inherit the server's
 * environment, so a key left there could be printed into a chat by `env`.
 */
export function takeFeedbackConfig(
  env: NodeJS.ProcessEnv,
  readText: (file: string) => string | undefined = readSmallFile,
): FeedbackConfig {
  const fromEnv: RawEndpoint = { url: env[FEEDBACK_URL_ENV], key: env[FEEDBACK_KEY_ENV] }
  const packagedFile = env[FEEDBACK_CONFIG_ENV]
  delete env[FEEDBACK_URL_ENV]
  delete env[FEEDBACK_KEY_ENV]
  delete env[FEEDBACK_CONFIG_ENV]

  const candidates: Array<() => RawEndpoint | undefined> = [
    () => (fromEnv.url || fromEnv.key ? fromEnv : undefined),
    () => (packagedFile ? parseEndpointFile(readText(packagedFile)) : undefined),
    () => parseEndpointFile(readText(configFile(FEEDBACK_CONFIG_FILE))),
  ]
  for (const candidate of candidates) {
    const raw = candidate()
    if (!raw || (!raw.url && !raw.key)) continue
    const endpoint = validateFeedbackEndpoint(raw)
    return endpoint ? { endpoint } : { invalid: true }
  }
  return {}
}

/** `KEY=VALUE` lines; `#` comments and surrounding quotes are allowed. */
export function parseEndpointFile(text: string | undefined): RawEndpoint | undefined {
  if (!text) return undefined
  const values: RawEndpoint = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = unquote(match[2] ?? '')
    if (match[1] === FEEDBACK_URL_ENV) values.url = value
    if (match[1] === FEEDBACK_KEY_ENV) values.key = value
  }
  return values
}

export function validateFeedbackEndpoint(raw: RawEndpoint): FeedbackEndpoint | undefined {
  const key = raw.key?.trim()
  const url = raw.url?.trim()
  if (!key || !url || !KEY_PATTERN.test(key)) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return undefined
  if (parsed.username || parsed.password) return undefined
  return { url: parsed.toString(), key }
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '')
}

function readSmallFile(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > MAX_CONFIG_BYTES ? undefined : text
  } catch {
    return undefined
  }
}
