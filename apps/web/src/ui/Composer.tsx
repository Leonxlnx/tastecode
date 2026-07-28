import { useRef, useState } from 'react'
import type { ApprovalMode, Model } from '@harness/contracts'
import { Menu, MenuItem } from './Menu.js'

/**
 * Prompt bar.
 *
 * A context chip sits above the input showing exactly which folder the next
 * turn will touch — an agent that edits files must never leave that ambiguous.
 * Controls sit in a quiet row underneath: what it runs on the left, what it is
 * allowed to do in the middle, send on the right.
 */

export const APPROVAL_MODES: { id: ApprovalMode; title: string; detail: string }[] = [
  { id: 'ask', title: 'Ask first', detail: 'Read-only until you approve each action' },
  { id: 'auto', title: 'Auto-approve', detail: 'Edits and commands inside this folder' },
  { id: 'full', title: 'Full access', detail: 'No sandbox, no prompts. Use with care.' },
]

export function Composer(props: {
  projectName: string | undefined
  models: Model[]
  modelId: string | undefined
  effort: string | undefined
  approval: ApprovalMode
  disabled: boolean
  running: boolean
  onModelChange: (id: string) => void
  onEffortChange: (effort: string) => void
  onApprovalChange: (mode: ApprovalMode) => void
  onSend: (text: string) => void
  onInterrupt: () => void
}) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  const model = props.models.find((m) => m.id === props.modelId)
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || props.disabled) return
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
        {props.projectName ? (
          <div className="context">
            <FolderGlyph />
            <span className="context__name">{props.projectName}</span>
          </div>
        ) : null}

        <textarea
          ref={area}
          value={text}
          rows={1}
          spellCheck={false}
          disabled={props.disabled}
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
          placeholder={props.disabled ? 'Start a session to begin' : 'Do anything'}
        />

        <div className="tools">
          <Menu
            label="Permissions"
            disabled={props.running}
            trigger={() => (
              <span className={`tool tool--${props.approval}`}>
                <ShieldGlyph />
                <span>{approval.title}</span>
              </span>
            )}
          >
            {(close) => (
              <>
                {APPROVAL_MODES.map((mode) => (
                  <MenuItem
                    key={mode.id}
                    title={mode.title}
                    detail={mode.detail}
                    active={mode.id === props.approval}
                    onClick={() => {
                      props.onApprovalChange(mode.id)
                      close()
                    }}
                  />
                ))}
              </>
            )}
          </Menu>

          <span className="tools__spacer" />

          {props.models.length > 0 ? (
            <Menu
              label="Model"
              align="right"
              disabled={props.running}
              trigger={() => (
                <span className="tool">
                  <BoltGlyph />
                  <span>{model?.displayName ?? 'Model'}</span>
                  {props.effort ? <span className="tool__sub">{props.effort}</span> : null}
                </span>
              )}
            >
              {(close) => (
                <>
                  {props.models.map((entry) => (
                    <MenuItem
                      key={entry.id}
                      title={entry.displayName}
                      detail={entry.description}
                      active={entry.id === props.modelId}
                      onClick={() => {
                        props.onModelChange(entry.id)
                        close()
                      }}
                    />
                  ))}
                  {model && model.reasoningEfforts.length > 0 ? (
                    <>
                      <div className="menu__rule" />
                      <p className="menu__group">Reasoning</p>
                      {model.reasoningEfforts.map((effort) => (
                        <MenuItem
                          key={effort}
                          title={effort}
                          active={effort === props.effort}
                          onClick={() => {
                            props.onEffortChange(effort)
                            close()
                          }}
                        />
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </Menu>
          ) : (
            <span className="tool tool--quiet">Loading models…</span>
          )}

          {props.running ? (
            <button className="orb orb--stop" onClick={props.onInterrupt} title="Stop">
              <span className="orb__square" />
            </button>
          ) : (
            <button
              className="orb"
              onClick={submit}
              disabled={text.trim() === '' || props.disabled}
              title="Send"
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function FolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ShieldGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2l4.5 1.8v4c0 3-1.9 5.2-4.5 6.2C5.4 13 3.5 10.8 3.5 7.8v-4L8 2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BoltGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 1.8L3.8 9h3.4l-.6 5.2L12.2 7H8.8l.2-5.2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArrowUp() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
