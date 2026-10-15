import type { CSSProperties } from 'react'
import type { Usage } from '@harness/contracts'
import '../styles/context-usage.css'

type ContextUsageStyle = CSSProperties & { '--context-used': number }

function contextUsageStyle(percent: number): ContextUsageStyle {
  return { '--context-used': percent }
}

/** A sliver of context is still some context: never claim 0% once tokens are in. */
function percentLabel(percent: number): string {
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

export function ContextUsage({ usage }: { usage: Usage }) {
  const contextWindow = usage.contextWindow ?? 0
  const percent = contextWindow
    ? Math.min(100, Math.max(0, (usage.totalTokens / contextWindow) * 100))
    : 0
  const shown = percentLabel(percent)
  const detail = `${usage.totalTokens.toLocaleString()} of ${contextWindow.toLocaleString()} context tokens used (${shown})`

  return (
    <span
      className="context-usage"
      tabIndex={0}
      role="img"
      aria-label={detail}
      style={contextUsageStyle(percent)}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle className="context-usage__track" cx="12" cy="12" r="9" />
        <circle className="context-usage__fill" cx="12" cy="12" r="9" pathLength="100" />
      </svg>
      <span className="context-usage__value" aria-hidden>
        {shown}
      </span>
      <span className="context-usage__tooltip" role="tooltip">
        <strong>{shown} context used</strong>
        <span>
          {usage.totalTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens
        </span>
      </span>
    </span>
  )
}
