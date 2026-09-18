import type { Item } from '@harness/contracts'
import { object } from './history-values.js'

type Value = Record<string, unknown>
type Base = Pick<Item, 'id' | 'turnId' | 'createdAt' | 'status'>
export type HistoryItem = { item: Item; diff?: string }

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === 'string' ? part : text(object(part).text ?? object(part).content),
      )
      .join('')
  return ''
}

function printable(value: unknown): string {
  return (
    text(value) || (value === undefined || value === null ? '' : JSON.stringify(value, null, 2))
  )
}

function attachments(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((raw) => {
    const part = object(raw)
    const type = String(part.type).toLowerCase().replaceAll('_', '')
    if (!type.includes('image') && !type.includes('audio')) return []
    const url = part.path ?? part.image_url ?? part.url ?? part.file_path
    if (typeof url === 'string') return [url]
    const nested = object(url).url
    if (typeof nested === 'string') return [nested]
    if (typeof part.data === 'string' && typeof part.mimeType === 'string')
      return [`data:${part.mimeType};base64,${part.data}`]
    return []
  })
}

function message(payload: Value, base: Base, role: 'user' | 'assistant'): HistoryItem[] {
  const images = attachments(payload.content)
  const phase = payload.phase ?? payload.channel
  return [
    {
      item: {
        ...base,
        type: 'message',
        role,
        text: text(payload.text ?? payload.content),
        ...(images.length ? { attachments: images } : {}),
        ...(phase === 'commentary' || phase === 'final_answer'
          ? { phase }
          : phase === 'final'
            ? { phase: 'final_answer' }
            : {}),
      },
    },
  ]
}

function duration(payload: Value): Pick<Item, 'durationMs'> {
  if (typeof payload.durationMs === 'number') return { durationMs: payload.durationMs }
  const value = object(payload.duration)
  return typeof value.secs === 'number'
    ? { durationMs: value.secs * 1000 + Number(value.nanos ?? 0) / 1e6 }
    : {}
}

export function historyItem(payload: Value, original: Base): HistoryItem[] {
  const failed =
    /failed|declined|error/i.test(String(payload.status)) ||
    payload.success === false ||
    object(payload.result).isError === true
  const base = { ...original, status: failed ? ('failed' as const) : original.status }
  const type = String(payload.type).replace(/^[a-z]/, (character) => character.toUpperCase())
  switch (type) {
    case 'UserMessage':
      return message(payload, base, 'user')
    case 'AgentMessage':
      return message(payload, base, 'assistant')
    case 'Reasoning': {
      const paragraphs = (value: unknown) =>
        Array.isArray(value)
          ? value
              .map((part) => text(typeof part === 'string' ? part : object(part).text))
              .filter(Boolean)
              .join('\n\n')
          : text(value)
      const value = [
        paragraphs(payload.summary_text ?? payload.summary),
        paragraphs(payload.raw_content ?? payload.content),
      ]
        .filter(Boolean)
        .join('\n\n')
      return value ? [{ item: { ...base, type: 'reasoning', text: value } }] : []
    }
    case 'Plan':
      return [{ item: { ...base, type: 'plan', text: text(payload.text ?? payload.content) } }]
    case 'CommandExecution': {
      const command = Array.isArray(payload.command)
        ? payload.command.map(String).join(' ')
        : String(payload.command ?? '')
      return [
        {
          item: {
            ...base,
            type: 'command',
            command,
            text:
              text(payload.aggregated_output ?? payload.aggregatedOutput) ||
              [text(payload.stdout), text(payload.stderr)].filter(Boolean).join('\n'),
            ...(typeof (payload.exit_code ?? payload.exitCode) === 'number'
              ? { exitCode: Number(payload.exit_code ?? payload.exitCode) }
              : {}),
            ...duration(payload),
          },
        },
      ]
    }
    case 'FileChange': {
      const changes: Array<[string, Value]> = Array.isArray(payload.changes)
        ? payload.changes.map((entry) => [String(object(entry).path ?? ''), object(entry)])
        : Object.entries(object(payload.changes)).map(([file, value]) => [file, object(value)])
      return changes.map(([file, change], index) => {
        const kind = String(
          change.type ?? object(change.kind).type ?? change.kind ?? 'update',
        ).toLowerCase()
        let body = text(change.unified_diff ?? change.diff ?? change.content)
        if ((kind === 'add' || kind === 'delete') && typeof change.content === 'string') {
          const lines = change.content.split('\n')
          if (lines.at(-1) === '') lines.pop()
          body =
            kind === 'add'
              ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
              : `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}\n`
        }
        const diff = body.startsWith('diff --git')
          ? body
          : `diff --git a/${file} b/${file}\n--- ${kind === 'add' ? '/dev/null' : `a/${file}`}\n+++ ${kind === 'delete' ? '/dev/null' : `b/${file}`}\n${body}`
        return {
          item: {
            ...base,
            id: `${base.id}:file:${index}`,
            type: 'file_change',
            path: file,
            text: body || `${kind} ${file}`,
            linesAdded: body
              .split('\n')
              .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
            linesRemoved: body
              .split('\n')
              .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
          },
          ...(body ? { diff } : {}),
        }
      })
    }
    case 'McpToolCall':
    case 'DynamicToolCall': {
      const result = object(payload.result)
      const content = result.content ?? payload.content_items ?? payload.contentItems
      const images = attachments(content)
      return [
        {
          item: {
            ...base,
            type: 'tool_call',
            ...duration(payload),
            text: [
              payload.server
                ? `${String(payload.server)}.${String(payload.tool)}`
                : String(payload.tool ?? 'Tool'),
              printable(payload.arguments),
              printable(content ?? payload.result ?? payload.error),
            ]
              .filter(Boolean)
              .join('\n\n'),
            ...(images.length ? { attachments: images } : {}),
          },
        },
      ]
    }
    case 'ImageView':
      return [
        {
          item: {
            ...base,
            type: 'tool_call',
            text: `View image\n${String(payload.path ?? '')}`,
            ...(typeof payload.path === 'string' ? { attachments: [payload.path] } : {}),
          },
        },
      ]
    case 'ContextCompaction':
      return [{ item: { ...base, type: 'tool_call', text: 'Context compacted' } }]
    case 'SubAgentActivity':
      return [
        {
          item: {
            ...base,
            type: 'tool_call',
            text: `Subagent ${String(payload.kind ?? 'activity')}\n${String(payload.agent_path ?? '')}`,
          },
        },
      ]
    default:
      return [{ item: { ...base, type: 'unknown', text: printable(payload) } }]
  }
}

