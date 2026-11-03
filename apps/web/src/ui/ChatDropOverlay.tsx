import { memo, useSyncExternalStore, type CSSProperties } from 'react'
import type { ChatDropStore } from './chat-drop.js'

/**
 * Where a chat dragged from the sidebar would land: a pane it replaces, or the
 * right half where it opens beside. Only this component follows the pointer;
 * the panes and their transcripts never re-render for a drag.
 */
export const ChatDropOverlay = memo(function ChatDropOverlay(props: { store: ChatDropStore }) {
  const hover = useSyncExternalStore(props.store.subscribe, props.store.get)
  if (!hover) return null
  // Placed inline, so it is out of the stage body's grid even before split
  // view's stylesheet, which draws it, has loaded.
  const style: CSSProperties = {
    position: 'absolute',
    left: hover.left,
    top: hover.top,
    width: hover.width,
    height: hover.height,
    pointerEvents: 'none',
  }
  return <div className="chat-drop" data-zone={hover.zone.kind} style={style} aria-hidden />
})
