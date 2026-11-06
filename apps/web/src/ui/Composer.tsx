import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import type { ApprovalMode, ProviderId, QueuedTurn, Usage } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import {
  IconArrowUp as ArrowUp,
  IconCornerDownRight as CornerDownRight,
  IconFile as FileIcon,
  IconFolder as Folder,
  IconFolderPlus as FolderPlus,
  IconGitBranch as GitBranch,
  IconGripVertical as GripVertical,
  IconPhoto as ImageIcon,
  IconDeviceLaptop as Laptop,
  IconPalette as Palette,
  IconPencil as Pencil,
  IconPlayerPlay as Play,
  IconPlus as Plus,
  IconSquare as Square,
  IconTrash as Trash2,
  IconVideo as Video,
  IconX as X,
} from '@tabler/icons-react'
import { APPROVAL_MODES } from './approval-modes.js'
import {
  isMacOS,
  pickFiles,
  previewViewedImage,
  revealPath,
  savePastedFile,
  type PickedAttachment,
} from '../bridge.js'
import { appCommands, parseAppActionCommand, type AppScreen } from '../app-commands.js'
import { rememberChipTokens, rememberedChipTokens } from '../composer-chip-memory.js'
import { parseFeedbackCommand } from '../feedback-command.js'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'
import type { Transport } from '../transport.js'
import { type VoiceRecording } from '../voice-capability.js'
import type { ProjectChoice } from '../project-choices.js'
import type { ComposerVoiceState } from './ComposerVoiceControl.js'
import { DesignBeam, preloadDesignBeamStyles } from './DesignBeam.js'
import {
  COMPOSER_RESOURCE_LIST_ID,
  composerResourceListLabel,
  type ComposerResource,
  type ComposerResourceMarker,
  type ComposerResourcePickerHandle,
  type ComposerResourceTrigger,
} from './composer-resource.js'
import {
  composerChipAround,
  composerChipFragments,
  composerChipPastSpaces,
  composerChipText,
  composerChipTokens,
  composerChips,
  composerChipTouching,
  composerSelectionOverChips,
  composerSlashCanLead,
  composerTextWithoutPicks,
  composerBrowserImages,
  composerWireText,
  createComposerChipTextStore,
  hasComposerChips,
  repairComposerChips,
  type ComposerChipKind,
} from './composer-chips.js'
import { browserCommentImages, browserCommentsAsPlainText } from './browser-comments.js'
import { composerTextWithChips } from './message-chips.js'
import { Menu, MenuItem } from './Menu.js'
import { IconMorph } from './IconMorph.js'
import { LazyMediaViewer as MediaViewer, preloadMediaViewer } from './LazyMediaViewer.js'
import { preloadThread } from './LazyThread.js'
import { ModelSearchField } from './ModelSearchField.js'
import { ComposerErrors, useComposerError, type ComposerError } from './ComposerErrors.js'
import { Skeleton, SkeletonRows, SkeletonStatus } from './Skeleton.js'
import { droppedFilePath } from './composer-dropped-file.js'

const loadResourcePicker = () => import('./ComposerResourcePicker.js')
const ComposerResourcePicker = lazy(() =>
  loadResourcePicker().then((module) => ({
    default: module.ComposerResourcePicker,
  })),
)
// Fetched when the box is about to be typed in, so a first `/` does not wait for it.
const preloadResourcePicker = () => {
  void loadResourcePicker().catch(() => undefined)
}
const warmUpComposer = () => {
  preloadThread()
  preloadResourcePicker()
}
// Loaded as soon as a menu opens or a draft brings chips, so the first chip
// rarely waits for it; until then the draft shows as plain text.
type ChipOverlayComponent = typeof import('./ComposerChipOverlay.js').ComposerChipOverlay
let chipOverlayModule: Promise<ChipOverlayComponent> | undefined
let loadedChipOverlay: ChipOverlayComponent | undefined
const loadComposerChipOverlay = () =>
  (chipOverlayModule ??= import('./ComposerChipOverlay.js').then(
    (module) => (loadedChipOverlay = module.ComposerChipOverlay),
    (error: unknown) => {
      chipOverlayModule = undefined
      throw error
    },
  ))
const preloadComposerChipOverlay = () => {
  void loadComposerChipOverlay().catch(() => undefined)
}

/**
 * The chip overlay, drawn as soon as its module is there. Under Suspense the
 * first mount would commit the empty fallback and React holds the reveal back
 * for up to 300 ms after it, however early the module arrived, leaving a
 * restored or recalled draft's raw chip characters on screen that long. The
 * module-level copy also covers a load that a later preload finished after
 * this one failed.
 */
function ChipOverlay(props: ComponentProps<ChipOverlayComponent>) {
  const [ownOverlay, setOverlay] = useState(() => loadedChipOverlay)
  const Overlay = ownOverlay ?? loadedChipOverlay
  useEffect(() => {
    if (Overlay) return
    let cancelled = false
    loadComposerChipOverlay().then(
      (component) => {
        if (!cancelled) setOverlay(() => component)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [Overlay])
  return Overlay ? <Overlay {...props} /> : null
}
const ModelSelector = lazy(() =>
  import('./ModelSelector.js').then((module) => ({ default: module.ModelSelector })),
)
const ComposerVoiceControl = lazy(() =>
  import('./ComposerVoiceControl.js').then((module) => ({
    default: module.ComposerVoiceControl,
  })),
)
// Only chats whose provider reports a context window show the ring.
const ContextUsage = lazy(() =>
  import('./ContextUsage.js').then((module) => ({ default: module.ContextUsage })),
)
const DRAFT_HAS_CONTENT = /\S/u
const RESOURCE_SKELETON_WIDTHS = [108, 76, 132, 92]
const NO_CHIP_TOKENS: ReadonlySet<string> = new Set()
/** Undo and redo put back a state the editor held; a chip repair must not redo itself on them. */
const HISTORY_INPUT_TYPES: ReadonlySet<string> = new Set(['historyUndo', 'historyRedo'])

/** Ctrl+Backspace and Ctrl+Delete delete a word, or Option with them on macOS. */
function deletesWord(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.metaKey || event.shiftKey) return false
  return isMacOS() ? event.altKey && !event.ctrlKey : event.ctrlKey && !event.altKey
}

function ModelTriggerSkeleton() {
  return (
    <SkeletonStatus
      label="Loading model"
      className="menutrigger menutrigger--model-selector composer-skeleton-model"
    >
      <Skeleton className="skeleton--icon" />
      <Skeleton width={88} height={9} />
    </SkeletonStatus>
  )
}

function VoiceControlSkeleton() {
  return (
    <SkeletonStatus
      label="Loading voice"
      className="composer-skeleton-slot composer-skeleton-voice"
    >
      <Skeleton className="skeleton--circle" width="100%" height="100%" />
    </SkeletonStatus>
  )
}

function ResourcePickerSkeleton(props: { marker: ComposerResourceMarker }) {
  const labels = composerResourceListLabel(props.marker)
  return (
    <div className="composer-skeleton-picker">
      <div
        id={COMPOSER_RESOURCE_LIST_ID}
        className="composer-skeleton-picker__list"
        role="listbox"
        aria-label={labels.label}
      >
        <SkeletonStatus label={labels.loading}>
          <SkeletonRows rows={4} icon widths={RESOURCE_SKELETON_WIDTHS} />
        </SkeletonStatus>
      </div>
    </div>
  )
}

function sameDraftPaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
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

const IMAGE_RE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i
const PREVIEWABLE_IMAGE_RE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|webp)$/i
const VIDEO_RE = /\.(avi|m4v|mkv|mov|mp4|mpe?g|ogg|ogv|webm)$/i
const COMPOSER_MIN_HEIGHT = 48
const COMPOSER_MAX_HEIGHT = 242
/** How long the composer's width must hold still before a draft is re-measured. */
const COMPOSER_WIDTH_SETTLE_MS = 120

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
// --dur-dock and --ease-dock: the dock lands with the sent message's entrance
// (also --dur-dock) instead of after it, and a move this long glides and
// settles softly rather than covering most of its distance in the first frames.
const COMPOSER_DOCK_MOTION_MS = 420
const COMPOSER_DOCK_EASING = 'cubic-bezier(0.45, 0, 0.2, 1)'
/**
 * Where the dock measures from: the prompt box itself. The shelves above it
 * (project, branch, queue) can go away in the same frame as the send, and
 * measuring the whole group made the prompt hop up by their height first.
 */
function dockRect(group: HTMLElement | null): DOMRect | null {
  return (group?.querySelector('.composer__prompt') ?? group)?.getBoundingClientRect() ?? null
}
const COMPOSER_QUEUE_ANIMATION_ID = 'harness-composer-queue'
// Match --dur-slow and --ease-rail so the panel and row reveal settle together.
const COMPOSER_QUEUE_MOTION_MS = 260
const COMPOSER_QUEUE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
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
  previewSettled?: boolean
}

