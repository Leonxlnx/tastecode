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
 * `?chat=demo-focus-ring`. The ids are in demo-data.ts. `?sidebar=classic`
 * opens the classic project tree instead of the inbox.
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

// The sandbox opens on the inbox rail, where the sample threads show every
// state; `?sidebar=classic` opens the project tree instead.
const transport = new DemoTransport({
  sidebarMode:
    new URLSearchParams(window.location.search).get('sidebar') === 'classic' ? 'classic' : 'inbox',
})

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App transport={transport} />
    </RendererErrorBoundary>
    <div className="sandbox-badge" role="note">
      Sandbox · sample data
    </div>
  </StrictMode>,
)

const requestedChat = new URLSearchParams(window.location.search).get('chat')
if (requestedChat) openChatWhenListed(requestedChat)

/**
 * Clicks the chat's sidebar row once it renders. Start-up can still move to a
 * new chat after the list first appears, so it clicks again until the row has
 * stayed active for a second, and gives up after ten seconds.
 */
function openChatWhenListed(id: string): void {
  const escaped = CSS.escape(id)
  const selector = `[data-archive-session-id="${escaped}"], [data-thread-id="${escaped}"]`
  const startedAt = Date.now()
  let clickedAt = 0
  const attempt = () => {
    const row = document.querySelector(selector)
    const active =
      row?.classList.contains('is-active') === true ||
      row?.classList.contains('is-selected') === true
    if (active && Date.now() - clickedAt > 1_000) return
    if (row && !active && Date.now() - clickedAt > 400) {
      row
        .querySelector<HTMLButtonElement>('button.sess, .inbox-card__main, .inbox-shelf__main')
        ?.click()
      clickedAt = Date.now()
    }
    if (Date.now() - startedAt < 10_000) window.setTimeout(attempt, 100)
    else console.warn(`[sandbox] chat ${id} did not open from the sidebar`)
  }
  attempt()
}
