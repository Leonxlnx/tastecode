import type { ChatImportChat, ChatImportFolder, ChatImportScan } from '@harness/contracts'

/** The strip's own value for every source at once. */
export const ALL_SOURCES = 'all'

export type ImportView = {
  source: string
  query: string
  archived: boolean
}

export type ImportFolderGroup = {
  folder: ChatImportFolder
  /** The chats this view can import, newest first. */
  chats: ChatImportChat[]
  updatedAt: number
}

function waiting(chat: ChatImportChat, archived: boolean): boolean {
  return !chat.imported && (archived || !chat.archived)
}

/**
 * What is left to import per source, and over all of them. A chat two apps saved
 * counts once, under the app it is listed for, so the figures add up to the total.
 */
export function sourceCounts(scan: ChatImportScan, archived: boolean): Map<string, number> {
  const counts = new Map<string, number>([[ALL_SOURCES, 0]])
  for (const source of scan.sources) counts.set(source.id, 0)
  for (const chat of scan.chats) {
    if (!waiting(chat, archived)) continue
    counts.set(ALL_SOURCES, (counts.get(ALL_SOURCES) ?? 0) + 1)
    counts.set(chat.source, (counts.get(chat.source) ?? 0) + 1)
  }
  return counts
}

export function archivedCount(scan: ChatImportScan): number {
  return scan.chats.filter((chat) => !chat.imported && chat.archived).length
}

/** Folders with something left to import in this view, the most recently used first. */
export function folderGroups(scan: ChatImportScan, view: ImportView): ImportFolderGroup[] {
  const query = view.query.trim().toLocaleLowerCase()
  const folders = new Map(scan.folders.map((folder) => [folder.path, folder]))
  const groups = new Map<string, ImportFolderGroup>()
  for (const chat of scan.chats) {
    if (!waiting(chat, view.archived)) continue
    if (view.source !== ALL_SOURCES && chat.source !== view.source) continue
    const folder = folders.get(chat.folder)
    if (!folder) continue
    if (
      query &&
      !chat.title.toLocaleLowerCase().includes(query) &&
      !folder.label.toLocaleLowerCase().includes(query)
    ) {
      continue
    }
    const group = groups.get(folder.path)
    if (group) {
      group.chats.push(chat)
      group.updatedAt = Math.max(group.updatedAt, chat.updatedAt)
    } else {
      groups.set(folder.path, { folder, chats: [chat], updatedAt: chat.updatedAt })
    }
  }
  const sorted = [...groups.values()]
  for (const group of sorted) group.chats.sort((a, b) => b.updatedAt - a.updatedAt)
  return sorted.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.folder.name.localeCompare(b.folder.name),
  )
}

/** What pressing Import would do. Chats chosen in another view still count. */
export function selectionSummary(scan: ChatImportScan, selected: ReadonlySet<string>) {
  const chosen = scan.chats.filter((chat) => selected.has(chat.id) && !chat.imported)
  const folders = new Set(chosen.map((chat) => chat.folder))
  const projects = new Map(scan.folders.map((folder) => [folder.path, folder.isProject]))
  return {
    ids: chosen.map((chat) => chat.id),
    chats: chosen.length,
    folders: folders.size,
    newProjects: [...folders].filter((folder) => !projects.get(folder)).length,
  }
}

export type CheckState = 'none' | 'some' | 'all'

export function checkState(chats: readonly ChatImportChat[], selected: ReadonlySet<string>) {
  const chosen = chats.filter((chat) => selected.has(chat.id)).length
  const state: CheckState = chosen === 0 ? 'none' : chosen === chats.length ? 'all' : 'some'
  return { state, chosen }
}

/** Ticks every chat given, or clears them when all of them were ticked already. */
export function toggled(
  selected: ReadonlySet<string>,
  chats: readonly ChatImportChat[],
): Set<string> {
  const next = new Set(selected)
  const clear = checkState(chats, selected).state === 'all'
  for (const chat of chats) {
    if (clear) next.delete(chat.id)
    else next.add(chat.id)
  }
  return next
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function lastUsed(at: number, now: number): string {
  const age = Math.max(0, now - at)
  if (age < HOUR) return 'Just now'
  if (age < DAY) {
    const hours = Math.floor(age / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(age / DAY)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(at)
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}
