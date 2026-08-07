import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'streamdown/styles.css'
import { App } from './App.js'
import { isDesktop } from './bridge.js'
import {
  applyAccentPreference,
  applyFontPreference,
  applyTheme,
  readAccentPreference,
  readFontPreference,
  readThemePreference,
  resolveTheme,
} from './theme.js'
import './styles/tokens.css'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

applyTheme(resolveTheme(readThemePreference()))
applyFontPreference(readFontPreference())
applyAccentPreference(readAccentPreference())

// The stylesheet needs to know whether an OS blur material exists behind the
// window (Electron acrylic/vibrancy) — that is what the sidebar glass shows.
document.documentElement.dataset['shell'] = isDesktop ? 'desktop' : 'web'

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
