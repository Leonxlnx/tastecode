import { useState } from 'react'
import type { UserInputRequest } from '@harness/contracts'
import './user-input.css'

export function UserInput(props: {
  request: UserInputRequest
  onSubmit: (answers: Record<string, string[]>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.request.questions.flatMap((question) => {
        const recommended = question.options?.[0]?.label
        return recommended ? [[question.id, recommended]] : []
      }),
    ),
  )
  const complete = props.request.questions.every((question) => answers[question.id]?.trim())

  return (
    <form
      className="brief-input"
      onSubmit={(event) => {
        event.preventDefault()
        if (!complete) return
        props.onSubmit(
          Object.fromEntries(
            Object.entries(answers).map(([questionId, answer]) => [questionId, [answer.trim()]]),
          ),
        )
      }}
    >
      <header className="brief-input__head">
        <span aria-hidden="true">✦</span>
        <div>
          <h2>A few useful decisions</h2>
          <p>The agent inferred the rest. Answer only what materially changes the brief.</p>
        </div>
      </header>

      {props.request.questions.map((question) => {
        const options = question.options ?? []
        const custom = question.allowOther || options.length === 0
        return (
          <fieldset className="brief-input__question" key={question.id}>
            <legend>{question.question}</legend>
            <span className="brief-input__label">{question.header}</span>
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
        )
      })}

      <footer className="brief-input__footer">
        <span>Nothing will be built after the brief.</span>
        <button type="submit" disabled={!complete}>
          Continue briefing
        </button>
      </footer>
    </form>
  )
}
