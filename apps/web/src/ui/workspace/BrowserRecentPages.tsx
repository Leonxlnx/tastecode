import { useRef, useSyncExternalStore, type ReactNode } from 'react'
import { IconHistory as History, IconX as X } from '@tabler/icons-react'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from '../session-clock.js'
import {
  browserVisitAddress,
  type BrowserVisit,
  clearBrowserHistory,
  forgetBrowserVisit,
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
 * from loading in this tab, and a way to take one or all of them off the
 * list. The children show until there is a page to list. A removed row hands keyboard
 * focus to the next row, else the one before; `onEmptied` takes it when none is left.
 * Subscribes here, so a page saved elsewhere never re-renders a tab showing one.
 */
export function BrowserRecentPages(props: {
  onOpen: (url: string) => void
  onEmptied?: () => void
  children: ReactNode
}) {
  const visits = useSyncExternalStore(subscribeBrowserHistory, readBrowserHistory)
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock)
  const list = useRef<HTMLUListElement>(null)
  const forget = (index: number) => {
    const { url } = visits[index]!
    forgetBrowserVisit(url)
    const left = new Set(readBrowserHistory().map((visit) => visit.url))
    // Storage refused the change: the row is still there, and so is the focus.
    if (left.has(url)) return
    const surviving = (visit: BrowserVisit) => left.has(visit.url)
    const next =
      visits.slice(index + 1).find(surviving) ?? visits.slice(0, index).findLast(surviving)
    if (!next) return props.onEmptied?.()
    // Rows are keyed by address, so the button focused now is the one that stays.
    list.current
      ?.querySelectorAll<HTMLButtonElement>('.workspace-browser__recent-forget')
      [visits.indexOf(next)]?.focus()
  }
  const clear = () => {
    clearBrowserHistory()
    if (readBrowserHistory().length === 0) props.onEmptied?.()
  }
  if (visits.length === 0) return props.children
  return (
    <section className="workspace-browser__recent" aria-label="Recently used pages">
      <h3 className="workspace-browser__recent-heading">
        <History size={16} aria-hidden />
        Recently used
        <button
          type="button"
          className="workspace-browser__recent-clear"
          aria-label="Clear recently used pages"
          onClick={clear}
        >
          Clear
        </button>
      </h3>
      <ul ref={list} className="workspace-browser__recent-list">
        {visits.map((visit, index) => (
          <li key={visit.url}>
            <button
              type="button"
              className="workspace-browser__recent-open"
              title={visit.url}
              onClick={() => props.onOpen(visit.url)}
            >
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
            <button
              type="button"
              className="icon-btn workspace-browser__recent-forget"
              aria-label={`Remove ${visit.url} from Recently used`}
              title="Remove from Recently used"
              onClick={() => forget(index)}
            >
              <X size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
