import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { savePastedFile } from '../../bridge.js'
import { browserCommentChipText } from '../composer-chips.js'
import {
  browserCommentImageName,
  newBrowserCommentId,
  rememberBrowserComment,
  type BrowserComment,
} from '../browser-comments.js'
import {
  AnnotationProbe,
  annotationComment,
  annotationCommentReady,
  annotationCrop,
  annotationPopoverPlace,
  annotationProbeScript,
  annotationText,
  type AnnotationBox,
  type AnnotationDraft,
  type AnnotationTarget,
  type BrowserAnnotation,
  type ProbeRequest,
} from './browser-annotations.js'

export type AnnotationGuest = HTMLElement & {
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<{ toDataURL(): string }>
  getURL(): string
  getTitle(): string
}

const MAX_PINS = 20
const TRACKING_INTERVAL_MS = 250
/** Above this the screenshot only costs the agent's context, not detail it can use. */
const MAX_CROP_SIDE = 1600
/** Long past a healthy page's answer, which takes a frame. */
const PAGE_ANSWER_MS = 2_000
const CAPTURE_MS = 10_000

/** A hung page never answers, and every click and pin would wait for it. */
function withinTime<T>(answer: Promise<T>, limit: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The page did not answer')), limit)
    void answer.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * Page reads a guest has not answered yet, given up on or not. A hung page keeps them, and
 * the tracking reads wait for them instead of piling up one more every time one times out.
 */
const unanswered = new WeakMap<AnnotationGuest, number>()

function awaitingAnswer(view: AnnotationGuest): boolean {
  return (unanswered.get(view) ?? 0) > 0
}

async function readPage(view: AnnotationGuest, request: ProbeRequest) {
  unanswered.set(view, (unanswered.get(view) ?? 0) + 1)
  const answer = view.executeJavaScript(annotationProbeScript(request))
  void answer
    .catch(() => undefined)
    .finally(() => unanswered.set(view, (unanswered.get(view) ?? 1) - 1))
  return AnnotationProbe.parse(await withinTime(answer, PAGE_ANSWER_MS))
}

/** Pixels of the element as the guest paints it now. The overlay is never in the capture. */
async function captureElement(
  view: AnnotationGuest,
  box: AnnotationBox,
  viewport: { width: number; height: number },
): Promise<string | undefined> {
  const screenshot = await view.capturePage()
  const source = new Image()
  source.src = screenshot.toDataURL()
  await source.decode()
  const bitmap = await createImageBitmap(source)
  try {
    const crop = annotationCrop(box, viewport, bitmap)
    if (!crop) return undefined
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, MAX_CROP_SIDE / Math.max(crop.width, crop.height))
    canvas.width = Math.max(1, Math.round(crop.width * scale))
    canvas.height = Math.max(1, Math.round(crop.height * scale))
    canvas
      .getContext('2d')!
      .drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]
  } finally {
    bitmap.close()
  }
}

