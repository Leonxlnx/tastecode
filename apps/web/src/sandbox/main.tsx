import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App.js'
import { RendererErrorBoundary } from '../RendererErrorBoundary.js'
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
} from '../theme.js'
import { backdropColorScheme } from '../theme-colors.js'
import { DemoTransport } from './demo-transport.js'
import '../styles/tokens.css'
import '../styles/app.css'
import './sandbox.css'

/**
 * The design sandbox: the real App in a normal browser, answered by an
 * in-memory server with dummy data. No desktop shell, no local server, no
 * provider and no subscription is involved. Start it with `pnpm sandbox` in
 * apps/web and open http://127.0.0.1:5420/sandbox.html.
 *
 * `?chat=<id>` opens that chat once the sidebar shows it, for example
 * `?chat=demo-focus-ring`. The ids are in demo-data.ts.
 */

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

// The same appearance start-up as main.tsx, so the sandbox opens in the theme,
// font and accent the user picked in it last time.
const appearanceMode = resolveTheme(readThemePreference())
const backdrop = readBackdropPreference(appearanceMode)
applyTheme(backdropColorScheme(backdrop) ?? appearanceMode)
applyBackdropPreference(backdrop)
applyFontPreference(readFontPreference(appearanceMode))
applyAccentPreference(readAccentPreference(appearanceMode))
document.documentElement.dataset['shell'] = 'web'

const transport = new DemoTransport()

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App transport={transport} />
    </RendererErrorBoundary>
    <div className="sandbox-badge" role="note">
      Sandbox · dummy data
    </div>
  </StrictMode>,
)

const requestedChat = new URLSearchParams(window.location.search).get('chat')
if (requestedChat) openChatWhenListed(requestedChat)

/** Clicks the chat's sidebar row as soon as it renders, giving up after ten seconds. */
function openChatWhenListed(id: string): void {
  const selector = `[data-archive-session-id="${CSS.escape(id)}"] button.sess`
  const startedAt = Date.now()
  const attempt = () => {
    const row = document.querySelector<HTMLButtonElement>(selector)
    if (row) {
      row.click()
      return
    }
    if (Date.now() - startedAt < 10_000) window.setTimeout(attempt, 100)
    else console.warn(`[sandbox] chat ${id} did not appear in the sidebar`)
  }
  attempt()
}
