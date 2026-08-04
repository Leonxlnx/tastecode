import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'streamdown/styles.css'
import { App } from './App.js'
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

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
