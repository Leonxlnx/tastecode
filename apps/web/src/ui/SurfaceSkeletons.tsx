import { createPortal } from 'react-dom'

import { Skeleton, SkeletonGroup, SkeletonStatus } from './Skeleton.js'
import '../styles/surface-skeleton.css'

/*
 * Placeholders for surfaces whose code or data arrives after the first paint.
 * Each one sits exactly where its surface renders and copies that surface's
 * geometry, so the arrival is a fill-in rather than a jump. They live in the
 * startup bundle because the surfaces they stand in for (and those surfaces'
 * stylesheets) are lazy chunks that have not loaded yet.
 */

const SIDEBAR_TREE: readonly { name: number; sessions: readonly string[] }[] = [
  { name: 96, sessions: ['78%', '62%', '86%', '54%'] },
  { name: 68, sessions: ['70%', '46%'] },
  { name: 112, sessions: [] },
  { name: 80, sessions: [] },
]

/** Project rows with their chats, drawn with the rail's own row classes. */
export function SidebarTreeSkeleton() {
  return (
    <SkeletonStatus label="Loading projects…" className="rail-skeleton">
      {SIDEBAR_TREE.map((project, index) => (
        <div className="proj" key={index}>
          <div className="proj__head">
            <span className="proj__toggle">
              <Skeleton className="rail-skeleton__mark" />
              <Skeleton className="rail-skeleton__name" width={project.name} />
            </span>
          </div>
          {project.sessions.length > 0 ? (
            <ul className="proj__sessions">
              {project.sessions.map((width, row) => (
                <li className="sessrow" key={row}>
                  <span className="sess">
                    <Skeleton className="rail-skeleton__chat" width={width} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </SkeletonStatus>
  )
}

const INBOX_CARDS: readonly { project: number; title: string; meta: string }[] = [
  { project: 64, title: '82%', meta: '46%' },
  { project: 52, title: '64%', meta: '58%' },
  { project: 72, title: '74%', meta: '40%' },
  { project: 58, title: '56%', meta: '52%' },
]

/** Inbox thread cards: project and state, a title, one line of detail. */
export function InboxCardsSkeleton() {
  return (
    <SkeletonStatus label="Loading threads…" className="inbox-skeleton">
      <Skeleton className="inbox-skeleton__heading" width={34} />
      {INBOX_CARDS.map((card, index) => (
        <div className="inbox-skeleton__card" key={index}>
          <span className="inbox-skeleton__topline">
            <Skeleton width={card.project} />
            <Skeleton width={30} />
          </span>
          <Skeleton className="inbox-skeleton__title" width={card.title} />
          <Skeleton className="inbox-skeleton__meta" width={card.meta} />
        </div>
      ))}
    </SkeletonStatus>
  )
}

/** The inbox rail before its chunk arrives: toolbar controls, then cards. */
export function InboxRailSkeleton(props: { pullRequests: boolean }) {
  return (
    <>
      <SkeletonGroup className="inbox-skeleton-toolbar">
        <Skeleton className="inbox-skeleton-toolbar__search" />
        <Skeleton className="inbox-skeleton-toolbar__new" />
        <span className="inbox-skeleton-toolbar__projects">
          <Skeleton className="inbox-skeleton-toolbar__scope" />
          <Skeleton className="inbox-skeleton-toolbar__add" />
        </span>
        {props.pullRequests ? <Skeleton className="inbox-skeleton-toolbar__pulls" /> : null}
      </SkeletonGroup>
      <div className="rail__body inbox-skeleton-body">
        <InboxCardsSkeleton />
      </div>
    </>
  )
}

const SETTINGS_NAV: readonly number[] = [52, 44, 72, 58, 62, 48, 32, 40, 92, 40]
const SETTINGS_ROWS: readonly { title: number; note: number; control: string }[] = [
  { title: 104, note: 0, control: 'segmented' },
  { title: 148, note: 232, control: 'switch' },
  { title: 120, note: 0, control: 'select' },
  { title: 136, note: 196, control: 'switch' },
  { title: 92, note: 0, control: 'select' },
]

const SETTINGS_PROVIDERS: readonly { name: number; status: number }[] = [
  { name: 52, status: 168 },
  { name: 96, status: 156 },
  { name: 40, status: 60 },
]
const PROVIDER_LABEL_WIDTHS: readonly number[] = [34, 38, 44]
const PROVIDER_VALUE_WIDTHS: readonly number[] = [64, 82, 108]

/** The providers page: each provider's row and its three defaults. */
function SettingsProvidersSkeleton() {
  return SETTINGS_PROVIDERS.map((provider, index) => (
    <div className="settings-skeleton__provider" key={index}>
      <span className="settings-skeleton__provider-head">
        <span className="settings-skeleton__provider-mark">
          <Skeleton className="skeleton--block" width={16} height={16} />
        </span>
        <Skeleton width={provider.name} height={12} />
        <Skeleton width={provider.status} height={9} />
      </span>
      <span className="settings-skeleton__tune">
        {PROVIDER_VALUE_WIDTHS.map((width, row) => (
          <span className="settings-skeleton__tune-row" key={row}>
            <Skeleton width={PROVIDER_LABEL_WIDTHS[row]} height={8} />
            <Skeleton width={width} height={9} />
          </span>
        ))}
      </span>
    </div>
  ))
}

/** Settings' two columns: the category rail and the page it opens on. */
export function SettingsSkeleton(props: { section?: string | undefined }) {
  return (
    <div className="settings-skeleton">
      <div className="settings-skeleton__titlebar" />
      <aside className="settings-skeleton__sidebar">
        <SkeletonGroup className="settings-skeleton__nav">
          <span className="settings-skeleton__item">
            <Skeleton className="skeleton--icon" />
            <Skeleton width={76} />
          </span>
          <Skeleton className="settings-skeleton__label" width={44} />
          {SETTINGS_NAV.map((width, index) => (
            <span className="settings-skeleton__item" key={index}>
              <Skeleton className="skeleton--icon" />
              <Skeleton width={width} />
            </span>
          ))}
        </SkeletonGroup>
      </aside>
      <main className="settings-skeleton__main">
        <SkeletonStatus label="Loading settings…" className="settings-skeleton__content">
          <Skeleton className="settings-skeleton__title" />
          {props.section === 'providers' ? (
            <SettingsProvidersSkeleton />
          ) : (
            <div className="settings-skeleton__group">
              {SETTINGS_ROWS.map((row, index) => (
                <div className="settings-skeleton__row" key={index}>
                  <span className="settings-skeleton__copy">
                    <Skeleton width={row.title} />
                    {row.note ? (
                      <Skeleton className="settings-skeleton__note" width={row.note} />
                    ) : null}
                  </span>
                  <Skeleton
                    className={`settings-skeleton__control settings-skeleton__control--${row.control}`}
                  />
                </div>
              ))}
            </div>
          )}
        </SkeletonStatus>
      </main>
    </div>
  )
}

const PULL_REQUEST_TITLES: readonly string[] = ['74%', '62%', '80%', '56%', '70%', '74%']

/** The pull request workspace: list header and rows, an empty detail pane. */
export function PullRequestsSkeleton() {
  return (
    <div className="pr-shell-skeleton">
      <div className="pr-shell-skeleton__list">
        <SkeletonGroup className="pr-shell-skeleton__head">
          <span className="pr-shell-skeleton__title-row">
            <span className="pr-shell-skeleton__title">
              <Skeleton width={112} height={11} />
              <Skeleton width={44} height={7} />
            </span>
            <Skeleton className="skeleton--block" width={30} height={30} />
          </span>
          <Skeleton className="skeleton--block" height={36} />
          <span className="pr-shell-skeleton__search">
            <Skeleton className="skeleton--block" height={34} />
            <Skeleton className="skeleton--block" width={74} height={34} />
          </span>
        </SkeletonGroup>
        <SkeletonStatus label="Loading pull requests" className="pr-shell-skeleton__rows">
          {PULL_REQUEST_TITLES.map((width, index) => (
            <span className="pr-shell-skeleton__row" key={index}>
              <Skeleton className="skeleton--circle" width={16} height={16} />
              <Skeleton width={width} height={9} />
              <Skeleton width="48%" height={7} />
            </span>
          ))}
        </SkeletonStatus>
      </div>
      <div className="pr-shell-skeleton__detail" />
    </div>
  )
}

// Review, Terminal, Browser, Files, Temporary chat.
const WORKSPACE_TOOL_LABELS: readonly number[] = [42, 50, 46, 30, 94]

/**
 * The workspace panel as it always opens: an empty tab strip over the tool
 * picker. Tool tiles are framed like the real buttons, with bars for content.
 */
export function WorkspacePanelSkeleton(props: { placement: 'right' | 'bottom'; open: boolean }) {
  return (
    <div
      className={`workspace-panel-skeleton${props.placement === 'bottom' ? ' workspace-panel-skeleton--bottom' : ''}`}
      hidden={!props.open}
    >
      <SkeletonGroup className="workspace-panel-skeleton__tabs">
        <span className="workspace-panel-skeleton__slot">
          <Skeleton className="skeleton--icon" />
        </span>
        <span className="workspace-panel-skeleton__slot workspace-panel-skeleton__close">
          <Skeleton className="skeleton--icon" />
        </span>
      </SkeletonGroup>
      <SkeletonStatus label="Loading workspace tools…" className="workspace-panel-skeleton__picker">
        <span className="workspace-panel-skeleton__tools">
          {WORKSPACE_TOOL_LABELS.map((width, index) => (
            <span className="workspace-panel-skeleton__tool" key={index}>
              <Skeleton className="skeleton--icon" width={16} height={16} />
              <Skeleton width={width} height={9} />
            </span>
          ))}
        </span>
      </SkeletonStatus>
    </div>
  )
}

/** Chat search before its chunk arrives: the dialog frame with its intro. */
export function ChatSearchSkeleton() {
  return (
    <div className="search-skeleton">
      <div className="search-skeleton__scrim" />
      <div className="search-skeleton__panel">
        <SkeletonGroup className="search-skeleton__search">
          <Skeleton className="skeleton--icon" />
          <Skeleton width={132} height={10} />
          <span className="search-skeleton__close">
            <Skeleton className="skeleton--icon" width={13} height={13} />
          </span>
        </SkeletonGroup>
        <SkeletonGroup className="search-skeleton__filters">
          <span className="search-skeleton__filter">
            <Skeleton width={38} height={8} />
            <Skeleton className="skeleton--block" width={98} height={28} />
          </span>
          <span className="search-skeleton__filter">
            <Skeleton width={32} height={8} />
            <Skeleton className="skeleton--block" width={91} height={28} />
          </span>
        </SkeletonGroup>
        <SkeletonStatus label="Opening search…" className="search-skeleton__intro">
          <Skeleton className="skeleton--circle" width={28} height={28} />
          <span className="search-skeleton__heading">
            <Skeleton width={176} height={12} />
          </span>
          <span className="search-skeleton__copy">
            <Skeleton width={248} height={9} />
            <Skeleton width={188} height={9} />
          </span>
        </SkeletonStatus>
      </div>
    </div>
  )
}

/** The thread's find bar: the frame is thread.css's own, the controls are bars. */
export function FindBarSkeleton() {
  return (
    <SkeletonStatus label="Opening find…" className="find find-skeleton">
      <span className="find-skeleton__input">
        <Skeleton width={88} height={9} />
      </span>
      <span className="find-skeleton__count" />
      {[0, 1, 2].map((index) => (
        <span className="find-skeleton__button" key={index}>
          <Skeleton className="skeleton--block" width={12} height={12} />
        </span>
      ))}
    </SkeletonStatus>
  )
}

/** The media viewer's backdrop and a frame where the image will land. */
export function MediaViewerSkeleton(props: { mediaType: 'image' | 'video' }) {
  return createPortal(
    <div className={`media-skeleton media-skeleton--${props.mediaType}`}>
      <SkeletonGroup className="media-skeleton__actions">
        <Skeleton className="skeleton--icon" />
        <Skeleton className="skeleton--icon" />
        <Skeleton className="skeleton--icon" />
      </SkeletonGroup>
      <SkeletonStatus label="Opening viewer…" className="media-skeleton__viewport">
        <Skeleton className="media-skeleton__frame" />
      </SkeletonStatus>
    </div>,
    document.body,
  )
}
