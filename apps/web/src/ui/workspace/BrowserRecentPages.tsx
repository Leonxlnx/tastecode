import { useSyncExternalStore, type ReactNode } from 'react'
import { IconHistory as History } from '@tabler/icons-react'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from '../session-clock.js'
import {
  browserVisitAddress,
  readBrowserHistory,
  subscribeBrowserHistory,
} from './browser-history.js'
import { browserPageLabel } from './browser-page.js'

function visitedAgo(visitedAt: number, now: number): string {
  const elapsed = compactRelativeTime(visitedAt, now)
  return elapsed === 'now' ? 'just now' : `${elapsed} ago`
}

/**
 * What an empty Browser tab offers: the pages opened before, each one click
 * from loading in this tab. The children show until there is a page to list.
 * Subscribes here, so a page saved elsewhere never re-renders a tab showing one.
 */
export function BrowserRecentPages(props: { onOpen: (url: string) => void; children: ReactNode }) {
  const visits = useSyncExternalStore(subscribeBrowserHistory, readBrowserHistory)
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock)
  if (visits.length === 0) return props.children
  return (
    <section className="workspace-browser__recent" aria-label="Recently used pages">
      <h3 className="workspace-browser__recent-heading">
        <History size={16} aria-hidden />
        Recently used
      </h3>
      <ul className="workspace-browser__recent-list">
        {visits.map((visit) => (
          <li key={visit.url}>
            <button type="button" title={visit.url} onClick={() => props.onOpen(visit.url)}>
              <span className="workspace-browser__recent-thumb" aria-hidden />
              <span className="workspace-browser__recent-text">
                <strong>{browserPageLabel(visit)}</strong>
                <span>
                  <span className="workspace-browser__recent-address">
                    {browserVisitAddress(visit.url)}
                  </span>
                  <span> · {visitedAgo(visit.visitedAt, now)}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
