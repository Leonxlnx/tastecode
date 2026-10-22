import type { ProjectsState, Session } from '../state/projects'
import { isArchived, lastActivity } from '../state/projects'
import type { ChatState, ChatsView, ChatView } from './types'

function waitsForYou(chat: ChatView): boolean {
  return chat.state === 'approval' || chat.state === 'input'
}

/** The server's inbox status, folded into what a chat row says. */
export function chatState(session: Session): ChatState {
  switch (session.status) {
    case 'approval':
    case 'input':
    case 'failed':
    case 'starting':
    case 'working':
    case 'queued':
      return session.status
    default:
      return session.running ? 'working' : 'idle'
  }
}

/**
 * Every chat on the computer, needs-you first and then by last activity, so
 * the list answers "what is waiting for me" before "what happened lately".
 */
export function chatsView(state: ProjectsState): ChatsView {
  const chats: ChatView[] = []
  for (const project of state.projects) {
    for (const session of project.sessions) {
      if (session.lifecycle?.state === 'snoozed') continue
      chats.push({
        id: session.id,
        title: session.title.trim() || 'New chat',
        projectPath: project.path,
        projectName: project.name,
        state: chatState(session),
        unread: session.unread ?? false,
        pinned: session.pinned ?? false,
        archived: isArchived(session),
        at: lastActivity(session, state.activity),
        branch: session.worktreeBranch ?? null,
      })
    }
  }
  chats.sort((left, right) => {
    const urgency = Number(waitsForYou(right)) - Number(waitsForYou(left))
    return urgency || right.at - left.at
  })
  return {
    status: state.status,
    error: state.error ?? null,
    projects: state.projects.map((project) => ({
      path: project.path,
      name: project.name,
      pinned: project.pinned,
      chats: project.sessions.filter((session) => !isArchived(session)).length,
    })),
    chats,
  }
}
