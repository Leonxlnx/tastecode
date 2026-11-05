import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import {
  dimFactor,
  MAX_APP_BACKGROUND_BLUR,
  MAX_APP_BACKGROUND_DIM,
  nextImageRevision,
  readAppBackground,
  requestWindowMaterialSupport,
  subscribeAppBackground,
  windowMaterialSupport,
  writeAppBackground,
  type AppBackground,
  type AppBackgroundEffect,
  type AppBackgroundMode,
} from '../app-background.js'
import {
  BACKGROUND_IMAGE_TYPES,
  BackgroundImageError,
  DISPLAY_IMAGE_EDGE,
  indexedDbBackgroundImages,
  prepareBackgroundImage,
  type BackgroundImageStore,
} from '../app-background-image.js'
import { effectPattern, type EffectPatternStyle } from '../app-background-patterns.js'
import { isDesktop, type WindowMaterial } from '../bridge.js'
import { AppBackgroundMotion } from './AppBackgroundMotion.js'
import { SettingsRow, SettingsSection } from './settings/SettingsLayout.js'
import { SettingsSegmented } from './settings/SettingsSegmented.js'
import '../styles/app-background-settings.css'

const MODE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'image', label: 'Image' },
  { value: 'effect', label: 'Effect' },
] as const satisfies ReadonlyArray<{ value: AppBackgroundMode; label: string }>

const EFFECT_OPTIONS = [
  { value: 'dither', label: 'Dither' },
  { value: 'halftone', label: 'Halftone' },
] as const satisfies ReadonlyArray<{ value: AppBackgroundEffect; label: string }>

const MATERIAL_OPTIONS = [
  { value: 'acrylic', label: 'Acrylic', title: 'Blurs the windows behind this one' },
  { value: 'mica', label: 'Mica', title: 'Tints the desktop wallpaper and stays still' },
] as const satisfies ReadonlyArray<{ value: WindowMaterial; label: string; title: string }>

const IMAGE_ACCEPT = BACKGROUND_IMAGE_TYPES.join(',')

function isMode(value: string): value is AppBackgroundMode {
  return MODE_OPTIONS.some((option) => option.value === value)
}

function isEffect(value: string): value is AppBackgroundEffect {
  return EFFECT_OPTIONS.some((option) => option.value === value)
}

function isMaterial(value: string): value is WindowMaterial {
  return value === 'acrylic' || value === 'mica'
}

/**
 * Window background: one choice for light and dark alike, applied by
 * AppBackground. The rows under the choice belong to it.
 */
