import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const css = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')
const component = readFileSync(
  new URL('../ui/workspace/WorkspacePanel.tsx', import.meta.url),
  'utf8',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
}

function appRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    appCss.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
  )
}

describe('workspace panel motion', () => {
  it('keeps the layout track snap-fast and the panel on the compositor', () => {
    expect(appRule('.workspace-layout')).not.toContain('transition: grid-template-columns')
    expect(appRule('.workspace-layout')).toContain('grid-template-rows: minmax(0, 1fr);')
    expect(css).not.toContain('.workspace-layout')
    expect(rule('.workspace-panel')).toContain('transform: translate3d(24px, 0, 0);')
    expect(rule('.workspace-panel')).toContain('transform var(--dur-slow) var(--ease-rail)')
    expect(rule('.workspace-panel.is-open')).toContain('transform: translate3d(0, 0, 0);')
    expect(rule('.workspace-panel__body')).toContain('contain: layout paint;')
    expect(rule('.workspace-panel')).not.toContain('var(--dur-rail)')
    expect(appRule('.stage')).toContain('min-height: 0;')
  })

  it('has transition cancellation and timeout completion guards', () => {
    expect(component).toContain('WORKSPACE_PANEL_CLOSE_FALLBACK_MS = 340')
    expect(component).toContain('onTransitionCancel={finishCloseTransition}')
    expect(component).toContain('globalThis.setTimeout(completeClose')
  })

  it('removes drawer motion when reduced motion is requested', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.workspace-layout,[\s\S]*?\.workspace-layout > \.stage \{[\s\S]*?transition: none;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.workspace-panel \{[\s\S]*?transition: none;/,
    )
  })
})
