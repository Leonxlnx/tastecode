/** How many objects a phase answer may close too early before it counts as broken. */
const MAX_EARLY_CLOSES = 3
/** How many opening braces to try when prose before the JSON contains braces of its own. */
const MAX_STARTS = 20

/**
 * A phase's final answer as JSON. Models wrap it in a Markdown fence, talk before or after it,
 * or close an object one brace too early and then carry on with its remaining members (a real
 * Codex Brand answer closed the root after designTokens, four times running). Those readings are
 * recovered here; anything else throws the original parse error, and the phase's own validation
 * still checks whatever is recovered.
 */
export function parsePhaseJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(unfenced(trimmed))
  } catch (error) {
    for (const candidate of new Set([unfenced(trimmed), fencedBlock(trimmed), trimmed])) {
      if (candidate === undefined) continue
      const recovered = firstValue(candidate)
      if (recovered.found) return recovered.value
    }
    throw error
  }
}

/** The text inside one fence that wraps the whole answer, or the answer itself. */
function unfenced(text: string): string {
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text
}

/** The first fenced block anywhere in the answer, when prose surrounds it. */
function fencedBlock(text: string): string | undefined {
  return /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)?.[1]
}

type Recovered = { found: true; value: unknown } | { found: false; open: boolean }

/** The first complete JSON object or array in `text`, after any prose before it. */
function firstValue(text: string): Recovered {
  let from = 0
  for (let tries = 0; tries < MAX_STARTS; tries++) {
    const start = text.slice(from).search(/[{[]/)
    if (start < 0) break
    const recovered = valueAt(text.slice(from + start))
    if (recovered.found) return recovered
    // A value still open at the end is a cut-off answer; a later brace sits inside it.
    if (recovered.open) break
    from += start + 1
  }
  return { found: false, open: false }
}

/**
 * The value that starts at the beginning of `source`. When it ends and the text goes on with
 * `,"member":`, the value was closed too early: its last closing brace is dropped and the rest
 * read as part of it.
 */
function valueAt(source: string): Recovered {
  let text = source
  for (let repairs = 0; repairs <= MAX_EARLY_CLOSES; repairs++) {
    const end = valueEnd(text)
    if (end < 0) return { found: false, open: true }
    if (/^\s*,\s*"/.test(text.slice(end)) && text[end - 1] === '}') {
      text = text.slice(0, end - 1) + text.slice(end)
      continue
    }
    try {
      return { found: true, value: JSON.parse(text.slice(0, end)) }
    } catch {
      return { found: false, open: false }
    }
  }
  return { found: false, open: false }
}

/** The index just past the bracket that closes the one `source` opens, or -1. */
function valueEnd(source: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const ch = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return index + 1
      if (depth < 0) return -1
    }
  }
  return -1
}
