import { lazy, memo, Suspense, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  readAppBackground,
  requestWindowMaterialSupport,
  subscribeAppBackground,
  windowMaterialSupport,
  type AppBackground as AppBackgroundChoice,
} from '../app-background.js'
import { setDesktopWindowMaterial, type WindowMaterial } from '../bridge.js'

const AppBackgroundLayer = lazy(() =>
  import('./AppBackgroundLayer.js').then((module) => ({ default: module.AppBackgroundLayer })),
)

/**
 * Settings › Appearance › Window background, applied to the window. With
 * None (the default) it renders nothing, loads nothing and asks the desktop
 * shell nothing. Memoised without props, so the shell re-rendering on a
 * streamed delta never reaches it.
 */
export const AppBackground = memo(function AppBackground() {
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
  const transparent = background.mode === 'transparent'
  useEffect(() => {
    if (transparent) void requestWindowMaterialSupport()
  }, [transparent])
  useWindowMaterial(background, support === 'material')

  if (background.mode === 'none') return null
  // Where the OS cannot draw behind the window, Transparent leaves the look unchanged.
  if (transparent && (support === undefined || support === 'none')) return null
  return (
    <Suspense fallback={null}>
      <AppBackgroundLayer background={background} />
    </Suspense>
  )
})

/**
 * Transparent picks the Windows 11 backdrop; every other choice puts back
 * Acrylic, which the sidebar glass was designed on. Nothing is sent until
 * Transparent has been chosen once, so None stays as it was.
 */
function useWindowMaterial(background: AppBackgroundChoice, supported: boolean): void {
  const sent = useRef<WindowMaterial | undefined>(undefined)
  const { mode, material } = background
  useEffect(() => {
    if (!supported) return
    if (mode !== 'transparent' && sent.current === undefined) return
    const effective: WindowMaterial = mode === 'transparent' ? material : 'acrylic'
    if (sent.current === effective) return
    sent.current = effective
    void setDesktopWindowMaterial(effective).catch(() => {
      if (sent.current === effective) sent.current = undefined
    })
  }, [mode, material, supported])
}
