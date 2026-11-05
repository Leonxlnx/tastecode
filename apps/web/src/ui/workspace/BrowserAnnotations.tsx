import { useEffect, useRef, useState } from 'react'
import type { Transport } from '../../transport.js'
import {
  AnnotationProbe,
  annotationCrop,
  annotationProbeScript,
  annotationPrompt,
  annotationText,
  type AnnotationDraft,
  type AnnotationTarget,
  type BrowserAnnotation,
} from './browser-annotations.js'

export type AnnotationGuest = HTMLElement & {
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<{ toDataURL(): string }>
  getURL(): string
}

export function BrowserAnnotations({
  view,
  enabled,
  imagesSupported,
  transport,
  onDraft,
  onExit,
}: {
  view: AnnotationGuest
  enabled: boolean
  imagesSupported: boolean
  transport: Transport
  onDraft: (draft: AnnotationDraft) => void
  onExit: () => void
}) {
  const [pins, setPins] = useState<BrowserAnnotation[]>([])
  const [hover, setHover] = useState<AnnotationTarget>()
  const [positions, setPositions] = useState<(AnnotationTarget | null)[]>([])
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const [editing, setEditing] = useState<BrowserAnnotation>()
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(false)
  const [notice, setNotice] = useState('Click an element to comment. Navigation clears pins.')
  const pinsRef = useRef(pins)
  pinsRef.current = pins
  const epoch = useRef(0)
  const reading = useRef(false)
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined)
  const overlay = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!enabled) {
      setHover(undefined)
      setEditing(undefined)
      return
    }
    let cancelled = false
    const refresh = async () => {
      if (reading.current) return
      reading.current = true
      try {
        const selectors = pinsRef.current.map((pin) => pin.selector)
        const data = AnnotationProbe.parse(
          await view.executeJavaScript(annotationProbeScript({ selectors })),
        )
        if (cancelled) return
        setPositions(data.targets)
        setViewport(data)
        if (pointer.current) {
          const hit = AnnotationProbe.parse(
            await view.executeJavaScript(annotationProbeScript({ point: pointer.current })),
          )
          if (!cancelled) setHover(hit.targets[0] ?? undefined)
        }
      } catch {
        if (!cancelled) setNotice('Could not read this page. Try reloading it.')
      } finally {
        reading.current = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 150)
    return () => {
      cancelled = true
      epoch.current++
      window.clearInterval(timer)
    }
  }, [view, enabled])

  useEffect(() => {
    input.current?.focus()
  }, [editing?.number])
  useEffect(
    () => () => {
      epoch.current++
    },
    [],
  )

  const point = (x: number, y: number) => {
    const rect = overlay.current!.getBoundingClientRect()
    return { x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height }
  }
  const style = (target: AnnotationTarget) => ({
    left: `${(target.box.x / viewport.width) * 100}%`,
    top: `${(target.box.y / viewport.height) * 100}%`,
    width: `${(target.box.width / viewport.width) * 100}%`,
    height: `${(target.box.height / viewport.height) * 100}%`,
  })
  const select = async (x: number, y: number) => {
    if (busy || editing || staged || pins.length >= 20) return
    setBusy(true)
    const revision = epoch.current
    try {
      const data = AnnotationProbe.parse(
        await view.executeJavaScript(annotationProbeScript({ point: point(x, y) })),
      )
      const target = data.targets[0]
      if (!target || !target.box.width || !target.box.height) return
      const screenshot = await view.capturePage()
      const source = new Image()
      source.src = screenshot.toDataURL()
      await source.decode()
      const bitmap = await createImageBitmap(source)
      let image: string | undefined
      try {
        const crop = annotationCrop(target.box, data, bitmap)
        if (!crop) return
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 1600 / Math.max(crop.width, crop.height))
        canvas.width = Math.max(1, Math.round(crop.width * scale))
        canvas.height = Math.max(1, Math.round(crop.height * scale))
        canvas
          .getContext('2d')!
          .drawImage(
            bitmap,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            canvas.width,
            canvas.height,
          )
        image = canvas.toDataURL('image/png').split(',')[1]
      } finally {
        bitmap.close()
      }
      if (revision !== epoch.current) return
      setViewport(data)
      setEditing({
        ...target,
        text: annotationText(target.text, 500),
        selector: annotationText(target.selector, 2048),
        number: Math.max(0, ...pins.map((p) => p.number)) + 1,
        comment: '',
        url: annotationText(view.getURL(), 2048),
        image,
      })
    } catch {
      setNotice('Could not capture this element. Your pins are still here.')
    } finally {
      setBusy(false)
    }
  }
  const stage = async () => {
    setBusy(true)
    const revision = epoch.current
    try {
      const attachments: string[] = []
      for (const pin of pins) {
        if (imagesSupported && pin.image) {
          const saved = await transport.request('attachments.saveImage', {
            mimeType: 'image/png',
            data: pin.image,
          })
          attachments.push(saved.path)
        }
      }
      if (revision !== epoch.current) return
      const text = annotationPrompt(pins, crypto.randomUUID())
      onDraft({
        text,
        attachments,
        onSent: () => {
          setPins([])
          setPositions([])
          setStaged(false)
          setNotice('Annotations sent.')
        },
      })
      setStaged(true)
      setNotice(
        imagesSupported
          ? 'Added to composer. Pins clear after a successful send.'
          : 'Added to composer as text only. This model does not support images.',
      )
    } catch {
      setNotice('Could not add annotations. Your pins are still here; try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {enabled ? (
        <div
          ref={overlay}
          className="browser-annotations__overlay"
          tabIndex={0}
          aria-label="Annotate page"
          onPointerMove={(event) => {
            pointer.current = point(event.clientX, event.clientY)
          }}
          onPointerLeave={() => {
            pointer.current = undefined
            setHover(undefined)
          }}
          onClick={(event) => {
            event.stopPropagation()
            void select(event.clientX, event.clientY)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setEditing(undefined)
              onExit()
            }
          }}
          onWheel={(event) => {
            const p = point(event.clientX, event.clientY)
            void view
              .executeJavaScript(
                annotationProbeScript({
                  wheel: {
                    x: p.x * viewport.width,
                    y: p.y * viewport.height,
                    dx: event.deltaX,
                    dy: event.deltaY,
                  },
                }),
              )
              .catch(() => undefined)
          }}
        >
          {hover ? <div className="browser-annotations__highlight" style={style(hover)} /> : null}
          {pins.map((pin, index) => {
            const target = positions[index]
            return target && target.box.width > 0 && target.box.height > 0 ? (
              <button
                key={pin.number}
                className="browser-annotations__pin"
                style={{ left: style(target).left, top: style(target).top }}
                title={`Annotation ${pin.number}: ${pin.comment}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!staged) setEditing(pin)
                }}
              >
                {pin.number}
              </button>
            ) : null
          })}
        </div>
      ) : null}
      {enabled ? (
        <div
          className="browser-annotations__tray"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setEditing(undefined)
              onExit()
            }
          }}
        >
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setPins((current) =>
                  [
                    ...current.filter((p) => p.number !== editing.number),
                    { ...editing, comment: annotationText(editing.comment, 2000) },
                  ].sort((a, b) => a.number - b.number),
                )
                setEditing(undefined)
              }}
            >
              <label htmlFor="browser-annotation-comment">Comment {editing.number}</label>
              <textarea
                id="browser-annotation-comment"
                ref={input}
                maxLength={2000}
                value={editing.comment}
                onChange={(event) => setEditing({ ...editing, comment: event.target.value })}
              />
              <div>
                <button className="btn" disabled={!editing.comment.trim()}>
                  Save comment
                </button>{' '}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setPins((current) => current.filter((p) => p.number !== editing.number))
                    setEditing(undefined)
                  }}
                >
                  Remove
                </button>{' '}
                <button type="button" className="ghost" onClick={() => setEditing(undefined)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p role="status">{notice}</p>
              {pins.length ? (
                <>
                  <div className="browser-annotations__list">
                    {pins.map((pin, index) => (
                      <button
                        key={pin.number}
                        className="ghost"
                        disabled={staged}
                        onClick={() => setEditing(pin)}
                      >
                        {pin.number}. {pin.comment.slice(0, 60)}
                        {!positions[index] ? ' (element missing)' : ''}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || staged}
                    onClick={() => void stage()}
                  >
                    Add {pins.length} to composer
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  )
}