export function AppBackgroundSettings(props: {
  images?: BackgroundImageStore | undefined
  prepare?: typeof prepareBackgroundImage | undefined
}) {
  const background = useSyncExternalStore(
    subscribeAppBackground,
    readAppBackground,
    readAppBackground,
  )
  const support = useSyncExternalStore(
    subscribeAppBackground,
    windowMaterialSupport,
    windowMaterialSupport,
  )
  useEffect(() => {
    void requestWindowMaterialSupport()
  }, [])

  const transparentNote =
    background.mode !== 'transparent' || support === undefined || support !== 'none'
      ? undefined
      : isDesktop
        ? 'This system cannot draw behind the window (that needs Windows 11 22H2 or macOS), so the window keeps its current look.'
        : 'Only the desktop app can show what is behind the window, so this page keeps its current look.'

  return (
    <SettingsSection title="Window background">
      <SettingsRow searchId="window-style" name="Style" note={transparentNote}>
        <SettingsSegmented
          ariaLabel="Window background"
          value={background.mode}
          options={MODE_OPTIONS}
          onChange={(mode) => {
            if (isMode(mode)) writeAppBackground({ mode })
          }}
        />
      </SettingsRow>
      {background.mode === 'transparent' && support === 'material' ? (
        <SettingsRow searchId="window-material" name="Material">
          <SettingsSegmented
            ariaLabel="Window material"
            value={background.material}
            options={MATERIAL_OPTIONS}
            onChange={(material) => {
              if (isMaterial(material)) writeAppBackground({ material })
            }}
          />
        </SettingsRow>
      ) : null}
      {background.mode === 'image' ? (
        <BackgroundImageRow
          hasImage={background.image !== undefined}
          blur={background.blur}
          images={props.images ?? indexedDbBackgroundImages}
          prepare={props.prepare ?? prepareBackgroundImage}
        />
      ) : null}
      {background.mode === 'image' && background.image !== undefined ? (
        <>
          <BackgroundPreview
            background={background}
            images={props.images ?? indexedDbBackgroundImages}
          />
          <LevelRow
            searchId="window-dim"
            name="Dim"
            value={background.dim}
            max={MAX_APP_BACKGROUND_DIM}
            onChange={(dim) => writeAppBackground({ dim })}
          />
          <LevelRow
            searchId="window-blur"
            name="Blur"
            value={background.blur}
            max={MAX_APP_BACKGROUND_BLUR}
            onChange={(blur) => writeAppBackground({ blur })}
          />
        </>
      ) : null}
      {background.mode === 'effect' ? (
        <>
          <SettingsRow searchId="window-effect" name="Effect">
            <SettingsSegmented
              ariaLabel="Background effect"
              value={background.effect}
              options={EFFECT_OPTIONS}
              onChange={(effect) => {
                if (isEffect(effect)) writeAppBackground({ effect })
              }}
            />
          </SettingsRow>
          <BackgroundPreview
            background={background}
            images={props.images ?? indexedDbBackgroundImages}
          />
          <LevelRow
            searchId="window-dim"
            name="Dim"
            value={background.dim}
            max={MAX_APP_BACKGROUND_DIM}
            onChange={(dim) => writeAppBackground({ dim })}
          />
        </>
      ) : null}
    </SettingsSection>
  )
}

/**
 * A slider that applies while it moves: every step is written at once, and
 * the window background follows (a new blur once the drag pauses).
 */
function LevelRow(props: {
  name: string
  searchId: string
  value: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <SettingsRow searchId={props.searchId} name={props.name}>
      <input
        className="app-bg-settings__range"
        type="range"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        aria-label={props.name}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
    </SettingsRow>
  )
}

/**
 * The window the preview stands for, in CSS pixels; the preview draws it at
 * whatever width Settings gives it (half of it at most), and the effects,
 * the blur and the miniature panes all shrink by the same factor
 * (app-background-settings.css builds its --u from the same number).
 */
const PREVIEW_WINDOW_WIDTH = 1120

type PreviewStyle = CSSProperties &
  EffectPatternStyle & {
    '--app-bg-image'?: string
    '--app-bg-dim'?: string
    '--app-bg-preview-blur'?: string
  }

/** `px` CSS pixels of the full-size window, at the preview's width. */
function previewLength(px: number): string {
  return `calc(${px} * 100cqw / ${PREVIEW_WINDOW_WIDTH})`
}

/**
 * The whole window in miniature over the chosen background: the title bar,
 * the sidebar, a chat and the prompt bar, painted in the theme's own colours
 * and panes exactly as the window paints them, so the picture or effect, Dim,
 * Blur and the colours show together. A picture is drawn from the stored
 * original, its blur scaled from the display copy to this width, so the
 * sliders show on every step; the CSS blur covers this preview, never the
 * window. An effect moves here as it does in the window, on the same clock.
 */
function BackgroundPreview(props: { background: AppBackground; images: BackgroundImageStore }) {
  const { mode, effect, image, dim, blur } = props.background
  const url = useOriginalImageUrl(mode === 'image' ? image : undefined, props.images)
  const [moving, setMoving] = useState(false)
  const style: PreviewStyle = { '--app-bg-dim': dimFactor(dim) }
  if (mode === 'image') {
    style['--app-bg-preview-blur'] = `calc(${blur} * 100cqw / ${DISPLAY_IMAGE_EDGE})`
    if (url) style['--app-bg-image'] = `url("${url}")`
  } else if (mode === 'effect') {
    const pattern = effectPattern(effect)
    style['--app-bg-pattern'] = pattern.image
    style['--app-bg-pattern-size'] =
      `${previewLength(pattern.width)} ${previewLength(pattern.height)}`
  }
  return (
    <div
      className="app-bg-preview"
      style={style}
      role="img"
      aria-label="Preview of the window background"
    >
      <div
        className="app-bg"
        data-mode={mode}
        data-effect={mode === 'effect' ? effect : undefined}
        data-motion={mode === 'effect' && moving ? '' : undefined}
        data-ready={url ? '' : undefined}
      >
        {mode === 'effect' ? (
          <AppBackgroundMotion
            effect={effect}
            windowWidth={PREVIEW_WINDOW_WIDTH}
            onDrawing={setMoving}
          />
        ) : null}
      </div>
      <PreviewWindow />
    </div>
  )
}

