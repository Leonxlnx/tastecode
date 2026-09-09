import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconDownload as Download,
  IconFolderOpen as FolderOpen,
  IconMaximize as Maximize2,
  IconMinimize as Minimize2,
  IconMinus as Minus,
  IconPlayerPause as Pause,
  IconPlayerPlay as Play,
  IconPlus as Plus,
  IconVolume as Volume2,
  IconVolumeOff as VolumeX,
  IconVideoOff as VideoOff,
  IconX as X,
} from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'
import '../styles/media-viewer.css'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25
const SEEK_STEP_SECONDS = 5

export function MediaViewer(props: {
  src: string
  name: string
  mediaType: 'image' | 'video'
  onReveal?: (() => void) | undefined
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [paused, setPaused] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [waiting, setWaiting] = useState(props.mediaType === 'video')
  const [videoError, setVideoError] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [imageSize, setImageSize] = useState<{ width: number; height: number }>()
  const dialog = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const videoShell = useRef<HTMLDivElement>(null)
  const previousZoom = useRef(zoom)
  const close = useRef<HTMLButtonElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  const togglePlayback = useCallback(() => {
    const element = video.current
    if (!element || videoError) return
    if (element.paused) {
      void element.play().catch(() => setVideoError(true))
    } else {
      element.pause()
    }
  }, [videoError])

  const seekBy = useCallback((seconds: number) => {
    const element = video.current
    if (!element || !Number.isFinite(element.duration)) return
    element.currentTime = Math.min(element.duration, Math.max(0, element.currentTime + seconds))
    setCurrentTime(element.currentTime)
  }, [])

  const toggleMuted = useCallback(() => {
    const element = video.current
    if (!element) return
    element.muted = !element.muted
  }, [])

  const toggleFullscreen = useCallback(() => {
    const element = videoShell.current
    if (!element) return
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
    } else {
      void element.requestFullscreen?.()
    }
  }, [])

  const fitImageToViewport = useCallback(() => {
    const imageElement = image.current
    const viewportElement = viewport.current
    if (!imageElement || !viewportElement) return

    const { naturalWidth, naturalHeight } = imageElement
    const { width: viewportWidth, height: viewportHeight } = viewportElement.getBoundingClientRect()
    if (naturalWidth <= 0 || naturalHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
      return
    }

    const fit = Math.min(1, viewportWidth / naturalWidth, viewportHeight / naturalHeight)
    const nextSize = { width: naturalWidth * fit, height: naturalHeight * fit }
    setImageSize((current) =>
      current?.width === nextSize.width && current.height === nextSize.height ? current : nextSize,
    )
  }, [])

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.fullscreenElement) return
        event.preventDefault()
        onClose.current()
        return
      }

      if (event.key === 'Tab') {
        const focusable = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled)',
          ) ?? [],
        )
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }

      if (props.mediaType !== 'video') return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('button, input, a')) return
      switch (event.key.toLowerCase()) {
        case ' ':
        case 'k':
          event.preventDefault()
          togglePlayback()
          break
        case 'arrowleft':
          event.preventDefault()
          seekBy(-SEEK_STEP_SECONDS)
          break
        case 'arrowright':
          event.preventDefault()
          seekBy(SEEK_STEP_SECONDS)
          break
        case 'm':
          event.preventDefault()
          toggleMuted()
          break
        case 'f':
          event.preventDefault()
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [props.mediaType, seekBy, toggleFullscreen, toggleMuted, togglePlayback])

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === videoShell.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useLayoutEffect(() => {
    if (props.mediaType !== 'image') return
    const element = viewport.current
    if (!element) return

    fitImageToViewport()
    const observer = new ResizeObserver(fitImageToViewport)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fitImageToViewport, props.mediaType, props.src])

  useEffect(() => {
    const element = viewport.current
    const oldZoom = previousZoom.current
    previousZoom.current = zoom
    if (!element || oldZoom === zoom || props.mediaType !== 'image') return

    const factor = zoom / oldZoom
    element.scrollLeft =
      (element.scrollLeft + element.clientWidth / 2) * factor - element.clientWidth / 2
    element.scrollTop =
      (element.scrollTop + element.clientHeight / 2) * factor - element.clientHeight / 2
  }, [props.mediaType, zoom])

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return createPortal(
    <div
      ref={dialog}
      className={`media-viewer media-viewer--${props.mediaType}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${props.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose.current()
      }}
    >
      <div className="media-viewer__actions" role="toolbar" aria-label="Media actions">
        {props.onReveal ? (
          <button
            className="media-viewer__action"
            type="button"
            onClick={props.onReveal}
            aria-label="Show in folder"
            title="Show in folder"
          >
            <FolderOpen size={17} aria-hidden />
          </button>
        ) : (
          <a
            className="media-viewer__action"
            href={props.src}
            download={props.name}
            aria-label={`Download ${props.mediaType}`}
            title="Download"
          >
            <Download size={17} aria-hidden />
          </a>
        )}
        <button
          ref={close}
          className="media-viewer__action"
          type="button"
          onClick={() => onClose.current()}
          aria-label="Close media viewer"
          title="Close"
        >
          <X size={18} aria-hidden />
        </button>
      </div>

      <div
        ref={viewport}
        className="media-viewer__viewport"
        onMouseDown={(event) => {
          if (props.mediaType === 'video' && event.target === event.currentTarget) onClose.current()
          if (props.mediaType === 'image' && zoom <= 1 && event.target === event.currentTarget) {
            onClose.current()
          }
        }}
      >
        {props.mediaType === 'image' ? (
          <div
            className="media-viewer__frame"
            data-sized={imageSize ? 'true' : undefined}
            style={
              imageSize
                ? { width: imageSize.width * zoom, height: imageSize.height * zoom }
                : { width: `${zoom * 100}%`, height: `${zoom * 100}%` }
            }
            onMouseDown={(event) => {
              if (zoom <= 1 && event.target === event.currentTarget) onClose.current()
            }}
          >
            <img
              ref={image}
              src={props.src}
              alt={props.name}
              draggable={false}
              decoding="async"
              onLoad={fitImageToViewport}
            />
          </div>
        ) : (
          <div className="media-viewer__video-frame">
            <div
              ref={videoShell}
              className="media-viewer__video-shell"
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={toggleFullscreen}
            >
              <video
                ref={video}
                src={props.src}
                aria-label={props.name}
                playsInline
                preload="metadata"
                onClick={togglePlayback}
                onLoadStart={() => {
                  setWaiting(true)
                  setVideoError(false)
                }}
                onLoadedMetadata={(event) => {
                  const element = event.currentTarget
                  setDuration(Number.isFinite(element.duration) ? element.duration : 0)
                  setCurrentTime(element.currentTime)
                  setPaused(element.paused)
                }}
                onCanPlay={() => setWaiting(false)}
                onPlaying={() => {
                  setPaused(false)
                  setWaiting(false)
                }}
                onPause={() => setPaused(true)}
                onWaiting={() => setWaiting(true)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onDurationChange={(event) => {
                  const nextDuration = event.currentTarget.duration
                  setDuration(Number.isFinite(nextDuration) ? nextDuration : 0)
                }}
                onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
                onError={() => {
                  setWaiting(false)
                  setVideoError(true)
                }}
              />

              {waiting && !videoError ? (
                <span
                  className="media-viewer__video-loading"
                  role="status"
                  aria-label="Loading video"
                />
              ) : null}
              {videoError ? (
                <div className="media-viewer__video-error" role="status">
                  <VideoErrorIcon />
                  <span>This video format can’t be played here.</span>
                </div>
              ) : null}

              <div
                className="media-viewer__video-controls"
                role="group"
                aria-label="Video controls"
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={togglePlayback}
                  disabled={videoError}
                  aria-label={paused ? 'Play video' : 'Pause video'}
                  title={paused ? 'Play' : 'Pause'}
                >
                  <IconMorph active={paused ? 0 : 1}>
                    <Play size={16} fill="currentColor" aria-hidden />
                    <Pause size={16} fill="currentColor" aria-hidden />
                  </IconMorph>
                </button>
                <input
                  className="media-viewer__scrubber"
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.01"
                  value={duration ? Math.min(currentTime, duration) : 0}
                  disabled={duration <= 0 || videoError}
                  onChange={(event) => {
                    const nextTime = Number(event.currentTarget.value)
                    if (video.current) video.current.currentTime = nextTime
                    setCurrentTime(nextTime)
                  }}
                  aria-label="Video progress"
                  style={mediaProgressStyle(progress)}
                />
                <output className="media-viewer__time" aria-label="Video time">
                  {formatTime(currentTime)} <span>/</span> {formatTime(duration)}
                </output>
                <button
                  type="button"
                  onClick={toggleMuted}
                  aria-label={muted ? 'Unmute video' : 'Mute video'}
                  title={muted ? 'Unmute' : 'Mute'}
                >
                  <IconMorph active={muted ? 1 : 0}>
                    <Volume2 size={16} aria-hidden />
                    <VolumeX size={16} aria-hidden />
                  </IconMorph>
                </button>
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  <IconMorph active={fullscreen ? 1 : 0}>
                    <Maximize2 size={16} aria-hidden />
                    <Minimize2 size={16} aria-hidden />
                  </IconMorph>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {props.mediaType === 'image' ? (
        <div className="media-viewer__zoom" aria-label="Image zoom controls">
          <button
            type="button"
            onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
            disabled={zoom === MIN_ZOOM}
            aria-label="Zoom out"
          >
            <Minus size={15} aria-hidden />
          </button>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
            disabled={zoom === MAX_ZOOM}
            aria-label="Zoom in"
          >
            <Plus size={15} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

function mediaProgressStyle(progress: number): CSSProperties & { '--media-progress': string } {
  return { '--media-progress': `${progress}%` }
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const totalSeconds = Math.floor(value)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

function VideoErrorIcon() {
  return (
    <span className="media-viewer__video-error-icon" aria-hidden>
      <VideoOff size={24} />
    </span>
  )
}
