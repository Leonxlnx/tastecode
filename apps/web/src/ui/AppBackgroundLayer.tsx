import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import type { AppBackground } from '../app-background.js'
import {
  backgroundDisplayImage,
  indexedDbBackgroundImages,
  type BackgroundImageStore,
} from '../app-background-image.js'
import '../styles/app-background.css'

type LayerStyle = CSSProperties & { '--app-bg-image'?: string }

/**
 * The window background itself: root attributes that turn the sidebar and
 * chat into panes (see app-background.css), and the layer behind them. Lazy,
 * so its stylesheet is fetched only once a background is chosen.
 */
export function AppBackgroundLayer(props: {
  background: AppBackground
  images?: BackgroundImageStore | undefined
}) {
  const { mode, effect, image } = props.background
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

  const imageUrl = useBackgroundImageUrl(mode === 'image' ? image : undefined, images)

  // Transparent paints nothing: the OS backdrop is the background.
  if (mode === 'transparent' || mode === 'none') return null
  const style: LayerStyle | undefined = imageUrl
    ? { '--app-bg-image': `url("${imageUrl}")` }
    : undefined
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

/** A blob: URL for the stored image's display copy, revoked when it changes. */
function useBackgroundImageUrl(
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
      .then((stored) => (stored ? backgroundDisplayImage(stored, images) : undefined))
      .then((blob) => {
        if (cancelled || !blob) return
        created = URL.createObjectURL(blob)
        setUrl(created)
      })
      .catch(() => {
        // An unreadable image leaves the plain background; Settings can replace it.
      })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
      setUrl(undefined)
    }
  }, [revision, images])
  return url
}
