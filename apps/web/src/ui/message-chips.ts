import {
  browserCommentSegments,
  newBrowserCommentId,
  rememberBrowserComment,
} from './browser-comments.js'
import {
  browserCommentChipText,
  composerChipText,
  hasComposerChips,
  type ComposerChipKind,
  type ComposerChipMarker,
} from './composer-chips.js'

/**
 * Finds the `$skill`, `@server` and `/command` tokens in a sent prompt, so the
 * transcript can draw them as the chips they were in the composer.
 *
 * A prompt is plain text, so a token is only trusted where TasteCode puts one:
 * - at the very start of the prompt, where commands always are and where
 *   earlier versions put picked skills and servers (`$cook\n\n/goal …`). There
 *   a `/name` or a lowercase `$name` counts on its own;
 * - anywhere else only when it is a token this device picked from the menu
 *   before, so `echo $path` or `ask @leon` stay text.
 */

export type MessageChip = {
  kind: ComposerChipKind
  marker: ComposerChipMarker
  name: string
  token: string
}

export type MessageChipSegment =
  /** `gap`: whitespace that only separates two leading chips, drawn as one space. */
  { type: 'text'; text: string; gap?: true } | ({ type: 'chip' } & MessageChip)

/** Token → what it is, for tokens picked from the menu on this device. */
export type KnownChipTokens = ReadonlyMap<string, ComposerChipKind>

// A marker after the start, a space or an opening bracket, then a name that
// ends in a letter or digit before a space, the end, or closing punctuation
// (so `$cook.` is `$cook`, while `/anthropic-skills:pdf` stays whole).
const TOKEN = /(^|[\s([{"'])([$@/])([A-Za-z0-9_](?:[\w.:-]*\w)?)(?=$|[\s.,;:!?)\]}"'])/g
const LEADING_SPACE = /^\s*/

export function messageChipSegments(text: string, known: KnownChipTokens): MessageChipSegment[] {
  // Most prompts carry no marker at all; they render exactly as before.
  if (!/[$@/]/.test(text)) return [{ type: 'text', text }]
  const segments: MessageChipSegment[] = []
  let position = 0
  // The leading run: tokens separated only by whitespace from the start.
  let leading = true
  let expected = LEADING_SPACE.exec(text)![0].length
  for (const match of text.matchAll(TOKEN)) {
    const lead = match[1]!
    const marker = match[2] as ComposerChipMarker
    const name = match[3]!
    const start = match.index + lead.length
    if (leading && (start !== expected || (lead !== '' && !/\s/.test(lead)))) leading = false
    const token = `${marker}${name}`
    const kind = chipKind(marker, name, token, leading, known)
    if (!kind) {
      leading = false
      continue
    }
    if (start > position) {
      const between = text.slice(position, start)
      // Earlier versions put a blank line after picked skills (`$cook\n\n/goal`);
      // between two leading chips it shows as the one space typed today.
      if (leading && between !== ' ' && segments.at(-1)?.type === 'chip')
        segments.push({ type: 'text', text: between, gap: true })
      else segments.push({ type: 'text', text: between })
    }
    segments.push({ type: 'chip', kind, marker, name, token })
    position = start + token.length
    if (leading) expected = position + LEADING_SPACE.exec(text.slice(position))![0].length
  }
  if (segments.length === 0) return [{ type: 'text', text }]
  if (position < text.length) segments.push({ type: 'text', text: text.slice(position) })
  return segments
}

function chipKind(
  marker: ComposerChipMarker,
  name: string,
  token: string,
  leading: boolean,
  known: KnownChipTokens,
): ComposerChipKind | undefined {
  const remembered = known.get(token)
  if (marker === '/') {
    // Providers read a command only at the start of the prompt.
    if (!leading) return undefined
    return remembered ?? (/^[A-Za-z]/.test(name) ? 'command' : undefined)
  }
  if (remembered) return remembered
  if (!leading) return undefined
  return marker === '$' && /^[a-z]/.test(name) ? 'skill' : undefined
}

/**
 * A sent prompt put back into the composer (Edit, Arrow Up) with its tokens as
 * chips again. A draft that already holds chips is left as it is.
 */
export function composerTextWithChips(
  text: string,
  known: KnownChipTokens,
  attachments: readonly string[] = [],
): string {
  if (hasComposerChips(text)) return text
  if (holdsCommentBlock(text))
    return commentBlocksAsChips(text, attachments, (part) => composerTextWithChips(part, known))
  const segments = messageChipSegments(text, known)
  if (segments.length === 1 && segments[0]!.type === 'text') return text
  return segments
    .map((segment) =>
      segment.type === 'chip' ? composerChipText(segment.token, segment.kind) : segment.text,
    )
    .join('')
}

/**
 * Text that was never sent, such as a queued prompt or a restored draft: its comment
 * blocks come back as chips, and what the user typed stays exactly as typed.
 */
export function composerTextWithCommentChips(
  text: string,
  attachments: readonly string[] = [],
): string {
  if (hasComposerChips(text) || !holdsCommentBlock(text)) return text
  return commentBlocksAsChips(text, attachments, (part) => part)
}

function holdsCommentBlock(text: string): boolean {
  return (
    text.includes('[Browser comment]') &&
    browserCommentSegments(text).some((part) => part.type === 'comment')
  )
}

function commentBlocksAsChips(
  text: string,
  attachments: readonly string[],
  rest: (text: string) => string,
): string {
  return browserCommentSegments(text)
    .map((segment) => {
      if (segment.type === 'text') return rest(segment.text)
      const image = attachments.find((path) => path.split(/[/\\]/).at(-1) === segment.imageName)
      const comment = { ...segment.comment, id: newBrowserCommentId(), ...(image ? { image } : {}) }
      rememberBrowserComment(comment)
      return browserCommentChipText(comment)
    })
    .join('')
}
