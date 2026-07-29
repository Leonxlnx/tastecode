import type { Item, ItemStatus } from '@harness/contracts'
import type { ThreadItem } from './generated/v2/ThreadItem'

/**
 * Translate a Codex `ThreadItem` into our provider-agnostic `Item`.
 *
 * Codex's union is much wider than ours and grows with every release. Anything
 * we do not map explicitly becomes an `unknown` item carrying its raw type name,
 * which the UI renders as plain text. That is deliberate: dropping unrecognised
 * output would silently lose work the agent actually did, and throwing would
 * break a session because the vendor shipped a new item kind.
 */
export function mapThreadItem(
  raw: ThreadItem,
  context: { turnId: string; status: ItemStatus; createdAt: number },
): Item {
  const base = {
    id: itemId(raw),
    turnId: context.turnId,
    status: context.status,
    createdAt: context.createdAt,
  }

  switch (raw.type) {
    case 'userMessage':
      return { ...base, type: 'message', role: 'user', text: userInputToText(raw.content) }

    case 'agentMessage':
      return { ...base, type: 'message', role: 'assistant', text: raw.text }

    case 'reasoning':
      return {
        ...base,
        type: 'reasoning',
        text: [...raw.summary, ...raw.content].join('\n\n'),
      }

    case 'plan':
      return { ...base, type: 'plan', text: raw.text }

    case 'commandExecution':
      return {
        ...base,
        type: 'command',
        command: raw.command,
        ...(raw.aggregatedOutput === null ? {} : { text: raw.aggregatedOutput }),
        ...(raw.exitCode === null ? {} : { exitCode: raw.exitCode }),
        ...(raw.durationMs === null ? {} : { durationMs: raw.durationMs }),
      }

    case 'fileChange': {
      // Codex reports a batch of file edits as one item; we surface the first
      // path and the aggregate counts until the diff view exists (M3).
      const first = raw.changes[0]
      return {
        ...base,
        type: 'file_change',
        ...(first === undefined ? {} : { path: String(first.path) }),
        text: `${raw.changes.length} file(s) changed`,
      }
    }

    case 'mcpToolCall':
      return {
        ...base,
        type: 'tool_call',
        text: `${raw.server}.${raw.tool}`,
        ...(raw.durationMs === null ? {} : { durationMs: raw.durationMs }),
      }

    case 'dynamicToolCall':
      return { ...base, type: 'tool_call', text: raw.tool }

    case 'webSearch':
      return { ...base, type: 'tool_call', text: 'web search' }

    default:
      return { ...base, type: 'unknown', text: `[${raw.type}]` }
  }
}

/** Every Codex item variant carries an id except the ones we treat as unknown. */
function itemId(raw: ThreadItem): string {
  const candidate = (raw as { id?: unknown }).id
  return typeof candidate === 'string' ? candidate : crypto.randomUUID()
}

function userInputToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}
