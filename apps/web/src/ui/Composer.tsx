import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, Model } from '@harness/contracts'
import {
  ArrowUp,
  File as FileIcon,
  Folder,
  GitBranch,
  Image as ImageIcon,
  LockOpen,
  Plus,
  ShieldCheck,
  ShieldQuestion,
  Square,
  type LucideIcon,
  X,
} from 'lucide-react'
import { pickFiles, savePastedImage } from '../bridge.js'
import { SHORTCUTS, shortcutAria } from '../shortcuts.js'
import {
  describeMicrophoneError,
  formatRecordingDuration,
  MAX_RECORDING_MS,
  type VoiceRecording,
  useVoiceRecorder,
} from '../voice-recorder.js'
import { ImageViewer } from './ImageViewer.js'
import { Menu, MenuItem } from './Menu.js'
import { ModelSelector } from './ModelSelector.js'
import { ComposerVoiceButton } from './ComposerVoiceButton.js'
import { ComposerVoiceRecorderBar } from './ComposerVoiceRecorderBar.js'

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
  icon: LucideIcon
}[] = [
  {
    id: 'ask',
    title: 'Ask first',
    short: 'Ask first',
    detail: 'Read-only until you approve each action',
    icon: ShieldQuestion,
  },
  {
    id: 'auto',
    title: 'Auto-approve',
    short: 'Auto',
    detail: 'Edits and commands inside this folder',
    icon: ShieldCheck,
  },
  {
    id: 'full',
    title: 'Full access',
    short: 'Full access',
    detail: 'No sandbox, no prompts, no undo. Use with care.',
    icon: LockOpen,
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
const PASTEABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
])

type ComposerAttachment = {
  id: string
  name: string
  path?: string
  previewUrl?: string
}

