import { StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import {
  isDesktop,
  isStartupBenchmark,
  reportRendererError,
  reportStartupMilestone,
} from './bridge.js'
import {
  applyAccentPreference,
  applyBackdropPreference,
  applyFontPreference,
  applyTheme,
  readAccentPreference,
  readBackdropPreference,
  readFontPreference,
  readThemePreference,
  resolveTheme,
} from './theme.js'
import { backdropColorScheme } from './theme-colors.js'
import './styles/tokens.css'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

const appearanceMode = resolveTheme(readThemePreference())
const backdrop = readBackdropPreference(appearanceMode)
applyTheme(backdropColorScheme(backdrop) ?? appearanceMode)
applyBackdropPreference(backdrop)
applyFontPreference(readFontPreference(appearanceMode))
applyAccentPreference(readAccentPreference(appearanceMode))

// The stylesheet needs to know whether an OS blur material exists behind the
// window (Electron acrylic/vibrancy) — that is what the sidebar glass shows.
document.documentElement.dataset['shell'] = isDesktop ? 'desktop' : 'web'

window.addEventListener('error', (event) => reportRendererError(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => reportRendererError(event.reason))

if (isStartupBenchmark) reportStartupMilestone('module-loaded')

function StartupProbe() {
  useLayoutEffect(() => {
    reportStartupMilestone('react-commit')
    const frame = window.requestAnimationFrame(() => reportStartupMilestone('first-frame'))
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return null
}

createRoot(root).render(
  <StrictMode>
    <App />
    {isStartupBenchmark ? <StartupProbe /> : null}
  </StrictMode>,
)
