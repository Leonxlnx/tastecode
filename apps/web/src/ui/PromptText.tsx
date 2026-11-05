import { memo } from 'react'
import { rememberedChipTokens } from '../composer-chip-memory.js'
import { BrowserCommentChip } from './BrowserCommentCard.js'
import { browserChipLabel, browserCommentSegments } from './browser-comments.js'
import { chipIcon } from './chip-icons.js'
import { messageChipSegments, type MessageChip } from './message-chips.js'
import '../styles/chips.css'

/**
 * A sent prompt with its skills, MCP servers and commands drawn as the chips
 * they were in the composer. Rendered once per prompt; prompts never stream.
 */
export const PromptText = memo(function PromptText({
  text,
  attachments,
}: {
  text: string
  attachments?: string[] | undefined
}) {
  const parts = browserCommentSegments(text)
  if (parts.some((part) => part.type === 'comment')) {
    return parts.map((part, index) =>
      part.type === 'text' ? (
        // Comments stack without the blank line that separates them on the wire.
        <PromptWords key={index} text={part.text.trim() ? part.text : '\n'} />
      ) : (
        <BrowserCommentChip
          key={index}
          comment={part.comment}
          label={browserChipLabel(part.comment.comment)}
          image={attachments?.find(
            (path) => part.imageName && path.split(/[/\\]/).at(-1) === part.imageName,
          )}
        />
      ),
    )
  }
  return <PromptWords text={text} />
})

function PromptWords({ text }: { text: string }) {
  const segments = messageChipSegments(text, rememberedChipTokens())
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'chip' ? (
          <PromptChip key={index} chip={segment} />
        ) : segment.gap ? (
          // Kept whole for copying; only the drawing folds it to one space.
          <span key={index} className="prompt-chip__gap">
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  )
}

function PromptChip({ chip }: { chip: MessageChip }) {
  const Icon = chipIcon(chip.kind, chip.name)
  return (
    <span className={`prompt-chip prompt-chip--${chip.kind}`} title={chip.token}>
      <Icon className="prompt-chip__icon" stroke={1.9} aria-hidden />
      {/* Kept as text so copying the prompt and screen readers get the token. */}
      <span className="prompt-chip__marker">{chip.marker}</span>
      {chip.name}
    </span>
  )
}
