/**
 * Every adapter writes a tool call into `Item.text` the same way, so the
 * transcript can read any provider without knowing which one it was:
 *
 *   line 1        the tool's name, or a human label the adapter already chose
 *   next value    optionally its arguments as one JSON object or array,
 *                 compact or pretty-printed, possibly after a blank line
 *   the rest      whatever the tool printed or returned
 *
 * Older persisted rows put the tool's result payload on the first line itself
 * (`grep [ ... ]`); everything after such a name is output, never arguments.
 */
export type ToolCall = {
  name: string
  args: Record<string, unknown> | unknown[] | undefined
  output: string | undefined
}

export function parseToolCall(text: string | undefined): ToolCall {
  const source = text ?? ''
  const newline = source.indexOf('\n')
  const firstLine = (newline === -1 ? source : source.slice(0, newline)).trim()
  const rest = newline === -1 ? '' : source.slice(newline + 1)

  const inline = firstLine.search(/\s[[{]/)
  if (inline > 0) {
    return withLazyOutput(firstLine.slice(0, inline).trim(), undefined, () =>
      readableOutput(`${firstLine.slice(inline + 1)}\n${rest}`.trim()),
    )
  }

  const start = rest.search(/\S/)
  const trimmed = start === -1 ? '' : rest.slice(start)
  const json =
    trimmed.startsWith('{') || trimmed.startsWith('[') ? readJsonValue(trimmed) : undefined
  const args = json?.value
  return withLazyOutput(firstLine, isRecord(args) || Array.isArray(args) ? args : undefined, () => {
    const output = (json ? trimmed.slice(json.end) : rest).trim()
    return output ? readableOutput(output) : undefined
  })
}

/**
 * Rows read a tool's name and arguments on every render; only an open detail
 * reads its output. A tool that returned a screenshot as JSON made each name
 * lookup parse hundreds of kilobytes.
 */
function withLazyOutput(
  name: string,
  args: ToolCall['args'],
  readOutput: () => string | undefined,
): ToolCall {
  let output: { value: string | undefined } | undefined
  return {
    name,
    args,
    get output() {
      output ??= { value: readOutput() }
      return output.value
    },
  }
}

/**
 * The one argument worth putting next to the tool's name while it runs: the
 * thing it is acting on. Prefers the keys tools conventionally use for that,
 * then falls back to the first string value.
 */
export function toolArgumentSnippet(args: ToolCall['args'], limit = 72): string | undefined {
  if (!args) return undefined
  const candidates = Array.isArray(args)
    ? args
    : [
        ...PREFERRED_ARGUMENT_KEYS.map((key) => args[key]),
        ...Object.values(args).filter((value) => typeof value === 'string'),
      ]
  const value = candidates.find((entry) => typeof entry === 'string' && entry.trim().length > 0)
  if (typeof value !== 'string') return undefined
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1).trimEnd()}…` : oneLine
}

const PREFERRED_ARGUMENT_KEYS = [
  'query',
  'command',
  'code',
  'path',
  'file_path',
  'url',
  'pattern',
  'prompt',
  'description',
  'text',
]

/** Arguments as rows to render, with values flattened to readable text. */
export function toolArgumentEntries(args: ToolCall['args']): Array<[string, string]> {
  if (!args) return []
  const entries = Array.isArray(args)
    ? args.map((value, index) => [String(index), value] as const)
    : Object.entries(args)
  return entries.flatMap(([key, value]) => {
    const text = readableValue(value)
    return text === undefined ? [] : [[key, text]]
  })
}

function readableValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((entry) => typeof entry !== 'object')) {
    return value.map(String).join(', ')
  }
  return JSON.stringify(value, null, 2)
}

/**
 * Output that is itself JSON (an MCP result, a wrapped stdout) reads as its
 * text. Structured output with nothing to say — an empty stdout, a bare
 * status record — reads as no output rather than as its JSON.
 */
function readableOutput(output: string): string | undefined {
  const values = parseJsonSequence(output)
  if (!values) return output
  const parts = values
    .map((value) => readableToolJson(value))
    .filter((value): value is string => value !== undefined)
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join('\n') : undefined
}

export function readableToolJson(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return readableToolJson(JSON.parse(trimmed) as unknown, depth + 1) ?? value
      } catch {
        return value
      }
    }
    return value
  }
  if (typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === 'number')) return undefined
    const parts = value
      .map((entry) => readableToolJson(entry, depth + 1))
      .filter((entry): entry is string => entry !== undefined)
    const unique = [...new Set(parts)]
    return unique.length ? unique.join('\n') : undefined
  }
  const record = value as Record<string, unknown>
  const textKeys = TEXT_KEYS.filter((key) => key in record)
  if (textKeys.length > 0) {
    // A result envelope: its text-like field is the whole story, and an empty
    // one means the tool had nothing to say — not that its status is news.
    for (const key of textKeys) {
      const extracted = readableToolJson(record[key], depth + 1)
      if (extracted) return extracted
    }
    return undefined
  }
  // A record without a text-like field still reads better as key: value
  // lines than as a JSON blob, or as nothing at all.
  const lines = Object.entries(record).flatMap(([key, entry]) => {
    const text = readableValue(entry)
    return text === undefined ? [] : [`${key}: ${text}`]
  })
  return lines.length ? lines.join('\n') : undefined
}

const TEXT_KEYS = ['text', 'stdout', 'output', 'result', 'message', 'content']

/** Consecutive JSON values in one string, or undefined when it is not JSON. */
export function parseJsonSequence(text: string): unknown[] | undefined {
  const values: unknown[] = []
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1
    if (index >= text.length) break
    const parsed = readJsonValue(text.slice(index))
    if (!parsed) return undefined
    values.push(parsed.value)
    index += parsed.end
  }
  return values.length > 0 ? values : undefined
}

/** The JSON value at the start of `text`, and where it ends. */
function readJsonValue(text: string): { value: unknown; end: number } | undefined {
  if (text[0] !== '{' && text[0] !== '[') return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') {
      depth -= 1
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(0, index + 1)) as unknown, end: index + 1 }
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
