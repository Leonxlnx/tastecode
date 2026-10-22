import { createContext, useContext } from 'react'

/** A screen on a tab's stack, written as a path value: `thread:<id>`, `new:<project>`, `project:<path>`. */
export type Route = { kind: 'thread' | 'new' | 'project'; value: string }

export function route(kind: Route['kind'], value = ''): string {
  return `${kind}:${value}`
}

export function parseRoute(entry: string): Route | undefined {
  const separator = entry.indexOf(':')
  const kind = entry.slice(0, separator)
  if (kind !== 'thread' && kind !== 'new' && kind !== 'project') return undefined
  return { kind, value: entry.slice(separator + 1) }
}

export type Navigator = {
  push: (entry: string) => void
  pop: () => void
}

export const NavigatorContext = createContext<Navigator>({ push: () => {}, pop: () => {} })

export function useNavigator(): Navigator {
  return useContext(NavigatorContext)
}
