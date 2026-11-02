import { defaultModel, modelLabel, sourceKey, type Source } from '../state/catalog'
import type { ProjectsState, Session } from '../state/projects'
import { isArchived, lastActivity } from '../state/projects'
import { providerLook } from './provider-mark'
import type { ChatState, ChatsView, ChatView } from './types'

/** Waiting for you, then working, then the rest: what each chat's place in the list starts from. */
function urgency(chat: ChatView): number {
  switch (chat.state) {
    case 'approval':
    case 'input':
      return 2
    case 'starting':
    case 'working':
    case 'queued':
      return 1
    default:
      return 0
  }
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

/** The source a chat runs on, matched with its account first and without it second. */
function sourceOf(session: Session, sources: readonly Source[]): Source | undefined {
  const exact = sourceKey(session)
  const shared = sourceKey({ ...session, accountId: undefined })
  return (
    sources.find((source) => source.key === exact) ??
    sources.find((source) => sourceKey({ ...source, accountId: undefined }) === shared)
  )
}

/**
 * Every chat on the computer: pinned ones first, then within each group the
 * chats waiting for you, the ones working, and the rest by last activity, so
 * the list answers "what is waiting for me" before "what happened lately".
 * Sources name each chat's agent and model, for filtering.
 */
export function chatsView(state: ProjectsState, sources: readonly Source[] = []): ChatsView {
  const chats: ChatView[] = []
  for (const project of state.projects) {
    for (const session of project.sessions) {
      if (session.lifecycle?.state === 'snoozed') continue
      const source = sourceOf(session, sources)
      const look = providerLook(session.provider, session.agent)
      // A chat with no model of its own runs its agent's default, as its composer shows.
      const chosen = session.model
        ? (source?.models.find((entry) => entry.id === session.model)?.displayName ?? session.model)
        : source && defaultModel(source.models)?.displayName
      const model = chosen ? modelLabel(chosen) : null
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
        sourceName: source?.name ?? look.label,
        mark: look.mark,
        modelName: model,
      })
    }
  }
  chats.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      urgency(right) - urgency(left) ||
      right.at - left.at,
  )
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
