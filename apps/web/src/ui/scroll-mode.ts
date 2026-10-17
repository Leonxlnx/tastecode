/**
 * How the thread behaves while output arrives.
 *
 * Following the bottom is right for short answers, but a new turn should not
 * scroll at all while its answer still fits on the screen. A turn that starts
 * at the end therefore pins its prompt near the top of the viewport, the
 * answer fills the room below it without anything moving, and only once the
 * answer reaches the bottom does the follow glide after it. The pin is part
 * of following the end (see turnRoom), not a mode of its own.
 *
 * Borrowed in shape from T3 Code's timeline, and from ChatGPT and Claude.ai
 * for the pinned prompt.
 */
export type ScrollMode =
  /** Newest output stays in view. */
  | 'follow-end'
  /** The user took over. Nothing moves on its own. */
  | 'free'
  /**
   * Details the user opened pushed the end out of view. Nothing moves on its
   * own, but they never scrolled away, so there is nothing to jump back to
   * until new content arrives below.
   */
  | 'reveal-hold'

/** Distance from the bottom, in px, still counted as "at the bottom". */
const AT_BOTTOM_SLACK = 80

/** Space between the top of the viewport and a new turn's pinned prompt. */
export const TURN_TOP_GAP = 24

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
 * If the user was following the end when a turn begins, keep following it —
 * with the new prompt pinned near the top, the reading position they asked
 * for by being there. If they had scrolled away, leave them alone.
 */
export function modeForNewTurn(following: boolean): ScrollMode {
  return following ? 'follow-end' : 'free'
}

export interface TurnRoom {
  /** The scroll position the follow aims for. */
  end: number
  /** Blank space needed below the content so the scroll can reach `end`. */
  room: number
}

/**
 * The end a follow aims for, and the blank room the transcript needs below
 * its content to reach it.
 *
 * `naturalEnd` is the content's own end (content height minus the viewport,
 * negative while the content is shorter than the viewport). `pinnedTop` is the
 * scroll position that puts a pinned prompt TURN_TOP_GAP below the top. While
 * the answer below the prompt is shorter than the screen, the end stays at the
 * pin and the room shrinks as the answer grows, so the scroll height and the
 * view stay still. Once the content's own end passes the pin, there is no room
 * and the end is the content's.
 */
export function turnRoom(naturalEnd: number, pinnedTop: number | undefined): TurnRoom {
  const end = Math.max(0, naturalEnd)
  if (pinnedTop === undefined || pinnedTop <= end) return { end, room: 0 }
  return { end: pinnedTop, room: pinnedTop - naturalEnd }
}

export function activeTurnAnchor(
  items: ReadonlyArray<{
    id: string
    turnId: string
    type: string
    role?: string | undefined
  }>,
  activeTurnId: string | undefined,
  liveStart = 0,
): { id: string; index: number } | undefined {
  if (!activeTurnId) return undefined

  // The active turn is always in the live tail. A confirmed optimistic prompt
  // can sit one row before the durable turn boundary, so include that row.
  // This keeps a structural stream event independent of completed history.
  const startIndex = Math.max(0, Math.min(items.length, liveStart) - 1)
  for (let index = startIndex; index < items.length; index += 1) {
    const item = items[index]
    if (item?.turnId === activeTurnId) return { id: item.id, index }
  }

  // A local send starts rendering before the provider assigns its durable
  // turn id. Track the optimistic user item by its stable submission id so
  // that local -> durable reconciliation is not mistaken for another turn.
  for (let index = items.length - 1; index >= startIndex; index -= 1) {
    const item = items[index]
    if (item?.turnId === '' && item.type === 'message' && item.role === 'user') {
      return { id: item.id, index }
    }
  }

  return undefined
}
