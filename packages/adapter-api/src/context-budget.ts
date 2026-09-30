import type { ApiMessage, ApiTool } from './runtime.js'

/** Conservative serialized-byte budgets, not a claim about a vendor's tokenizer. */
export function contextBudgetBytes(model: string): number {
  // These families support larger windows; unknown/custom endpoints stay conservative.
  return /^(?:gpt-4[.o-]|gpt-5(?:[.-]|$)|claude-(?:sonnet|opus|haiku|3))/i.test(model)
    ? 64 * 1024
    : 8 * 1024
}

export function boundedContext(
  messages: readonly ApiMessage[],
  tools: readonly ApiTool[],
  model: string,
  budget = contextBudgetBytes(model),
  instructions?: string,
): { messages: ApiMessage[]; removedTurns: number } {
  if (!Number.isSafeInteger(budget) || budget < 1024) throw new Error('Invalid API context budget')
  // User boundaries keep every assistant/tool-call/result group together, including
  // opaque transport state. Never truncate structured tool arguments or results.
  const starts = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []))
  const current = starts.at(-1) ?? 0
  const fits = (candidate: readonly ApiMessage[]) =>
    Buffer.byteLength(JSON.stringify({ model, messages: candidate, tools })) <= budget
  const candidate = (start: number): ApiMessage[] => {
    const result = messages.slice(start)
    const first = result[0]
    const prefix = instructions
      ? `<system-instructions>\n${instructions}\n</system-instructions>\n\n`
      : ''
    if (prefix && first?.role === 'user' && !first.content.startsWith(prefix)) {
      result[0] = { ...first, content: prefix + first.content }
    }
    return result
  }
  const latest = candidate(current)
  if (!fits(latest)) {
    throw new Error(
      'The current turn exceeds the API context budget. Start a new thread or reduce the prompt/tool output.',
    )
  }
  let first = current
  for (let index = starts.length - 2; index >= 0; index--) {
    const start = starts[index]!
    if (!fits(candidate(start))) break
    first = start
  }
  return {
    messages: candidate(first),
    removedTurns: starts.filter((start) => start < first).length,
  }
}

/** Enforce the same cap on each vendor's final serialized request, including tools. */
export function serializeContextRequest(
  body: { model: string; [key: string]: unknown },
  budget = contextBudgetBytes(body.model),
): string {
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized) > budget) {
    throw new Error(
      'The provider request exceeds the API context budget. Start a new thread or reduce the prompt/tool output.',
    )
  }
  return serialized
}
