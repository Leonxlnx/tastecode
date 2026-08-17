import type { DomainEvent, Item, Usage } from '@harness/contracts'
import { JsonRpcValueSchema } from '@harness/proc'
import { z } from 'zod'
import { propertiesWhen } from './properties-when.js'

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
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

/**
 * Translate one envelope into domain events.
 *
 * Returns a list because a single assistant message can carry text, thinking
 * and several tool calls at once — Claude Code batches where Codex streams.
 */
export function toDomainEvents(event: ClaudeEvent, turnId: string): DomainEvent[] {
  const at = Date.now()

  if (event.type === 'assistant' && event.message?.content) {
    return event.message.content.flatMap((block, index) => {
      const id = assistantBlockId(event, block, index, at)
      const item = blockToItem(block, id, turnId, at)
      return item ? [{ type: 'item.completed' as const, item }] : []
    })
  }

  if (event.type === 'user' && event.message?.content) {
    // Tool results come back as user messages. They belong to the tool call
    // that produced them, not to a new exchange, so they are not rendered as
    // the user speaking.
    return event.message.content.flatMap((block) => {
      if (block.type !== 'tool_result') return []
      const text = flattenContent(block.content)
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

    case 'tool_use': {
      const name = block.name ?? 'tool'
      const input = block.input ?? {}

      if (SHELL_TOOLS.has(name)) {
        return { ...base, type: 'command', command: String(input['command'] ?? name) }
      }
      if (EDIT_TOOLS.has(name)) {
        return { ...base, type: 'file_change', path: String(input['file_path'] ?? '') }
      }
      return { ...base, type: 'tool_call', text: name }
    }

    default:
      return undefined
  }
}

/** Tool results are sometimes a string, sometimes a content-block array. */
function flattenContent(content: ToolResultContent | undefined): string {
  if (content === undefined) return ''
  const text = z.string().safeParse(content)
  if (text.success) return text.data
  return z
    .array(ResultPartSchema)
    .parse(content)
    .map((part) => {
      const partText = z.string().safeParse(part)
      return partText.success
        ? partText.data
        : (z.object({ text: z.string().optional() }).parse(part).text ?? '')
    })
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
    ...propertiesWhen(!(costUsd === undefined), () => ({ costUsd })),
  }
}
