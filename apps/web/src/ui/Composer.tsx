import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, Model } from '@harness/contracts'
import { canDictate, pickFiles, startDictation } from '../bridge.js'
import { Menu, MenuItem } from './Menu.js'

/**
 * Prompt bar.
 *
 * A context chip names the exact folder the next turn will touch — an agent
 * that edits files must never leave that ambiguous. Below the input: what it
 * may do on the left, what it runs on the right, send at the end.
 *
 * Every control here does something. A bar full of ornaments looks finished and
 * behaves like a prototype, so anything that cannot work yet is not drawn.
 */

export const APPROVAL_MODES: { id: ApprovalMode; title: string; detail: string }[] = [
  { id: 'ask', title: 'Ask first', detail: 'Read-only until you approve each action' },
  { id: 'auto', title: 'Auto-approve', detail: 'Edits and commands inside this folder' },
  { id: 'full', title: 'Full access', detail: 'No sandbox, no prompts. Use with care.' },
]

/** Expanded into the input rather than sent as a command, so nothing is hidden. */
const SLASH_COMMANDS: { name: string; detail: string; text: string }[] = [
  {
    name: '/review',
    detail: 'Review the current diff',
    text: 'Review my current changes and tell me what is wrong before I commit.',
  },
  {
    name: '/test',
    detail: 'Run the test suite',
    text: 'Run the tests and fix anything that fails.',
  },
  {
    name: '/explain',
    detail: 'Explain this codebase',
    text: 'Explain how this project is structured and where the important parts live.',
  },
  {
    name: '/tidy',
    detail: 'Clean up without behaviour changes',
    text: 'Tidy the code you can see without changing any behaviour. No new features.',
  },
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
  onSend: (text: string, attachments: string[]) => void
  onInterrupt: () => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [dictating, setDictating] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const stopDictation = useRef<(() => void) | null>(null)

  useEffect(() => () => stopDictation.current?.(), [])

  const model = props.models.find((m) => m.id === props.modelId)
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!

  const grow = () => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  const insert = (value: string) => {
    setText((current) => (current === '' ? value : `${current} ${value}`))
    requestAnimationFrame(() => {
      area.current?.focus()
      grow()
    })
  }

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || props.disabled) return
    props.onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    const el = area.current
    if (el) {
      el.style.height = 'auto'
      el.focus()
    }
  }

  const attach = async () => {
    const picked = await pickFiles()
    if (picked.length > 0) setAttachments((current) => [...new Set([...current, ...picked])])
  }

  const toggleDictation = () => {
    if (dictating) {
      stopDictation.current?.()
      return
    }
    setDictating(true)
    stopDictation.current = startDictation({
      onText: (spoken) => insert(spoken),
      onEnd: () => {
        setDictating(false)
        stopDictation.current = null
      },
    })
  }

  return (
    <div className="composer">
      <div className="composer__box">
        <div className="chips">
          {props.projectName ? (
            <span className="chip chip--context">
              <FolderGlyph />
              <span className="chip__label">{props.projectName}</span>
            </span>
          ) : null}
          {attachments.map((path) => (
            <span className="chip chip--file" key={path} title={path}>
              <FileGlyph />
              <span className="chip__label">{basename(path)}</span>
              <button
                className="chip__x"
                onClick={() => setAttachments((c) => c.filter((p) => p !== path))}
                title="Remove"
              >
                <XGlyph />
              </button>
            </span>
          ))}
        </div>

        <textarea
          ref={area}
          value={text}
          rows={1}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(e) => {
            setText(e.target.value)
            grow()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={props.disabled ? 'Add a project folder first' : 'Do anything'}
        />

        <div className="tools">
          <Menu
            label="Add"
            disabled={props.disabled}
            trigger={() => (
              <span className="tool tool--icon">
                <PlusGlyph />
              </span>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  title="Attach files"
                  detail="Images are shown to the model; other files are referenced by path"
                  onClick={() => {
                    close()
                    void attach()
                  }}
                />
                <div className="menu__rule" />
                <p className="menu__group">Commands</p>
                {SLASH_COMMANDS.map((command) => (
                  <MenuItem
                    key={command.name}
                    title={command.name}
                    detail={command.detail}
                    onClick={() => {
                      insert(command.text)
                      close()
                    }}
                  />
                ))}
              </>
            )}
          </Menu>

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
                      {model.reasoningEfforts.map((entry) => (
                        <MenuItem
                          key={entry}
                          title={entry}
                          active={entry === props.effort}
                          onClick={() => {
                            props.onEffortChange(entry)
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

          {canDictate ? (
            <button
              className={`icon-btn icon-btn--always ${dictating ? 'is-live' : ''}`}
              onClick={toggleDictation}
              disabled={props.disabled}
              title={dictating ? 'Stop dictation' : 'Dictate'}
            >
              <MicGlyph />
            </button>
          ) : null}

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

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6L9 2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function XGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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

function MicGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="2" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.8 7.5a4.2 4.2 0 008.4 0M8 11.7V14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
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
