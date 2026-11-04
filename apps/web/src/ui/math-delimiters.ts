/**
 * Models write math as `\(…\)`, `\[…\]`, `$…$` or `$$…$$`. remark-math reads only
 * dollar signs, and with single-dollar math on it would turn "$5 and $10" into a
 * formula, so the renderer runs with it off: inline math is `$$…$$` and display
 * math is a `$$` fence. This rewrites the other spellings into those two forms,
 * outside code. It runs once per finished block, never per streamed delta.
 */

const MAY_HAVE_MATH = /\\[([]|\$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const DISPLAY = /\\\[([\s\S]+?)\\\]/g
const INLINE = /\\\(([^\r\n]+?)\\\)/g
/**
 * `$x$` the way Pandoc reads it: the opening dollar is not escaped or glued to a
 * word, the formula neither starts nor ends with a space, and the closing dollar
 * is not followed by a digit. That keeps "$5 and $10" and "US$5" as text.
 */
const SINGLE_DOLLAR = /(^|[^\\$\w])\$(?=[^\s$])([^$\r\n]+?)(?<=[^\s\\])\$(?![\d$\w])/g
/** A formula, not a bracketed word: `\[1\]` and `$HOME$` stay text. */
const MATH_SIGNS = /[\\^_{}=+\-*/<>|]/
const SINGLE_LETTER = /^[A-Za-z]$/

export function normalizeMathDelimiters(markdown: string): string {
  if (!MAY_HAVE_MATH.test(markdown)) return markdown
  let result = ''
  let prose = ''
  let fence: string | undefined
  for (const line of markdown.split(/(?<=\n)/)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      result += line
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.slice(line.indexOf(marker) + marker.length).trim()
      )
        fence = undefined
      continue
    }
    if (marker) {
      result += rewriteProse(prose) + line
      prose = ''
      fence = marker
      continue
    }
    prose += line
  }
  return result + rewriteProse(prose)
}

/** Rewrites prose between code fences, leaving inline code spans as they are. */
function rewriteProse(prose: string): string {
  if (!MAY_HAVE_MATH.test(prose)) return prose
  let result = ''
  let index = 0
  while (index < prose.length) {
    const tick = prose.indexOf('`', index)
    if (tick < 0) break
    let run = tick
    while (prose[run] === '`') run += 1
    const ticks = prose.slice(tick, run)
    const close = closingTicks(prose, run, ticks.length)
    if (close < 0) {
      // An unclosed run is literal text.
      result += rewriteMath(prose.slice(index, run))
      index = run
      continue
    }
    result += rewriteMath(prose.slice(index, tick)) + prose.slice(tick, close + ticks.length)
    index = close + ticks.length
  }
  return result + rewriteMath(prose.slice(index))
}

function closingTicks(text: string, from: number, length: number): number {
  for (let index = text.indexOf('`', from); index >= 0; index = text.indexOf('`', index)) {
    let run = index
    while (text[run] === '`') run += 1
    if (run - index === length) return index
    index = run
  }
  return -1
}

function rewriteMath(text: string): string {
  if (!MAY_HAVE_MATH.test(text)) return text
  return text
    .replace(DISPLAY, (match, body: string, offset: number) => {
      if (!MATH_SIGNS.test(body)) return match
      const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset)
      // A formula on its own line keeps that line's indent, so it stays inside a list item.
      const lineStart = /^[ \t]*$/.test(before)
      const indent = lineStart ? before : ''
      const lines = body.trim().split(/\r?\n/)
      return `${lineStart ? '\n' : '\n\n'}${indent}$$\n${lines.map((line) => indent + line.trim()).join('\n')}\n${indent}$$\n\n`
    })
    .replace(INLINE, (_match, body: string) => `$$${body.trim()}$$`)
    .replace(SINGLE_DOLLAR, (match, lead: string, body: string) =>
      MATH_SIGNS.test(body) || SINGLE_LETTER.test(body) ? `${lead}$$${body}$$` : match,
    )
}

const DOLLAR_MATH = new RegExp(`\\$\\$|${SINGLE_DOLLAR.source}`)

/**
 * Whether a text may hold dollar math, which the plain-text fast path cannot show.
 * A regular expression test only: it also runs on streamed deltas.
 */
export function mayHaveDollarMath(text: string): boolean {
  return text.includes('$') && DOLLAR_MATH.test(text)
}
