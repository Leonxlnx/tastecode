import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, Model } from '@harness/contracts'
import { canDictate, pickFiles, startDictation } from '../bridge.js'
import { Menu, MenuItem } from './Menu.js'

/**
 * Prompt bar.
 *
 * Reads left to right as a sentence about the next turn: what it can see
 * (context chip), what it may do (permissions), what runs it (model + effort),
 * and how to send. Everything here does something — a bar full of ornaments
 * looks finished and behaves like a prototype.
 */

export type WorkspaceInfo = {
  branch?: string | undefined
  added: number
  removed: number
  dirtyFiles: number
}

export const APPROVAL_MODES: {
  id: ApprovalMode
  title: string
  short: string
  detail: string
}[] = [
  {
    id: 'ask',
    title: 'Ask first',
    short: 'Ask first',
    detail: 'Read-only until you approve each action',
  },
  {
    id: 'auto',
    title: 'Auto-approve',
    short: 'Auto',
    detail: 'Edits and commands inside this folder',
  },
  {
    id: 'full',
    title: 'Full access',
    short: 'Yolo',
    detail: 'No sandbox, no prompts, no undo. Use with care.',
  },
]

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
  {
    name: '/commit',
    detail: 'Stage and commit what changed',
    text: 'Commit the current changes with a clear message explaining why, not what.',
  },
]

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function Composer(props: {
  projectName: string | undefined
  workspace: WorkspaceInfo | undefined
  models: Model[]
  /** Whether the list has come back yet, so an empty list is not read as pending. */
  modelsLoaded: boolean
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
  const [dragging, setDragging] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const stopDictation = useRef<(() => void) | null>(null)

  useEffect(() => () => stopDictation.current?.(), [])

  const model = props.models.find((m) => m.id === props.modelId)
  // A provider that cannot enumerate models shows nothing. Sitting on
  // "Loading models…" forever is the UI lying about what it is doing.
  const showModelPlaceholder = props.models.length === 0 && !props.modelsLoaded
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!
  const efforts = model?.reasoningEfforts ?? []

  const matches = slashOpen
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(text.trim().toLowerCase()))
    : []

  const grow = () => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  const setValue = (value: string) => {
    setText(value)
    requestAnimationFrame(() => {
      area.current?.focus()
      grow()
    })
  }

  const addFiles = (paths: string[]) => {
    if (paths.length > 0) setAttachments((current) => [...new Set([...current, ...paths])])
  }

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || props.disabled) return
    props.onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    setSlashOpen(false)
    const el = area.current
    if (el) {
      el.style.height = 'auto'
      el.focus()
    }
  }

  const toggleDictation = () => {
    if (dictating) {
      stopDictation.current?.()
      return
    }
    setDictating(true)
    stopDictation.current = startDictation({
      onText: (spoken) => setValue(text === '' ? spoken : `${text} ${spoken}`),
      onEnd: () => {
        setDictating(false)
        stopDictation.current = null
      },
    })
  }

  return (
    <div className="composer">
      <div
        className={`composer__box ${dragging ? 'is-dropping' : ''} ${
          props.approval === 'full' ? 'is-yolo' : ''
        }`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          // Electron exposes a real path on dropped files; browsers do not, so
          // this quietly does nothing during development rather than lying.
          const paths = Array.from(e.dataTransfer.files)
            .map((file) => (file as File & { path?: string }).path)
            .filter((path): path is string => typeof path === 'string' && path !== '')
          addFiles(paths)
        }}
      >
        <div className="chips">
          {props.projectName ? (
            <span className="chip chip--context" title={props.workspace?.branch}>
              <FolderGlyph />
              <span className="chip__label">{props.projectName}</span>
              {props.workspace?.branch ? (
                <>
                  <span className="chip__sep">/</span>
                  <span className="chip__branch">{props.workspace.branch}</span>
                </>
              ) : null}
              {props.workspace && props.workspace.dirtyFiles > 0 ? (
                <span className="chip__stat">
                  <span className="stat stat--add">+{props.workspace.added}</span>
                  <span className="stat stat--del">−{props.workspace.removed}</span>
                </span>
              ) : null}
            </span>
          ) : null}

          {attachments.map((path) => (
            <span className={`chip chip--file`} key={path} title={path}>
              {IMAGE_RE.test(path) ? <ImageGlyph /> : <FileGlyph />}
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

        <div className="composer__field">
          <textarea
            ref={area}
            value={text}
            rows={1}
            spellCheck={false}
            disabled={props.disabled}
            onChange={(e) => {
              const value = e.target.value
              setText(value)
              setSlashOpen(value.startsWith('/') && !value.includes(' '))
              grow()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && slashOpen) {
                setSlashOpen(false)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (slashOpen && matches[0]) {
                  setValue(matches[0].text)
                  setSlashOpen(false)
                  return
                }
                submit()
              }
            }}
            onPaste={(e) => {
              const paths = Array.from(e.clipboardData.files)
                .map((file) => (file as File & { path?: string }).path)
                .filter((path): path is string => typeof path === 'string' && path !== '')
              if (paths.length > 0) {
                e.preventDefault()
                addFiles(paths)
              }
            }}
            placeholder={props.disabled ? 'Add a project folder first' : 'Do anything'}
          />

          {slashOpen && matches.length > 0 ? (
            <div className="slash" role="listbox">
              {matches.map((command) => (
                <button
                  key={command.name}
                  className="menu__item"
                  onClick={() => {
                    setValue(command.text)
                    setSlashOpen(false)
                  }}
                >
                  <span className="menu__name">{command.name}</span>
                  <span className="menu__desc">{command.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

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
                  detail="Or drag them onto the box"
                  onClick={() => {
                    close()
                    void pickFiles().then(addFiles)
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
                      setValue(command.text)
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
              <span className={`tool ${props.approval === 'full' ? 'tool--danger' : ''}`}>
                <ShieldGlyph />
                <span>{approval.short}</span>
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

          {/* Effort is changed far more often than the model, so it stays at the
              top level. Segments while they fit; past four options they would
              push the send button off a narrow window, so it becomes a menu. */}
          {efforts.length > 1 && efforts.length <= 4 ? (
            <div className="segments" role="group" aria-label="Reasoning effort">
              {efforts.map((entry) => (
                <button
                  key={entry}
                  className={`segment ${entry === props.effort ? 'is-on' : ''}`}
                  onClick={() => props.onEffortChange(entry)}
                  disabled={props.running}
                  title={`Reasoning: ${entry}`}
                >
                  {entry}
                </button>
              ))}
            </div>
          ) : efforts.length > 1 ? (
            <Menu
              label="Reasoning effort"
              align="right"
              disabled={props.running}
              trigger={() => (
                <span className="tool tool--compact">
                  <GaugeGlyph />
                  <span>{props.effort ?? 'effort'}</span>
                </span>
              )}
            >
              {(close) => (
                <>
                  <p className="menu__group">Reasoning effort</p>
                  {efforts.map((entry) => (
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
              )}
            </Menu>
          ) : null}

          {props.models.length > 0 ? (
            <Menu
              label="Model"
              align="right"
              disabled={props.running}
              trigger={() => (
                <span className="tool">
                  <BoltGlyph />
                  <span>{model?.displayName ?? 'Model'}</span>
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
                </>
              )}
            </Menu>
          ) : showModelPlaceholder ? (
            <span className="tool tool--quiet">Loading models…</span>
          ) : null}

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

function ImageGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 11l3-3 2.5 2.5L11 8l2 2" stroke="currentColor" strokeWidth="1.3" />
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

function GaugeGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.6 11.5a6 6 0 1110.8 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M8 11L10.6 6.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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
