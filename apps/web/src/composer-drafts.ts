import { z } from 'zod'
import type { ComposerResource } from './ui/ComposerResourcePicker.js'

export const NEW_CHAT_DRAFT_KEY = 'new-chat'

/**
 * Each project has a New chat draft of its own. The one New chat shows is under
 * NEW_CHAT_DRAFT_KEY; a project's draft waits here while New chat shows another project.
 */
export function parkedNewChatDraftKey(projectPath: string): string {
  return `${NEW_CHAT_DRAFT_KEY}:${projectPath}`
}

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

/**
 * Moves a draft to another key. What is already drafted there stays, in front
 * of it: neither of two unsent prompts is dropped.
 */
export function joinComposerDraft(
  drafts: Map<string, ComposerDraft>,
  from: string,
  to: string,
): void {
  if (from === to) return
  const moving = drafts.get(from)
  drafts.delete(from)
  if (!moving) return
  const kept = drafts.get(to)
  drafts.set(
    to,
    kept
      ? {
          text: [kept.text, moving.text].filter(Boolean).join('\n\n'),
          attachments: [...new Set([...kept.attachments, ...moving.attachments])],
          resources: [
            ...kept.resources,
            ...moving.resources.filter(
              (resource) => !kept.resources.some((held) => held.key === resource.key),
            ),
          ],
        }
      : moving,
  )
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

function serializeComposerDrafts(drafts: ReadonlyMap<string, ComposerDraft>): string | undefined {
  const restorable = [...drafts].filter(([key]) => !key.startsWith('pending:'))
  return restorable.length > 0 ? JSON.stringify(Object.fromEntries(restorable)) : undefined
}

/**
 * Saves the drafts through `write`, which says whether storage took them, and returns what
 * storage now holds, or undefined when it was left as it was. `stored` is what the last
 * successful save wrote. When storage refuses the drafts (the quota is full, say after a
 * pasted log of several MB), the draft that grew most since that save goes back to its saved
 * version, or out when it was never saved, and the write is retried. A failed write never
 * leaves storage worse: a saved draft that did not change is never reduced, and when nothing
 * fits nothing is written or removed. Memory keeps every draft, and the next save tries the
 * full set again. Drafts `keeps` names are never set back.
 */
export function saveComposerDrafts(
  drafts: ReadonlyMap<string, ComposerDraft>,
  stored: ReadonlyMap<string, ComposerDraft>,
  write: (drafts: string | undefined) => boolean,
  keeps: (key: string) => boolean = () => false,
): ReadonlyMap<string, ComposerDraft> | undefined {
  const target = new Map([...drafts].filter(([key]) => !key.startsWith('pending:')))
  if (write(serializeComposerDrafts(target))) return target
  const size = (draft: ComposerDraft | undefined) => (draft ? JSON.stringify(draft).length : 0)
  const growth = (key: string) => size(target.get(key)) - size(stored.get(key))
  const grown = [...target.keys()]
    .filter((key) => !keeps(key) && growth(key) > 0)
    .sort((left, right) => growth(right) - growth(left))
  for (const key of grown) {
    const saved = stored.get(key)
    if (saved) target.set(key, saved)
    else target.delete(key)
    if (sameDrafts(target, stored)) return undefined
    if (write(serializeComposerDrafts(target))) return target
  }
  return undefined
}

function sameDrafts(
  left: ReadonlyMap<string, ComposerDraft>,
  right: ReadonlyMap<string, ComposerDraft>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, draft] of left) {
    const other = right.get(key)
    if (!other || JSON.stringify(other) !== JSON.stringify(draft)) return false
  }
  return true
}
