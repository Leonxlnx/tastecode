import {
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { QueuedTurn } from '@harness/contracts'
import type { PaneSlot } from '../thread-controller.js'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import { Composer } from './Composer.js'

const NO_QUEUE: QueuedTurn[] = []

/**
 * A split pane's composer. With focus it is the app's composer as always.
 * Without focus it keeps the props it had when it lost focus, so it shows the
 * same draft, model and controls and nothing moves; only whether its chat is
 * running, its context usage and its queue stay live. It reads those from its
 * column's structure snapshot, which streamed text never changes.
 */
export function PaneComposer(props: {
  store: ThreadFrameStore
  composer: ComponentProps<typeof Composer>
  dormant?: boolean | undefined
  queue?: { items: QueuedTurn[]; canSteer: boolean } | undefined
}) {
  const thread = useSyncExternalStore(
    props.store.subscribeStructure,
    props.store.getStructureSnapshot,
  )
  if (!props.dormant) return <Composer {...props.composer} />
  return (
    <Composer
      {...props.composer}
      dormant
      errorsVisible={false}
      running={thread.running}
      usage={thread.usage}
      queuedTurns={props.queue?.items ?? NO_QUEUE}
      canSteerQueue={props.queue?.canSteer ?? false}
    />
  )
}

/**
 * One column of split view. Without a split the wrapper takes no box of its
 * own (`display: contents`), so the single-chat layout and its styles are
 * exactly what they were, and opening a split keeps the chat mounted.
 *
 * The pane without focus stays live: its transcript streams, scrolls and takes
 * approvals. The first pointer press or keyboard focus inside it moves focus
 * there before the press reaches its target, so an action in that pane always
 * acts on that pane's chat.
 */
export function SplitPane(props: {
  slot: PaneSlot
  split: boolean
  focused: boolean
  /** The pane shown first; the other one sits to its right. */
  start: boolean
  label: string
  onFocusPane: (slot: PaneSlot, target: EventTarget | null) => void
  children: ReactNode
}) {
  // One element type in both layouts: switching between them must not remount
  // the chat inside.
  if (!props.split) {
    return (
      <section className="split__pane" style={CONTENTS}>
        {props.children}
      </section>
    )
  }
  const claimFocus = (target: EventTarget | null) => {
    if (!props.focused) props.onFocusPane(props.slot, target)
  }
  return (
    <section
      className={`split__pane${props.focused ? ' is-focused' : ' is-dormant'}${props.start ? ' is-start' : ' is-end'}`}
      style={props.start ? START : END}
      aria-label={props.label}
      data-split-slot={props.slot}
      onPointerDownCapture={(event) => {
        if (event.button === 0) claimFocus(event.target)
      }}
      onFocusCapture={(event) => claimFocus(event.target)}
    >
      {props.children}
    </section>
  )
}

const CONTENTS: CSSProperties = { display: 'contents' }
const START: CSSProperties = { order: 0 }
const END: CSSProperties = { order: 2 }
