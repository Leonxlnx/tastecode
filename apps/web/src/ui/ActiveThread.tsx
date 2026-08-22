import { memo, useMemo, useSyncExternalStore } from 'react'
import { activeTurnActivityIndices, activeTurnIsSearching } from '../thread-store.js'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import { LazyThread } from './LazyThread.js'
import type { Checkpoint } from './RollbackDialog.js'
import type { ThreadProps } from './Thread.js'

const EMPTY_CHECKPOINTS: Checkpoint[] = []

type SnapshotThreadProp =
  | 'items'
  | 'liveItems'
  | 'itemVersion'
  | 'liveStart'
  | 'running'
  | 'searching'
  | 'activeActivityIndices'
  | 'activeTurn'
  | 'turnTiming'
  | 'plan'
  | 'diff'
  | 'diffTurnId'
  | 'approvals'
  | 'userInputs'
  | 'reviews'
  | 'checkpoints'

type ActiveThreadProps = Omit<ThreadProps, SnapshotThreadProp> & {
  frameStore: ThreadFrameStore
  stopping: boolean
  checkpoints?: Checkpoint[] | undefined
}

function ActiveThreadComponent({
  frameStore,
  stopping,
  checkpoints = EMPTY_CHECKPOINTS,
  ...props
}: ActiveThreadProps) {
  const thread = useSyncExternalStore(
    frameStore.subscribeStructure,
    frameStore.getStructureSnapshot,
    frameStore.getStructureSnapshot,
  )
  const reviews = useMemo(() => Object.values(thread.reviews), [thread.reviews])
  const activeActivityIndices = useMemo(
    () => activeTurnActivityIndices(thread.items, thread.activeTurn?.id, thread.liveStart),
    [thread.items, thread.activeTurn?.id, thread.liveStart],
  )
  const searching = activeTurnIsSearching(
    thread.items,
    thread.activeTurn?.id,
    thread.liveItems,
    thread.liveStart,
    activeActivityIndices,
  )

  return (
    <LazyThread
      {...props}
      frameStore={frameStore}
      items={thread.items}
      liveItems={thread.liveItems}
      itemVersion={thread.itemVersion}
      liveStart={thread.liveStart}
      running={thread.running && !stopping}
      searching={searching}
      activeActivityIndices={activeActivityIndices}
      activeTurn={thread.activeTurn}
      turnTiming={thread.turnTiming}
      plan={thread.plan}
      diff={thread.diff}
      diffTurnId={thread.diffTurnId}
      approvals={thread.approvals}
      userInputs={thread.userInputs}
      reviews={reviews}
      checkpoints={thread.running ? EMPTY_CHECKPOINTS : checkpoints}
    />
  )
}

export const ActiveThread = memo(ActiveThreadComponent)
