import { useEffect, useState, type ComponentProps } from 'react'
import type { MediaViewer } from './MediaViewer.js'

type Viewer = typeof MediaViewer
let loadedViewer: Viewer | undefined
let viewerPromise: Promise<Viewer> | undefined

function loadMediaViewer(): Promise<Viewer> {
  viewerPromise ??= import('./MediaViewer.js')
    .then((module) => {
      loadedViewer = module.MediaViewer
      return loadedViewer
    })
    .catch((error: unknown) => {
      viewerPromise = undefined
      throw error
    })
  return viewerPromise
}

export function preloadMediaViewer(): void {
  void loadMediaViewer().catch(() => undefined)
}

export function LazyMediaViewer(props: ComponentProps<Viewer>) {
  const [viewer, setViewer] = useState(() => loadedViewer)
  const [loadError, setLoadError] = useState<{ error: unknown }>()
  useEffect(() => {
    if (viewer) return
    let cancelled = false
    void loadMediaViewer()
      .then((component) => {
        if (!cancelled) setViewer(() => component)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError({ error })
      })
    return () => {
      cancelled = true
    }
  }, [viewer])

  if (loadError) throw loadError.error
  // Updating state on import completion avoids React's Suspense reveal delay.
  const LoadedViewer = viewer ?? loadedViewer
  return LoadedViewer ? <LoadedViewer {...props} /> : null
}
