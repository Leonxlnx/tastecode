import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react'
import type { ApprovalMode, ProviderId, QueuedTurn, Usage } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import {
  ArrowUp,
  Box,
  CornerDownRight,
  File as FileIcon,
  Folder,
  GitBranch,
  GripVertical,
  Image as ImageIcon,
  Laptop,
  LockOpen,
  Palette,
  Pencil,
  Play,
  Plus,
  ScanEye,
  Server,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Trash2,
  type LucideIcon,
  Video,
  X,
} from 'lucide-react'
import {
  pickFiles,
  previewViewedImage,
  revealPath,
  savePastedFile,
  type PickedAttachment,
} from '../bridge.js'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'
import type { Transport } from '../transport.js'
import { type VoiceRecording } from '../voice-capability.js'
import type { ComposerVoiceState } from './ComposerVoiceControl.js'
import { DesignBeam, preloadDesignBeamStyles } from './DesignBeam.js'
import {
  COMPOSER_RESOURCE_LIST_ID,
  type ComposerResource,
  type ComposerResourcePickerHandle,
  type ComposerResourceTrigger,
} from './composer-resource.js'
import { Menu, MenuItem } from './Menu.js'
import { ModelSearchField } from './ModelSearchField.js'
import type { Project } from './Sidebar.js'

const MediaViewer = lazy(() =>
  import('./MediaViewer.js').then((module) => ({ default: module.MediaViewer })),
)
const ComposerResourcePicker = lazy(() =>
  import('./ComposerResourcePicker.js').then((module) => ({
    default: module.ComposerResourcePicker,
  })),
)
const ModelSelector = lazy(() =>
  import('./ModelSelector.js').then((module) => ({ default: module.ModelSelector })),
)
const ComposerVoiceControl = lazy(() =>
  import('./ComposerVoiceControl.js').then((module) => ({
    default: module.ComposerVoiceControl,
  })),
)
const DRAFT_HAS_CONTENT = /\S/u

declare global {
  interface File {
    readonly path?: string
  }
}

type ContextUsageStyle = CSSProperties & { '--context-used': number }

function contextUsageStyle(percent: number): ContextUsageStyle {
  return { '--context-used': percent }
}

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
    id: 'auto-review',
    title: 'Auto-review',
    short: 'Auto-review',
    detail: 'Codex reviews elevated actions before they run',
    icon: ScanEye,
  },
  {
    id: 'full',
    title: 'Full access',
    short: 'Full access',
    detail: 'No sandbox, no prompts, no undo. Use with care.',
    icon: LockOpen,
  },
]

const IMAGE_RE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i
const PREVIEWABLE_IMAGE_RE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|webp)$/i
const VIDEO_RE = /\.(avi|m4v|mkv|mov|mp4|mpe?g|ogg|ogv|webm)$/i
const COMPOSER_MIN_HEIGHT = 68
const COMPOSER_MAX_HEIGHT = 242

function composerInputOnlyInserts(previous: string, next: string, event: InputEvent): boolean {
  if (event.isComposing) return false
  if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
    return next.length === previous.length + 1
  }
  if (event.inputType !== 'insertText' && event.inputType !== 'insertFromPaste') return false
  return event.data !== null && next.length === previous.length + event.data.length
}
const COMPOSER_RESOURCE_FAST_QUERY_LENGTH = 64

function BranchMenu(props: {
  branches: string[]
  activeBranch: string | undefined
  onSelect: (branch: string) => void
}) {
  const [query, setQuery] = useState('')
  const results = useRef<HTMLDivElement>(null)
  const orderedBranches = useMemo(
    () => [
      ...props.branches.filter((branch) => branch === 'main'),
      ...props.branches.filter((branch) => branch !== 'main'),
    ],
    [props.branches],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBranches = normalizedQuery
    ? orderedBranches.filter((branch) => branch.toLocaleLowerCase().includes(normalizedQuery))
    : orderedBranches

  const focusResult = (edge: 'first' | 'last') => {
    const items = results.current?.querySelectorAll<HTMLButtonElement>('.menu__item')
    const target = edge === 'first' ? items?.[0] : items?.[items.length - 1]
    target?.focus()
  }

  return (
    <>
      <ModelSearchField
        className="branch-menu__search"
        value={query}
        label="Search branches"
        placeholder="Search branches"
        autoFocus
        onChange={setQuery}
        onNavigate={focusResult}
      />
      <div className="branch-menu__results" ref={results}>
        {filteredBranches.length > 0 ? (
          filteredBranches.map((branch) => (
            <MenuItem
              key={branch}
              title={branch}
              icon={<GitBranch size={14} aria-hidden />}
              active={branch === props.activeBranch}
              onClick={() => props.onSelect(branch)}
            />
          ))
        ) : (
          <p className="branch-menu__empty" role="status">
            No matching branches.
          </p>
        )}
      </div>
    </>
  )
}
const COMPOSER_DOCK_ANIMATION_ID = 'harness-composer-dock'
const COMPOSER_DOCK_MOTION_MS = 320
const COMPOSER_DOCK_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)'
const ATTACHMENTS_UNSUPPORTED = 'Attachments aren’t supported by this source.'
const ATTACHMENTS_BLOCK_SEND = 'Remove attachments or switch to a source that supports them.'
const MAX_PASTED_FILE_BYTES = 25 * 1024 * 1024
const PREVIEWABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
])
const PREVIEWABLE_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/ogg',
  'video/mpeg',
  'video/x-matroska',
  'video/x-msvideo',
])

type ComposerAttachment = {
  id: string
  name: string
  path?: string
  previewUrl?: string
  thumbnailUrl?: string
  mediaType?: 'image' | 'video'
}

type RunningSubmission = 'queue' | 'steer'

export type SendAvailability = 'loading' | 'ready' | 'setup-required' | 'unavailable'

function QueuedMediaPreview({ attachments }: { attachments: string[] }) {
  const reference = attachments.find((attachment) => previewMediaType('', attachment))
  return reference ? <QueuedMediaPreviewCard key={reference} reference={reference} /> : null
}

