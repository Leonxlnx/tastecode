import { z } from 'zod'
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

const SavedComposerDraftsSchema = z.record(
  z.string(),
  z.object({
    text: z.string(),
    attachments: z.array(z.string()),
    resources: z.array(
      z.object({
        key: z.string(),
        // A command is typed into the text as `/name`, never kept as a chip.
        kind: z.enum({ skill: 'skill', mcp: 'mcp' } satisfies {
          [Kind in Exclude<ComposerResource['kind'], 'command'>]: Kind
        }),
        id: z.string(),
        name: z.string(),
        description: z.string(),
        scope: z.string(),
        token: z.string(),
        available: z.boolean(),
        unavailableReason: z.string().optional(),
      }),
    ),
  }),
)

export function parseComposerDrafts(saved: string | null): Map<string, ComposerDraft> {
  if (!saved) return new Map()
  try {
    return new Map(Object.entries(SavedComposerDraftsSchema.parse(JSON.parse(saved))))
  } catch {
    return new Map()
  }
}

export function serializeComposerDrafts(
  drafts: ReadonlyMap<string, ComposerDraft>,
): string | undefined {
  const restorable = [...drafts].filter(([key]) => !key.startsWith('pending:'))
  return restorable.length > 0 ? JSON.stringify(Object.fromEntries(restorable)) : undefined
}
