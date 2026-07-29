import type { PlanStep } from '@harness/contracts'

/**
 * The agent's own plan for the current turn.
 *
 * Pinned above the composer rather than buried in the transcript: it is the
 * answer to "what is it doing and how far along", which is the question you ask
 * while it works — and a row that scrolls away cannot answer it.
 */
export function Plan({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null

  const done = steps.filter((step) => step.status === 'done').length

  return (
    <details className="plan" open>
      <summary className="plan__head">
        <span className="plan__title">Plan</span>
        <span className="plan__count">
          {done}/{steps.length}
        </span>
      </summary>
      <ol className="plan__list">
        {steps.map((step, index) => (
          <li key={`${index}-${step.text}`} className={`planstep is-${step.status}`}>
            <span className="planstep__mark" aria-hidden>
              {step.status === 'done' ? '✓' : step.status === 'running' ? '›' : '·'}
            </span>
            <span className="planstep__text">{step.text}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}
