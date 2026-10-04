import type { DomainEvent, Item, Usage } from '@harness/contracts'
import { JsonRpcValueSchema } from '@harness/proc'
import { z } from 'zod'

/**
 * The Claude Code stream-json envelope, as the binary actually emits it.
 *
 * Typed by hand from observed output rather than from a published schema —
 * unlike Codex, there is no generator. That makes this the fragile end of the
 * adapter, so every field is optional and anything unrecognised becomes an
 * `unknown` item instead of throwing. Verified against claude-code 2.1.220.
 */

const JsonObjectSchema = z.record(z.string(), JsonRpcValueSchema)
const ResultPartSchema = z.union([z.string(), z.object({ text: z.string().optional() })])
const ToolResultContentSchema = z.union([z.string(), z.array(ResultPartSchema)])
const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: JsonObjectSchema.optional(),
  tool_use_id: z.string().optional(),
  content: ToolResultContentSchema.optional(),
  is_error: z.boolean().optional(),
})
const ClaudeUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
})
export const ClaudeEventSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
  message: z
    .object({
      id: z.string().optional(),
      role: z.string().optional(),
      model: z.string().optional(),
      content: z.array(ContentBlockSchema).optional(),
      usage: ClaudeUsageSchema.optional(),
    })
    .optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: ClaudeUsageSchema.optional(),
})

export type ClaudeEvent = z.infer<typeof ClaudeEventSchema>
type ContentBlock = z.infer<typeof ContentBlockSchema>
type ToolResultContent = z.infer<typeof ToolResultContentSchema>
type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>

/** Tools whose call is really a shell command, so it reads as one. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** Tools that write to disk. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * Translate one envelope into domain events.
 *
 * Returns a list because a single assistant message can carry text, thinking
 * and several tool calls at once — Claude Code batches where Codex streams.
 *
 * `tools` remembers each call by its tool_use id so the result that follows
 * lands on the same item: the call turns from started into completed (or
 * failed) with its output attached, the way the saved-history replay already
 * reads. Without the map a result has nothing to attach to and stands alone.
 */
export function toDomainEvents(
  event: ClaudeEvent,
  turnId: string,
  tools?: Map<string, Item>,
): DomainEvent[] {
  const at = Date.now()

  if (event.type === 'assistant' && event.message?.content) {
    return event.message.content.flatMap((block, index) => {
      const id = assistantBlockId(event, block, index, at)
      const item = blockToItem(block, id, turnId, at)
      if (!item) return []
      if (block.type === 'tool_use' && block.id && tools) {
        tools.set(block.id, item)
        return [{ type: 'item.completed' as const, item: { ...item, status: 'started' } }]
      }
      return [{ type: 'item.completed' as const, item }]
    })
  }

  if (event.type === 'user' && event.message?.content) {
    // Tool results come back as user messages. They belong to the tool call
    // that produced them, not to a new exchange, so they are not rendered as
    // the user speaking.
    return event.message.content.flatMap((block) => {
      if (block.type !== 'tool_result') return []
      const text = flattenContent(block.content)
      const call = block.tool_use_id ? tools?.get(block.tool_use_id) : undefined
      if (call && block.tool_use_id) {
        tools?.delete(block.tool_use_id)
        return [
          { type: 'item.completed' as const, item: completedCall(call, text, block.is_error) },
        ]
      }
      if (!text) return []
      return [
        {
          type: 'item.completed' as const,
          item: {
            id: `${block.tool_use_id ?? at}-result`,
            turnId,
            type: block.is_error ? ('error' as const) : ('tool_call' as const),
            status: 'completed' as const,
            text,
            createdAt: at,
          },
        },
      ]
    })
  }

  if (event.type === 'result') {
    const events: DomainEvent[] = []
    const usage = toUsage(event.usage, event.total_cost_usd)
    if (usage) events.push({ type: 'usage.updated', usage })
    events.push({
      type: 'turn.completed',
      turnId,
      status: event.is_error ? 'failed' : 'completed',
    })
    return events
  }

  return []
}

function assistantBlockId(
  event: ClaudeEvent,
  block: ContentBlock,
  index: number,
  fallback: number,
): string {
  if (block.type === 'tool_use') {
    if (block.id) return `${block.id}-call`
  }
  return `${event.message?.id ?? event.uuid ?? fallback}-${block.type}-${index}`
}

