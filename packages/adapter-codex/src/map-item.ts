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

    case 'collabAgentToolCall': {
      const failed = failedAgentCount(raw)
      const targets = new Set([...raw.receiverThreadIds, ...Object.keys(raw.agentsStates)]).size
      const status: ItemStatus =
        raw.status === 'failed' || failed > 0
          ? 'failed'
          : raw.status === 'inProgress'
            ? 'started'
            : 'completed'
      return {
        ...base,
        type: 'tool_call',
        status,
        text: collabAgentLabel(raw.tool, status, targets, failed),
      }
    }

    case 'subAgentActivity':
      return {
        ...base,
        type: 'tool_call',
        status: raw.kind === 'interrupted' ? 'failed' : context.status,
        text:
          raw.kind === 'started'
            ? 'Subagent started'
            : raw.kind === 'interrupted'
              ? 'Subagent interrupted'
              : 'Subagent active',
      }

    case 'webSearch':
      return { ...base, type: 'tool_call', text: 'web search' }

    default:
      return { ...base, type: 'unknown', text: `[${raw.type}]` }
  }
}

function failedAgentCount(raw: Extract<ThreadItem, { type: 'collabAgentToolCall' }>): number {
  return Object.values(raw.agentsStates).filter(
    (state) =>
      state?.status === 'errored' ||
      state?.status === 'notFound' ||
      state?.status === 'interrupted',
  ).length
}

function collabAgentLabel(
  tool: Extract<ThreadItem, { type: 'collabAgentToolCall' }>['tool'],
  status: ItemStatus,
  targets: number,
  failed: number,
): string {
  if (failed > 0) {
    return targets > 1 ? `${failed} of ${targets} subagents failed` : 'Subagent failed'
  }

  const plural = targets > 1
  switch (tool) {
    case 'spawnAgent':
      if (status === 'failed') return 'Could not spawn a subagent'
      if (status === 'started') return plural ? 'Spawning subagents' : 'Spawning a subagent'
      return plural ? `Spawned ${targets} subagents` : 'Spawned a subagent'
    case 'wait':
      if (status === 'failed') return 'Subagent wait failed'
      if (status === 'started') return 'Waiting for subagents'
      return plural ? `${targets} subagents finished` : 'Subagent finished'
    case 'sendInput':
      return status === 'started' ? 'Sending input to a subagent' : 'Sent input to a subagent'
    case 'resumeAgent':
      return status === 'started' ? 'Resuming a subagent' : 'Resumed a subagent'
    case 'closeAgent':
      return status === 'started' ? 'Closing a subagent' : 'Closed a subagent'
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
