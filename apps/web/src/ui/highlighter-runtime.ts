import type { CodeHighlighterPlugin, HighlightOptions } from 'streamdown'
import {
  COMMON_LANGUAGES,
  HIGHLIGHT_QUEUE_CHARACTER_LIMIT,
  HIGHLIGHT_QUEUE_ENTRY_LIMIT,
  MAX_HIGHLIGHT_CHARACTERS,
  plainHighlight,
} from './highlighter-config.js'
import type {
  HighlighterRequest,
  HighlighterResponse,
  HighlightResult,
} from './highlighter-protocol.js'

export type HighlighterRuntime = {
  dispose: () => void
  highlight: CodeHighlighterPlugin['highlight']
}

type HighlightCallback = NonNullable<Parameters<CodeHighlighterPlugin['highlight']>[1]>
type PendingHighlight = {
  callbacks: Set<HighlightCallback>
  codeCharacters: number
  key: string
}
type CacheEntry = {
  codeCharacters: number
  result: HighlightResult
  tokenCount: number
}

export { MAX_HIGHLIGHT_CHARACTERS } from './highlighter-config.js'
const CACHE_CHARACTER_LIMIT = 256 * 1024
const CACHE_ENTRY_LIMIT = 16
const CACHE_TOKEN_LIMIT = 64 * 1024
const WORKER_IDLE_MS = 30_000
const LANGUAGE = /^[a-z0-9_+.#-]{1,64}$/u

/**
 * Keeps Shiki's regex engine, grammar work, and retained grammar memory outside
 * the renderer. Very large blocks stay plain instead of spending seconds on
 * decorative colour parsing.
 */
export async function createHighlighterRuntime(
  initialLanguages: readonly string[] = COMMON_LANGUAGES,
): Promise<HighlighterRuntime> {
  let worker: Worker | undefined
  let workerIdleTimer: ReturnType<typeof setTimeout> | undefined
  let nextRequestId = 1
  let cacheCharacters = 0
  let cacheTokens = 0
  let pendingCharacters = 0
  const cache = new Map<string, CacheEntry>()
  const outstanding = new Set<number>()
  const pendingById = new Map<number, PendingHighlight>()
  const pendingByKey = new Map<string, PendingHighlight>()
  const queuedRequests: HighlighterRequest[] = []

  const stopWorker = () => {
    if (workerIdleTimer !== undefined) clearTimeout(workerIdleTimer)
    workerIdleTimer = undefined
    worker?.terminate()
    worker = undefined
    outstanding.clear()
    pendingById.clear()
    pendingByKey.clear()
    queuedRequests.length = 0
    pendingCharacters = 0
  }

  const scheduleWorkerStop = () => {
    if (workerIdleTimer !== undefined) clearTimeout(workerIdleTimer)
    workerIdleTimer = setTimeout(() => {
      if (outstanding.size > 0 || queuedRequests.length > 0) scheduleWorkerStop()
      else stopWorker()
    }, WORKER_IDLE_MS)
  }

  const remember = (key: string, codeCharacters: number, result: HighlightResult) => {
    const tokenCount = countTokens(result)
    if (codeCharacters > CACHE_CHARACTER_LIMIT || tokenCount > CACHE_TOKEN_LIMIT) return
    const previous = cache.get(key)
    if (previous) {
      cacheCharacters -= previous.codeCharacters
      cacheTokens -= previous.tokenCount
      cache.delete(key)
    }
    cache.set(key, { codeCharacters, result, tokenCount })
    cacheCharacters += codeCharacters
    cacheTokens += tokenCount
    while (
      cache.size > CACHE_ENTRY_LIMIT ||
      cacheCharacters > CACHE_CHARACTER_LIMIT ||
      cacheTokens > CACHE_TOKEN_LIMIT
    ) {
      const oldestKey = cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      const oldest = cache.get(oldestKey)
      cache.delete(oldestKey)
      if (oldest) {
        cacheCharacters -= oldest.codeCharacters
        cacheTokens -= oldest.tokenCount
      }
    }
  }

  const readCache = (key: string): HighlightResult | undefined => {
    const entry = cache.get(key)
    if (!entry) return undefined
    cache.delete(key)
    cache.set(key, entry)
    return entry.result
  }

  const handleResponse = (response: HighlighterResponse) => {
    outstanding.delete(response.id)
    const pending = pendingById.get(response.id)
    if (pending) {
      pendingById.delete(response.id)
      pendingByKey.delete(pending.key)
      pendingCharacters -= pending.codeCharacters
      if (response.type === 'highlighted' && response.result) {
        remember(pending.key, pending.codeCharacters, response.result)
        for (const callback of pending.callbacks) callback(response.result)
      }
    }
    dispatchNext()
    scheduleWorkerStop()
  }

  const ensureWorker = (): Worker | undefined => {
    if (worker) return worker
    if (typeof Worker === 'undefined') return undefined
    worker = new Worker(new URL('./highlighter.worker.js', import.meta.url), {
      type: 'module',
      name: 'harness-highlighter',
    })
    worker.onmessage = (event: MessageEvent<HighlighterResponse>) => handleResponse(event.data)
    worker.onerror = stopWorker
    return worker
  }

  const dispatchNext = () => {
    if (outstanding.size > 0) return
    const request = queuedRequests.shift()
    if (!request) return
    const target = ensureWorker()
    if (!target) {
      stopWorker()
      return
    }
    try {
      outstanding.add(request.id)
      target.postMessage(request)
    } catch {
      stopWorker()
    }
  }

  const send = (request: HighlighterRequest): boolean => {
    if (!ensureWorker()) return false
    queuedRequests.push(request)
    dispatchNext()
    scheduleWorkerStop()
    return true
  }

  const warm = initialLanguages.filter((language) => LANGUAGE.test(language))
  if (warm.length > 0) {
    const id = nextRequestId++
    send({ type: 'warm', id, languages: warm })
  }

  return {
    dispose() {
      stopWorker()
      cache.clear()
      cacheCharacters = 0
      cacheTokens = 0
    },
    highlight(options: HighlightOptions, callback?: HighlightCallback) {
      const language = String(options.language ?? '').toLowerCase()
      if (!LANGUAGE.test(language) || options.code.length > MAX_HIGHLIGHT_CHARACTERS) {
        return plainHighlight(options.code)
      }

      const key = `${language}\0${options.code}`
      const cached = readCache(key)
      if (cached) return cached
      if (!callback) return plainHighlight(options.code)

      const active = pendingByKey.get(key)
      if (active) active.callbacks.add(callback)
      else {
        if (
          pendingByKey.size >= HIGHLIGHT_QUEUE_ENTRY_LIMIT ||
          pendingCharacters + options.code.length > HIGHLIGHT_QUEUE_CHARACTER_LIMIT
        ) {
          return plainHighlight(options.code)
        }
        const id = nextRequestId++
        const pending = {
          callbacks: new Set([callback]),
          codeCharacters: options.code.length,
          key,
        }
        pendingByKey.set(key, pending)
        pendingById.set(id, pending)
        pendingCharacters += options.code.length
        if (!send({ type: 'highlight', id, code: options.code, language })) {
          pendingByKey.delete(key)
          pendingById.delete(id)
          pendingCharacters -= options.code.length
        }
      }
      return plainHighlight(options.code)
    },
  }
}

function countTokens(result: HighlightResult): number {
  let count = 0
  for (const line of result.tokens) count += line.length
  return count
}
