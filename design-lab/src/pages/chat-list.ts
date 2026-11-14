/**
 * Organizing the sidebar's chats: pure functions from chats + options to the
 * sections the sidebar draws. No React here.
 */
import type { Chat } from './chat-examples'

export type Organize = 'project' | 'inbox' | 'date' | 'list'
export type SortKey = 'updated' | 'created' | 'name'
export type Show = 'all' | 'unread' | 'running'

export type ListOptions = {
  organize: Organize
  sort: SortKey
  /** Flips the natural order: newest first becomes oldest first, A–Z becomes Z–A. */
  reversed: boolean
  show: Show
}

export const defaultOptions: ListOptions = { organize: 'project', sort: 'updated', reversed: false, show: 'all' }

/** The Inbox's sections, in priority order: what's stuck on you comes first. */
export type InboxBucket = 'needs' | 'review' | 'running' | 'done'

export const INBOX: readonly { key: InboxBucket; label: string }[] = [
  { key: 'needs', label: 'Needs you' },
  { key: 'review', label: 'Ready to review' },
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Done' },
]

export function inboxBucket(chat: Chat): InboxBucket {
  switch (chat.status) {
    case 'approval':
    case 'input':
    case 'failed':
      return 'needs'
    case 'unread':
      return 'review'
    case 'running':
      return 'running'
    default:
      return 'done'
  }
}

export type Group =
  | { kind: 'project'; key: string; name: string; chats: Chat[] }
  | { kind: 'inbox'; key: InboxBucket; label: string; chats: Chat[] }
  | { kind: 'date'; key: string; label: string; chats: Chat[] }
  | { kind: 'list'; key: string; chats: Chat[] }

export type ChatView = { pinned: Chat[]; groups: Group[]; matches: number }

/** The time a row shows and dates are grouped by: the sort's own date, or the last update when sorting by name. */
export function rowTime(chat: Chat, sort: SortKey): number {
  return sort === 'created' ? chat.created : chat.updated
}

function compare(sort: SortKey, reversed: boolean) {
  const sign = reversed ? -1 : 1
  return (a: Chat, b: Chat): number => {
    const order =
      sort === 'name'
        ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
        : rowTime(b, sort) - rowTime(a, sort)
    return sign * order || a.id.localeCompare(b.id)
  }
}

function matches(chat: Chat, show: Show): boolean {
  return show === 'all' || chat.status === show
}

const DATE_BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'] as const

function dateBucket(time: number, now: number): (typeof DATE_BUCKETS)[number] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const day = 24 * 60 * 60 * 1000
  if (time >= startOfToday) return 'Today'
  if (time >= startOfToday - day) return 'Yesterday'
  if (time >= startOfToday - 7 * day) return 'Previous 7 days'
  if (time >= startOfToday - 30 * day) return 'Previous 30 days'
  return 'Older'
}

/**
 * `keep` is a chat that stays listed whatever the filter says (the one you're
 * on), so opening an unread chat under "Unread" doesn't make it vanish.
 * `stick` holds that chat in the Inbox section it was in when you opened it,
 * so it doesn't jump to Done under your cursor; it moves once you move on.
 */
export function organizeChats(
  chats: Chat[],
  projects: string[],
  options: ListOptions,
  now: number,
  hold: { keep?: string; stick?: { id: string; bucket: InboxBucket } } = {},
): ChatView {
  const { organize, sort, reversed, show } = options
  const { keep, stick } = hold
  const byOrder = compare(sort, reversed)
  const visible = chats.filter((chat) => matches(chat, show) || chat.id === keep).sort(byOrder)

  const pinned = visible.filter((chat) => chat.pinned)
  const rest = visible.filter((chat) => !chat.pinned)
  const view = (groups: Group[]): ChatView => ({ pinned, groups, matches: visible.length })

  if (organize === 'inbox') {
    // Anything that needs something from you shows in its section even when
    // it's pinned; Pinned keeps only the pinned chats that are done.
    const bucketOf = (chat: Chat) => (stick?.id === chat.id ? stick.bucket : inboxBucket(chat))
    const restingPins = visible.filter((chat) => chat.pinned && bucketOf(chat) === 'done')
    const inbox = visible.filter((chat) => !restingPins.includes(chat))
    return {
      pinned: restingPins,
      groups: INBOX.map(({ key, label }) => ({
        kind: 'inbox' as const,
        key,
        label,
        chats: inbox.filter((chat) => bucketOf(chat) === key),
      })).filter((group) => group.chats.length > 0),
      matches: visible.length,
    }
  }

  if (organize === 'list') return view(rest.length ? [{ kind: 'list', key: 'list', chats: rest }] : [])

  if (organize === 'date') {
    const buckets = new Map<string, Chat[]>()
    for (const chat of rest) {
      const label = dateBucket(rowTime(chat, sort), now)
      buckets.set(label, [...(buckets.get(label) ?? []), chat])
    }
    // Buckets follow the date direction; within a bucket rows keep the chosen sort.
    const datesReversed = sort === 'name' ? false : reversed
    const labels = DATE_BUCKETS.filter((label) => buckets.has(label))
    if (datesReversed) labels.reverse()
    return view(labels.map((label) => ({ kind: 'date', key: label, label, chats: buckets.get(label)! })))
  }

  // By project. A project ranks by its best chat under the current sort, so
  // "Last updated" puts the most active project first. Pinned chats live in
  // Pinned only but still count towards their project's rank.
  const ranked = projects.map((name) => {
    const all = visible.filter((chat) => chat.project === name)
    return { name, lead: all[0], chats: all.filter((chat) => !chat.pinned) }
  })
  const withChats = ranked.filter((p) => p.chats.length > 0)
  withChats.sort((a, b) =>
    sort === 'name'
      ? (reversed ? -1 : 1) * a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      : byOrder(a.lead!, b.lead!),
  )
  // Empty projects only make sense when nothing is filtered out; they go last.
  const empty = show === 'all' ? ranked.filter((p) => p.chats.length === 0) : []
  return view(
    [...withChats, ...empty].map((p) => ({ kind: 'project', key: p.name, name: p.name, chats: p.chats })),
  )
}

/** Compact relative time: now, 4m, 3h, 2d, 3w, 5mo, 1y. */
export function ago(time: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.round(days / 7)}w`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${Math.round(days / 365)}y`
}
