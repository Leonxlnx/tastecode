import type { Item } from '@harness/contracts'
import { toolUseItemFields } from './events.js'

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

// Claude Code saves a Stop as a user row holding only one of these texts, and shows
// that row as a notice on the interrupted turn rather than as a prompt.
const INTERRUPT_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

export function isInterruptMarker(row: SavedRecord): boolean {
  const blocks = contentBlocks(row).filter((block) => block.type !== 'tool_result')
  return (
    row.type === 'user' &&
    blocks.length > 0 &&
    blocks.every(
      (block) => block.type === 'text' && INTERRUPT_MARKERS.has(string(block.text) ?? ''),
    )
  )
}

// Claude Code saves a slash command it ran (a skill, a custom command, a name it does
// not know) as a user row of these tags instead of the text that was typed:
//   <command-name>/name</command-name>
//   <command-message>name</command-message>
//   <command-args>the rest of the prompt</command-args>
// Older versions put the message tag first. Captured from claude 2.1.296.
const COMMAND_TAG = /<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/g
// What a local command printed, saved as a user row of its own after the command.
const COMMAND_OUTPUT =
  /^\s*<(local-command-stdout|local-command-stderr|command-stdout|command-stderr)>([\s\S]*)<\/\1>\s*$/

/** The only text of a user row, or undefined when it holds anything else. */
function soleText(row: SavedRecord): string | undefined {
  if (row.type !== 'user') return undefined
  const blocks = contentBlocks(row)
  return blocks.length === 1 && blocks[0]!.type === 'text' ? string(blocks[0]!.text) : undefined
}

/** `/name args` for a saved slash-command row: what the user typed and TasteCode sent. */
export function slashCommandPrompt(row: SavedRecord): string | undefined {
  const text = soleText(row)
  if (!text?.trimStart().startsWith('<command-')) return undefined
  const tags = new Map<string, string>()
  // The row must be these tags and nothing else, so a prompt that only quotes one stays text.
  const rest = text.replace(COMMAND_TAG, (_match, tag: string, value: string) => {
    tags.set(tag, value)
    return ''
  })
  const name = tags.get('command-name')?.trim()
  if (rest.trim() !== '' || !name) return undefined
  const command = name.startsWith('/') ? name : `/${name}`
  const args = tags.get('command-args')?.trim()
  return args ? `${command} ${args}` : command
}

/** What a local command printed, from a row Claude Code saved after the command. */
export function slashCommandOutput(row: SavedRecord): string | undefined {
  const text = soleText(row)
  return text === undefined ? undefined : COMMAND_OUTPUT.exec(text)?.[2]
}

export function isPrompt(row: SavedRecord): boolean {
  return (
    row.type === 'user' &&
    !row.isMeta &&
    !row.isCompactSummary &&
    contentBlocks(row).some((block) => block.type !== 'tool_result') &&
    !isInterruptMarker(row) &&
    slashCommandOutput(row) === undefined
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
  return { ...base, ...toolUseItemFields(string(block.name) ?? 'tool', object(block.input)) }
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
  const rowItems: Item[] = []
  if (row.type === 'user' && isPrompt(row)) {
    const attachments = blocks.flatMap((block) => {
      const ref = attachment(block)
      return ref ? [ref] : []
    })
    const text =
      slashCommandPrompt(row) ??
      blocks
        .filter((block) => block.type !== 'tool_result' && !attachment(block))
        .map((block) => string(block.text) ?? JSON.stringify(block))
        .join('\n')
    rowItems.push({
      ...base,
      id: rowId,
      type: 'message',
      role: 'user',
      text,
      ...(attachments.length ? { attachments } : {}),
    })
  }
  // The SDK shows a local command's output as assistant-style text, never as a prompt.
  const output = slashCommandOutput(row)?.trim()
  if (output) {
    rowItems.push({ ...base, id: rowId, type: 'message', role: 'assistant', text: output })
  }
  return [
    ...rowItems,
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
        // A finished edit keeps its diff alone, as the live item does: the diff view
        // would show Claude's success message as lines of the file.
        const edited = call?.type === 'file_change' && !block.is_error
        const item: Item = {
          ...itemBase,
          ...call,
          type: call?.type ?? 'tool_call',
          status: block.is_error ? 'failed' : 'completed',
          ...(edited ? {} : { text: call?.text ? `${call.text}\n\n${text}` : text }),
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