export function BrowserAnnotations({
  view,
  enabled,
  imagesSupported,
  onDraft,
  onExit,
}: {
  view: AnnotationGuest
  enabled: boolean
  imagesSupported: boolean
  onDraft: (draft: AnnotationDraft) => void
  onExit: () => void
}) {
  const [pins, setPins] = useState<BrowserAnnotation[]>([])
  const [hover, setHover] = useState<AnnotationTarget>()
  const [boxes, setBoxes] = useState<ReadonlyMap<number, AnnotationBox | null>>(new Map())
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const [editing, setEditing] = useState<BrowserAnnotation>()
  const [popoverPlace, setPopoverPlace] = useState<{ left: number; top: number }>()
  const [busy, setBusy] = useState(false)
  const [unreadable, setUnreadable] = useState(false)
  const [addFailed, setAddFailed] = useState(false)

  const overlay = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLFormElement>(null)
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined)
  const pendingScroll = useRef({ dx: 0, dy: 0 })
  const requestRead = useRef<() => void>(() => undefined)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const editingRef = useRef(editing)
  editingRef.current = editing
  // The element of a comment still being written is followed like a saved pin.
  const tracked = useRef<BrowserAnnotation[]>([])
  tracked.current =
    editing && !pins.some((pin) => pin.number === editing.number) ? [...pins, editing] : pins

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let reading = false
    let readAgain = false
    let frame: number | undefined
    const read = async () => {
      if (reading) {
        readAgain = true
        return
      }
      // A read the page never answered still runs in it; the next one waits until it ends.
      if (awaitingAnswer(view)) return
      reading = true
      const scroll = pendingScroll.current
      pendingScroll.current = { dx: 0, dy: 0 }
      const pins = tracked.current
      const at = editingRef.current ? undefined : pointer.current
      const request: ProbeRequest = {
        selectors: pins.map((pin) => pin.selector),
        ...(at ? { point: at } : {}),
        ...(scroll.dx || scroll.dy ? { scroll } : {}),
      }
      try {
        const data = await readPage(view, request)
        if (stopped) return
        setViewport({ width: data.width, height: data.height })
        setBoxes(new Map(pins.map((pin, index) => [pin.number, data.targets[index]?.box ?? null])))
        setHover(data.hit ?? undefined)
        setUnreadable(false)
      } catch {
        // Expected for a moment while a page reloads; the next read clears it.
        if (!stopped) setUnreadable(true)
      } finally {
        reading = false
        if (readAgain && !stopped) {
          readAgain = false
          void read()
        }
      }
    }
    requestRead.current = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        void read()
      })
    }
    void read()
    // Pages move on their own too: layout shifts, carousels, late images.
    const timer = window.setInterval(() => {
      if (tracked.current.length > 0) void read()
    }, TRACKING_INTERVAL_MS)
    overlay.current?.focus({ preventScroll: true })
    return () => {
      stopped = true
      window.clearInterval(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
      requestRead.current = () => undefined
      pointer.current = undefined
      setHover(undefined)
      setEditing(undefined)
    }
  }, [view, enabled])

  const editingBox = editing ? (boxes.get(editing.number) ?? editing.box) : undefined
  useLayoutEffect(() => {
    if (!editingBox || !overlay.current || !popover.current) {
      setPopoverPlace(undefined)
      return
    }
    const area = overlay.current.getBoundingClientRect()
    const panel = popover.current.getBoundingClientRect()
    const scaleX = area.width / viewport.width
    const scaleY = area.height / viewport.height
    const next = annotationPopoverPlace(
      {
        x: editingBox.x * scaleX,
        y: editingBox.y * scaleY,
        width: editingBox.width * scaleX,
        height: editingBox.height * scaleY,
      },
      area,
      panel,
    )
    setPopoverPlace((current) =>
      current?.left === next.left && current.top === next.top ? current : next,
    )
  }, [editingBox, viewport])

  // The box measures itself hidden first, and a hidden field cannot take focus.
  const editorPlaced = popoverPlace !== undefined
  useEffect(() => {
    if (editorPlaced) popover.current?.querySelector('textarea')?.focus()
  }, [editing?.number, editorPlaced])

  const toPoint = (x: number, y: number) => {
    const rect = overlay.current!.getBoundingClientRect()
    return { x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height }
  }
  const boxStyle = (box: AnnotationBox): CSSProperties => ({
    left: `${(box.x / viewport.width) * 100}%`,
    top: `${(box.y / viewport.height) * 100}%`,
    width: `${(box.width / viewport.width) * 100}%`,
    height: `${(box.height / viewport.height) * 100}%`,
  })
  const onPage = (box: AnnotationBox | null | undefined): box is AnnotationBox =>
    !!box &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width > 0 &&
    box.y + box.height > 0 &&
    box.x < viewport.width &&
    box.y < viewport.height

  const closeEditor = () => {
    setEditing(undefined)
    overlay.current?.focus({ preventScroll: true })
  }
  const select = async (x: number, y: number) => {
    if (busy || pins.length >= MAX_PINS) return
    setBusy(true)
    try {
      const data = await readPage(view, { point: toPoint(x, y), withText: true })
      const target = data.hit
      if (!target || !target.box.width || !target.box.height) return
      // A second click on a pinned element means this comment, not a duplicate of it.
      const pinned = pins.find((pin) => pin.selector === annotationText(target.selector, 2048))
      if (pinned) {
        setEditing(pinned)
        return
      }
      if (!enabledRef.current) return
      setViewport({ width: data.width, height: data.height })
      const number = Math.max(0, ...pins.map((pin) => pin.number)) + 1
      // The box opens at once: the capture is slower than a click should feel, and it
      // cannot see the box. Add to chat stays disabled until the image has landed.
      setEditing({
        ...target,
        tag: annotationText(target.tag, 64),
        text: annotationText(target.text, 500),
        selector: annotationText(target.selector, 2048),
        number,
        comment: '',
        url: annotationText(view.getURL(), 2048),
        title: annotationText(view.getTitle(), 300),
      })
      const image = await withinTime(captureElement(view, target.box, data), CAPTURE_MS).catch(
        () => undefined,
      )
      if (image) {
        setEditing((current) => (current?.number === number ? { ...current, image } : current))
        setPins((current) =>
          current.map((pin) => (pin.number === number ? { ...pin, image } : pin)),
        )
      }
    } catch {
      setUnreadable(true)
    } finally {
      setBusy(false)
    }
  }
  const saveEditing = () => {
    if (!editing || !annotationCommentReady(editing.comment)) return
    const saved = { ...editing, comment: annotationComment(editing.comment) }
    setPins((current) =>
      [...current.filter((pin) => pin.number !== saved.number), saved].sort(
        (a, b) => a.number - b.number,
      ),
    )
    closeEditor()
  }
  const addToChat = async () => {
    setBusy(true)
    setAddFailed(false)
    try {
      const attachments: string[] = []
      const comments: BrowserComment[] = []
      for (const pin of pins) {
        const comment: BrowserComment = {
          id: newBrowserCommentId(),
          comment: pin.comment,
          title: pin.title,
          url: pin.url,
          selector: pin.selector,
          text: pin.text,
        }
        if (imagesSupported && pin.image) {
          const bytes = Uint8Array.from(atob(pin.image), (character) => character.charCodeAt(0))
          const saved = await savePastedFile(
            new File([bytes], browserCommentImageName(comment.id), { type: 'image/png' }),
          )
          if (!saved) throw new Error('Image attachment saving is unavailable')
          comment.image = saved.path
        }
        comments.push(comment)
      }
      for (const comment of comments) rememberBrowserComment(comment)
      // Images belong to their chips. The send path collects only those still in the draft.
      onDraft({ text: comments.map(browserCommentChipText).join('\n'), attachments })
      // The composer owns them now: there they can be edited, sent, or recovered after a failure.
      setPins([])
      setBoxes(new Map())
      onExit()
    } catch {
      setAddFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) return null

  const editingExisting = editing && pins.some((pin) => pin.number === editing.number)
  const editingIndex = editing
    ? editingExisting
      ? pins.findIndex((pin) => pin.number === editing.number)
      : pins.length
    : 0
  const status = addFailed
    ? 'Could not add these. They are still here.'
    : unreadable
      ? 'Cannot read this page right now'
      : pins.length >= MAX_PINS
        ? `${MAX_PINS} comments is the most for one round`
        : pins.length === 0
          ? 'Click anything to comment'
          : !imagesSupported
            ? 'Text only: this model cannot take images'
            : `${pins.length} ${pins.length === 1 ? 'comment' : 'comments'}`

  return (
    <>
      <div
        ref={overlay}
        className="browser-annotations__overlay"
        tabIndex={-1}
        aria-label="Annotate page"
        data-busy={busy || undefined}
        onPointerMove={(event) => {
          pointer.current = toPoint(event.clientX, event.clientY)
          requestRead.current()
        }}
        onPointerLeave={() => {
          pointer.current = undefined
          setHover(undefined)
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (!editing) void select(event.clientX, event.clientY)
          else if (annotationCommentReady(editing.comment))
            popover.current?.querySelector('textarea')?.focus()
          else closeEditor()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onExit()
        }}
        onWheel={(event) => {
          pointer.current = toPoint(event.clientX, event.clientY)
          pendingScroll.current.dx += event.deltaX
          pendingScroll.current.dy += event.deltaY
          requestRead.current()
        }}
      >
        {pins.map((pin) => {
          const box = boxes.get(pin.number)
          return onPage(box) ? (
            <div key={pin.number} className="browser-annotations__outline" style={boxStyle(box)} />
          ) : null
        })}
        {hover && !editing ? (
          <div
            className="browser-annotations__highlight"
            data-inside={hover.box.y < 24 || undefined}
            style={boxStyle(hover.box)}
          >
            {pins.some((pin) => pin.selector === hover.selector) ? null : (
              <span className="browser-annotations__tag">{annotationText(hover.tag, 32)}</span>
            )}
          </div>
        ) : null}
        {editing && !editingExisting && onPage(editingBox) ? (
          <div className="browser-annotations__highlight" style={boxStyle(editingBox)} />
        ) : null}
        {pins.map((pin, index) => {
          const box = boxes.get(pin.number)
          return onPage(box) ? (
            <button
              key={pin.number}
              type="button"
              className="browser-annotations__pin"
              style={{
                left: `clamp(13px, ${(box.x / viewport.width) * 100}%, calc(100% - 13px))`,
                top: `clamp(13px, ${(box.y / viewport.height) * 100}%, calc(100% - 13px))`,
              }}
              title={pin.comment}
              aria-label={`Comment ${index + 1}: ${pin.comment}`}
              onClick={(event) => {
                event.stopPropagation()
                setEditing(pin)
              }}
            >
              {index + 1}
            </button>
          ) : null
        })}
      </div>

      {editing ? (
        <form
          ref={popover}
          className="browser-annotations__popover"
          style={popoverPlace ?? { visibility: 'hidden' }}
          onSubmit={(event) => {
            event.preventDefault()
            saveEditing()
          }}
        >
          <div className="browser-annotations__target" title={editing.selector}>
            <span className="browser-annotations__number">{editingIndex + 1}</span>
            <code>{annotationText(editing.tag, 32)}</code>
            {editing.text ? <span>{annotationText(editing.text, 80)}</span> : null}
          </div>
          <textarea
            maxLength={2000}
            rows={2}
            placeholder="What should change?"
            aria-label={`Comment ${editingIndex + 1}`}
            value={editing.comment}
            onChange={(event) => setEditing({ ...editing, comment: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                closeEditor()
              } else if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                saveEditing()
              }
            }}
          />
          <div className="browser-annotations__popover-actions">
            {editingExisting ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setPins((current) => current.filter((pin) => pin.number !== editing.number))
                  closeEditor()
                }}
              >
                Delete
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={closeEditor}>
              Cancel
            </button>
            <button className="btn" disabled={!annotationCommentReady(editing.comment)}>
              {editingExisting ? 'Save' : 'Comment'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="browser-annotations__bar" role="group" aria-label="Page comments">
        {pins.length > 0 ? (
          <ol className="browser-annotations__list">
            {pins.map((pin, index) => (
              <li key={pin.number}>
                <button
                  type="button"
                  className="browser-annotations__row"
                  onClick={() => setEditing(pin)}
                >
                  <span className="browser-annotations__number">{index + 1}</span>
                  <span className="browser-annotations__comment">{pin.comment}</span>
                  {boxes.get(pin.number) === null ? (
                    <span className="browser-annotations__gone">Element gone</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="browser-annotations__actions">
          <p role="status">{status}</p>
          <button type="button" className="ghost" onClick={onExit}>
            Done
          </button>
          {pins.length > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={busy || Boolean(editing)}
              onClick={() => void addToChat()}
            >
              Add to chat
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}
