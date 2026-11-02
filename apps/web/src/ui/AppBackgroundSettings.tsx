import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import {
  nextImageRevision,
  readAppBackground,
  requestWindowMaterialSupport,
  subscribeAppBackground,
  windowMaterialSupport,
  writeAppBackground,
  type AppBackgroundEffect,
  type AppBackgroundMode,
} from '../app-background.js'
import {
  BACKGROUND_IMAGE_TYPES,
  BackgroundImageError,
  indexedDbBackgroundImages,
  prepareBackgroundImage,
  type BackgroundImageStore,
} from '../app-background-image.js'
import { isDesktop, type WindowMaterial } from '../bridge.js'
import { SettingsRow, SettingsSection } from './settings/SettingsLayout.js'
import { SettingsSegmented } from './settings/SettingsSegmented.js'

const MODE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'image', label: 'Image' },
  { value: 'effect', label: 'Effect' },
] as const satisfies ReadonlyArray<{ value: AppBackgroundMode; label: string }>

const EFFECT_OPTIONS = [
  { value: 'glow', label: 'Glow' },
  { value: 'grain', label: 'Grain' },
  { value: 'aurora', label: 'Aurora' },
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
          images={props.images ?? indexedDbBackgroundImages}
          prepare={props.prepare ?? prepareBackgroundImage}
        />
      ) : null}
      {background.mode === 'effect' ? (
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
      ) : null}
    </SettingsSection>
  )
}

function BackgroundImageRow(props: {
  hasImage: boolean
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
      await props.images.save(await props.prepare(file))
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
