import type { ThreadSettings } from '@harness/contracts'
import { choiceKeySource } from './model-catalog-visibility.js'
import { modelChoiceKey, sourceKey, type ModelChoice } from './model-catalog.js'

/** What this window remembers per chat: the choice key it shows, and the rest of the setup. */
export type LocalThreadSelection = {
  modelKey: string
  effort?: string
  serviceTier?: string
  designMode?: boolean
}

type SessionSource = {
  provider: ModelChoice['provider']
  agent?: string | undefined
  connectionId?: string | undefined
}

type SharedSetup = Pick<ThreadSettings, 'model' | 'effort' | 'serviceTier'>

/** The model id inside a choice key; `automatic` stands for the provider's own default. */
export function modelIdFromKey(key: string): string {
  const id = decodeURIComponent(key.slice(key.lastIndexOf(':') + 1))
  return id === 'automatic' ? '' : id
}

/** The part of a selection every client shares through the server. */
export function sharedSetup(selection: LocalThreadSelection): SharedSetup {
  return {
    model: modelIdFromKey(selection.modelKey),
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  }
}

/**
 * The selection to keep for a chat whose shared setup arrived from the
 * server, or undefined when the window already shows exactly that. The key
 * stays the one the window knows when the model is the same; otherwise it is
 * the visible choice for that model in the chat's own source.
 */
export function adoptedSelection(
  settings: ThreadSettings,
  saved: LocalThreadSelection | undefined,
  session: SessionSource | undefined,
  choices: readonly ModelChoice[],
): LocalThreadSelection | undefined {
  if (settings.model === undefined) return undefined
  if (
    saved &&
    modelIdFromKey(saved.modelKey) === settings.model &&
    saved.effort === settings.effort &&
    saved.serviceTier === settings.serviceTier
  )
    return undefined
  // Matched the way opening a chat matches choices: by provider, agent and
  // connection, so a chat on another account finds its model too.
  const source = session
    ? sourceKey({
        provider: session.provider,
        connectionId: session.connectionId,
        agentId: session.agent,
      })
    : saved
      ? choiceKeySource(saved.modelKey)
      : undefined
  if (source === undefined) return undefined
  const sameModel = saved && modelIdFromKey(saved.modelKey) === settings.model
  const visible = choices.find(
    (choice) =>
      choice.model.id === settings.model &&
      sourceKey({
        provider: choice.provider,
        connectionId: choice.connectionId,
        agentId: choice.agent?.id,
      }) === source,
  )
  return {
    modelKey: sameModel ? saved.modelKey : (visible?.key ?? modelChoiceKey(source, settings.model)),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(saved?.designMode !== undefined ? { designMode: saved.designMode } : {}),
  }
}

type ListedChat = { id: string; model?: string | undefined }

/**
 * Shares the setups this window kept for chats the server names no model for,
 * so a chat set up before the server kept setups shows and filters by its
 * model on every client. All go at once, so the server's list notices for
 * them arrive as one. Returns how many were shared.
 */
export async function shareSavedSetups(
  chats: readonly ListedChat[],
  saved: (threadId: string) => LocalThreadSelection | undefined,
  share: (threadId: string, setup: SharedSetup) => Promise<unknown>,
): Promise<number> {
  const pending: Array<Promise<unknown>> = []
  for (const chat of chats) {
    if (chat.model !== undefined) continue
    const selection = saved(chat.id)
    if (!selection) continue
    const setup = sharedSetup(selection)
    // The provider's own default names no model; the chat shares it when opened.
    if (!setup.model) continue
    pending.push(share(chat.id, setup))
  }
  const results = await Promise.allSettled(pending)
  return results.filter((result) => result.status === 'fulfilled').length
}
