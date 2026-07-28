import { useRef, useState } from 'react'

export function Composer(props: {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
}) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    props.onSend(trimmed)
    setText('')
    area.current?.focus()
  }

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="composer">
      <div className="composer__box">
        <textarea
          ref={area}
          value={text}
          rows={1}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            grow(e.target)
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. The reverse costs a
            // keystroke on the action taken hundreds of times a day.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Describe the task…"
        />
        <div className="composer__bar">
          <span className="label composer__hint">
            {props.running ? 'Running' : 'Enter to send · Shift+Enter for a new line'}
          </span>
          {props.running ? (
            <button className="btn btn--quiet" onClick={props.onInterrupt}>
              Stop
            </button>
          ) : (
            <button className="btn" onClick={submit} disabled={text.trim() === ''}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
