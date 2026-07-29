import type { DomainEvent, Item, Usage } from '@harness/contracts'

/**
 * The Claude Code stream-json envelope, as the binary actually emits it.
 *
 * Typed by hand from observed output rather than from a published schema —
 * unlike Codex, there is no generator. That makes this the fragile end of the
 * adapter, so every field is optional and anything unrecognised becomes an
 * `unknown` item instead of throwing. Verified against claude-code 2.1.220.
 */

export type ClaudeEvent = {
  type?: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: {
    id?: string
    role?: string
    model?: string
    content?: ContentBlock[]
    usage?: ClaudeUsage
  }
  /** Present on `result`. */
  result?: string
  is_error?: boolean
  duration_ms?: number
  total_cost_usd?: number
  usage?: ClaudeUsage
}

type ContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string }

type ClaudeUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

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
      const id = `${event.message?.id ?? event.uuid ?? at}-${index}`
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
      const result = block as Extract<ContentBlock, { type: 'tool_result' }>
      const text = flattenContent(result.content)
      if (!text) return []
      return [
        {
          type: 'item.completed' as const,
          item: {
            id: `${result.tool_use_id ?? at}-result`,
            turnId,
            type: result.is_error ? ('error' as const) : ('tool_call' as const),
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
    const usage = toUsage(event.usage)
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

function blockToItem(
  block: ContentBlock,
  id: string,
  turnId: string,
  at: number,
): Item | undefined {
  const base = { id, turnId, status: 'completed' as const, createdAt: at }

  switch (block.type) {
    case 'text': {
      const text = (block as { text?: string }).text
      return text ? { ...base, type: 'message', role: 'assistant', text } : undefined
    }

    case 'thinking': {
      const text = (block as { thinking?: string }).thinking
      return text ? { ...base, type: 'reasoning', text } : undefined
    }

    case 'tool_use': {
      const call = block as Extract<ContentBlock, { type: 'tool_use' }>
      const name = call.name ?? 'tool'
      const input = call.input ?? {}

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
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
    .join('')
    .trim()
}

export function toUsage(usage: ClaudeUsage | undefined): Usage | undefined {
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
  }
}
