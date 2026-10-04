import type { ComposerResource } from './ui/ComposerResourcePicker.js'

export const NEW_CHAT_DRAFT_KEY = 'new-chat'

export type ComposerDraft = {
  text: string
  attachments: string[]
  resources: ComposerResource[]
}

export function composerDraftKey(threadId: string | undefined): string {
  return threadId ?? NEW_CHAT_DRAFT_KEY
}

export function emptyComposerDraft(): ComposerDraft {
  return { text: '', attachments: [], resources: [] }
}

export function isEmptyComposerDraft(draft: ComposerDraft): boolean {
  return draft.text === '' && draft.attachments.length === 0 && draft.resources.length === 0
}

export function readComposerDraft(drafts: Map<string, ComposerDraft>, key: string): ComposerDraft {
  return drafts.get(key) ?? emptyComposerDraft()
}

export function upsertComposerDraft(
  drafts: Map<string, ComposerDraft>,
  key: string,
  patch: Partial<ComposerDraft>,
): ComposerDraft {
  const next = { ...emptyComposerDraft(), ...drafts.get(key), ...patch }
  if (isEmptyComposerDraft(next)) drafts.delete(key)
  else drafts.set(key, next)
  return next
}

export function moveComposerDraft(
  drafts: Map<string, ComposerDraft>,
  from: string,
  to: string,
): void {
  if (from === to) return
  const draft = drafts.get(from)
  drafts.delete(from)
  if (!draft || drafts.has(to)) return
  drafts.set(to, draft)
}
