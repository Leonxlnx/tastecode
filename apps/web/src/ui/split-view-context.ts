import { createContext } from 'react'
import type { RowDragOptions } from './useRowDrag.js'

/**
 * What a sidebar chat row needs from split view: which chat is open beside the
 * active one, how to open another there, and where a row dragged out of the
 * rail can be dropped. Rows read it from context so the rail's many row
 * components do not each thread more props through.
 */
export type SplitSidebar = {
  besideSessionId: string | undefined
  openBeside: ((id: string) => void) | undefined
  dragOut: RowDragOptions['away']
}

export const SplitSidebarContext = createContext<SplitSidebar>({
  besideSessionId: undefined,
  openBeside: undefined,
  dragOut: undefined,
})

let splitViewStyles: Promise<unknown> | undefined

/** Split view's stylesheet loads with the first split, never at startup. */
export function loadSplitViewStyles(): Promise<unknown> {
  splitViewStyles ??= import('./split-view-styles.js').catch((error: unknown) => {
    splitViewStyles = undefined
    throw error
  })
  return splitViewStyles
}
