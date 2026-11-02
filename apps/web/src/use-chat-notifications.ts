import { useEffect, useRef, useSyncExternalStore } from 'react'
import { canNotifyChats, onOpenChatRequest, reportChatAttention } from './bridge.js'
import {
  chatAttentionReport,
  readChatNotificationMode,
  sameChatAttentionReport,
  subscribeChatNotificationMode,
  type ChatAttentionReport,
} from './chat-notifications.js'
import type { Project } from './ui/Sidebar.js'

/**
 * Reports the chats that are not at rest to the desktop shell after each
 * sidebar status change, and opens a chat whose notification was clicked.
 * The sidebar list changes on status changes, not on streamed text, so this
 * stays off the per-delta path.
 *
 * Nothing is reported until the chat list has loaded: an empty first report
 * would read as every running chat finishing.
 */
export function useChatNotifications(
  projects: readonly Project[],
  loaded: boolean,
  openChat: (chatId: string) => void,
): void {
  const mode = useSyncExternalStore(
    subscribeChatNotificationMode,
    readChatNotificationMode,
    readChatNotificationMode,
  )
  const sent = useRef<ChatAttentionReport | undefined>(undefined)
  useEffect(() => {
    if (!canNotifyChats || !loaded) return
    const report = chatAttentionReport(projects, mode)
    if (sameChatAttentionReport(sent.current, report)) return
    sent.current = report
    reportChatAttention(report)
  }, [projects, loaded, mode])

  // The listener stays subscribed once; the latest callback is read from a ref.
  const open = useRef(openChat)
  open.current = openChat
  useEffect(() => onOpenChatRequest((chatId) => open.current(chatId)), [])
}
