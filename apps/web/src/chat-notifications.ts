import type { Project, Session } from './ui/Sidebar.js'

/**
 * When the desktop shell tells the user about a chat while TasteCode is not
 * in front. The shell decides what to show (apps/desktop/src/chat-attention.ts);
 * this side keeps the setting and reports which chats are not at rest, read
 * from the status the sidebar draws, so every provider and API connection
 * behaves the same.
 */
export type ChatNotificationMode = 'off' | 'needs-you' | 'needs-you-or-finished'

/** Mirrors ChatState in apps/desktop/src/chat-attention.ts. */
export type ReportedChatState = 'working' | 'approval' | 'input' | 'failed'
export type ReportedChat = { id: string; title: string; state: ReportedChatState }
export type ChatAttentionReport = { mode: ChatNotificationMode; chats: ReportedChat[] }

export const CHAT_NOTIFICATIONS_KEY = 'harness.chatNotifications'
const CHANGE_EVENT = 'harness:chat-notifications'
const DEFAULT_MODE: ChatNotificationMode = 'needs-you'
let sessionMode: ChatNotificationMode | undefined

function isMode(value: unknown): value is ChatNotificationMode {
  return value === 'off' || value === 'needs-you' || value === 'needs-you-or-finished'
}

export function readChatNotificationMode(): ChatNotificationMode {
  if (sessionMode) return sessionMode
  try {
    const stored = localStorage.getItem(CHAT_NOTIFICATIONS_KEY)
    return isMode(stored) ? stored : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function writeChatNotificationMode(mode: ChatNotificationMode): void {
  try {
    localStorage.setItem(CHAT_NOTIFICATIONS_KEY, mode)
    sessionMode = undefined
  } catch {
    // Site data blocked: keep the choice for this session.
    sessionMode = mode
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeChatNotificationMode(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

/** What a chat is doing, as far as notifications care; undefined is at rest. */
export function reportedChatState(session: Session): ReportedChatState | undefined {
  switch (session.status) {
    case 'approval':
    case 'input':
    case 'failed':
      return session.status
    case 'starting':
    case 'working':
    case 'queued':
      return 'working'
    default:
      return undefined
  }
}

const projectChats = new WeakMap<Project, ReportedChat[]>()

function chatsOf(project: Project): ReportedChat[] {
  const cached = projectChats.get(project)
  if (cached) return cached
  const chats: ReportedChat[] = []
  for (const session of project.sessions) {
    // A chat that is still starting has a local id until the server adopts
    // it; reporting both would look like one chat finished and another began.
    if (session.id.startsWith('pending:')) continue
    const state = reportedChatState(session)
    if (state) chats.push({ id: session.id, title: session.title, state })
  }
  projectChats.set(project, chats)
  return chats
}

/**
 * The chats that are not at rest. A status change replaces only its own
 * project, so the other projects' lists come from the cache.
 */
export function chatAttentionReport(
  projects: readonly Project[],
  mode: ChatNotificationMode,
): ChatAttentionReport {
  const chats: ReportedChat[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    for (const chat of chatsOf(project)) {
      if (seen.has(chat.id)) continue
      seen.add(chat.id)
      chats.push(chat)
    }
  }
  return { mode, chats }
}

/** Equal reports say the same thing, so the second need not be sent. */
export function sameChatAttentionReport(
  left: ChatAttentionReport | undefined,
  right: ChatAttentionReport,
): boolean {
  if (!left || left.mode !== right.mode || left.chats.length !== right.chats.length) return false
  for (let index = 0; index < right.chats.length; index += 1) {
    const a = left.chats[index]!
    const b = right.chats[index]!
    if (a.id !== b.id || a.state !== b.state || a.title !== b.title) return false
  }
  return true
}
