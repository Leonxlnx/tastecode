import type { ApprovalMode } from '@harness/contracts'
import { connection, projects, sessions } from './app'
import { preferences, type SourceRef } from './catalog'
import type { ThreadSession } from './thread-session'

export type NewChatChoice = {
  projectPath: string
  source: SourceRef
  model: string | undefined
  effort: string | undefined
  /** A faster routing the model offers, such as Fast; absent is the standard one. */
  serviceTier?: string | undefined
  approval: ApprovalMode
  /** Work in a private git checkout instead of the project folder itself. */
  isolate: boolean
}

const NEW_CHAT_KEY = 'new-chat'

export function readNewChatChoice(): Partial<NewChatChoice> {
  return preferences.read<Partial<NewChatChoice>>(NEW_CHAT_KEY) ?? {}
}

export function rememberNewChatChoice(choice: NewChatChoice): void {
  preferences.write(NEW_CHAT_KEY, choice)
}

/** The desktop's rule, so a chat reads the same in both lists before its title is generated. */
export function titleFrom(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 40 ? `${Array.from(clean).slice(0, 40).join('')}…` : clean
}

/**
 * Starts a chat and sends its first prompt, the way the desktop does: start,
 * name it after the prompt, send, then let the background model write a better
 * title. The session exists before the prompt goes out, so no event is missed.
 */
export async function startChat(
  choice: NewChatChoice,
  text: string,
  attachments: string[],
): Promise<{ threadId: string; session: ThreadSession }> {
  const { source } = choice
  const { threadId } = await connection.request('thread.start', {
    provider: source.provider,
    workspacePath: choice.projectPath,
    approval: choice.approval,
    ...(source.agent ? { agent: source.agent } : {}),
    ...(source.connectionId ? { connectionId: source.connectionId } : {}),
    ...(source.accountId ? { accountId: source.accountId } : {}),
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
    ...(choice.isolate ? { isolate: true } : {}),
  })
  // The computer keeps the chat's setup from here on; this only seeds the next new chat.
  rememberNewChatChoice(choice)
  projects.touch(threadId)
  const session = sessions.acquire(threadId)
  const localId = session.addLocalMessage(text, attachments)
  const title = titleFrom(text)
  void connection
    .request('thread.rename', { threadId, title })
    .then(() =>
      connection.request('backgroundModel.generateTitle', {
        threadId,
        prompt: text,
        expectedTitle: title,
      }),
    )
    .then(() => projects.refreshSoon())
    .catch(() => undefined)
  try {
    await session.send(
      text,
      attachments,
      {
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
      },
      localId,
    )
  } finally {
    sessions.release(threadId)
  }
  return { threadId, session }
}
