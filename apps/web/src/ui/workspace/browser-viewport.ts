export type BrowserViewportId = 'fluid' | 'desktop' | 'tablet' | 'mobile'

export type BrowserViewport = {
  id: BrowserViewportId
  label: string
  width?: number | undefined
  height?: number | undefined
  deviceScaleFactor?: number | undefined
  mobile?: boolean | undefined
}

export const BROWSER_VIEWPORTS: readonly BrowserViewport[] = [
  { id: 'fluid', label: 'Fit available space' },
  {
    id: 'desktop',
    label: 'Desktop · 1280 × 800',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  },
  {
    id: 'tablet',
    label: 'Tablet · 768 × 1024',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
  },
  {
    id: 'mobile',
    label: 'Mobile · 390 × 844',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  },
]

export type FittedBrowserViewport = {
  width: number
  height: number
  viewport?: {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
  }
}

/** Fit a real viewport into the canvas without stretching or upscaling it. */
export function fitBrowserViewport(
  availableWidth: number,
  availableHeight: number,
  viewport: BrowserViewport,
): FittedBrowserViewport {
  const width = positivePixels(availableWidth)
  const height = positivePixels(availableHeight)
  if (!viewport.width || !viewport.height) return { width, height }

  const scale = Math.min(1, width / viewport.width, height / viewport.height)
  return {
    width: Math.max(1, Math.round(viewport.width * scale)),
    height: Math.max(1, Math.round(viewport.height * scale)),
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? false,
    },
  }
}

function positivePixels(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}
