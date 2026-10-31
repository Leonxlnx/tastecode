import { createContext } from 'react'

/**
 * What a sidebar chat row needs from split view: which chat is open beside the
 * active one, and how to open another there. Rows read it from context so the
 * rail's many row components do not each thread two more props through.
 */
export type SplitSidebar = {
  besideSessionId: string | undefined
  openBeside: ((id: string) => void) | undefined
}

export const SplitSidebarContext = createContext<SplitSidebar>({
  besideSessionId: undefined,
  openBeside: undefined,
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
