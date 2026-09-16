import type { Item } from '@harness/contracts'

export type SavedRecord = Record<string, unknown>

export function object(value: unknown): SavedRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as SavedRecord)
    : {}
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function contentBlocks(row: SavedRecord): SavedRecord[] {
  const content = object(row.message).content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.map(object) : []
}

export function isPrompt(row: SavedRecord): boolean {
  return (
    row.type === 'user' &&
    !row.isMeta &&
    !row.isCompactSummary &&
    contentBlocks(row).some((block) => block.type !== 'tool_result')
  )
}

function attachment(block: SavedRecord): string | undefined {
  const source = object(block.source)
  const filePath = string(block.file_path) ?? string(block.path) ?? string(source.path)
  if (filePath) return filePath
  if (source.type === 'url') return string(source.url)
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = string(source.media_type) ?? 'application/octet-stream'
    return `data:${mediaType};base64,${source.data}`
  }
  return undefined
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      const block = object(part)
      return string(block.text) ?? (attachment(block) ? '' : JSON.stringify(block, null, 2))
    })
    .join('\n')
}

function toolItem(block: SavedRecord, base: Item): Item {
  const name = string(block.name) ?? 'tool'
  const input = object(block.input)
  if (name === 'Bash' || name === 'PowerShell') {
    return { ...base, type: 'command', command: string(input.command) ?? name }
  }
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'MultiEdit') {
    const filePath = string(input.file_path) ?? string(input.notebook_path) ?? ''
    return { ...base, type: 'file_change', path: filePath, text: JSON.stringify(input, null, 2) }
  }
  return { ...base, type: 'tool_call', text: `${name}\n${JSON.stringify(input, null, 2)}` }
}

/** Keep each tool's result on its own typed item, including failed command output. */
export function historyItems(
  row: SavedRecord,
  turnId: string,
  at: number,
  tools: Map<string, Item>,
): Item[] {
  const blocks = contentBlocks(row)
  const rowId = String(row.uuid)
  const base = { turnId, status: 'completed' as const, createdAt: at }
  const userItems: Item[] = []
  if (row.type === 'user' && isPrompt(row)) {
    const attachments = blocks.flatMap((block) => {
      const ref = attachment(block)
      return ref ? [ref] : []
    })
    const text = blocks
      .filter((block) => block.type !== 'tool_result' && !attachment(block))
      .map((block) => string(block.text) ?? JSON.stringify(block))
      .join('\n')
    userItems.push({
      ...base,
      id: rowId,
      type: 'message',
      role: 'user',
      text,
      ...(attachments.length ? { attachments } : {}),
    })
  }
  return [
    ...userItems,
    ...blocks.flatMap((block, index): Item[] => {
      if (row.type === 'user' && block.type !== 'tool_result') return []
      const itemBase: Item = { ...base, id: `${rowId}:${index}`, type: 'unknown' }
      if (block.type === 'text') {
        return [
          {
            ...itemBase,
            type: row.isApiErrorMessage ? 'error' : 'message',
            role: 'assistant',
            text: string(block.text) ?? '',
          },
        ]
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        return [
          {
            ...itemBase,
            type: 'reasoning',
            text: string(block.thinking) ?? 'Thinking is not available in this saved conversation.',
          },
        ]
      }
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const item = toolItem(block, { ...itemBase, status: 'started' })
        const toolId = string(block.id)
        if (toolId) tools.set(toolId, item)
        return [item]
      }
      if (block.type === 'tool_result' || String(block.type).endsWith('_tool_result')) {
        const call = tools.get(string(block.tool_use_id) ?? '')
        const result = object(row.toolUseResult)
        const exitCode =
          typeof result.exitCode === 'number'
            ? result.exitCode
            : typeof result.code === 'number'
              ? result.code
              : undefined
        const text = blockText(block.content)
        const attachments = Array.isArray(block.content)
          ? block.content.flatMap((part) => {
              const ref = attachment(object(part))
              return ref ? [ref] : []
            })
          : []
        const item: Item = {
          ...itemBase,
          ...call,
          type: call?.type ?? 'tool_call',
          status: block.is_error ? 'failed' : 'completed',
          text: call?.text ? `${call.text}\n\n${text}` : text,
          ...(attachments.length ? { attachments } : {}),
          ...(call?.command ? { command: call.command } : {}),
          ...(call?.path ? { path: call.path } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
        }
        if (call) tools.set(string(block.tool_use_id) ?? '', item)
        return [item]
      }
      const ref = attachment(block)
      return [
        {
          ...itemBase,
          ...(ref
            ? { type: 'message', role: 'assistant', attachments: [ref] }
            : { text: JSON.stringify(block, null, 2) }),
        },
      ]
    }),
  ]
}