function QueuedMediaPreviewCard({ reference }: { reference: string }) {
  const inferredMediaType = previewMediaType('', reference)
  const [preview, setPreview] = useState<PickedAttachment>()
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void previewViewedImage(reference).then((result) => {
      if (!cancelled) setPreview(result)
    })
    return () => {
      cancelled = true
    }
  }, [reference])

  if (!inferredMediaType) return null
  const mediaType = preview?.mediaType ?? inferredMediaType
  const name = preview?.name ?? basename(reference)
  const inlineSource =
    !mediaFailed && preview?.thumbnailUrl && !thumbnailFailed
      ? preview.thumbnailUrl
      : !mediaFailed && mediaType === 'image'
        ? preview?.previewUrl
        : undefined
  const canOpen = Boolean(preview?.previewUrl && preview.mediaType)

  return (
    <>
      <button
        type="button"
        className="queue-row__media"
        disabled={!canOpen}
        onClick={() => setViewerOpen(true)}
        aria-label={
          canOpen ? `Open queued preview of ${name}` : `Loading queued preview of ${name}`
        }
      >
        <span className="queue-row__media-fallback" aria-hidden>
          {mediaType === 'video' ? <Video size={16} /> : <ImageIcon size={16} />}
        </span>
        {inlineSource ? (
          <img
            src={inlineSource}
            alt=""
            draggable={false}
            onError={() => {
              if (preview?.thumbnailUrl && !thumbnailFailed) setThumbnailFailed(true)
              else setMediaFailed(true)
            }}
          />
        ) : null}
        {mediaType === 'video' ? (
          <span className="queue-row__media-play" aria-hidden>
            <Play size={9} fill="currentColor" />
          </span>
        ) : null}
      </button>
      {viewerOpen && preview?.previewUrl && preview.mediaType ? (
        <Suspense fallback={null}>
          <MediaViewer
            src={preview.previewUrl}
            name={preview.name}
            mediaType={preview.mediaType}
            onReveal={() => void revealPath(reference)}
            onClose={() => setViewerOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}

export function composerResourceTriggerAt(
  text: string,
  cursor: number,
): ComposerResourceTrigger | undefined {
  if (!Number.isFinite(cursor)) return undefined
  const position = Math.max(0, Math.min(text.length, Math.trunc(cursor)))
  if (position === 0) return undefined

  // Most resource names are short. Walk only the active token instead of
  // slicing and running a regular expression across the complete draft on
  // every key. A pathological long token keeps the old parser as a bounded
  // fallback, so its worst case does not regress.
  const fastStart = Math.max(0, position - COMPOSER_RESOURCE_FAST_QUERY_LENGTH)
  let queryStart = position
  while (queryStart > fastStart && isResourceQueryCharacter(text.charCodeAt(queryStart - 1))) {
    queryStart -= 1
  }
  if (
    queryStart === fastStart &&
    queryStart > 0 &&
    isResourceQueryCharacter(text.charCodeAt(queryStart - 1))
  ) {
    return composerResourceTriggerAtLongToken(text, position)
  }

  const markerIndex = queryStart - 1
  if (markerIndex < 0) return undefined
  if (markerIndex > 0 && !/[\s([{]/.test(text[markerIndex - 1]!)) return undefined

  const marker = text[markerIndex]
  if (marker !== '/' && marker !== '$' && marker !== '@') return undefined
  const query = text.slice(queryStart, position)
  if (marker === '/' && /^(?:side|btw)$/i.test(query)) return undefined
  let end = position
  while (end < text.length && isResourceQueryCharacter(text.charCodeAt(end))) end += 1
  return { marker, query, start: markerIndex, end }
}

function composerResourceTriggerAtLongToken(
  text: string,
  cursor: number,
): ComposerResourceTrigger | undefined {
  const beforeCursor = text.slice(0, cursor)
  const match = /(^|[\s([{])([/$@])([\w.:-]*)$/.exec(beforeCursor)
  if (!match) return undefined
  const marker = match[2]
  if (marker !== '/' && marker !== '$' && marker !== '@') return undefined
  const query = match[3] ?? ''
  if (marker === '/' && /^(?:side|btw)$/i.test(query)) return undefined
  const start = cursor - query.length - 1
  let end = cursor
  while (end < text.length && isResourceQueryCharacter(text.charCodeAt(end))) end += 1
  return { marker, query, start, end }
}

function isResourceQueryCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 46 ||
    code === 58 ||
    code === 95
  )
}

export function composerPromptWithResources(text: string, resources: ComposerResource[]): string {
  const references = resources.map((resource) => resource.token).join(' ')
  const body = text.trim()
  if (references && body) return `${references}\n\n${body}`
  return references || body
}

function ComposerComponent(props: {
  transport: Transport
  provider: ProviderId
  projects: Project[]
  projectPath: string | undefined
  projectName: string | undefined
  branch: string | undefined
  branches: string[]
  models: ModelChoice[]
  /** Whether the list has come back yet, so an empty list is not read as pending. */
  modelsLoaded: boolean
  modelId: string | undefined
  effort: string | undefined
  serviceTier: string | undefined
  usage?: Usage | undefined
  approval: ApprovalMode
  autoReviewSupported: boolean
  attachmentsSupported: boolean
  voiceAvailable: boolean
  disabled: boolean
  sendAvailability: SendAvailability
  running: boolean
  newSession: boolean
  isolate: boolean
  designMode: boolean
  keybindings?: Keybindings | undefined
  focusRequest: number
  draftRequest?: { text: string; attachments?: string[]; request: number } | undefined
  onDraftChange?: ((text: string) => void) | undefined
  onAttachmentsChange?: ((attachments: string[]) => void) | undefined
  queuedTurns: QueuedTurn[]
  canSteerQueue: boolean
  onModelSelectorOpen?: (() => void) | undefined
  onModelChange: (id: string) => void
  onEffortChange: (effort: string) => void
  onServiceTierChange: (serviceTier: string | undefined) => void
  onApprovalChange: (mode: ApprovalMode) => void
  onIsolateChange: (isolate: boolean) => void
  onDesignModeChange: (enabled: boolean) => void
  onTranscribeVoice: (requestId: string, recording: VoiceRecording) => Promise<string>
  onCancelVoice: (requestId: string) => void
  onProjectChange: (path: string) => void
  onBranchChange: (branch: string) => void
  onProjectRequired: () => void
  onSetupProvider: () => void
  onSend: (text: string, attachments: string[]) => void
  onSteer: (text: string, attachments: string[]) => void
  onInterrupt: () => void
  /** An interrupt is sent and the turn has not ended yet. */
  stopping?: boolean | undefined
  onDeleteQueuedTurn: (id: string) => void
  onMoveQueuedTurn: (id: string, direction: 'up' | 'down') => void | Promise<boolean | void>
  onSteerQueuedTurn: (id: string) => void
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  // The textarea owns its full draft. React only needs the blank/nonblank
  // boundary, so ordinary typing does not rerender the complete composer.
  const [hasDraftText, setHasDraftText] = useState(false)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [viewingMedia, setViewingMedia] = useState<{
    src: string
    name: string
    mediaType: 'image' | 'video'
    localPath?: string
  }>()
  const [voiceState, setVoiceState] = useState<ComposerVoiceState>('idle')
  const [voiceError, setVoiceError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [draggedQueueId, setDraggedQueueId] = useState<string>()
  const [queueDropTarget, setQueueDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  }>()
  const [selectedResources, setSelectedResources] = useState<ComposerResource[]>([])
  const [resourceTrigger, setResourceTrigger] = useState<ComposerResourceTrigger>()
  const [resourcePickerMounted, setResourcePickerMounted] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const resourcePicker = useRef<ComposerResourcePickerHandle>(null)
  const sendAvailabilityRef = useRef(props.sendAvailability)
  const textRef = useRef('')
  const hasDraftTextRef = useRef(false)
  const attachmentsSupportedRef = useRef(props.attachmentsSupported)
  const previewUrls = useRef(new Set<string>())
  const resizeFrame = useRef<number | undefined>(undefined)
  const composerAtMaximumHeight = useRef(false)
  const observedComposerWidth = useRef<number | undefined>(undefined)
  const composerAnchor = useRef<HTMLDivElement>(null)
  const previousNewSession = useRef(props.newSession)
  const previousComposerRect = useRef<DOMRect | null>(null)
  const dockAnimation = useRef<Animation | null>(null)
  const mounted = useRef(true)
  const selectedResourceKeys = useMemo(
    () => new Set(selectedResources.map((resource) => resource.key)),
    [selectedResources],
  )

  const updateResourceTrigger = (trigger: ComposerResourceTrigger | undefined) => {
    setResourceTrigger(trigger)
    if (trigger) setResourcePickerMounted(true)
  }

  const endQueueDrag = () => {
    setDraggedQueueId(undefined)
    setQueueDropTarget(undefined)
  }

  const dropQueuedTurn = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!draggedQueueId || !queueDropTarget || draggedQueueId === targetId) {
      endQueueDrag()
      return
    }
    const sourceIndex = props.queuedTurns.findIndex((turn) => turn.id === draggedQueueId)
    const remaining = props.queuedTurns.filter((turn) => turn.id !== draggedQueueId)
    const targetIndex = remaining.findIndex((turn) => turn.id === targetId)
    const destination = targetIndex + (queueDropTarget.position === 'after' ? 1 : 0)
    if (sourceIndex >= 0 && targetIndex >= 0) {
      const direction = destination < sourceIndex ? 'up' : 'down'
      void (async () => {
        for (let index = 0; index < Math.abs(destination - sourceIndex); index += 1) {
          if ((await props.onMoveQueuedTurn(draggedQueueId, direction)) === false) break
        }
      })()
    }
    endQueueDrag()
  }

  attachmentsSupportedRef.current = props.attachmentsSupported
  sendAvailabilityRef.current = props.sendAvailability

  useEffect(() => {
    if (props.attachmentsSupported) setAttachmentError(undefined)
  }, [props.attachmentsSupported])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (resizeFrame.current !== undefined) window.cancelAnimationFrame(resizeFrame.current)
      dockAnimation.current?.cancel()
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    }
  }, [])

  useEffect(() => {
    const el = area.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined) return
      const previousWidth = observedComposerWidth.current
      observedComposerWidth.current = width
      if (previousWidth !== undefined && width !== previousWidth) {
        composerAtMaximumHeight.current = false
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // T3 Code's draft composer uses a FLIP transition: remember where the real
  // composer was before send, render it in the docked layout, then animate only
  // that positional delta. This keeps focus and textarea state on one DOM tree.
  useLayoutEffect(() => {
    const group = composerAnchor.current
    const nextRect = group?.getBoundingClientRect() ?? null
    const stateChanged = previousNewSession.current !== props.newSession
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    dockAnimation.current?.cancel()
    dockAnimation.current = null

    const previousRect = previousComposerRect.current
    if (stateChanged && !reduceMotion && group && previousRect && nextRect && group.animate) {
      const x = previousRect.left - nextRect.left
      const y = previousRect.top - nextRect.top
      if (Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5) {
        const animation = group.animate(
          [{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          { duration: COMPOSER_DOCK_MOTION_MS, easing: COMPOSER_DOCK_EASING },
        )
        animation.id = COMPOSER_DOCK_ANIMATION_ID
        dockAnimation.current = animation
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (dockAnimation.current === animation) dockAnimation.current = null
          })
      }
    }

    previousNewSession.current = props.newSession
    previousComposerRect.current = nextRect
  }, [props.newSession])

  useEffect(() => {
    if (props.focusRequest > 0 && !props.disabled) area.current?.focus()
  }, [props.focusRequest, props.disabled])

  useEffect(() => {
    setSelectedResources([])
    setResourceTrigger(undefined)
  }, [props.provider, props.projectPath])

  // A provider that cannot enumerate models shows nothing. Sitting on
  // "Loading models…" forever is the UI lying about what it is doing.
  const showModelPlaceholder = props.models.length === 0 && !props.modelsLoaded
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!
  const ApprovalIcon = approval.icon

  const grow = () => {
    const el = area.current
    if (!el) return
    const currentHeight = el.offsetHeight
    el.style.height = 'auto'
    const contentHeight = el.scrollHeight
    composerAtMaximumHeight.current = contentHeight > COMPOSER_MAX_HEIGHT
    const nextHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(contentHeight, COMPOSER_MAX_HEIGHT))
    el.style.height = `${currentHeight}px`
    el.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
    if (resizeFrame.current !== undefined) window.cancelAnimationFrame(resizeFrame.current)
    resizeFrame.current = window.requestAnimationFrame(() => {
      resizeFrame.current = undefined
      el.style.height = `${nextHeight}px`
    })
  }

  const updateText = (value: string, syncArea = true) => {
    textRef.current = value
    if (syncArea && area.current && area.current.value !== value) area.current.value = value
    const nextHasDraftText = DRAFT_HAS_CONTENT.test(value)
    if (nextHasDraftText !== hasDraftTextRef.current) {
      hasDraftTextRef.current = nextHasDraftText
      setHasDraftText(nextHasDraftText)
    }
    props.onDraftChange?.(value)
  }

  const setValue = (value: string) => {
    updateText(value)
    setResourceTrigger(undefined)
    requestAnimationFrame(() => {
      area.current?.focus()
      grow()
    })
  }

  useEffect(() => {
    if (!props.draftRequest) return
    setValue(props.draftRequest.text)
    if (props.draftRequest.attachments !== undefined) {
      clearAttachments()
      addFiles(props.draftRequest.attachments)
    }
  }, [props.draftRequest?.request])

  const hydrateAttachmentPreview = (reference: string) => {
    void previewViewedImage(reference).then((preview) => {
      if (!mounted.current || !preview?.mediaType || !preview.previewUrl) return
      const { mediaType, name, previewUrl, thumbnailUrl } = preview
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.path === reference
            ? {
                ...attachment,
                name,
                mediaType,
                previewUrl,
                ...(thumbnailUrl ? { thumbnailUrl } : {}),
              }
            : attachment,
        ),
      )
    })
  }

  const addFiles = (files: Array<PickedAttachment | string>) => {
    if (files.length === 0) return
    setAttachments((current) => {
      const attached = new Set(current.flatMap((attachment) => attachment.path ?? []))
      const additions: ComposerAttachment[] = []
      for (const file of files) {
        const picked = typeof file === 'string' ? { path: file, name: basename(file) } : file
        if (attached.has(picked.path)) continue
        attached.add(picked.path)
        const inferredMediaType = previewMediaType('', picked.name)
        additions.push({
          id: picked.path,
          name: picked.name,
          path: picked.path,
          ...(inferredMediaType ? { mediaType: inferredMediaType } : {}),
          ...(picked.previewUrl ? { previewUrl: picked.previewUrl } : {}),
          ...(picked.thumbnailUrl
            ? {
                thumbnailUrl: picked.thumbnailUrl,
              }
            : {}),
          ...(picked.mediaType ? { mediaType: picked.mediaType } : {}),
        })
      }
      return [...current, ...additions]
    })
    for (const file of files) {
      if (typeof file === 'string' && previewMediaType('', file)) hydrateAttachmentPreview(file)
    }
  }

  const attachFiles = (files: Array<PickedAttachment | string>) => {
    if (files.length === 0) return
    if (!attachmentsSupportedRef.current) {
      setAttachmentError(ATTACHMENTS_UNSUPPORTED)
      return
    }
    setAttachmentError(undefined)
    addFiles(files)
  }

  const addPastedFiles = (files: File[]) => {
    setAttachmentError(undefined)
    for (const file of files) {
      if (file.size > MAX_PASTED_FILE_BYTES) {
        setAttachmentError(`“${file.name}” is larger than 25 MB. Use the file picker instead.`)
        continue
      }
      const mediaType = previewMediaType(file.type, file.name)
      const previewUrl = mediaType ? URL.createObjectURL(file) : undefined
      if (previewUrl) previewUrls.current.add(previewUrl)
      const id = previewUrl ?? `pasted:${crypto.randomUUID()}`
      setAttachments((current) => [
        ...current,
        {
          id,
          name: file.name || 'Pasted file',
          ...(previewUrl ? { previewUrl } : {}),
          ...(mediaType ? { mediaType } : {}),
        },
      ])

      void savePastedFile(file)
        .then((saved) => {
          if (!mounted.current) return
          if (!saved) {
            removeAttachment(id, previewUrl)
            setAttachmentError('Pasting files is available in the desktop app.')
            return
          }
          const picked = saved
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    path: picked.path,
                    ...(picked.thumbnailUrl
                      ? {
                          thumbnailUrl: picked.thumbnailUrl,
                        }
                      : {}),
                  }
                : attachment,
            ),
          )
        })
        .catch(() => {
          if (!mounted.current) return
          removeAttachment(id, previewUrl)
          setAttachmentError(
            `Couldn’t attach “${file.name || 'that file'}”. Use the file picker instead.`,
          )
        })
    }
  }

  const releasePreview = (previewUrl: string | undefined) => {
    if (!previewUrl || !previewUrls.current.delete(previewUrl)) return
    URL.revokeObjectURL(previewUrl)
  }

  const removeAttachment = (id: string, previewUrl?: string) => {
    // Side effects stay outside the updater — updaters run during render and
    // replay under StrictMode. Only renderer-created blob previews are revoked;
    // signed native-picker URLs remain owned by the desktop protocol.
    if (previewUrl) {
      setViewingMedia((current) => (current?.src === previewUrl ? undefined : current))
    }
    releasePreview(previewUrl)
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const clearAttachments = () => {
    for (const attachment of attachments) releasePreview(attachment.previewUrl)
    setViewingMedia(undefined)
    setAttachments([])
  }

  const addDroppedFiles = (files: File[]) => {
    if (!attachmentsSupportedRef.current) {
      setAttachmentError(ATTACHMENTS_UNSUPPORTED)
      return
    }

    const attachedPaths = new Set(attachments.flatMap((attachment) => attachment.path ?? []))
    const picked: PickedAttachment[] = []
    const materialized: File[] = []
    for (const file of files) {
      const filePath = file.path
      if (!filePath) {
        materialized.push(file)
        continue
      }
      if (attachedPaths.has(filePath)) continue
      attachedPaths.add(filePath)
      const mediaType = previewMediaType(file.type, file.name)
      const previewUrl = mediaType ? URL.createObjectURL(file) : undefined
      if (previewUrl) previewUrls.current.add(previewUrl)
      picked.push({
        path: filePath,
        name: file.name || basename(filePath),
        ...(previewUrl ? { previewUrl } : {}),
        ...(mediaType ? { mediaType } : {}),
      })
    }
    attachFiles(picked)
    addPastedFiles(materialized)
  }

  useEffect(() => {
    props.onAttachmentsChange?.(attachments.flatMap((attachment) => attachment.path ?? []))
  }, [attachments, props.onAttachmentsChange])

  const sendContent = (content: string, submission: RunningSubmission = 'queue') => {
    const trimmed = composerPromptWithResources(content, selectedResources)
    const paths = attachments.flatMap((attachment) => attachment.path ?? [])
    if (
      trimmed === '' ||
      paths.length !== attachments.length ||
      props.disabled ||
      sendAvailabilityRef.current !== 'ready' ||
      (!props.attachmentsSupported && attachments.length > 0)
    )
      return false
    if (!props.projectPath) {
      props.onProjectRequired()
      return false
    }
    const el = area.current
    const currentHeight = el?.offsetHeight ?? COMPOSER_MIN_HEIGHT
    previousComposerRect.current = composerAnchor.current?.getBoundingClientRect() ?? null
    if (submission === 'steer') props.onSteer(trimmed, paths)
    else props.onSend(trimmed, paths)
    composerAtMaximumHeight.current = false
    updateText('')
    setSelectedResources([])
    setResourceTrigger(undefined)
    clearAttachments()
    if (el) {
      if (resizeFrame.current !== undefined) window.cancelAnimationFrame(resizeFrame.current)
      el.style.height = `${currentHeight}px`
      resizeFrame.current = window.requestAnimationFrame(() => {
        resizeFrame.current = undefined
        el.style.height = `${COMPOSER_MIN_HEIGHT}px`
        el.style.overflowY = 'hidden'
      })
      el.focus()
    }
    return true
  }

  const submit = (submission: RunningSubmission = 'queue') => {
    if (voiceState !== 'idle') return
    sendContent(textRef.current, submission)
  }

  const editQueuedTurn = (queuedTurn: QueuedTurn) => {
    // Never overwrite words the user is mid-way through typing — prepend the
    // queued text so both survive the edit.
    const draft = textRef.current.trim()
    setValue(draft === '' ? queuedTurn.text : `${queuedTurn.text}\n\n${draft}`)
    addFiles(queuedTurn.attachments)
    props.onDeleteQueuedTurn(queuedTurn.id)
  }

  const insertTranscript = (
    transcript: string,
    cursor = area.current?.selectionStart ?? textRef.current.length,
  ) => {
    const inserted = insertTranscriptAtCursor(textRef.current, transcript, cursor)
    if (!inserted) return
    updateText(inserted.text)
    setResourceTrigger(undefined)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(inserted.cursor, inserted.cursor)
      grow()
    })
  }

  useEffect(() => {
    if (props.voiceAvailable) return
    setVoiceState('idle')
    setVoiceError(undefined)
  }, [props.voiceAvailable])

  const showStop =
    props.running && !hasDraftText && attachments.length === 0 && selectedResources.length === 0
  const submitLabel = props.running ? 'Queue' : 'Send'
  const sendDisabled =
    (!hasDraftText && selectedResources.length === 0) ||
    attachments.some((attachment) => !attachment.path) ||
    props.disabled ||
    props.sendAvailability !== 'ready' ||
    (!props.attachmentsSupported && attachments.length > 0)
  const visibleAttachmentError =
    !props.attachmentsSupported && attachments.length > 0 ? ATTACHMENTS_BLOCK_SEND : attachmentError

  const selectResource = (resource: ComposerResource) => {
    const trigger = resourceTrigger
    if (!trigger) return
    setSelectedResources((current) =>
      current.some((entry) => entry.key === resource.key) ? current : [...current, resource],
    )

    const before = textRef.current.slice(0, trigger.start)
    let after = textRef.current.slice(trigger.end)
    if ((before === '' || before.endsWith(' ')) && after.startsWith(' ')) after = after.slice(1)
    const next = before + after
    updateText(next)
    setResourceTrigger(undefined)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(trigger.start, trigger.start)
      grow()
    })
  }

  return (
    <>
      <div className={`composer${props.newSession ? ' is-new-session' : ''}`}>
        <div
          ref={composerAnchor}
          className={`composer__box ${dragging ? 'is-dropping' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (props.attachmentsSupported) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addDroppedFiles(Array.from(e.dataTransfer.files))
          }}
        >
          {props.newSession ? (
            <div className="composer__shelf">
              <Menu
                label="Choose project"
                drop="down"
                triggerClassName="shelf-control shelf-control--project"
                trigger={() => (
                  <span className="shelf-control__content">
                    <Folder size={15} aria-hidden />
                    <span>{props.projectName ?? 'Choose project'}</span>
                  </span>
                )}
              >
                {(close) => (
                  <>
                    {props.projects.map((project) => (
                      <MenuItem
                        key={project.path}
                        title={project.name ?? basename(project.path)}
                        icon={<Folder size={14} aria-hidden />}
                        detail={project.path}
                        active={project.path === props.projectPath}
                        onClick={() => {
                          props.onProjectChange(project.path)
                          close()
                        }}
                      />
                    ))}
                  </>
                )}
              </Menu>

              <button
                type="button"
                className="shelf-control shelf-control--mode"
                aria-label="Workspace mode"
                aria-pressed={props.isolate}
                aria-keyshortcuts={shortcutAria(keybindings.toggleIsolatedSession)}
                onClick={() => props.onIsolateChange(!props.isolate)}
                title="Switch between the project checkout and an isolated worktree"
              >
                <span className="shelf-control__content">
                  {props.isolate ? (
                    <GitBranch size={15} aria-hidden />
                  ) : (
                    <Laptop size={15} aria-hidden />
                  )}
                  <span>{props.isolate ? 'Isolated' : 'Local'}</span>
                </span>
              </button>

              {props.branches.length > 0 ? (
                <Menu
                  label="Choose branch"
                  drop="down"
                  triggerClassName="shelf-control shelf-control--branch"
                  panelRole="dialog"
                  panelLabel="Choose branch"
                  panelClassName="branch-menu"
                  trigger={() => (
                    <span className="shelf-control__content">
                      <GitBranch size={15} aria-hidden />
                      <span>{props.branch ?? 'No branch'}</span>
                    </span>
                  )}
                >
                  {(close) => (
                    <BranchMenu
                      branches={props.branches}
                      activeBranch={props.branch}
                      onSelect={(branch) => {
                        props.onBranchChange(branch)
                        close()
                      }}
                    />
                  )}
                </Menu>
              ) : null}
            </div>
          ) : null}

          {props.queuedTurns.length > 0 ? (
            <div className="composer__queue" aria-label="Queued prompts">
              {props.queuedTurns.map((queuedTurn, index) => (
                <div
                  className={`queue-row${draggedQueueId === queuedTurn.id ? ' is-dragging' : ''}`}
                  data-drop-position={
                    queueDropTarget?.id === queuedTurn.id ? queueDropTarget.position : undefined
                  }
                  key={queuedTurn.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', queuedTurn.id)
                    setDraggedQueueId(queuedTurn.id)
                  }}
                  onDragOver={(event) => {
                    if (!draggedQueueId || draggedQueueId === queuedTurn.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const bounds = event.currentTarget.getBoundingClientRect()
                    setQueueDropTarget({
                      id: queuedTurn.id,
                      position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
                    })
                  }}
                  onDrop={(event) => dropQueuedTurn(event, queuedTurn.id)}
                  onDragEnd={endQueueDrag}
                >
                  <button
                    type="button"
                    className="queue-row__handle"
                    title="Drag to reorder"
                    aria-label={`Drag ${queuedTurn.text} to reorder`}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
                      if (
                        (direction === 'up' && index > 0) ||
                        (direction === 'down' && index < props.queuedTurns.length - 1)
                      )
                        void props.onMoveQueuedTurn(queuedTurn.id, direction)
                    }}
                  >
                    <GripVertical size={14} aria-hidden />
                  </button>
                  <QueuedMediaPreview attachments={queuedTurn.attachments} />
                  <span className="queue-row__text" title={queuedTurn.text}>
                    {queuedTurn.text}
                  </span>
                  {props.canSteerQueue ? (
                    <button
                      type="button"
                      className="queue-row__steer"
                      onClick={() => props.onSteerQueuedTurn(queuedTurn.id)}
                      title="Steer the running agent with this prompt"
                    >
                      <CornerDownRight size={15} aria-hidden />
                      <span>Steer</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="queue-row__action"
                    onClick={() => editQueuedTurn(queuedTurn)}
                    title="Edit prompt"
                    aria-label={`Edit ${queuedTurn.text}`}
                  >
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="queue-row__action"
                    onClick={() => props.onDeleteQueuedTurn(queuedTurn.id)}
                    title="Remove from queue"
                    aria-label={`Remove ${queuedTurn.text} from queue`}
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {resourcePickerMounted ? (
            <Suspense fallback={null}>
              <ComposerResourcePicker
                ref={resourcePicker}
                transport={props.transport}
                provider={props.provider}
                projectPath={props.projectPath}
                trigger={resourceTrigger}
                selectedKeys={selectedResourceKeys}
                onSelect={selectResource}
              />
            </Suspense>
          ) : null}

          <DesignBeam
            className={`composer__design-beam${props.newSession ? ' is-shelved' : ''}`}
            strength={1}
            active={props.designMode}
          >
            <div className="composer__prompt">
              <div className="chips">
                {attachments.map((attachment) =>
                  attachment.mediaType ? (
                    <span
                      className={`attachment-preview attachment-preview--${attachment.mediaType}${attachment.path ? '' : ' is-loading'}`}
                      key={attachment.id}
                      title={attachment.name}
                    >
                      <button
                        className="attachment-preview__open"
                        type="button"
                        disabled={!attachment.previewUrl}
                        onClick={() => {
                          if (!attachment.previewUrl || !attachment.mediaType) return
                          setViewingMedia({
                            src: attachment.previewUrl,
                            name: attachment.name,
                            mediaType: attachment.mediaType,
                            ...(attachment.previewUrl.startsWith('tastecode-attachment:') &&
                            attachment.path
                              ? { localPath: attachment.path }
                              : {}),
                          })
                        }}
                        aria-label={
                          attachment.previewUrl
                            ? `Open ${attachment.name}`
                            : `Loading preview of ${attachment.name}`
                        }
                      >
                        <span className="attachment-preview__fallback" aria-hidden>
                          {attachment.mediaType === 'video' ? (
                            <Video size={21} strokeWidth={1.6} />
                          ) : (
                            <ImageIcon size={21} strokeWidth={1.6} />
                          )}
                        </span>
                        {attachmentThumbnailUrl(attachment) ? (
                          <img
                            src={attachmentThumbnailUrl(attachment)}
                            alt=""
                            onError={(event) => {
                              event.currentTarget.hidden = true
                            }}
                          />
                        ) : null}
                        {attachment.mediaType === 'video' ? (
                          <span className="attachment-preview__play" aria-hidden>
                            <Play size={14} fill="currentColor" />
                          </span>
                        ) : null}
                      </button>
                      <button
                        className="attachment-preview__remove"
                        onClick={() => removeAttachment(attachment.id, attachment.previewUrl)}
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
                      ) : attachment.path && VIDEO_RE.test(attachment.path) ? (
                        <Play size={13} aria-hidden />
                      ) : (
                        <FileIcon size={13} aria-hidden />
                      )}
                      <span className="chip__label">{attachment.name}</span>
                      <button
                        className="chip__x"
                        onClick={() => removeAttachment(attachment.id, attachment.previewUrl)}
                        title="Remove"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X size={10} aria-hidden />
                      </button>
                    </span>
                  ),
                )}
                {selectedResources.map((resource) => {
                  const ResourceIcon = resource.kind === 'skill' ? Box : Server
                  return (
                    <span
                      className="chip chip--resource"
                      key={resource.key}
                      title={`${resource.kind === 'skill' ? 'Skill' : 'MCP server'} · ${resource.description}`}
                    >
                      <ResourceIcon size={14} strokeWidth={1.7} aria-hidden />
                      <span className="chip__label">{resource.name}</span>
                      <button
                        type="button"
                        className="chip__x"
                        onClick={() => {
                          setSelectedResources((current) =>
                            current.filter((entry) => entry.key !== resource.key),
                          )
                          area.current?.focus()
                        }}
                        title="Remove"
                        aria-label={`Remove ${resource.name}`}
                      >
                        <X size={10} aria-hidden />
                      </button>
                    </span>
                  )
                })}
                {visibleAttachmentError ? (
                  <span className="chip chip--error" role="alert">
                    {visibleAttachmentError}
                  </span>
                ) : null}
              </div>

              <div className="composer__field">
                <textarea
                  ref={area}
                  defaultValue=""
                  rows={2}
                  spellCheck={false}
                  disabled={props.disabled}
                  aria-label="Message"
                  aria-keyshortcuts={shortcutAria(keybindings.focusComposer)}
                  aria-controls={resourceTrigger ? COMPOSER_RESOURCE_LIST_ID : undefined}
                  aria-expanded={resourceTrigger !== undefined}
                  aria-haspopup="listbox"
                  aria-autocomplete="list"
                  onChange={(e) => {
                    const value = e.target.value
                    const onlyInserts =
                      composerAtMaximumHeight.current &&
                      composerInputOnlyInserts(textRef.current, value, e.nativeEvent as InputEvent)
                    updateText(value, false)
                    updateResourceTrigger(
                      composerResourceTriggerAt(value, e.target.selectionStart ?? value.length),
                    )
                    if (!onlyInserts) grow()
                  }}
                  onKeyDown={(e) => {
                    // IME users press Escape to dismiss the candidate window;
                    // that must never reach the shortcuts below (interrupt!).
                    if (e.nativeEvent.isComposing) return
                    if (resourceTrigger) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        resourcePicker.current?.move(e.key === 'ArrowDown' ? 1 : -1)
                        return
                      }
                      if (e.key === 'Tab') {
                        if (resourcePicker.current?.selectActive()) e.preventDefault()
                        return
                      }
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        if (!resourcePicker.current?.selectActive()) setResourceTrigger(undefined)
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setResourceTrigger(undefined)
                        return
                      }
                    }
                    // Typing turns the orb into Queue, which made the agent
                    // unstoppable mid-draft. Esc stays the brake.
                    if (e.key === 'Escape' && props.running) {
                      e.preventDefault()
                      props.onInterrupt()
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submit(
                        props.running && props.canSteerQueue && (e.ctrlKey || e.metaKey)
                          ? 'steer'
                          : 'queue',
                      )
                    }
                  }}
                  onSelect={(e) => {
                    const target = e.currentTarget
                    updateResourceTrigger(
                      composerResourceTriggerAt(textRef.current, target.selectionStart ?? 0),
                    )
                  }}
                  onBlur={() => setResourceTrigger(undefined)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files)
                    const paths = files
                      .filter((file) => previewMediaType(file.type, file.name) === undefined)
                      .map((file) => file.path)
                      .filter((path): path is string => path !== undefined && path !== '')
                    const materialized = files.filter(
                      (file) => previewMediaType(file.type, file.name) !== undefined || !file.path,
                    )
                    if (materialized.length > 0 || paths.length > 0) {
                      e.preventDefault()
                      if (!props.attachmentsSupported) {
                        setAttachmentError(ATTACHMENTS_UNSUPPORTED)
                        return
                      }
                      attachFiles(paths)
                      addPastedFiles(materialized)
                    }
                  }}
                  placeholder={props.disabled ? 'Add a project folder first' : 'Do anything'}
                />
              </div>

              {props.sendAvailability !== 'ready' && props.sendAvailability !== 'loading' ? (
                <div className="composer__provider-state">
                  <span role="status">
                    {props.sendAvailability === 'setup-required'
                      ? 'Provider setup required'
                      : 'Provider unavailable'}
                  </span>
                  <button className="ghost" type="button" onClick={props.onSetupProvider}>
                    Set up a provider
                  </button>
                </div>
              ) : null}

              <div className="tools">
                {props.attachmentsSupported ? (
                  <button
                    type="button"
                    className="menutrigger composer__add"
                    disabled={props.disabled}
                    aria-label="Attach files"
                    onClick={() => void pickFiles().then(attachFiles)}
                  >
                    <span className="tool tool--icon">
                      <Plus size={15} aria-hidden />
                    </span>
                  </button>
                ) : null}

                <Menu
                  label="Permissions"
                  triggerClassName="composer__permission"
                  trigger={() => (
                    <span
                      className={`tool${props.approval === 'auto-review' ? ' tool--review' : ''}${props.approval === 'full' ? ' tool--danger' : ''}`}
                    >
                      <ApprovalIcon size={13} aria-hidden />
                      <span>{approval.short}</span>
                    </span>
                  )}
                >
                  {(close) => (
                    <>
                      {APPROVAL_MODES.filter(
                        (mode) => mode.id !== 'auto-review' || props.autoReviewSupported,
                      ).map((mode) => {
                        const ModeIcon = mode.icon
                        return (
                          <MenuItem
                            key={mode.id}
                            title={mode.title}
                            detail={mode.detail}
                            icon={<ModeIcon size={14} aria-hidden />}
                            className={`composer__permission-option composer__permission-option--${mode.id}`}
                            active={mode.id === props.approval}
                            onClick={() => {
                              props.onApprovalChange(mode.id)
                              close()
                            }}
                          />
                        )
                      })}
                    </>
                  )}
                </Menu>

                <DesignBeam
                  className="composer__design-button-beam"
                  strength={0.58}
                  active={props.designMode}
                >
                  <button
                    type="button"
                    className={`menutrigger tool composer__design${props.designMode ? ' is-active' : ''}`}
                    aria-pressed={props.designMode}
                    aria-keyshortcuts={shortcutAria(keybindings.toggleDesignMode)}
                    onFocus={preloadDesignBeamStyles}
                    onPointerEnter={preloadDesignBeamStyles}
                    onClick={() => props.onDesignModeChange(!props.designMode)}
                    title={props.designMode ? 'Turn off Design mode' : 'Turn on Design mode'}
                  >
                    <Palette size={13} aria-hidden />
                    <span>Design</span>
                  </button>
                </DesignBeam>

                {voiceState === 'idle' ? <span className="tools__spacer" /> : null}

                {voiceState === 'idle' && props.usage?.contextWindow ? (
                  <ContextUsage usage={props.usage} />
                ) : null}

                {voiceState === 'idle' && props.models.length > 0 ? (
                  <Suspense fallback={<span className="tool tool--quiet">Loading model…</span>}>
                    <ModelSelector
                      models={props.models}
                      modelId={props.modelId}
                      effort={props.effort}
                      serviceTier={props.serviceTier}
                      // The active turn already captured its settings. Changes
                      // here configure the next prompt, including a queued one.
                      disabled={false}
                      onOpen={props.onModelSelectorOpen}
                      onModelChange={props.onModelChange}
                      onEffortChange={props.onEffortChange}
                      onServiceTierChange={props.onServiceTierChange}
                    />
                  </Suspense>
                ) : voiceState === 'idle' && showModelPlaceholder ? (
                  <span className="tool tool--quiet">Loading models…</span>
                ) : null}

                {props.voiceAvailable ? (
                  <Suspense fallback={null}>
                    <ComposerVoiceControl
                      disabled={props.disabled}
                      running={props.running}
                      getCursor={() => area.current?.selectionStart ?? textRef.current.length}
                      onStateChange={setVoiceState}
                      onError={setVoiceError}
                      onTranscribeVoice={props.onTranscribeVoice}
                      onCancelVoice={props.onCancelVoice}
                      onTranscript={(transcript, cursor, sendAfter) => {
                        const inserted = insertTranscriptAtCursor(
                          textRef.current,
                          transcript,
                          cursor,
                        )
                        if (inserted && (!sendAfter || !sendContent(inserted.text))) {
                          insertTranscript(transcript, cursor)
                        }
                      }}
                    />
                  </Suspense>
                ) : null}

                {voiceState === 'idle' ? (
                  <>
                    {props.running && !showStop && props.canSteerQueue ? (
                      <button
                        type="button"
                        className="menutrigger tool composer__steer"
                        onClick={() => submit('steer')}
                        disabled={sendDisabled}
                        aria-label="Steer current draft"
                        title="Steer now (Ctrl+Enter)"
                      >
                        <CornerDownRight size={14} aria-hidden />
                        <span>Steer</span>
                      </button>
                    ) : null}
                    <span className="composer__send-beam">
                      <button
                        className={`orb${showStop ? ' orb--stop' : ''}${
                          showStop && props.stopping ? ' is-stopping' : ''
                        }`}
                        onClick={showStop ? props.onInterrupt : () => submit()}
                        disabled={showStop ? Boolean(props.stopping) : sendDisabled}
                        title={showStop ? (props.stopping ? 'Stopping…' : 'Stop') : submitLabel}
                        aria-label={
                          showStop ? (props.stopping ? 'Stopping…' : 'Stop') : submitLabel
                        }
                      >
                        <span className="orb__icon orb__icon--send">
                          <ArrowUp size={15} aria-hidden />
                        </span>
                        <span className="orb__icon orb__icon--stop">
                          <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden />
                        </span>
                      </button>
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </DesignBeam>
        </div>
      </div>
      {voiceError ? (
        <div className="composer__voice-error" role="alert">
          {voiceError}
        </div>
      ) : null}
      {viewingMedia ? (
        <Suspense fallback={null}>
          <MediaViewer
            src={viewingMedia.src}
            name={viewingMedia.name}
            mediaType={viewingMedia.mediaType}
            onReveal={
              viewingMedia.localPath
                ? () => {
                    if (viewingMedia.localPath) void revealPath(viewingMedia.localPath)
                  }
                : undefined
            }
            onClose={() => setViewingMedia(undefined)}
          />
        </Suspense>
      ) : null}
    </>
  )
}

function ContextUsage({ usage }: { usage: Usage }) {
  const contextWindow = usage.contextWindow ?? 0
  const percent = contextWindow
    ? Math.min(100, Math.max(0, (usage.totalTokens / contextWindow) * 100))
    : 0
  const detail = `${usage.totalTokens.toLocaleString()} of ${contextWindow.toLocaleString()} context tokens used (${Math.round(percent)}%)`

  return (
    <span
      className="context-usage"
      tabIndex={0}
      role="img"
      aria-label={detail}
      style={contextUsageStyle(percent)}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle className="context-usage__track" cx="12" cy="12" r="9" />
        <circle className="context-usage__fill" cx="12" cy="12" r="9" pathLength="100" />
      </svg>
      <span className="context-usage__tooltip" role="tooltip">
        <strong>{Math.round(percent)}% context used</strong>
        <span>
          {usage.totalTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens
        </span>
      </span>
    </span>
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

function previewMediaType(mimeType: string, fileName: string): 'image' | 'video' | undefined {
  if (PREVIEWABLE_IMAGE_TYPES.has(mimeType) || PREVIEWABLE_IMAGE_RE.test(fileName)) return 'image'
  if (PREVIEWABLE_VIDEO_TYPES.has(mimeType) || VIDEO_RE.test(fileName)) return 'video'
  return undefined
}

function attachmentThumbnailUrl(attachment: ComposerAttachment): string | undefined {
  return (
    attachment.thumbnailUrl ??
    (attachment.mediaType === 'image' ? attachment.previewUrl : undefined)
  )
}

/**
 * Memoised: the app root re-renders on every streamed frame, and this subtree
 * does not change while an answer arrives. Every handler the owner passes has
 * a stable identity, which is what makes the shallow compare actually hold.
 */
export const Composer = memo(ComposerComponent)
