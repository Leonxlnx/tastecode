import { useEffect, useRef, useState, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import type { UserInputRequest } from '@harness/contracts'
import { IconLoader2 } from '@tabler/icons-react'
import { IndeterminateRequestError } from '../transport.js'
import './user-input.css'

type Answer = { options: string[]; custom: boolean; text: string }

function answerValues(answer: Answer | undefined): string[] {
  if (!answer) return []
  const text = answer.custom ? answer.text.trim() : ''
  return [...answer.options, ...(text ? [text] : [])]
}

export function UserInput(props: {
  request: UserInputRequest
  onSubmit: (answers: Record<string, string[]>) => void | Promise<void>
  /** Render in place for a thread that has no composer of its own, such as a Side chat. */
  inline?: boolean | undefined
}) {
  const [answers, setAnswers] = useState(() => new Map<string, Answer>())
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState<'definite' | 'indeterminate'>()
  const previousRequest = useRef(props.request)
  const lastWheelAt = useRef(0)
  const question = props.request.questions[step]
  const selected = question ? answers.get(question.id) : undefined
  const answer = answerValues(selected).length > 0
  const lastStep = step === props.request.questions.length - 1
  const composer = props.inline
    ? null
    : (globalThis.document?.querySelector<HTMLElement>('.composer__box') ?? null)

  useEffect(() => {
    if (previousRequest.current === props.request) return
    previousRequest.current = props.request
    if (submissionError !== 'indeterminate') return
    setSubmitting(false)
    setSubmissionError(undefined)
  }, [props.request, submissionError])

  if (submitting) {
    const status = (
      <div className="brief-input brief-input--status" role="status">
        <IconLoader2 className="brief-input__spinner" size={14} aria-hidden />
        {submissionError === 'indeterminate'
          ? 'Checking whether answers were received…'
          : 'Submitting answers…'}
      </div>
    )
    return composer ? createPortal(status, composer) : status
  }

  if (!question) return null

  const options = question.options ?? []
  const custom = question.allowOther || options.length === 0
  const customSelected = selected?.custom ?? false
  const updateAnswer = (update: (current: Answer) => Answer) => {
    setAnswers((current) => {
      const next = new Map(current)
      next.set(
        question.id,
        update(current.get(question.id) ?? { options: [], custom: false, text: '' }),
      )
      return next
    })
  }

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
        setSubmissionError(undefined)
        const retry = (error: unknown) => {
          if (error instanceof IndeterminateRequestError) {
            setSubmissionError('indeterminate')
            return
          }
          setSubmitting(false)
          setSubmissionError('definite')
        }
        try {
          void Promise.resolve(
            props.onSubmit(
              Object.fromEntries(
                [...answers].map(([questionId, answer]) => [questionId, answerValues(answer)]),
              ),
            ),
          ).catch(retry)
        } catch (error) {
          retry(error)
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
            role={question.multiSelect ? 'group' : 'radiogroup'}
            aria-labelledby={`brief-question-${question.id}`}
          >
            {options.map((option) => (
              <label className="brief-input__option" key={option.label}>
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={selected?.options.includes(option.label) ?? false}
                  onChange={() =>
                    updateAnswer((current) =>
                      question.multiSelect
                        ? {
                            ...current,
                            options: current.options.includes(option.label)
                              ? current.options.filter((label) => label !== option.label)
                              : [...current.options, option.label],
                          }
                        : { options: [option.label], custom: false, text: '' },
                    )
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}

            {custom ? (
              <label className="brief-input__option brief-input__option--custom">
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={customSelected}
                  aria-label="Write your own answer"
                  onChange={() =>
                    updateAnswer((current) => ({
                      options: question.multiSelect ? current.options : [],
                      custom: question.multiSelect ? !current.custom : true,
                      text: '',
                    }))
                  }
                />
                {customSelected ? (
                  <input
                    className="brief-input__custom"
                    type={question.secret ? 'password' : 'text'}
                    value={selected?.text ?? ''}
                    placeholder="Type your answer…"
                    aria-label={`Custom answer: ${question.question}`}
                    autoFocus
                    onChange={(event) =>
                      updateAnswer((current) => ({ ...current, text: event.target.value }))
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
        {submissionError === 'definite' ? (
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
