import { useState } from 'react'
import type { UserInputRequest } from '@harness/contracts'
import './user-input.css'

export function UserInput(props: {
  request: UserInputRequest
  onSubmit: (answers: Record<string, string[]>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<'back' | 'forward'>('forward')
  const [submitting, setSubmitting] = useState(false)
  const question = props.request.questions[step]
  const answer = question ? answers[question.id]?.trim() : undefined
  const lastStep = step === props.request.questions.length - 1

  if (submitting) {
    return (
      <div className="brief-input brief-input--status" role="status">
        <span className="brief-input__spinner" aria-hidden="true" />
        Submitting answers…
      </div>
    )
  }

  if (!question) return null

  const options = question.options ?? []
  const custom = question.allowOther || options.length === 0

  return (
    <form
      className="brief-input"
      aria-label="Design brief questions"
      onSubmit={(event) => {
        event.preventDefault()
        if (!answer) return
        if (!lastStep) {
          setDirection('forward')
          setStep((current) => current + 1)
          return
        }
        setSubmitting(true)
        props.onSubmit(
          Object.fromEntries(
            Object.entries(answers).map(([questionId, value]) => [questionId, [value.trim()]]),
          ),
        )
      }}
    >
      <div
        className="brief-input__stage"
        aria-live="polite"
        key={question.id}
        data-direction={direction}
      >
        <fieldset className="brief-input__question">
          <span className="brief-input__label">{question.header}</span>
          <legend>{question.question}</legend>

          {options.length > 0 ? (
            <div className="brief-input__options">
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
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {custom ? (
            <input
              className="brief-input__custom"
              type={question.secret ? 'password' : 'text'}
              value={
                options.some((option) => option.label === answers[question.id])
                  ? ''
                  : (answers[question.id] ?? '')
              }
              placeholder={options.length > 0 ? 'Or write your own answer' : 'Your answer'}
              aria-label={`Custom answer: ${question.question}`}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
              }
            />
          ) : null}
        </fieldset>
      </div>

      <footer className="brief-input__footer">
        <span>
          Question {step + 1} of {props.request.questions.length}
        </span>
        <div className="brief-input__actions">
          {step > 0 ? (
            <button
              className="brief-input__back"
              type="button"
              onClick={() => {
                setDirection('back')
                setStep((current) => current - 1)
              }}
            >
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
}