function blockToItem(
  block: ContentBlock,
  id: string,
  turnId: string,
  at: number,
): Item | undefined {
  const base = { id, turnId, status: 'completed' as const, createdAt: at }

  switch (block.type) {
    case 'text': {
      return block.text
        ? { ...base, type: 'message', role: 'assistant', text: block.text }
        : undefined
    }

    case 'thinking': {
      return block.thinking ? { ...base, type: 'reasoning', text: block.thinking } : undefined
    }

    case 'tool_use':
      return { ...base, ...toolUseItemFields(block.name ?? 'tool', block.input ?? {}) }

    default:
      return undefined
  }
}

type ToolInput = Record<string, unknown>

/**
 * What a tool_use block contributes to its item. Shell tools read as a
 * command, edit tools as a file change carrying the edit as a unified diff,
 * and everything else as a tool call whose text names the tool on the first
 * line and carries its input as one JSON line — the transcript's convention
 * for every provider.
 */
export function toolUseItemFields(
  name: string,
  input: ToolInput,
):
  | { type: 'command'; command: string }
  | { type: 'file_change'; path: string; text?: string; linesAdded?: number; linesRemoved?: number }
  | { type: 'tool_call'; text: string } {
  if (SHELL_TOOLS.has(name)) {
    return { type: 'command', command: String(input['command'] ?? name) }
  }
  if (EDIT_TOOLS.has(name)) {
    const path = String(input['file_path'] ?? input['notebook_path'] ?? '')
    const diff = editDiff(name, path, input)
    return {
      type: 'file_change',
      path,
      ...(diff
        ? {
            text: diff,
            linesAdded: diff.split('\n').filter((line) => /^\+(?!\+\+ )/.test(line)).length,
            linesRemoved: diff.split('\n').filter((line) => /^-(?!-- )/.test(line)).length,
          }
        : {}),
    }
  }
  const argumentLine = Object.keys(input).length ? JSON.stringify(input) : undefined
  return { type: 'tool_call', text: argumentLine ? `${name}\n${argumentLine}` : name }
}

/** A tool call whose result arrived: same item, finished, output attached. */
function completedCall(call: Item, output: string, failed: boolean | undefined): Item {
  const status = failed ? 'failed' : 'completed'
  if (call.type === 'command') return { ...call, status, ...(output ? { text: output } : {}) }
  if (call.type === 'file_change') {
    // The edit itself is the diff already on the item; a success message adds
    // nothing, but an error explains why the file did not change.
    return {
      ...call,
      status,
      ...(failed && output ? { text: [call.text, output].filter(Boolean).join('\n\n') } : {}),
    }
  }
  return { ...call, status, ...(output ? { text: `${call.text ?? ''}\n${output}` } : {}) }
}

/** The edit tools describe a change as strings; the transcript wants a diff. */
function editDiff(name: string, path: string, input: ToolInput): string | undefined {
  const lines = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\n$/, '').split('\n') : []
  const hunks: Array<{ removed: string[]; added: string[] }> = []
  if (name === 'Write') {
    hunks.push({ removed: [], added: lines(input['content']) })
  } else if (name === 'Edit') {
    hunks.push({ removed: lines(input['old_string']), added: lines(input['new_string']) })
  } else if (name === 'MultiEdit' && Array.isArray(input['edits'])) {
    for (const edit of input['edits'] as unknown[]) {
      const change = edit as Record<string, unknown>
      hunks.push({ removed: lines(change['old_string']), added: lines(change['new_string']) })
    }
  } else if (name === 'NotebookEdit') {
    hunks.push({
      removed: [],
      added: input['edit_mode'] === 'delete' ? [] : lines(input['new_source']),
    })
  }
  const body = hunks
    .filter((hunk) => hunk.removed.length > 0 || hunk.added.length > 0)
    .flatMap(({ removed, added }) => [
      `@@ -${removed.length ? `1,${removed.length}` : '0,0'} +${added.length ? `1,${added.length}` : '0,0'} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ])
  if (body.length === 0) return undefined
  return [
    `diff --git a/${path} b/${path}`,
    name === 'Write' ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
    ...body,
  ].join('\n')
}

/** Tool results are sometimes a string, sometimes a content-block array. */
function flattenContent(content: ToolResultContent | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (typeof part === 'string' ? part : (part.text ?? '')))
    .join('')
    .trim()
}

export function toUsage(usage: ClaudeUsage | undefined, costUsd?: number): Usage | undefined {
  if (!usage) return undefined
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cached = usage.cache_read_input_tokens ?? 0
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    // Claude Code does not report reasoning tokens separately.
    reasoningTokens: 0,
    totalTokens: input + output + cached + (usage.cache_creation_input_tokens ?? 0),
    inputIncludesCached: false,
    ...(!(costUsd === undefined) ? { costUsd } : {}),
  }
}
