import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { dimFactor, type AppBackground } from '../app-background.js'
import {
  backgroundDisplayImage,
  indexedDbBackgroundImages,
  type BackgroundImageStore,
} from '../app-background-image.js'
import { effectPatternStyle, type EffectPatternStyle } from '../app-background-patterns.js'
import '../styles/app-background.css'

type LayerStyle = CSSProperties &
  EffectPatternStyle & { '--app-bg-image'?: string; '--app-bg-dim'?: string }

/**
 * How long the Blur slider has to rest before the display copy is rebuilt.
 * Each rebuild blurs and encodes the whole picture, so a drag rebuilds once
 * it pauses, not on every step.
 */
export const BLUR_SETTLE_MS = 220

/**
 * The window background itself: root attributes that turn the sidebar and
 * chat into panes (see app-background.css), and the layer behind them. Lazy,
 * so its stylesheet is fetched only once a background is chosen.
 */
export function AppBackgroundLayer(props: {
  background: AppBackground
  images?: BackgroundImageStore | undefined
}) {
  const { mode, effect, image, dim, blur } = props.background
  const images = props.images ?? indexedDbBackgroundImages

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset['appBg'] = mode
    if (mode === 'effect') root.dataset['appBgEffect'] = effect
    else delete root.dataset['appBgEffect']
    return () => {
      delete root.dataset['appBg']
      delete root.dataset['appBgEffect']
    }
  }, [mode, effect])

  const settledBlur = useSettled(blur, BLUR_SETTLE_MS)
  const imageUrl = useBackgroundImageUrl(mode === 'image' ? image : undefined, settledBlur, images)

  // Transparent paints nothing: the OS backdrop is the background.
  if (mode === 'transparent' || mode === 'none') return null
  const style: LayerStyle = {
    '--app-bg-dim': dimFactor(dim),
    ...(mode === 'effect' ? effectPatternStyle(effect) : {}),
  }
  if (imageUrl) style['--app-bg-image'] = `url("${imageUrl}")`
  return (
    <div
      className="app-bg"
      data-mode={mode}
      data-effect={mode === 'effect' ? effect : undefined}
      data-ready={imageUrl ? '' : undefined}
      style={style}
      aria-hidden
    />
  )
}

/** `value`, once it has stayed the same for `delay` ms; the first value at once. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(value, settled)) return
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, settled, delay])
  return settled
}

/**
 * A blob: URL for the stored image's display copy at `blur`. The previous
 * URL stays on screen until the next one is ready, so a new blur swaps in
 * without the picture fading out; each URL is revoked once it is replaced.
 */
function useBackgroundImageUrl(
  revision: string | undefined,
  blur: number,
  images: BackgroundImageStore,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!revision) {
      setUrl(undefined)
      return
    }
    let cancelled = false
    void images
      .load()
      .then((stored) => (stored ? backgroundDisplayImage(stored, images, blur) : undefined))
      .then((blob) => {
        if (cancelled || !blob) return
        setUrl(URL.createObjectURL(blob))
      })
      .catch(() => {
        // An unreadable image leaves the plain background; Settings can replace it.
      })
    return () => {
      cancelled = true
    }
  }, [revision, blur, images])
  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])
  return url
}
