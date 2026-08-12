import { useRef, useState, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import type { UserInputRequest } from '@harness/contracts'
import './user-input.css'

export function UserInput(props: {
  request: UserInputRequest
  onSubmit: (answers: Record<string, string[]>) => void | Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState(false)
  const lastWheelAt = useRef(0)
  const question = props.request.questions[step]
  const answer = question ? answers[question.id]?.trim() : undefined
  const lastStep = step === props.request.questions.length - 1
  const composer =
    typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.composer__box')

  if (submitting) {
    const status = (
      <div className="brief-input brief-input--status" role="status">
        <span className="brief-input__spinner" aria-hidden="true" />
        Submitting answers…
      </div>
    )
    return composer ? createPortal(status, composer) : status
  }

  if (!question) return null

  const options = question.options ?? []
  const custom = question.allowOther || options.length === 0
  const customSelected =
    Object.hasOwn(answers, question.id) &&
    !options.some((option) => option.label === answers[question.id])

  const goBack = () => {
    if (step === 0) return
    setStep((current) => current - 1)
  }

  const goForward = () => {
    if (!answer || lastStep) return
    setStep((current) => current + 1)
  }

  const handleWheel = (event: WheelEvent<HTMLFormElement>) => {
    if (Math.abs(event.deltaY) < 28) return
    const now = Date.now()
    if (now - lastWheelAt.current < 360) return

    if (event.deltaY < 0 && step > 0) {
      goBack()
    } else if (event.deltaY > 0 && answer && !lastStep) {
      goForward()
    } else {
      return
    }

    lastWheelAt.current = now
    event.preventDefault()
  }

  const form = (
    <form
      className="brief-input"
      aria-label="Design brief questions"
      onWheel={handleWheel}
      onSubmit={(event) => {
        event.preventDefault()
        if (!answer) return
        if (!lastStep) {
          goForward()
          return
        }
        setSubmitting(true)
        setSubmissionError(false)
        const retry = () => {
          setSubmitting(false)
          setSubmissionError(true)
        }
        try {
          void Promise.resolve(
            props.onSubmit(
              Object.fromEntries(
                Object.entries(answers).map(([questionId, value]) => [questionId, [value.trim()]]),
              ),
            ),
          ).catch(retry)
        } catch {
          retry()
        }
      }}
    >
      <div className="brief-input__stage" aria-live="polite">
        <section
          className="brief-input__question"
          aria-labelledby={`brief-question-${question.id}`}
        >
          <h2 id={`brief-question-${question.id}`}>{question.question}</h2>

          <div
            className="brief-input__options"
            role="radiogroup"
            aria-labelledby={`brief-question-${question.id}`}
          >
            {options.map((option) => (
              <label className="brief-input__option" key={option.label}>
                <input
                  type="radio"
                  name={question.id}
                  checked={answers[question.id] === option.label}
                  onChange={() =>
                    setAnswers((current) => ({ ...current, [question.id]: option.label }))
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}

            {custom ? (
              <label className="brief-input__option brief-input__option--custom">
                <input
                  type="radio"
                  name={question.id}
                  checked={customSelected}
                  aria-label="Write your own answer"
                  onChange={() => setAnswers((current) => ({ ...current, [question.id]: '' }))}
                />
                {customSelected ? (
                  <input
                    className="brief-input__custom"
                    type={question.secret ? 'password' : 'text'}
                    value={answers[question.id] ?? ''}
                    placeholder="Type your answer…"
                    aria-label={`Custom answer: ${question.question}`}
                    autoFocus
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                    }
                  />
                ) : (
                  <span className="brief-input__custom-preview">Write your own answer…</span>
                )}
              </label>
            ) : null}
          </div>
        </section>
      </div>

      <footer className="brief-input__footer">
        {submissionError ? (
          <span role="alert">Could not submit. Try again.</span>
        ) : (
          <span>
            Question {step + 1} of {props.request.questions.length}
          </span>
        )}
        <div className="brief-input__actions">
          {step > 0 ? (
            <button className="brief-input__back" type="button" onClick={goBack}>
              Back
            </button>
          ) : null}
          <button className="brief-input__next" type="submit" disabled={!answer}>
            {lastStep ? 'Submit' : 'Next'}
          </button>
        </div>
      </footer>
    </form>
  )

  return composer ? createPortal(form, composer) : form
}
