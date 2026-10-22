import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { NavigationDestination, NavigationStack } from '@expo/ui/swift-ui'
import { NavigatorContext, parseRoute } from './nav'
import { ProjectScreen } from './ProjectsScreen'
import { ThreadScreen } from './ThreadScreen'

/** A tab's navigation stack. Every screen it can show is built here from its path value. */
export function Stack(props: { children: ReactNode }) {
  const [path, setPath] = useState<string[]>([])
  const push = useCallback((entry: string) => setPath((current) => [...current, entry]), [])
  const pop = useCallback(() => setPath((current) => current.slice(0, -1)), [])
  const navigator = useMemo(() => ({ push, pop }), [push, pop])
  return (
    <NavigatorContext.Provider value={navigator}>
      <NavigationStack path={path} onPathChange={setPath}>
        {props.children}
        {path.map((entry, index) => (
          <NavigationDestination key={`${index}:${entry}`} value={entry}>
            {screen(entry)}
          </NavigationDestination>
        ))}
      </NavigationStack>
    </NavigatorContext.Provider>
  )
}

function screen(entry: string): ReactNode {
  const target = parseRoute(entry)
  switch (target?.kind) {
    case 'thread':
      return <ThreadScreen key={entry} threadId={target.value} />
    case 'new':
      return <ThreadScreen key={entry} newChatProject={target.value || undefined} />
    case 'project':
      return <ProjectScreen path={target.value} />
    default:
      return null
  }
}
