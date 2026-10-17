import { useCallback, useEffect, useRef, useState } from 'react'
import type { CheckoutPullRequest, CheckoutPullRequestResult } from '@harness/contracts'
import type { Transport } from '../../transport.js'

/** Recently seen checkouts, so switching back to a chat shows its chip at once. */
const KNOWN_LIMIT = 32

type Listener = (key: string, result: CheckoutPullRequestResult) => void
const listeners = new Set<Listener>()

/**
 * Share a fresh lookup with every header chip, so a pull request the Review
 * tab just opened, or a push that restarted its checks, shows at once.
 */
export function publishCheckoutPullRequest(
  projectPath: string,
  sessionId: string | undefined,
  result: CheckoutPullRequestResult,
): void {
  const key = checkoutKey(projectPath, checkoutThreadId(sessionId))
  for (const listener of listeners) listener(key, result)
}

/** A chat that has not started yet works in the project folder. */
function checkoutThreadId(sessionId: string | undefined): string | undefined {
  return sessionId?.startsWith('pending:') ? undefined : sessionId
}

/**
 * The pull request whose head is the chat's checkout branch, for the header.
 *
 * Asks the server when the chat or project changes, when the chat surface
 * comes back, when the chat's turn ends (the agent may have pushed or opened
 * one) and when the connection reopens. Never on deltas, never on a timer:
 * the server keeps a short cache and drops it when a turn ends there.
 * A server without `pullRequests.forCheckout` answers an error; that reads as
 * no pull request.
 */
export function useCheckoutPullRequest(
  transport: Transport,
  projectPath: string | undefined,
  sessionId: string | undefined,
  running: boolean,
  enabled: boolean,
): CheckoutPullRequest | undefined {
  const threadId = checkoutThreadId(sessionId)
  const key = projectPath === undefined ? undefined : checkoutKey(projectPath, threadId)
  const [known, setKnown] = useState<ReadonlyMap<string, CheckoutPullRequestResult>>(
    () => new Map(),
  )
  const sequence = useRef(new Map<string, number>())

  useEffect(() => {
    const listener: Listener = (publishedKey, result) => {
      // A request already on its way read GitHub before this answer did.
      sequence.current.set(publishedKey, (sequence.current.get(publishedKey) ?? 0) + 1)
      setKnown((current) => remember(current, publishedKey, result))
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const load = useCallback(() => {
    if (projectPath === undefined) return
    const loadKey = checkoutKey(projectPath, threadId)
    const id = (sequence.current.get(loadKey) ?? 0) + 1
    sequence.current.set(loadKey, id)
    transport
      .request('pullRequests.forCheckout', { projectPath, ...(threadId ? { threadId } : {}) })
      .then(
        (result) => {
          // An older request for the same checkout must not replace a newer answer.
          if (sequence.current.get(loadKey) !== id) return
          setKnown((current) => remember(current, loadKey, result))
        },
        () => {},
      )
  }, [projectPath, threadId, transport])

  // Latched on what changed, so a re-render can never ask again by itself.
  const last = useRef<{ load: typeof load; enabled: boolean; running: boolean }>(undefined)
  useEffect(() => {
    const before = last.current
    last.current = { load, enabled, running }
    if (!enabled) return
    const shown = !before || before.load !== load || !before.enabled
    const turnEnded = before?.running === true && !running
    if (shown || turnEnded) load()
  }, [enabled, load, running])

  useEffect(() => {
    if (!enabled) return
    return transport.onState((state) => {
      if (state === 'open') load()
    })
  }, [enabled, load, transport])

  const result = key === undefined ? undefined : known.get(key)
  return result?.available ? result.pullRequest : undefined
}

function checkoutKey(projectPath: string, threadId: string | undefined): string {
  return `${projectPath}\u0000${threadId ?? ''}`
}

function remember(
  current: ReadonlyMap<string, CheckoutPullRequestResult>,
  key: string,
  result: CheckoutPullRequestResult,
): ReadonlyMap<string, CheckoutPullRequestResult> {
  const next = new Map(current)
  next.delete(key)
  next.set(key, result)
  for (const oldest of next.keys()) {
    if (next.size <= KNOWN_LIMIT) break
    next.delete(oldest)
  }
  return next
}