type BarStyle = CSSProperties & { '--w': string }

/** A line of text in the miniature, `width` of its column. */
function bar(width: string): BarStyle {
  return { '--w': width }
}

/** The panes of the miniature window; nothing in it is text or can be focused. */
function PreviewWindow() {
  return (
    <div className="app-bg-preview__window" aria-hidden>
      <span className="app-bg-preview__titlebar" />
      <span className="app-bg-preview__rail">
        <i data-new style={bar('46%')} />
        <i data-label style={bar('24%')} />
        <i style={bar('64%')} />
        <i data-active style={bar('52%')} />
        <i style={bar('72%')} />
        <i style={bar('44%')} />
        <i style={bar('58%')} />
        <i style={bar('38%')} />
      </span>
      <span className="app-bg-preview__notch" />
      <span className="app-bg-preview__stage">
        <i className="app-bg-preview__title" />
        <span className="app-bg-preview__chat">
          <i data-you style={bar('62%')} />
          <i style={bar('96%')} />
          <i style={bar('90%')} />
          <i style={bar('58%')} />
          <span className="app-bg-preview__code">
            <i style={bar('34%')} />
            <i data-accent style={bar('52%')} />
            <i style={bar('28%')} />
          </span>
          <i data-file style={bar('84%')} />
          <i style={bar('46%')} />
        </span>
        <span className="app-bg-preview__prompt">
          <i style={bar('34%')} />
          <i data-chip style={bar('11%')} />
          <b />
        </span>
      </span>
    </div>
  )
}

/** A blob: URL for the stored original, revoked when the image changes. */
function useOriginalImageUrl(
  revision: string | undefined,
  images: BackgroundImageStore,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!revision) return
    let cancelled = false
    let created: string | undefined
    void images
      .load()
      .then((stored) => {
        if (cancelled || !stored) return
        created = URL.createObjectURL(stored.original)
        setUrl(created)
      })
      .catch(() => {
        // No preview; the window background reports its own failure the same way.
      })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
      setUrl(undefined)
    }
  }, [revision, images])
  return url
}

function BackgroundImageRow(props: {
  hasImage: boolean
  blur: number
  images: BackgroundImageStore
  prepare: typeof prepareBackgroundImage
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    // The same file picked twice in a row must fire change again.
    event.currentTarget.value = ''
    if (!file) return
    setBusy(true)
    setProblem(undefined)
    try {
      await props.images.save(await props.prepare(file, props.blur))
      writeAppBackground({ image: nextImageRevision() })
    } catch (error) {
      if (mounted.current) {
        setProblem(
          error instanceof BackgroundImageError ? error.message : 'The image could not be used.',
        )
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const remove = async () => {
    setProblem(undefined)
    try {
      await props.images.clear()
    } catch {
      // A leftover record is replaced by the next image and never shown.
    }
    writeAppBackground({ image: undefined })
  }

  return (
    <SettingsRow
      searchId="window-image"
      name="Image"
      tone={problem ? 'error' : props.hasImage ? undefined : 'muted'}
      note={
        problem ??
        (props.hasImage
          ? undefined
          : 'Kept inside the app, resized and blurred, and dimmed behind the sidebar and chat.')
      }
    >
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => void choose(event)}
      />
      {props.hasImage ? (
        <button
          className="set-button set-button--quiet"
          type="button"
          disabled={busy}
          onClick={() => void remove()}
        >
          Remove
        </button>
      ) : null}
      <button
        className="set-button"
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? 'Preparing…' : props.hasImage ? 'Change image…' : 'Choose image…'}
      </button>
    </SettingsRow>
  )
}
