import { useState } from 'react'
import type { PlanStep } from '@harness/contracts'
import {
  IconCheck as Check,
  IconCircle as Circle,
  IconLoader2 as LoaderCircle,
} from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'

/**
 * The agent's own plan for the current turn.
 *
 * Pinned above the composer rather than buried in the transcript: it is the
 * answer to "what is it doing and how far along", which is the question you ask
 * while it works — and a row that scrolls away cannot answer it.
 */
export function Plan({ steps, compact = false }: { steps: PlanStep[]; compact?: boolean }) {
  // Owned state, not a hardcoded `open` attribute: re-applying `open` on
  // every plan-step update cancelled the user's collapse mid-turn.
  const [open, setOpen] = useState(true)

  if (steps.length === 0) return null

  if (compact) {
    const current =
      steps.find((step) => step.status === 'running') ??
      steps.find((step) => step.status === 'pending')
    return current ? <div className="live-status">{current.text}</div> : null
  }

  const done = steps.filter((step) => step.status === 'done').length

  return (
    <details className="plan" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="plan__head">
        <span className="plan__title">Plan</span>
        <span className="plan__count">
          {done}/{steps.length}
        </span>
      </summary>
      <ol className="plan__list">
        {steps.map((step, index) => (
          <li key={`${index}-${step.text}`} className={`planstep is-${step.status}`}>
            <span className="planstep__mark">
              <IconMorph active={step.status === 'done' ? 2 : step.status === 'running' ? 1 : 0}>
                <Circle size={7} />
                <LoaderCircle className="spinner" />
                <Check size={10} />
              </IconMorph>
            </span>
            <span className="planstep__text">{step.text}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}