export function responseItem(payload: Value, base: Base, output?: unknown): HistoryItem[] {
  switch (payload.type) {
    case 'message': {
      if (payload.role !== 'user' && payload.role !== 'assistant') return []
      if (payload.role === 'assistant' && payload.channel === 'analysis') {
        const value = text(payload.content)
        return value ? [{ item: { ...base, type: 'reasoning', text: value } }] : []
      }
      return message(payload, base, payload.role)
    }
    case 'agent_message':
      return [
        { item: { ...base, type: 'tool_call', text: `Agent message\n${text(payload.content)}` } },
      ]
    case 'reasoning':
      return historyItem({ ...payload, type: 'Reasoning' }, base)
    case 'function_call':
    case 'custom_tool_call': {
      const name = String(payload.name ?? 'Tool')
      const input = payload.arguments ?? payload.input
      const args = typeof input === 'string' ? parseObject(input) : object(input)
      const command = args.cmd ?? args.command
      const result = typeof output === 'string' ? parseObject(output) : object(output)
      const isCommand = /(?:^|[._])(?:exec_command|shell_command|shell)$/.test(name)
      const images = attachments(output)
      if (isCommand && (typeof command === 'string' || Array.isArray(command))) {
        return [
          {
            item: {
              ...base,
              type: 'command',
              command: Array.isArray(command) ? command.join(' ') : command,
              text: printable(result.output ?? output),
              ...(typeof result.exit_code === 'number'
                ? {
                    exitCode: result.exit_code,
                    status: result.exit_code === 0 ? 'completed' : 'failed',
                  }
                : {}),
            },
          },
        ]
      }
      return [
        {
          item: {
            ...base,
            type: 'tool_call',
            text: [name, printable(input), printable(output)].filter(Boolean).join('\n\n'),
            ...(images.length ? { attachments: images } : {}),
          },
        },
      ]
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      return []
    case 'web_search_call':
      return [
        { item: { ...base, type: 'tool_call', text: `Web search\n${printable(payload.action)}` } },
      ]
    case 'image_generation_call':
      return [
        {
          item: {
            ...base,
            type: 'tool_call',
            text: 'Image generated',
            ...(typeof payload.result === 'string'
              ? {
                  attachments: [
                    payload.result.startsWith('data:')
                      ? payload.result
                      : `data:image/png;base64,${payload.result}`,
                  ],
                }
              : {}),
          },
        },
      ]
    default:
      return [{ item: { ...base, type: 'unknown', text: printable(payload) } }]
  }
}

function parseObject(value: string): Value {
  try {
    return object(JSON.parse(value))
  } catch {
    return {}
  }
}
