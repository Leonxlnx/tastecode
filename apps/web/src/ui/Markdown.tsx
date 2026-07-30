import { memo, useEffect, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Streamdown, type IconMap } from 'streamdown'
import { onHighlighterChange, shikiPlugin } from './highlighter.js'

const STREAMDOWN_ICONS = {
  CheckIcon: Check,
  CopyIcon: Copy,
  DownloadIcon: Download,
  ExternalLinkIcon: ExternalLink,
  Loader2Icon: LoaderCircle,
  Maximize2Icon: Maximize2,
  RotateCcwIcon: RotateCcw,
  XIcon: X,
  ZoomInIcon: ZoomIn,
  ZoomOutIcon: ZoomOut,
} satisfies IconMap

/**
 * Agent output, rendered.
 *
 * Streamdown rather than react-markdown because a turn arrives token by token:
 * mid-stream there is an unterminated fence, a half-written bold, a dangling
 * link. A standard renderer flickers between raw and rendered on every one.
 *
 * Memoised on the text, so a completed message renders once and stays put while
 * the message after it is still streaming.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Shiki loads grammars in the background. This is the one re-render that
  // swaps plain code for coloured code once they arrive — the layout box is
  // identical either way, so nothing moves.
  const [, bump] = useState(0)
  useEffect(() => onHighlighterChange(() => bump((n) => n + 1)), [])

  return (
    <Streamdown
      className="md"
      // We already stream: the text prop grows token by token, so Streamdown's
      // own reveal animation would gate content behind a second timeline.
      mode="static"
      animated={false}
      parseIncompleteMarkdown
      plugins={{ code: shikiPlugin }}
      controls={{ code: true, table: true, mermaid: false }}
      icons={STREAMDOWN_ICONS}
    >
      {text}
    </Streamdown>
  )
})
