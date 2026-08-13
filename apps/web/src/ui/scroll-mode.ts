/**
 * How the thread behaves while output arrives.
 *
 * Two modes are not enough. Following the bottom is right for short answers,
 * but a long one then scrolls past faster than anyone reads. What you actually
 * want there is the *start* of the new turn pinned near the top, so the answer
 * fills downward and you read it in order.
 *
 * Borrowed in shape from T3 Code's timeline, which arrived at the same three.
 */
export type ScrollMode =
  /** Newest output stays in view. */
  | 'follow-end'
  /** Top of the current turn is pinned; the answer grows downward. */
  | 'anchor-turn'
  /** The user took over. Nothing moves on its own. */
  | 'free'

/** Distance from the bottom, in px, still counted as "at the bottom". */
export const AT_BOTTOM_SLACK = 80

export function isAtBottom(el: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK
}

/**
 * Which mode a newly started turn should use.
 *
 * If the user is at the bottom when a turn begins, anchor its start — that is
 * the reading position they asked for by being there. If they had scrolled
 * away, leave them alone.
 */
export function modeForNewTurn(userAtBottom: boolean): ScrollMode {
  return userAtBottom ? 'anchor-turn' : 'free'
}

export function activeTurnAnchor(
  items: ReadonlyArray<{
    id: string
    turnId: string
    type: string
    role?: string | undefined
  }>,
  activeTurnId: string | undefined,
): { id: string; index: number } | undefined {
  if (!activeTurnId) return undefined

  const durableIndex = items.findIndex((item) => item.turnId === activeTurnId)
  if (durableIndex >= 0) {
    const item = items[durableIndex]
    return item ? { id: item.id, index: durableIndex } : undefined
  }

  // A local send starts rendering before the provider assigns its durable
  // turn id. Track the optimistic user item by its stable submission id so
  // that local -> durable reconciliation is not mistaken for another turn.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.turnId === '' && item.type === 'message' && item.role === 'user') {
      return { id: item.id, index }
    }
  }

  return undefined
}

/**
 * A turn that outgrows the viewport can no longer be read from its start, so
 * anchoring stops being useful and following the output is better.
 */
export function shouldReleaseAnchor(turnHeight: number, viewportHeight: number): boolean {
  return turnHeight > viewportHeight
}
