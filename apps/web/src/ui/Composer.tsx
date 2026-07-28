import { useEffect, useRef, useState } from 'react'
import type { Model } from '@harness/contracts'

/**
 * Prompt bar. Text on top, controls in a quiet row underneath — model picker on
 * the left where it is glanceable, send on the right where the hand expects it.
 */
export function Composer(props: {
  models: Model[]
  modelId: string | undefined
  onModelChange: (id: string) => void
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
    const el = area.current
    if (el) {
      el.style.height = 'auto'
      el.focus()
    }
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
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Describe a task…"
        />

        <div className="composer__tools">
          <ModelPicker
            models={props.models}
            value={props.modelId}
            onChange={props.onModelChange}
            disabled={props.running}
          />

          <div className="composer__right">
            {props.running ? (
              <button className="stop" onClick={props.onInterrupt} title="Stop">
                <span className="stop__square" />
              </button>
            ) : (
              <button className="send" onClick={submit} disabled={text.trim() === ''} title="Send">
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelPicker(props: {
  models: Model[]
  value: string | undefined
  onChange: (id: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const current = props.models.find((model) => model.id === props.value)

  if (props.models.length === 0) {
    return <span className="model model--empty">Loading models…</span>
  }

  return (
    <div className="modelwrap" ref={wrap}>
      <button className="model" onClick={() => setOpen(!open)} disabled={props.disabled}>
        <span>{current?.displayName ?? 'Model'}</span>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4 6.5l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <ul className="menu" role="listbox">
          {props.models.map((model) => (
            <li key={model.id}>
              <button
                className={`menu__item ${model.id === props.value ? 'is-active' : ''}`}
                onClick={() => {
                  props.onChange(model.id)
                  setOpen(false)
                }}
              >
                <span className="menu__name">{model.displayName}</span>
                {model.description ? <span className="menu__desc">{model.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ArrowUp() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
