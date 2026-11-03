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
import { effectPatternStyle, type EffectPatternStyle } from '../app-background-patterns.js'
import { isDesktop, type WindowMaterial } from '../bridge.js'
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
  { value: 'dots', label: 'Dot grid' },
  { value: 'grain', label: 'Grain' },
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
      <SettingsRow name="Style" note={transparentNote}>
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
        <SettingsRow name="Material">
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
          <SettingsRow name="Preview">
            <BackgroundImagePreview
              background={background}
              images={props.images ?? indexedDbBackgroundImages}
            />
          </SettingsRow>
          <LevelRow
            name="Dim"
            value={background.dim}
            max={MAX_APP_BACKGROUND_DIM}
            onChange={(dim) => writeAppBackground({ dim })}
          />
          <LevelRow
            name="Blur"
            value={background.blur}
            max={MAX_APP_BACKGROUND_BLUR}
            onChange={(blur) => writeAppBackground({ blur })}
          />
        </>
      ) : null}
      {background.mode === 'effect' ? (
        <>
          <SettingsRow name="Effect">
            <SettingsSegmented
              ariaLabel="Background effect"
              value={background.effect}
              options={EFFECT_OPTIONS}
              onChange={(effect) => {
                if (isEffect(effect)) writeAppBackground({ effect })
              }}
            />
          </SettingsRow>
          <SettingsRow name="Preview">
            <BackgroundEffectPreview background={background} />
          </SettingsRow>
          <LevelRow
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
  value: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <SettingsRow name={props.name}>
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

/** Width of the preview, in CSS pixels; the blur is scaled down to it. */
const PREVIEW_WIDTH = 176

type PreviewStyle = CSSProperties & {
  '--app-bg-image'?: string
  '--app-bg-dim'?: string
  '--app-bg-preview-blur'?: string
}

/**
 * The picture as the window will show it, drawn small from the stored
 * original: the blur scaled from the display copy to this width and the same
 * dim over it. Both follow the sliders on every step; the CSS blur here
 * covers a thumbnail, never the window.
 */
function BackgroundImagePreview(props: {
  background: AppBackground
  images: BackgroundImageStore
}) {
  const { image, dim, blur } = props.background
  const url = useOriginalImageUrl(image, props.images)
  const style: PreviewStyle = {
    '--app-bg-dim': dimFactor(dim),
    '--app-bg-preview-blur': `${((blur * PREVIEW_WIDTH) / DISPLAY_IMAGE_EDGE).toFixed(2)}px`,
  }
  if (url) style['--app-bg-image'] = `url("${url}")`
  return (
    <div
      className="app-bg app-bg--preview"
      data-mode="image"
      data-ready={url ? '' : undefined}
      style={style}
      role="img"
      aria-label="Preview of the window background"
    />
  )
}

/**
 * The effect as the window shows it, at its real size: the top-left corner
 * of the window, where the patterns are densest.
 */
function BackgroundEffectPreview(props: { background: AppBackground }) {
  const { effect, dim } = props.background
  const style: CSSProperties & EffectPatternStyle & { '--app-bg-dim'?: string } = {
    '--app-bg-dim': dimFactor(dim),
    ...effectPatternStyle(effect),
  }
  return (
    <div
      className="app-bg app-bg--preview"
      data-mode="effect"
      data-effect={effect}
      style={style}
      role="img"
      aria-label="Preview of the window background"
    />
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