export function Composer(props: {
  projectName: string | undefined
  workspace: WorkspaceInfo | undefined
  models: Model[]
  /** Whether the list has come back yet, so an empty list is not read as pending. */
  modelsLoaded: boolean
  modelId: string | undefined
  effort: string | undefined
  serviceTier: string | undefined
  approval: ApprovalMode
  voiceAvailable: boolean
  disabled: boolean
  running: boolean
  newSession: boolean
  isolate: boolean
  focusRequest: number
  onModelChange: (id: string) => void
  onEffortChange: (effort: string) => void
  onServiceTierChange: (serviceTier: string | undefined) => void
  onApprovalChange: (mode: ApprovalMode) => void
  onIsolateChange: (isolate: boolean) => void
  onTranscribeVoice: (requestId: string, recording: VoiceRecording) => Promise<string>
  onCancelVoice: (requestId: string) => void
  onSend: (text: string, attachments: string[]) => void
  onInterrupt: () => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [viewingImage, setViewingImage] = useState<{ src: string; name: string }>()
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceError, setVoiceError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const voiceRequest = useRef<string | undefined>(undefined)
  const voiceOperation = useRef(0)
  const cancelVoiceRequest = useRef(props.onCancelVoice)
  const textRef = useRef(text)
  const previewUrls = useRef(new Set<string>())
  const mounted = useRef(true)
  const recorder = useVoiceRecorder()

  textRef.current = text
  cancelVoiceRequest.current = props.onCancelVoice

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void recorder.cancel()
      if (voiceRequest.current) cancelVoiceRequest.current(voiceRequest.current)
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    }
  }, [recorder.cancel])

  useEffect(() => {
    if (props.focusRequest > 0 && !props.disabled) area.current?.focus()
  }, [props.focusRequest, props.disabled])

  // A provider that cannot enumerate models shows nothing. Sitting on
  // "Loading models…" forever is the UI lying about what it is doing.
  const showModelPlaceholder = props.models.length === 0 && !props.modelsLoaded
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!
  const ApprovalIcon = approval.icon

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
    if (paths.length === 0) return
    setAttachments((current) => {
      const attached = new Set(current.flatMap((attachment) => attachment.path ?? []))
      return [
        ...current,
        ...paths
          .filter((path) => !attached.has(path))
          .map((path) => ({ id: path, name: basename(path), path })),
      ]
    })
  }

  const addPastedImages = (files: File[]) => {
    setAttachmentError(undefined)
    for (const file of files) {
      const previewUrl = URL.createObjectURL(file)
      previewUrls.current.add(previewUrl)
      const id = previewUrl
      setAttachments((current) => [
        ...current,
        { id, name: file.name || 'Pasted image', previewUrl },
      ])

      void savePastedImage(file)
        .then((path) => {
          if (!mounted.current) return
          if (!path) {
            removeAttachment(id)
            setAttachmentError('Pasting images is available in the desktop app.')
            return
          }
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id ? { ...attachment, path } : attachment,
            ),
          )
        })
        .catch(() => {
          if (!mounted.current) return
          removeAttachment(id)
          setAttachmentError('Couldn’t attach that image.')
        })
    }
  }

  const releasePreview = (previewUrl: string | undefined) => {
    if (!previewUrl || !previewUrls.current.delete(previewUrl)) return
    URL.revokeObjectURL(previewUrl)
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed?.previewUrl === viewingImage?.src) setViewingImage(undefined)
      releasePreview(removed?.previewUrl)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  const clearAttachments = () => {
    for (const attachment of attachments) releasePreview(attachment.previewUrl)
    setAttachments([])
  }

  const submit = () => {
    const trimmed = text.trim()
    const paths = attachments.flatMap((attachment) => attachment.path ?? [])
    if (
      trimmed === '' ||
      paths.length !== attachments.length ||
      props.disabled ||
      voiceState !== 'idle'
    ) {
      return
    }
    props.onSend(trimmed, paths)
    setText('')
    clearAttachments()
    setSlashOpen(false)
    const el = area.current
    if (el) {
      el.style.height = 'auto'
      el.focus()
    }
  }

  const insertTranscript = (transcript: string) => {
    const cursor = area.current?.selectionStart ?? textRef.current.length
    const inserted = insertTranscriptAtCursor(textRef.current, transcript, cursor)
    if (!inserted) return
    textRef.current = inserted.text
    setText(inserted.text)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(inserted.cursor, inserted.cursor)
      grow()
    })
  }

  const startVoice = async () => {
    const operation = voiceOperation.current + 1
    voiceOperation.current = operation
    setVoiceError(undefined)
    try {
      await recorder.start()
      if (mounted.current && voiceOperation.current === operation) {
        setVoiceState('recording')
      } else {
        await recorder.cancel()
      }
    } catch (error) {
      if (mounted.current && voiceOperation.current === operation) {
        setVoiceState('idle')
        setVoiceError(describeMicrophoneError(error))
      }
    }
  }

  const transcribeVoice = async () => {
    if (voiceState !== 'recording') return
    const operation = voiceOperation.current
    setVoiceState('transcribing')
    setVoiceError(undefined)
    const recording = await recorder.stop()
    if (!mounted.current || voiceOperation.current !== operation) return
    if (!recording) {
      setVoiceState('idle')
      setVoiceError('No audio was captured. Check the selected microphone and try again.')
      return
    }
    const requestId = crypto.randomUUID()
    voiceRequest.current = requestId
    try {
      const transcript = await props.onTranscribeVoice(requestId, recording)
      if (
        !mounted.current ||
        voiceOperation.current !== operation ||
        voiceRequest.current !== requestId
      ) {
        return
      }
      insertTranscript(transcript)
    } catch (error) {
      if (
        !mounted.current ||
        voiceOperation.current !== operation ||
        voiceRequest.current !== requestId
      ) {
        return
      }
      setVoiceError(error instanceof Error ? error.message : 'Voice transcription failed.')
    } finally {
      if (
        mounted.current &&
        voiceOperation.current === operation &&
        voiceRequest.current === requestId
      ) {
        voiceRequest.current = undefined
        setVoiceState('idle')
      }
    }
  }

  const cancelVoice = () => {
    voiceOperation.current += 1
    if (voiceRequest.current) {
      props.onCancelVoice(voiceRequest.current)
      voiceRequest.current = undefined
    }
    void recorder.cancel()
    setVoiceError(undefined)
    setVoiceState('idle')
  }

  useEffect(() => {
    if (voiceState === 'recording' && recorder.durationMs >= MAX_RECORDING_MS) {
      void transcribeVoice()
    }
  })

  useEffect(() => {
    if (!props.voiceAvailable && voiceState !== 'idle') cancelVoice()
  }, [props.voiceAvailable])

  return (
    <>
      <div className="composer">
        <div
          className={`composer__box ${dragging ? 'is-dropping' : ''}`}
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
                <Folder size={13} aria-hidden />
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

            {attachments.map((attachment) =>
              attachment.previewUrl ? (
                <span
                  className={`attachment-preview ${attachment.path ? '' : 'is-loading'}`}
                  key={attachment.id}
                  title={attachment.name}
                >
                  <button
                    className="attachment-preview__open"
                    type="button"
                    onClick={() =>
                      setViewingImage({ src: attachment.previewUrl!, name: attachment.name })
                    }
                    aria-label={`Open ${attachment.name}`}
                  >
                    <img src={attachment.previewUrl} alt="" />
                  </button>
                  <button
                    className="attachment-preview__remove"
                    onClick={() => removeAttachment(attachment.id)}
                    title="Remove"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X size={13} aria-hidden />
                  </button>
                  {attachment.path ? null : <span className="attachment-preview__loading" />}
                </span>
              ) : (
                <span className="chip chip--file" key={attachment.id} title={attachment.path}>
                  {attachment.path && IMAGE_RE.test(attachment.path) ? (
                    <ImageIcon size={13} aria-hidden />
                  ) : (
                    <FileIcon size={13} aria-hidden />
                  )}
                  <span className="chip__label">{attachment.name}</span>
                  <button
                    className="chip__x"
                    onClick={() => removeAttachment(attachment.id)}
                    title="Remove"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X size={10} aria-hidden />
                  </button>
                </span>
              ),
            )}
            {attachmentError ? (
              <span className="chip chip--error" role="alert">
                {attachmentError}
              </span>
            ) : null}
          </div>

          <div className="composer__field">
            <textarea
              ref={area}
              value={text}
              rows={1}
              spellCheck={false}
              disabled={props.disabled}
              aria-keyshortcuts={shortcutAria(SHORTCUTS.focusComposer)}
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
                const files = Array.from(e.clipboardData.files)
                const images = files.filter((file) => PASTEABLE_IMAGE_TYPES.has(file.type))
                const paths = files
                  .filter((file) => !PASTEABLE_IMAGE_TYPES.has(file.type))
                  .map((file) => (file as File & { path?: string }).path)
                  .filter((path): path is string => typeof path === 'string' && path !== '')
                if (images.length > 0 || paths.length > 0) {
                  e.preventDefault()
                  addFiles(paths)
                  addPastedImages(images)
                }
              }}
              placeholder={props.disabled ? 'Add a project folder first' : 'Do anything'}
            />

            {slashOpen && matches.length > 0 ? (
              <div className="slash" role="listbox">
                {matches.map((command) => {
                  const CommandIcon = command.icon
                  return (
                    <button
                      key={command.name}
                      className="menu__item"
                      onClick={() => {
                        setValue(command.text)
                        setSlashOpen(false)
                      }}
                    >
                      <CommandIcon className="menu__icon" size={12} aria-hidden />
                      <span className="menu__copy">
                        <span className="menu__name">{command.name}</span>
                        <span className="menu__desc">{command.detail}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>

          <div className="tools">
            <Menu
              label="Add"
              disabled={props.disabled}
              wrapperClassName="composer-tool composer-tool--add"
              trigger={() => (
                <span className="tool tool--icon">
                  <Plus size={15} aria-hidden />
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
              wrapperClassName="composer-tool composer-tool--approval"
              trigger={() => (
                <span className={`tool ${props.approval === 'full' ? 'tool--danger' : ''}`}>
                  <ApprovalIcon size={13} aria-hidden />
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

            {voiceState === 'idle' && props.newSession ? (
              <button
                className={`tool isolation-toggle${props.isolate ? ' is-on' : ''}`}
                type="button"
                aria-pressed={props.isolate}
                onClick={() => props.onIsolateChange(!props.isolate)}
                title="Give this session its own git worktree"
              >
                <GitBranch size={13} aria-hidden />
                <span>{props.isolate ? 'Isolated checkout' : 'Shared checkout'}</span>
              </button>
            ) : null}

            {voiceState === 'idle' ? <span className="tools__spacer" /> : null}

            {voiceState === 'idle' && props.models.length > 0 ? (
              <ModelSelector
                models={props.models}
                modelId={props.modelId}
                effort={props.effort}
                serviceTier={props.serviceTier}
                disabled={props.running}
                onModelChange={props.onModelChange}
                onEffortChange={props.onEffortChange}
                onServiceTierChange={props.onServiceTierChange}
              />
            ) : voiceState === 'idle' && showModelPlaceholder ? (
              <span className="tool tool--quiet">Loading models…</span>
            ) : null}

            {props.voiceAvailable && voiceState === 'idle' && !props.running ? (
              <ComposerVoiceButton
                disabled={props.disabled || props.running}
                isRecording={false}
                isTranscribing={false}
                durationLabel={formatRecordingDuration(recorder.durationMs)}
                onClick={() => void startVoice()}
              />
            ) : null}

            {props.voiceAvailable && voiceState !== 'idle' ? (
              <ComposerVoiceRecorderBar
                disabled={props.disabled || props.running}
                isTranscribing={voiceState === 'transcribing'}
                durationLabel={formatRecordingDuration(recorder.durationMs)}
                waveformLevels={recorder.levels}
                onCancel={cancelVoice}
                onSubmit={() => void transcribeVoice()}
              />
            ) : props.running ? (
              <button className="orb orb--stop" onClick={props.onInterrupt} title="Stop">
                <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden />
              </button>
            ) : (
              <button
                className="orb"
                onClick={submit}
                disabled={
                  text.trim() === '' ||
                  attachments.some((attachment) => !attachment.path) ||
                  props.disabled ||
                  voiceState !== 'idle'
                }
                title="Send"
              >
                <ArrowUp size={15} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
      {voiceError ? (
        <div className="composer__voice-error" role="alert">
          {voiceError}
        </div>
      ) : null}
      {viewingImage ? (
        <ImageViewer
          src={viewingImage.src}
          name={viewingImage.name}
          onClose={() => setViewingImage(undefined)}
        />
      ) : null}
    </>
  )
}

export function insertTranscriptAtCursor(
  current: string,
  transcript: string,
  cursor: number,
): { text: string; cursor: number } | undefined {
  const spoken = transcript.trim()
  if (!spoken) return undefined
  const position = Math.max(0, Math.min(current.length, cursor))
  const before = current.slice(0, position)
  const after = current.slice(position)
  const leading = before && !/\s$/.test(before) ? ' ' : ''
  const trailing = after && !/^\s/.test(after) ? ' ' : ''
  const insertion = `${leading}${spoken}${trailing}`
  return {
    text: `${before}${insertion}${after}`,
    cursor: before.length + leading.length + spoken.length + trailing.length,
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
