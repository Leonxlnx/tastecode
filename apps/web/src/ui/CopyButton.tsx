import { useEffect, useRef, useState } from 'react'
import {
  IconAlertCircle as CircleAlert,
  IconCheck as Check,
  IconCopy as Copy,
} from '@tabler/icons-react'
import { writeClipboardText } from '../bridge.js'
import { IconMorph } from './IconMorph.js'

/** How long the check mark stays before the copy glyph comes back. */
const COPIED_MS = 1600

/**
 * One icon button that copies text through the app clipboard. The glyph morphs
 * to a check on success; a failed write shows an alert glyph, a retry title and
 * an inline alert, so a rejected copy never looks like a working one.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  // Rows are virtualized, so this unmounts the moment it scrolls out of the
  // overscan window — the tick-reset timer must not outlive it.
  const resetTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = async () => {
    try {
      await writeClipboardText(text)
      setFailed(false)
      setCopied(true)
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      window.clearTimeout(resetTimer.current)
      setCopied(false)
      setFailed(true)
    }
  }

  return (
    <span className={`copy-action${failed ? ' is-failed' : ''}`}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        title={failed ? 'Copy failed — click to retry' : 'Copy'}
      >
        <IconMorph active={failed ? 2 : copied ? 1 : 0}>
          <Copy aria-hidden />
          <Check aria-hidden />
          <CircleAlert aria-hidden />
        </IconMorph>
      </button>
      {failed ? (
        <span className="copy-action__error" role="alert">
          Copy failed
        </span>
      ) : null}
    </span>
  )
}