type RunningSubmission = 'queue' | 'steer'

type QueueItemPhase = 'present' | 'entering' | 'exiting'

type QueueExitBox = {
  top: number
  left: number
  width: number
  height: number
}

type RenderedQueuedTurn = {
  turn: QueuedTurn
  phase: QueueItemPhase
  exitBox?: QueueExitBox | undefined
}

type QueueRenderState = {
  revision: number
  items: RenderedQueuedTurn[]
}

type QueueLayoutSnapshot = {
  revision: number
  queueRect: DOMRectReadOnly | null
  rowRects: Map<string, DOMRectReadOnly>
  reduceMotion: boolean
}

export type SendAvailability =
  | 'loading'
  | 'ready'
  | 'setup-required'
  | 'unavailable'
  /** A new chat with no provider added under Settings › Providers. */
  | 'no-provider'

function QueuedMediaPreview({ attachments, text }: { attachments: string[]; text: string }) {
  const commentImages = browserCommentImages(text, attachments)
  const reference = attachments.find(
    (attachment) => !commentImages.has(attachment) && previewMediaType('', attachment),
  )
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
        onPointerEnter={preloadMediaViewer}
        onFocus={preloadMediaViewer}
        onClick={() => setViewerOpen(true)}
        aria-label={
          canOpen ? `Open queued preview of ${name}` : `Loading queued preview of ${name}`
        }
      >
        <span className="queue-row__media-fallback" aria-hidden>
          {mediaType === 'video' ? <Video size={12} /> : <ImageIcon size={12} />}
        </span>
        {inlineSource ? (
          <img
            src={inlineSource}
            onLoad={preloadMediaViewer}
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
            <Play size={7} fill="currentColor" />
          </span>
        ) : null}
      </button>
      {viewerOpen && preview?.previewUrl && preview.mediaType ? (
        <Suspense fallback={null}>
          <MediaViewer
            src={preview.previewUrl}
            thumbnailSrc={inlineSource}
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
  if (marker === '/' && !composerSlashCanLead(text, markerIndex)) return undefined
  const query = text.slice(queryStart, position)
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
  const start = cursor - query.length - 1
  if (marker === '/' && !composerSlashCanLead(text, start)) return undefined
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

/** Drafts saved before chips sat inline kept picked skills and servers apart from the text. */
function draftTextWithResources(text: string, resources: readonly ComposerResource[]): string {
  if (resources.length === 0) return text
  const chips = resources
    .map((resource) => composerChipText(resource.token, chipKind(resource)))
    .join(' ')
  return text ? `${chips} ${text}` : `${chips} `
}

function chipKind(resource: ComposerResource): ComposerChipKind {
  if (resource.kind === 'command') return resource.commandKind === 'skill' ? 'skill' : 'command'
  return resource.kind
}

function ComposerComponent(props: {
  transport: Transport
  provider: ProviderId
  projects: ReadonlyArray<ProjectChoice>
  projectPath: string | undefined
  projectName: string | undefined
  /** The started chat this composer writes to; absent for a new chat. */
  threadId?: string | undefined
  projectsLoading?: boolean
  branch: string | undefined
  branches: string[]
  branchesLoading?: boolean
  /** The branch menu opened; the owner may list branches again. */
  onBranchMenuOpen?: (() => void) | undefined
  models: ModelChoice[]
  /** Whether the list has come back yet, so an empty list is not read as pending. */
  modelsLoaded: boolean
  modelId: string | undefined
  /** The choice a send uses. The picker shows it instead of resolving `modelId` again. */
  modelChoice?: ModelChoice | undefined
  /** The preferred source has not listed its models, so no model is known yet. */
  modelPending?: boolean
  effort: string | undefined
  serviceTier: string | undefined
  usage?: Usage | undefined
  approval: ApprovalMode
  approvalLoading?: boolean | undefined
  autoReviewSupported: boolean
  attachmentsSupported: boolean
  attachmentsLoading?: boolean
  voiceAvailable: boolean
  voiceLoading?: boolean
  disabled: boolean
  /** Replaces "Do anything" while the composer cannot be used, e.g. while a turn stops. */
  placeholder?: string | undefined
  sendAvailability: SendAvailability
  providerSignInRequired?: boolean
  errors?: readonly ComposerError[] | undefined
  errorsVisible?: boolean
  providerError?: ComposerError | undefined
  running: boolean
  newSession: boolean
  isolate: boolean
  /** Why this project cannot start an isolated chat; the option is disabled with it. */
  isolateUnavailable?: string | undefined
  designMode: boolean
  /** Why Ask first cannot run with this provider; the option is disabled with it. */
  askFirstUnavailable?: string | undefined
  keybindings?: Keybindings | undefined
  focusRequest: number
  draftRequest?:
    | {
        text: string
        attachments?: string[] | undefined
        resources?: ComposerResource[] | undefined
        /** Insert the text as one native edit, so Ctrl+Z brings back what it replaced. */
        undoable?: boolean | undefined
        request: number
      }
    | undefined
  onDraftChange?: ((text: string) => void) | undefined
  onAttachmentsChange?: ((attachments: string[]) => void) | undefined
  /**
   * Register a pending save with the current draft's owner before it can change.
   * Resolves with the saved path only when this composer no longer shows that
   * draft, so the owner must keep the file itself.
   */
  onPendingAttachment?: ((savedPath: Promise<string | undefined>) => void) | undefined
  /**
   * Register a queued-prompt edit with the current draft's owner before it can
   * change. Resolves with the removed prompt only when this composer no longer
   * shows that draft, so the owner must put the prompt back itself.
   */
  onPendingQueuedEdit?:
    ((removed: Promise<Pick<QueuedTurn, 'text' | 'attachments'> | undefined>) => void) | undefined
  onResourcesChange?: ((resources: ComposerResource[]) => void) | undefined
  /**
   * Puts the chat's last sent prompt back into the composer for editing, the
   * way its Edit action does. Returns that prompt, or undefined when there is none.
   */
  onRecallLastPrompt?: (() => string | undefined) | undefined
  onReady?: (() => void) | undefined
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
  /** Opens the folder picker and makes the chosen folder a project. */
  onAddProject: () => void
  onBranchChange: (branch: string) => void
  onProjectRequired: () => void
  onSetupProvider: () => void
  onSend: (text: string, attachments: string[]) => void
  onSteer: (text: string, attachments: string[]) => void
  /** /feedback [text] opens TasteCode's feedback dialog instead of reaching a provider. */
  onFeedbackCommand?: ((text: string) => void) | undefined
  /** /new or /clear starts a new chat instead of reaching a provider. */
  onNewChatCommand?: (() => void) | undefined
  /** /resume, /settings, /mcp, /skills, /usage or /login opens TasteCode's own screen for it. */
  onAppScreenCommand?: ((screen: AppScreen) => void) | undefined
  onInterrupt: () => void
  /** An interrupt is sent and the turn has not ended yet. */
  stopping?: boolean | undefined
  onDeleteQueuedTurn: (id: string) => void | Promise<boolean | void>
  onMoveQueuedTurn: (id: string, direction: 'up' | 'down') => void | Promise<boolean | void>
  onSteerQueuedTurn: (id: string) => void
  /**
   * The composer of a split pane without focus: shown as it was, inactive, and
   * any recording is cancelled so a transcript cannot land in another chat.
   */
  dormant?: boolean | undefined
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  // The textarea owns its full draft. React only needs the blank/nonblank
  // boundary, so ordinary typing does not rerender the complete composer.
  const [hasDraftText, setHasDraftText] = useState(false)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useComposerError()
  const [viewingMedia, setViewingMedia] = useState<{
    src: string
    thumbnailSrc?: string | undefined
    name: string
    mediaType: 'image' | 'video'
    localPath?: string
  }>()
  const [voiceState, setVoiceState] = useState<ComposerVoiceState>('idle')
  const [voiceError, setVoiceError] = useComposerError()
  const [queueError, setQueueError] = useComposerError()
  const editingQueue = useRef(new Set<string>())
  const [dragging, setDragging] = useState(false)
  const [draggedQueueId, setDraggedQueueId] = useState<string>()
  const [queueDropTarget, setQueueDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  }>()
  const [renderedQueue, setRenderedQueue] = useState<QueueRenderState>(() => ({
    revision: 0,
    items: props.queuedTurns.map((turn) => ({ turn, phase: 'present' })),
  }))
  const [resourceTrigger, setResourceTrigger] = useState<ComposerResourceTrigger>()
  const [resourcePickerMounted, setResourcePickerMounted] = useState(false)
  const [chipStore] = useState(createComposerChipTextStore)
  // The overlay mounts once a menu opened or a chip arrived, and stays.
  const [chipsSeen, setChipsSeen] = useState(false)
  const chipsSeenRef = useRef(false)
  // Set while a chip repair edits through the editor, whose own input events must not repair again.
  const repairingChips = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const resourcePicker = useRef<ComposerResourcePickerHandle>(null)
  const sendAvailabilityRef = useRef(props.sendAvailability)
  /** An Enter pressed while Send was loading, sent once it is ready (see submit). */
  const heldSubmit = useRef<
    | {
        text: string
        submission: RunningSubmission
        threadId: string | undefined
        request: number | undefined
      }
    | undefined
  >(undefined)
  const textRef = useRef('')
  /** The prompt Arrow Up put back, until it is sent, cleared or replaced. */
  const recalledPrompt = useRef<string | undefined>(undefined)
  const hasDraftTextRef = useRef(false)
  const attachmentsSupportedRef = useRef(props.attachmentsSupported)
  const previewUrls = useRef(new Set<string>())
  const resizeFrame = useRef<number | undefined>(undefined)
  const composerAtMaximumHeight = useRef(false)
  const observedComposerWidth = useRef<number | undefined>(undefined)
  /** Re-fits the text box to its draft; set once `grow` exists below. */
  const growRef = useRef<() => void>(() => {})
  const composerRoot = useRef<HTMLDivElement>(null)
  const composerAnchor = useRef<HTMLDivElement>(null)
  const queuePanel = useRef<HTMLDivElement>(null)
  const queueRowNodes = useRef(new Map<string, HTMLDivElement>())
  const queueRowRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const queueRowAnimations = useRef(new Map<string, Animation>())
  const queuePanelAnimation = useRef<Animation | null>(null)
  const pendingQueueLayout = useRef<QueueLayoutSnapshot | null>(null)
  const previousNewSession = useRef(props.newSession)
  const attachmentsChangeReady = useRef(false)
  const attachmentsEdited = useRef(false)
  const pendingAttachments = useRef(new Set<string>())
  const onReady = useRef(props.onReady)
  onReady.current = props.onReady
  const draftRequestRef = useRef(props.draftRequest)
  draftRequestRef.current = props.draftRequest
  const previousComposerRect = useRef<DOMRect | null>(null)
  const dockAnimation = useRef<Animation | null>(null)
  const mounted = useRef(true)
  // Read once per menu update, never per keystroke while the menu is closed.
  const chipTokensInDraft = useMemo(
    () => (resourceTrigger ? composerChipTokens(textRef.current) : NO_CHIP_TOKENS),
    [resourceTrigger],
  )
  // A side chat branches off a started chat; feedback needs this build's service.
  const sideChatAvailable = props.threadId !== undefined
  const feedbackAvailable = props.onFeedbackCommand !== undefined
  const newChatAvailable = props.onNewChatCommand !== undefined
  // /model opens the picker this composer shows; without one it means nothing here.
  const modelPickerAvailable = !props.modelPending && props.models.length > 0
  // /permissions opens the access picker this composer shows next to dictation.
  const permissionsAvailable = !props.approvalLoading
  const screensAvailable = props.onAppScreenCommand !== undefined
  const ownCommands = useMemo(
    () =>
      appCommands({
        sideChat: sideChatAvailable,
        feedback: feedbackAvailable,
        newChat: newChatAvailable,
        model: modelPickerAvailable,
        permissions: permissionsAvailable,
        screens: screensAvailable,
      }),
    [
      sideChatAvailable,
      feedbackAvailable,
      newChatAvailable,
      modelPickerAvailable,
      permissionsAvailable,
      screensAvailable,
    ],
  )

  const updateResourceTrigger = (trigger: ComposerResourceTrigger | undefined) => {
    setResourceTrigger(trigger)
    if (!trigger) return
    setResourcePickerMounted(true)
    // A pick is a key away; have the chip drawing ready for it.
    preloadComposerChipOverlay()
  }

  const getQueueRowRef = (queueRowId: string) => {
    const existing = queueRowRefCallbacks.current.get(queueRowId)
    if (existing) return existing

    const ref = (node: HTMLDivElement | null) => {
      if (node) queueRowNodes.current.set(queueRowId, node)
      else {
        queueRowNodes.current.delete(queueRowId)
        // Strict Mode detaches and immediately reattaches callback refs while
        // checking effects in development. Wait one microtask before treating
        // this as a real unmount so both sides of a queue reorder keep moving.
        window.queueMicrotask(() => {
          if (queueRowNodes.current.has(queueRowId)) return
          queueRowAnimations.current.get(queueRowId)?.cancel()
          queueRowAnimations.current.delete(queueRowId)
          queueRowRefCallbacks.current.delete(queueRowId)
        })
      }
    }
    queueRowRefCallbacks.current.set(queueRowId, ref)
    return ref
  }

  const finishQueueItemMotion = (queueRowId: string, phase: QueueItemPhase) => {
    setRenderedQueue((current) => {
      const item = current.items.find((candidate) => candidate.turn.id === queueRowId)
      if (!item || item.phase !== phase) return current
      return {
        ...current,
        items:
          phase === 'exiting'
            ? current.items.filter((candidate) => candidate.turn.id !== queueRowId)
            : current.items.map((candidate) =>
                candidate.turn.id === queueRowId ? { ...candidate, phase: 'present' } : candidate,
              ),
      }
    })
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
    const held = heldSubmit.current
    if (!held || props.sendAvailability === 'loading') return
    heldSubmit.current = undefined
    // A check that ends in setup or sign-in keeps the draft, and the composer
    // says why. Changed words or another chat mean the Enter no longer stands.
    if (
      props.sendAvailability !== 'ready' ||
      textRef.current !== held.text ||
      props.threadId !== held.threadId ||
      draftRequestRef.current?.request !== held.request
    )
      return
    submit(held.submission)
    // Runs only when availability changes; submit reads the current render.
  }, [props.sendAvailability])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (resizeFrame.current !== undefined) window.cancelAnimationFrame(resizeFrame.current)
      dockAnimation.current?.cancel()
      queuePanelAnimation.current?.cancel()
      for (const animation of queueRowAnimations.current.values()) animation.cancel()
      queueRowAnimations.current.clear()
      queueRowRefCallbacks.current.clear()
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    }
  }, [])

  useEffect(() => {
    const el = area.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let settle: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined) return
      const previousWidth = observedComposerWidth.current
      observedComposerWidth.current = width
      if (previousWidth !== undefined && width !== previousWidth) {
        composerAtMaximumHeight.current = false
        // A draft wraps differently at the new width (opening a split halves
        // it), and its extra lines stayed clipped until the next key. Measure
        // once the width settles, not on every frame of a window or panel drag.
        if (el.value === '') return
        clearTimeout(settle)
        settle = setTimeout(() => growRef.current(), COMPOSER_WIDTH_SETTLE_MS)
      }
    })
    observer.observe(el)
    return () => {
      clearTimeout(settle)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    if (props.newSession) return
    const root = composerRoot.current
    const conversation = root?.parentElement
    if (!root || !conversation?.classList.contains('stage__conversation')) return

    const updateOverlayHeight = () => {
      const height = root.getBoundingClientRect().height
      if (height > 0) {
        conversation.style.setProperty('--composer-overlay-height', `${height}px`)
      }
    }

    updateOverlayHeight()
    const ResizeObserverConstructor = globalThis.ResizeObserver
    const observer = ResizeObserverConstructor
      ? new ResizeObserverConstructor(updateOverlayHeight)
      : undefined
    observer?.observe(root)

    return () => {
      observer?.disconnect()
      conversation.style.removeProperty('--composer-overlay-height')
    }
  }, [props.newSession])

  // T3 Code's draft composer uses a FLIP transition: remember where the real
  // composer was before send, render it in the docked layout, then animate only
  // that positional delta. This keeps focus and textarea state on one DOM tree.
  useLayoutEffect(() => {
    const group = composerAnchor.current
    const nextRect = dockRect(group)
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

  useLayoutEffect(() => {
    const activeItems = renderedQueue.items.filter((item) => item.phase !== 'exiting')
    const sameOrder =
      activeItems.length === props.queuedTurns.length &&
      activeItems.every((item, index) => item.turn.id === props.queuedTurns[index]?.id)

    if (sameOrder) {
      const nextById = new Map(props.queuedTurns.map((turn) => [turn.id, turn]))
      if (activeItems.some((item) => nextById.get(item.turn.id) !== item.turn)) {
        setRenderedQueue((current) => ({
          ...current,
          items: current.items.map((item) => {
            if (item.phase === 'exiting') return item
            const turn = nextById.get(item.turn.id)
            return turn && turn !== item.turn ? { ...item, turn } : item
          }),
        }))
      }
      return
    }

    const panel = queuePanel.current
    const queueRect = panel?.getBoundingClientRect() ?? null
    const rowRects = new Map<string, DOMRectReadOnly>()
    for (const item of renderedQueue.items) {
      const row = queueRowNodes.current.get(item.turn.id)
      if (row) rowRects.set(item.turn.id, row.getBoundingClientRect())
    }

    const nextIds = new Set(props.queuedTurns.map((turn) => turn.id))
    const currentById = new Map(renderedQueue.items.map((item) => [item.turn.id, item]))
    const nextItems: RenderedQueuedTurn[] = props.queuedTurns.map((turn) => {
      const current = currentById.get(turn.id)
      return {
        turn,
        phase: current?.phase === 'entering' ? 'entering' : current ? 'present' : 'entering',
      }
    })

    for (const item of renderedQueue.items) {
      if (nextIds.has(item.turn.id)) continue
      if (item.phase === 'exiting') {
        nextItems.push(item)
        continue
      }

      const rect = rowRects.get(item.turn.id)
      const exitBox =
        panel && queueRect && rect
          ? {
              top: rect.top - queueRect.top + panel.scrollTop,
              left: rect.left - queueRect.left + panel.scrollLeft,
              width: rect.width,
              height: rect.height,
            }
          : undefined
      nextItems.push({ turn: item.turn, phase: 'exiting', exitBox })
    }

    const revision = renderedQueue.revision + 1
    pendingQueueLayout.current = {
      revision,
      queueRect,
      rowRects,
      reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    }
    setRenderedQueue({ revision, items: nextItems })
  }, [props.queuedTurns, renderedQueue])

  useLayoutEffect(() => {
    const snapshot = pendingQueueLayout.current
    if (!snapshot || snapshot.revision !== renderedQueue.revision) return
    pendingQueueLayout.current = null

    queuePanelAnimation.current?.cancel()
    queuePanelAnimation.current = null
    queuePanel.current?.style.removeProperty('overflow-y')
    for (const animation of queueRowAnimations.current.values()) animation.cancel()
    queueRowAnimations.current.clear()

    const panel = queuePanel.current
    const nextQueueRect = panel?.getBoundingClientRect() ?? null
    const nextRowRects = new Map<string, DOMRectReadOnly>()
    for (const item of renderedQueue.items) {
      if (item.phase !== 'present') continue
      const row = queueRowNodes.current.get(item.turn.id)
      if (row) nextRowRects.set(item.turn.id, row.getBoundingClientRect())
    }
    if (
      snapshot.reduceMotion ||
      !panel ||
      !panel.animate ||
      !snapshot.queueRect ||
      !nextQueueRect
    ) {
      return
    }

    if (Math.abs(snapshot.queueRect.height - nextQueueRect.height) >= 0.5) {
      panel.style.overflowY = 'hidden'
      const animation = panel.animate(
        [{ height: `${snapshot.queueRect.height}px` }, { height: `${nextQueueRect.height}px` }],
        { duration: COMPOSER_QUEUE_MOTION_MS, easing: COMPOSER_QUEUE_EASING },
      )
      animation.id = `${COMPOSER_QUEUE_ANIMATION_ID}-panel`
      queuePanelAnimation.current = animation
      void animation.finished
        .catch(() => undefined)
        .then(() => {
          if (queuePanelAnimation.current !== animation) return
          queuePanelAnimation.current = null
          if (queuePanel.current === panel) panel.style.removeProperty('overflow-y')
        })
    }

    for (const item of renderedQueue.items) {
      // Let an entering row finish its opacity reveal. Starting a transform
      // FLIP on the same row can be canceled when that reveal becomes present,
      // which makes rapid queue additions jump for one frame.
      if (item.phase !== 'present') continue
      const previousRect = snapshot.rowRects.get(item.turn.id)
      const row = queueRowNodes.current.get(item.turn.id)
      const nextRect = nextRowRects.get(item.turn.id)
      if (!previousRect || !nextRect || !row?.animate) continue

      const x = previousRect.left - snapshot.queueRect.left - (nextRect.left - nextQueueRect.left)
      const y = previousRect.top - snapshot.queueRect.top - (nextRect.top - nextQueueRect.top)
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue

      const animation = row.animate(
        [{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: COMPOSER_QUEUE_MOTION_MS, easing: COMPOSER_QUEUE_EASING },
      )
      animation.id = COMPOSER_QUEUE_ANIMATION_ID
      queueRowAnimations.current.set(item.turn.id, animation)
      void animation.finished
        .catch(() => undefined)
        .then(() => {
          if (queueRowAnimations.current.get(item.turn.id) === animation) {
            queueRowAnimations.current.delete(item.turn.id)
          }
        })
    }
  }, [renderedQueue])

  // Focus once per request. A request that arrives while disabled waits for
  // the composer to be enabled, but enabling alone must not steal focus from
  // whatever field the user moved to in the meantime.
  const handledFocusRequest = useRef(0)
  useEffect(() => {
    if (props.disabled || props.focusRequest === handledFocusRequest.current) return
    handledFocusRequest.current = props.focusRequest
    if (props.focusRequest > 0) area.current?.focus()
  }, [props.focusRequest, props.disabled])

  // The new-chat composer keeps its draft when its provider or project
  // changes, but skills and MCP servers belong to the place they were picked
  // for and may not exist in the new one, so their chips go. Command chips
  // stay, as typed commands always did. A switch that comes with another
  // draft (another chat, a draft handed to a new chat) leaves the text to it.
  const pickPlace = useRef({
    provider: props.provider,
    projectPath: props.projectPath,
    threadId: props.threadId,
    draftRequest: props.draftRequest?.request,
  })
  useEffect(() => {
    const previous = pickPlace.current
    pickPlace.current = {
      provider: props.provider,
      projectPath: props.projectPath,
      threadId: props.threadId,
      draftRequest: props.draftRequest?.request,
    }
    if (previous.provider === props.provider && previous.projectPath === props.projectPath) return
    setResourceTrigger(undefined)
    if (
      previous.threadId !== props.threadId ||
      previous.draftRequest !== props.draftRequest?.request
    )
      return
    // A first project only adds to what the picks could come from.
    if (previous.provider === props.provider && previous.projectPath === undefined) return
    const kept = composerTextWithoutPicks(textRef.current)
    if (kept === textRef.current) return
    updateText(kept)
    grow()
  }, [props.provider, props.projectPath, props.threadId, props.draftRequest?.request])

  // A provider that cannot enumerate models shows nothing once discovery finishes.
  const showModelPlaceholder = props.models.length === 0 && !props.modelsLoaded
  const approval = APPROVAL_MODES.find((m) => m.id === props.approval) ?? APPROVAL_MODES[0]!

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
  growRef.current = grow

  const updateText = (value: string, syncArea = true, notify = true) => {
    textRef.current = value
    if (value === '') recalledPrompt.current = undefined
    if (syncArea && area.current && area.current.value !== value) area.current.value = value
    const nextHasDraftText = DRAFT_HAS_CONTENT.test(value)
    if (nextHasDraftText !== hasDraftTextRef.current) {
      hasDraftTextRef.current = nextHasDraftText
      setHasDraftText(nextHasDraftText)
    }
    // Notifies the overlay only while chips are in the draft or just left it.
    chipStore.set(value)
    if (!chipsSeenRef.current && chipStore.get() !== '') {
      chipsSeenRef.current = true
      setChipsSeen(true)
    }
    if (notify) props.onDraftChange?.(value)
  }

  const setValue = (value: string) => {
    updateText(value)
    setResourceTrigger(undefined)
    requestAnimationFrame(() => {
      area.current?.focus()
      grow()
    })
  }

  /** Replace the whole text through the editor, which keeps it on the native undo stack. */
  const insertUndoably = (value: string): boolean => {
    const el = area.current
    if (!el || el.disabled || typeof document.execCommand !== 'function') return false
    el.focus()
    el.select()
    // The input event this fires runs onChange, which records the new text.
    const inserted = value
      ? document.execCommand('insertText', false, value)
      : document.execCommand('delete')
    return inserted && el.value === value
  }

  /** Arrow Up may only replace nothing: no text, chips or files, and the caret at the start. */
  const composerEmptyAtStart = (el: HTMLTextAreaElement) =>
    el.value === '' && el.selectionStart === 0 && el.selectionEnd === 0 && attachments.length === 0

  /** Escape after Arrow Up: back to the empty composer, which Ctrl+Z can undo. */
  const cancelRecalledPrompt = () => {
    recalledPrompt.current = undefined
    if (!insertUndoably('')) setValue('')
  }

  const replaceDraft = (value: string, notify = false) => {
    updateText(value, true, notify)
    setResourceTrigger(undefined)
    requestAnimationFrame(() => {
      area.current?.focus()
      grow()
    })
  }

  useEffect(() => {
    onReady.current?.()
  }, [])

  useEffect(() => {
    if (!props.draftRequest) return
    // Only the request Arrow Up made keeps Escape's way back to an empty box.
    if (props.draftRequest.text !== recalledPrompt.current) recalledPrompt.current = undefined
    // A sent prompt coming back (Edit, Arrow Up) gets its chips back, and a
    // draft saved before chips sat inline brings its skills into the text.
    const legacyResources = props.draftRequest.resources ?? []
    const text = draftTextWithResources(
      props.draftRequest.undoable || props.draftRequest.text.includes('[Browser comment]')
        ? composerTextWithChips(
            props.draftRequest.text,
            rememberedChipTokens(),
            props.draftRequest.attachments,
          )
        : props.draftRequest.text,
      legacyResources,
    )
    // A draft that brings chips (restored, edited, recalled) starts loading
    // their drawing at once: one includes, not a parse. The textarea shows the
    // text in this same pass, so when nothing loaded the drawing earlier (a
    // draft restored at startup) the raw chip text shows until it arrives.
    if (hasComposerChips(text)) preloadComposerChipOverlay()
    // Parent already holds this snapshot. Writing it back would let a stale
    // empty request wipe a draft that was typed after the last publish; only
    // a draft this composer just rewrote is saved again.
    if (!props.draftRequest.undoable || !insertUndoably(text))
      replaceDraft(text, text !== props.draftRequest.text)
    if (legacyResources.length > 0) props.onResourcesChange?.([])
    if (props.draftRequest.attachments !== undefined) {
      for (const attachment of attachments) releasePreview(attachment.previewUrl)
      setViewingMedia(undefined)
      attachmentsEdited.current = false
      const linked = browserCommentImages(props.draftRequest.text, props.draftRequest.attachments)
      const paths = props.draftRequest.attachments.filter((path) => !linked.has(path))
      setAttachments(
        paths.map((path) => {
          const name = basename(path)
          const inferredMediaType = previewMediaType('', name)
          return {
            id: path,
            name,
            path,
            ...(inferredMediaType ? { mediaType: inferredMediaType } : {}),
          }
        }),
      )
      for (const path of paths) {
        if (previewMediaType('', path)) hydrateAttachmentPreview(path)
      }
    }
  }, [props.draftRequest?.request])

  const hydrateAttachmentPreview = (reference: string) => {
    void previewViewedImage(reference).then((preview) => {
      if (!mounted.current) return
      setAttachments((current) =>
        current.map((attachment) => {
          if (attachment.path !== reference) return attachment
          if (!preview?.mediaType || !preview.previewUrl)
            return { ...attachment, previewSettled: true }
          const { mediaType, name, previewUrl, thumbnailUrl } = preview
          return {
            ...attachment,
            name,
            mediaType,
            previewUrl,
            ...(thumbnailUrl ? { thumbnailUrl } : {}),
          }
        }),
      )
    })
  }

  const addFiles = (files: Array<PickedAttachment | string>) => {
    if (files.length === 0) return
    const pickedFiles = files.map((file) =>
      typeof file === 'string' ? { path: file, name: basename(file) } : file,
    )
    setAttachments((current) => {
      const attached = new Set(current.flatMap((attachment) => attachment.path ?? []))
      const additions: ComposerAttachment[] = []
      for (const picked of pickedFiles) {
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
    const attached = new Set(attachments.flatMap((attachment) => attachment.path ?? []))
    for (const picked of pickedFiles) {
      if (attached.has(picked.path)) continue
      attached.add(picked.path)
      if (!picked.previewUrl && (picked.mediaType ?? previewMediaType('', picked.name)))
        hydrateAttachmentPreview(picked.path)
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

  const addPastedFiles = (files: File[], source: 'paste' | 'drop') => {
    const owner = draftRequestRef.current?.request
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
      pendingAttachments.current.add(id)
      setAttachments((current) => [
        ...current,
        {
          id,
          name: file.name || 'Pasted file',
          ...(previewUrl ? { previewUrl } : {}),
          ...(mediaType ? { mediaType } : {}),
        },
      ])

      const savedPath = savePastedFile(file)
        .then((saved) => {
          if (!pendingAttachments.current.delete(id)) return undefined
          if (!mounted.current || draftRequestRef.current?.request !== owner) return saved?.path
          if (!saved) {
            removeAttachment(id, previewUrl)
            setAttachmentError(
              `${source === 'drop' ? 'Dropping' : 'Pasting'} files is available in the desktop app.`,
            )
            return undefined
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
          return undefined
        })
        .catch(() => {
          pendingAttachments.current.delete(id)
          if (!mounted.current || draftRequestRef.current?.request !== owner) return undefined
          removeAttachment(id, previewUrl)
          setAttachmentError(
            `Couldn’t attach “${file.name || 'that file'}”. Use the file picker instead.`,
          )
          return undefined
        })
      props.onPendingAttachment?.(savedPath)
    }
  }

  const releasePreview = (previewUrl: string | undefined) => {
    if (!previewUrl || !previewUrls.current.delete(previewUrl)) return
    URL.revokeObjectURL(previewUrl)
  }

  const removeAttachment = (id: string, previewUrl?: string) => {
    pendingAttachments.current.delete(id)
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
      const filePath = droppedFilePath(file)
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
    addPastedFiles(materialized, 'drop')
  }

  useEffect(() => {
    if (!attachmentsChangeReady.current) {
      attachmentsChangeReady.current = true
      return
    }
    const paths = attachments.flatMap((attachment) => attachment.path ?? [])
    const hydrated = draftRequestRef.current?.attachments
    // Only suppress the initial restore. Returning to that same list after an
    // edit (including clearing on send) must also update the saved draft.
    if (!attachmentsEdited.current && hydrated !== undefined && sameDraftPaths(paths, hydrated))
      return
    attachmentsEdited.current = true
    props.onAttachmentsChange?.(paths)
  }, [attachments, props.onAttachmentsChange])

  const sendContent = (content: string, submission: RunningSubmission = 'queue') => {
    // Chips are only how the draft looks: the provider and TasteCode's own
    // commands read the tokens they stand for.
    const prompt = composerWireText(content, { images: props.attachmentsSupported })
    const feedback = parseFeedbackCommand(prompt)
    if (feedback && props.onFeedbackCommand) {
      updateText('')
      props.onFeedbackCommand(feedback.text)
      return true
    }
    const action = parseAppActionCommand(prompt)
    if (action === 'new-chat' && props.onNewChatCommand) {
      updateText('')
      props.onNewChatCommand()
      return true
    }
    if (typeof action === 'object' && props.onAppScreenCommand) {
      updateText('')
      setResourceTrigger(undefined)
      props.onAppScreenCommand(action.screen)
      return true
    }
    const pickerTrigger =
      action === 'model' || action === 'permissions'
        ? composerRoot.current?.querySelector<HTMLButtonElement>(
            action === 'model' ? '.menutrigger--model-selector' : '.composer__permission',
          )
        : undefined
    if (pickerTrigger && !pickerTrigger.disabled) {
      updateText('')
      setResourceTrigger(undefined)
      // The picker's own trigger, so it opens exactly as a click opens it.
      pickerTrigger.click()
      return true
    }
    const trimmed = prompt.trim()
    const pickedPaths = attachments.flatMap((attachment) => attachment.path ?? [])
    const paths = [
      ...new Set([
        ...pickedPaths,
        ...(props.attachmentsSupported ? composerBrowserImages(content) : []),
      ]),
    ]
    if (
      (trimmed === '' && paths.length === 0) ||
      pickedPaths.length !== attachments.length ||
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
    previousComposerRect.current = dockRect(composerAnchor.current)
    // Clear before handing the text over. A send that is rejected on the spot
    // puts the words back into this chat's draft, and a later clear would
    // erase them from the saved draft while the box still showed them.
    updateText('')
    // The transcript draws these tokens as chips wherever they sit in the prompt.
    rememberChipTokens(composerChips(content))
    if (submission === 'steer') props.onSteer(trimmed, paths)
    else props.onSend(trimmed, paths)
    composerAtMaximumHeight.current = false
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
    heldSubmit.current = undefined
    // Send is still loading (the model list or the account check has not
    // answered): keep the Enter and send once Send is ready, instead of
    // ignoring it while the words stay in the box.
    if (sendAvailabilityRef.current === 'loading') {
      heldSubmit.current = {
        text: textRef.current,
        submission,
        threadId: props.threadId,
        request: draftRequestRef.current?.request,
      }
      return
    }
    sendContent(textRef.current, submission)
  }

  const editQueuedTurn = async (queuedTurn: QueuedTurn) => {
    if (editingQueue.current.has(queuedTurn.id)) return
    editingQueue.current.add(queuedTurn.id)
    const owner = draftRequestRef.current?.request
    let handBack: (prompt: Pick<QueuedTurn, 'text' | 'attachments'> | undefined) => void = () => {}
    props.onPendingQueuedEdit?.(
      new Promise((resolve) => {
        handBack = resolve
      }),
    )
    setQueueError(undefined)
    try {
      const removed = await props.onDeleteQueuedTurn(queuedTurn.id)
      if (!mounted.current || draftRequestRef.current?.request !== owner) {
        // The prompt already left the queue, so the draft it was edited from
        // must keep it now that this composer shows another one.
        if (removed === true)
          handBack({ text: queuedTurn.text, attachments: queuedTurn.attachments })
        return
      }
      if (removed !== true) {
        setQueueError(
          'Could not remove the queued prompt. It may have already started; no copy was added.',
        )
        return
      }
      // Preserve text typed while the deletion was in flight.
      const draft = textRef.current.trim()
      const recalled = composerTextWithChips(
        queuedTurn.text,
        rememberedChipTokens(),
        queuedTurn.attachments,
      )
      setValue(draft === '' ? recalled : `${recalled}\n\n${draft}`)
      const linked = browserCommentImages(queuedTurn.text, queuedTurn.attachments)
      addFiles(queuedTurn.attachments.filter((path) => !linked.has(path)))
    } catch (error) {
      if (mounted.current && draftRequestRef.current?.request === owner) {
        setQueueError(
          error instanceof Error ? error.message : 'Could not remove the queued prompt.',
        )
      }
    } finally {
      handBack(undefined)
      editingQueue.current.delete(queuedTurn.id)
    }
  }

  const removeQueuedTurn = async (queuedTurnId: string) => {
    setQueueError(undefined)
    try {
      await props.onDeleteQueuedTurn(queuedTurnId)
    } catch (error) {
      if (mounted.current) {
        setQueueError(
          error instanceof Error ? error.message : 'Could not remove the queued prompt.',
        )
      }
    }
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

  const showStop = props.running && !hasDraftText && attachments.length === 0
  const submitLabel = props.running ? 'Queue' : 'Send'
  const sendDisabled =
    (!hasDraftText && attachments.length === 0) ||
    attachments.some((attachment) => !attachment.path) ||
    props.disabled ||
    props.sendAvailability !== 'ready' ||
    (!props.attachmentsSupported && attachments.length > 0)
  const unsupportedAttachmentIssue = useMemo<ComposerError | undefined>(
    () =>
      !props.attachmentsSupported && attachments.length > 0
        ? { id: crypto.randomUUID(), message: ATTACHMENTS_BLOCK_SEND }
        : undefined,
    [props.attachmentsSupported, attachments.length],
  )

  const setupError = useMemo<
    (Omit<ComposerError, 'action'> & { action: { label: string } }) | undefined
  >(() => {
    if (props.sendAvailability === 'ready' || props.sendAvailability === 'loading') return undefined
    return {
      id: crypto.randomUUID(),
      role: 'status',
      message:
        props.sendAvailability === 'no-provider'
          ? 'Add a provider to start chatting.'
          : props.sendAvailability === 'unavailable'
            ? 'Provider unavailable'
            : props.providerSignInRequired
              ? 'Sign in to use this provider.'
              : 'Set up this provider to start chatting.',
      action: {
        label:
          props.sendAvailability === 'no-provider'
            ? 'Add provider'
            : props.sendAvailability === 'unavailable'
              ? 'Check setup'
              : props.providerSignInRequired
                ? 'Sign in'
                : 'Set up provider',
      },
    }
  }, [props.provider, props.sendAvailability, props.providerSignInRequired])
  const composerErrors = [
    ...(props.errors ?? []),
    props.providerError ??
      (setupError
        ? { ...setupError, action: { ...setupError.action, run: props.onSetupProvider } }
        : undefined),
    unsupportedAttachmentIssue ?? attachmentError,
    voiceError,
    queueError,
  ].filter((error): error is ComposerError => error !== undefined)

  /** Removes a range through the editor, so Ctrl+Z brings it back. */
  const deleteRange = (from: number, to: number) => {
    const el = area.current
    if (!el) return
    const text = el.value
    const next = text.slice(0, from) + text.slice(to)
    el.setSelectionRange(from, to)
    // The input event this fires runs onChange, which records the new text.
    if (!el.disabled && typeof document.execCommand === 'function') {
      if (document.execCommand('delete') && el.value === next) return
    }
    updateText(next)
    setResourceTrigger(undefined)
    el.setSelectionRange(from, from)
    grow()
  }

  /**
   * Removes what an edit left of a cut chip through the editor, last range
   * first, so the repair sits on the undo stack after the edit that caused it
   * and Ctrl+Z can step back to the whole chip. False when the editor is not
   * there or refused, as it does for an edit the composer itself made through
   * it; the caller then writes the text.
   */
  const removeChipFragments = (el: HTMLTextAreaElement, text: string): boolean => {
    if (el.disabled || typeof document.execCommand !== 'function') return false
    const fragments = composerChipFragments(text)
    repairingChips.current = true
    try {
      for (let index = fragments.length - 1; index >= 0; index -= 1) {
        const [from, to] = fragments[index]!
        el.setSelectionRange(from, to)
        if (!document.execCommand('delete')) return false
      }
      return true
    } finally {
      repairingChips.current = false
    }
  }

  /**
   * A chip moves and deletes as one character: Backspace after it or Delete
   * before it removes all of it, the arrows step over it, and typing over a
   * selection that cuts through it replaces the whole chip.
   */
  const handleChipKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = event.currentTarget
    const text = el.value
    const start = el.selectionStart
    const end = el.selectionEnd
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const backward = event.key === 'Backspace'
      if (start !== end) {
        const [from, to] = composerSelectionOverChips(text, start, end)
        if (from !== start || to !== end) el.setSelectionRange(from, to)
        return false
      }
      const chip =
        composerChipTouching(text, start, backward ? 'before' : 'after') ??
        composerChipAround(text, start)
      if (chip) {
        event.preventDefault()
        deleteRange(chip.start, chip.end)
        return true
      }
      // A word deletion across the space after a pick takes the chip with the
      // space, as it takes a word with the space after it.
      const spaced =
        (event.ctrlKey || event.altKey) && deletesWord(event)
          ? composerChipPastSpaces(text, start, backward ? 'before' : 'after')
          : undefined
      if (!spaced) return false
      event.preventDefault()
      if (backward) deleteRange(spaced.start, start)
      else deleteRange(start, spaced.end)
      return true
    }
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // A plain arrow on a selection collapses it, as it always does.
      if (start !== end && !event.shiftKey) return false
      const backward = el.selectionDirection === 'backward'
      const focus = backward ? start : end
      const anchor = backward ? end : start
      const chip = composerChipTouching(text, focus, event.key === 'ArrowLeft' ? 'before' : 'after')
      if (!chip) return false
      event.preventDefault()
      const next = event.key === 'ArrowLeft' ? chip.start : chip.end
      if (event.shiftKey) {
        el.setSelectionRange(
          Math.min(anchor, next),
          Math.max(anchor, next),
          next < anchor ? 'backward' : 'forward',
        )
      } else el.setSelectionRange(next, next)
      return true
    }
    if (
      start !== end &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key.length === 1 || event.key === 'Process')
    ) {
      const [from, to] = composerSelectionOverChips(text, start, end)
      if (from !== start || to !== end) el.setSelectionRange(from, to)
    }
    return false
  }

  /** Copy and cut hand out the tokens a selection's chips stand for. */
  const copyChips = (event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    if (chipStore.get() === '') return
    const el = event.currentTarget
    const [from, to] = composerSelectionOverChips(el.value, el.selectionStart, el.selectionEnd)
    const selected = el.value.slice(from, to)
    if (!hasComposerChips(selected)) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', composerWireText(selected))
    if (cut) deleteRange(from, to)
  }

  /** Text pasted over a selection that cuts into a chip replaces the whole chip. */
  const pasteOverChips = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (chipStore.get() === '') return
    const el = event.currentTarget
    const [from, to] = composerSelectionOverChips(el.value, el.selectionStart, el.selectionEnd)
    if (from === el.selectionStart && to === el.selectionEnd) return
    el.setSelectionRange(from, to)
    // Inserted through the editor, so Ctrl+Z takes it out as it would a paste.
    // Without it, the browser's own paste lands on the widened selection.
    if (typeof document.execCommand !== 'function') return
    if (document.execCommand('insertText', false, event.clipboardData.getData('text/plain')))
      event.preventDefault()
  }

  const selectResource = (resource: ComposerResource) => {
    const trigger = resourceTrigger
    if (!trigger) return
    // Every pick becomes a chip where its marker was typed, with the caret
    // after it, ready for the next word or a command's arguments.
    const text = textRef.current
    const before = text.slice(0, trigger.start)
    const replaceEnd = text.startsWith(' ', trigger.end) ? trigger.end + 1 : trigger.end
    const chip = composerChipText(resource.token, chipKind(resource))
    // Providers read a slash command only at the start of the prompt, so one
    // picked after skill or server chips goes in front of them. The chips are
    // written again after it in the same edit, so one Ctrl+Z undoes the pick.
    const firstChip = resource.token.startsWith('/') ? composerChips(before)[0] : undefined
    const from = firstChip ? 0 : trigger.start
    // Only whitespace comes before the first chip; the chip's own icon room stays.
    const inserted = firstChip ? `${chip} ${before.slice(firstChip.start)}` : `${chip} `
    const next = text.slice(0, from) + inserted + text.slice(replaceEnd)
    const caret = from + inserted.length
    setResourceTrigger(undefined)
    const el = area.current
    if (el && !el.disabled && typeof document.execCommand === 'function') {
      el.focus()
      el.setSelectionRange(from, replaceEnd)
      // Inserted through the editor so Ctrl+Z takes the chip back out; the
      // input event runs onChange, which records the new text.
      if (document.execCommand('insertText', false, inserted) && el.value === next) return
    }
    updateText(next)
    // The textarea value is already written; a later caret reset can overtake typing.
    el?.focus()
    el?.setSelectionRange(caret, caret)
    grow()
  }

  return (
    <>
      <div
        ref={composerRoot}
        className={`composer${props.newSession ? ' is-new-session' : ''}${props.dormant ? ' is-dormant' : ''}`}
        inert={props.dormant ? true : undefined}
      >
        <div
          ref={composerAnchor}
          className={`composer__box ${dragging ? 'is-dropping' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (props.attachmentsSupported && hasDroppedFiles(e)) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (hasDroppedFiles(e)) addDroppedFiles(Array.from(e.dataTransfer.files))
          }}
        >
          {/* First child: the panel tucks its lower band behind the top of the box,
              so the shelves below have to paint over that band, not under it. */}
          {renderedQueue.items.length > 0 ? (
            <div
              ref={queuePanel}
              className="composer__queue"
              aria-label="Queued prompts"
              aria-hidden={props.queuedTurns.length === 0 ? true : undefined}
              inert={props.queuedTurns.length === 0 ? true : undefined}
            >
              {renderedQueue.items.map(({ turn: queuedTurn, phase, exitBox }, index) => (
                <div
                  className={`queue-row${phase !== 'exiting' && draggedQueueId === queuedTurn.id ? ' is-dragging' : ''}`}
                  data-drop-position={
                    phase !== 'exiting' && queueDropTarget?.id === queuedTurn.id
                      ? queueDropTarget.position
                      : undefined
                  }
                  data-queue-id={queuedTurn.id}
                  data-queue-phase={phase}
                  data-queue-positioned={exitBox ? true : undefined}
                  style={
                    exitBox
                      ? {
                          top: exitBox.top,
                          left: exitBox.left,
                          width: exitBox.width,
                          height: exitBox.height,
                        }
                      : undefined
                  }
                  aria-hidden={phase === 'exiting' ? true : undefined}
                  inert={phase === 'exiting' ? true : undefined}
                  key={queuedTurn.id}
                  ref={getQueueRowRef(queuedTurn.id)}
                  draggable={phase !== 'exiting'}
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
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget && phase !== 'present') {
                      finishQueueItemMotion(queuedTurn.id, phase)
                    }
                  }}
                >
                  <button
                    type="button"
                    className="queue-row__handle"
                    title="Drag to reorder"
                    aria-label={`Drag ${browserCommentsAsPlainText(queuedTurn.text)} to reorder`}
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
                  <QueuedMediaPreview attachments={queuedTurn.attachments} text={queuedTurn.text} />
                  <span
                    className="queue-row__text"
                    title={browserCommentsAsPlainText(queuedTurn.text)}
                  >
                    {browserCommentsAsPlainText(queuedTurn.text)}
                  </span>
                  {props.canSteerQueue ? (
                    <button
                      type="button"
                      className="queue-row__steer"
                      onClick={() => props.onSteerQueuedTurn(queuedTurn.id)}
                      title="Steer the running agent with this prompt"
                    >
                      <CornerDownRight size={13} aria-hidden />
                      <span>Steer</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="queue-row__action"
                    onClick={() => void editQueuedTurn(queuedTurn)}
                    title="Edit prompt"
                    aria-label={`Edit ${browserCommentsAsPlainText(queuedTurn.text)}`}
                  >
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="queue-row__action"
                    onClick={() => void removeQueuedTurn(queuedTurn.id)}
                    title="Remove from queue"
                    aria-label={`Remove ${browserCommentsAsPlainText(queuedTurn.text)} from queue`}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <ComposerErrors
            errors={composerErrors}
            visible={props.errorsVisible ?? true}
            onDismiss={() => area.current?.focus()}
          />
          {resourcePickerMounted ? (
            <Suspense
              fallback={
                resourceTrigger ? <ResourcePickerSkeleton marker={resourceTrigger.marker} /> : null
              }
            >
              <ComposerResourcePicker
                ref={resourcePicker}
                transport={props.transport}
                provider={props.provider}
                projectPath={props.projectPath}
                threadId={props.threadId}
                appCommands={ownCommands}
                trigger={resourceTrigger}
                selectedTokens={chipTokensInDraft}
                onSelect={selectResource}
              />
            </Suspense>
          ) : null}

          <DesignBeam
            className={`composer__design-beam${props.newSession ? ' is-shelved' : ''}`}
            strength={1}
            active={props.designMode}
          >
            {/* New chat: the beam wraps shelf and prompt, so its clip and glow follow the one surface. */}
            {props.newSession ? (
              <div className="composer__shelf composer__shelf--project">
                <Menu
                  label="Choose project"
                  drop="down"
                  triggerClassName="shelf-control shelf-control--project"
                  panelClassName="menu--compact menu--project-picker"
                  trigger={() => (
                    <span className="shelf-control__content">
                      <Folder size={15} aria-hidden />
                      {props.projectName === undefined && props.projectsLoading ? (
                        <Skeleton className="skeleton-group" width={56} height={9} />
                      ) : (
                        <span>{props.projectName ?? 'Choose project'}</span>
                      )}
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
                      {/* With no project yet the list was empty, and no folder could be chosen here (#2194). */}
                      <MenuItem
                        title="New project"
                        icon={<FolderPlus size={14} aria-hidden />}
                        onClick={() => {
                          close()
                          props.onAddProject()
                        }}
                      />
                    </>
                  )}
                </Menu>

                <Menu
                  label="Workspace mode"
                  drop="down"
                  triggerClassName="shelf-control shelf-control--mode"
                  panelClassName="menu--compact menu--mode"
                  shortcutAria={shortcutAria(keybindings.toggleIsolatedSession)}
                  trigger={() => (
                    <span className="shelf-control__content">
                      <IconMorph active={props.isolate ? 1 : 0}>
                        <Laptop size={15} aria-hidden />
                        <GitBranch size={15} aria-hidden />
                      </IconMorph>
                      <span>{props.isolate ? 'Isolated' : 'Local'}</span>
                    </span>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem
                        title="Local"
                        icon={<Laptop size={14} aria-hidden />}
                        checked={!props.isolate}
                        onClick={() => {
                          props.onIsolateChange(false)
                          close()
                        }}
                      />
                      <MenuItem
                        title="Isolated"
                        icon={<GitBranch size={14} aria-hidden />}
                        detail={props.isolateUnavailable}
                        disabled={props.isolateUnavailable !== undefined}
                        checked={props.isolate}
                        onClick={() => {
                          props.onIsolateChange(true)
                          close()
                        }}
                      />
                    </>
                  )}
                </Menu>

                {props.branches.length > 0 ? (
                  <Menu
                    label="Choose branch"
                    drop="down"
                    triggerClassName="shelf-control shelf-control--branch"
                    panelRole="dialog"
                    panelLabel="Choose branch"
                    panelClassName="branch-menu"
                    onOpen={props.onBranchMenuOpen}
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
                ) : props.branchesLoading ? (
                  <SkeletonStatus
                    label="Loading branches"
                    className="menutrigger shelf-control shelf-control--branch composer-skeleton-branch"
                  >
                    <span className="shelf-control__content">
                      <Skeleton className="skeleton--icon" />
                      <Skeleton width={64} height={9} />
                    </span>
                  </SkeletonStatus>
                ) : null}
              </div>
            ) : null}

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
                        onPointerEnter={preloadMediaViewer}
                        onFocus={preloadMediaViewer}
                        onClick={() => {
                          if (!attachment.previewUrl || !attachment.mediaType) return
                          setViewingMedia({
                            src: attachment.previewUrl,
                            thumbnailSrc: attachmentThumbnailUrl(attachment),
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
                            : attachment.previewSettled
                              ? `Preview unavailable for ${attachment.name}`
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
                            onLoad={preloadMediaViewer}
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
              </div>

              <div className="composer__field">
                {chipsSeen || resourcePickerMounted ? (
                  <ChipOverlay store={chipStore} area={area} />
                ) : null}
                <textarea
                  ref={area}
                  defaultValue=""
                  rows={1}
                  spellCheck={false}
                  disabled={props.disabled}
                  aria-label="Message"
                  aria-keyshortcuts={shortcutAria(keybindings.focusComposer)}
                  aria-controls={resourceTrigger ? COMPOSER_RESOURCE_LIST_ID : undefined}
                  aria-expanded={resourceTrigger !== undefined}
                  aria-haspopup="listbox"
                  aria-autocomplete="list"
                  onFocus={warmUpComposer}
                  onPointerEnter={warmUpComposer}
                  onChange={(e) => {
                    const input = e.nativeEvent as InputEvent
                    let value = e.target.value
                    // An edit that cut through a chip leaves no invisible mark
                    // behind. Undo and redo only put back what the editor held,
                    // so Ctrl+Z can step back past the repair to the whole chip.
                    const repaired =
                      chipStore.get() !== '' &&
                      !input.isComposing &&
                      !repairingChips.current &&
                      !HISTORY_INPUT_TYPES.has(input.inputType)
                        ? repairComposerChips(value, e.target.selectionStart ?? value.length)
                        : undefined
                    if (repaired) {
                      removeChipFragments(e.target, value)
                      if (e.target.value !== repaired.text) e.target.value = repaired.text
                      e.target.setSelectionRange(repaired.caret, repaired.caret)
                      value = repaired.text
                    }
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
                    if (chipStore.get() !== '' && handleChipKey(e)) return
                    if (resourceTrigger) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        resourcePicker.current?.move(e.key === 'ArrowDown' ? 1 : -1)
                        return
                      }
                      if (e.key === 'Tab') {
                        if (resourcePicker.current?.selectActive('Tab')) e.preventDefault()
                        return
                      }
                      if (e.key === 'Enter') {
                        // Behind chips a command cannot run as typed: Enter
                        // picks it, which puts it in front, as Tab does.
                        const behindChips =
                          resourceTrigger.marker === '/' &&
                          hasComposerChips(textRef.current.slice(0, resourceTrigger.start))
                        const key = behindChips ? 'Tab' : 'Enter'
                        if (resourcePicker.current?.selectActive(key) === 'selected') {
                          e.preventDefault()
                          return
                        }
                        // Nothing to pick ("echo $HOME"), or a command typed in
                        // full that needs no arguments: Enter sends as usual.
                        setResourceTrigger(undefined)
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setResourceTrigger(undefined)
                        return
                      }
                    }
                    // Arrow Up in an empty composer brings the last prompt back
                    // to edit, as in a shell; Escape puts the empty box back.
                    if (
                      e.key === 'ArrowUp' &&
                      !e.shiftKey &&
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      props.onRecallLastPrompt &&
                      composerEmptyAtStart(e.currentTarget)
                    ) {
                      const recalled = props.onRecallLastPrompt()
                      if (recalled !== undefined) {
                        e.preventDefault()
                        recalledPrompt.current = recalled
                      }
                      return
                    }
                    if (e.key === 'Escape' && recalledPrompt.current !== undefined) {
                      e.preventDefault()
                      cancelRecalledPrompt()
                      return
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
                    // A click or a vertical move that lands inside a chip goes to its nearer edge.
                    if (chipStore.get() !== '' && target.selectionStart === target.selectionEnd) {
                      const caret = target.selectionStart
                      const chip = composerChipAround(target.value, caret)
                      if (chip) {
                        const edge = caret - chip.start < chip.end - caret ? chip.start : chip.end
                        target.setSelectionRange(edge, edge)
                      }
                    }
                    updateResourceTrigger(
                      composerResourceTriggerAt(textRef.current, target.selectionStart ?? 0),
                    )
                  }}
                  onCopy={(e) => copyChips(e, false)}
                  onCut={(e) => copyChips(e, true)}
                  onBlur={() => setResourceTrigger(undefined)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files)
                    const paths: string[] = []
                    const materialized: File[] = []
                    for (const file of files) {
                      const filePath =
                        previewMediaType(file.type, file.name) === undefined
                          ? droppedFilePath(file)
                          : undefined
                      if (filePath) paths.push(filePath)
                      else materialized.push(file)
                    }
                    if (materialized.length > 0 || paths.length > 0) {
                      e.preventDefault()
                      if (!props.attachmentsSupported) {
                        setAttachmentError(ATTACHMENTS_UNSUPPORTED)
                        return
                      }
                      attachFiles(paths)
                      addPastedFiles(materialized, 'paste')
                      return
                    }
                    pasteOverChips(e)
                  }}
                  placeholder={props.placeholder ?? 'Do anything'}
                />
              </div>

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
                      <Plus size={16} aria-hidden />
                    </span>
                  </button>
                ) : props.attachmentsLoading ? (
                  <SkeletonStatus
                    label="Loading attachments"
                    className="composer-skeleton-slot composer-skeleton-attachment"
                  >
                    <Skeleton width="100%" height="100%" />
                  </SkeletonStatus>
                ) : null}

                <div
                  className="composer__dictation-options"
                  data-hidden={voiceState !== 'idle' ? '' : undefined}
                  inert={voiceState !== 'idle'}
                  aria-hidden={voiceState !== 'idle'}
                >
                  <div className="composer__dictation-options-clip">
                    <div className="composer__dictation-options-content">
                      <Menu
                        label="Permissions"
                        triggerTitle={
                          props.approvalLoading ? undefined : `Permissions: ${approval.short}`
                        }
                        disabled={Boolean(props.approvalLoading)}
                        triggerClassName="composer__permission"
                        panelClassName="menu--compact menu--permissions"
                        trigger={() =>
                          props.approvalLoading ? (
                            <SkeletonStatus
                              label="Loading permissions"
                              className="tool composer-skeleton-permission"
                            >
                              <div className="composer-skeleton-permission__icon">
                                <Skeleton className="skeleton--icon" />
                                {/* Shown instead of the skeleton where the label is hidden. */}
                                <approval.icon
                                  className="composer-skeleton-permission__glyph"
                                  size={13}
                                  aria-hidden
                                />
                              </div>
                              <span className="composer-skeleton-permission__label" aria-hidden>
                                <span>{approval.short}</span>
                                <Skeleton height={9} />
                              </span>
                            </SkeletonStatus>
                          ) : (
                            <span
                              className={`tool${props.approval === 'auto-review' ? ' tool--review' : ''}${props.approval === 'full' ? ' tool--danger' : ''}`}
                            >
                              <IconMorph active={APPROVAL_MODES.indexOf(approval)}>
                                {APPROVAL_MODES.map((mode) => (
                                  <mode.icon key={mode.id} size={13} aria-hidden />
                                ))}
                              </IconMorph>
                              <span>{approval.short}</span>
                            </span>
                          )
                        }
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
                                  detail={
                                    mode.id === 'ask' && props.askFirstUnavailable
                                      ? props.askFirstUnavailable
                                      : mode.detail
                                  }
                                  disabled={mode.id === 'ask' && Boolean(props.askFirstUnavailable)}
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
                    </div>
                  </div>
                </div>

                {voiceState === 'idle' ? <span className="tools__spacer" /> : null}

                {voiceState === 'idle' && props.usage?.contextWindow ? (
                  <Suspense fallback={null}>
                    <ContextUsage usage={props.usage} />
                  </Suspense>
                ) : null}

                {voiceState === 'idle' && props.modelPending ? (
                  <ModelTriggerSkeleton />
                ) : voiceState === 'idle' && props.models.length > 0 ? (
                  <Suspense fallback={<ModelTriggerSkeleton />}>
                    <ModelSelector
                      models={props.models}
                      modelId={props.modelId}
                      choice={props.modelChoice}
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
                  <ModelTriggerSkeleton />
                ) : null}

                {props.voiceAvailable ? (
                  <Suspense fallback={props.running ? null : <VoiceControlSkeleton />}>
                    <ComposerVoiceControl
                      contextKey={`${props.provider}:${props.projectPath ?? ''}:${props.draftRequest?.request ?? ''}${props.dormant ? ':dormant' : ''}`}
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
                ) : props.voiceLoading && !props.running ? (
                  <VoiceControlSkeleton />
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
                        title={
                          showStop
                            ? props.stopping
                              ? 'Stopping…'
                              : 'Stop'
                            : props.modelPending
                              ? 'Loading models…'
                              : submitLabel
                        }
                        aria-label={
                          showStop ? (props.stopping ? 'Stopping…' : 'Stop') : submitLabel
                        }
                      >
                        <IconMorph active={showStop ? 1 : 0}>
                          <ArrowUp size={16} aria-hidden />
                          <Square
                            className="orb__stop-glyph"
                            size={10}
                            fill="currentColor"
                            strokeWidth={0}
                            aria-hidden
                          />
                        </IconMorph>
                      </button>
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </DesignBeam>
        </div>
      </div>
      {viewingMedia ? (
        <Suspense fallback={null}>
          <MediaViewer
            src={viewingMedia.src}
            thumbnailSrc={viewingMedia.thumbnailSrc}
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

/** Queued-prompt reorders bubble up here too; only real file drags attach. */
function hasDroppedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes('Files')
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
