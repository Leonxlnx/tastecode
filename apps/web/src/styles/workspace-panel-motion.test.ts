import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')
const component = readFileSync(
  new URL('../ui/workspace/WorkspacePanel.tsx', import.meta.url),
  'utf8',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
}

describe('workspace panel motion', () => {
  it('uses a short drawer curve and compositor transform', () => {
    expect(rule('.workspace-layout')).toContain(
      'transition: grid-template-columns var(--dur-slow) var(--ease-rail);',
    )
    expect(rule('.workspace-panel')).toContain('transform: translate3d(24px, 0, 0);')
    expect(rule('.workspace-panel')).toContain('transform var(--dur-slow) var(--ease-rail)')
    expect(rule('.workspace-panel.is-open')).toContain('transform: translate3d(0, 0, 0);')
    expect(rule('.workspace-panel__body')).toContain('contain: layout paint;')
    expect(rule('.workspace-panel')).not.toContain('var(--dur-rail)')
  })

  it('has transition cancellation and timeout completion guards', () => {
    expect(component).toContain('WORKSPACE_PANEL_CLOSE_FALLBACK_MS = 340')
    expect(component).toContain('onTransitionCancel={finishCloseTransition}')
    expect(component).toContain('globalThis.setTimeout(completeClose')
  })

  it('removes drawer motion when reduced motion is requested', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.workspace-layout,[\s\S]*?\.workspace-panel \{[\s\S]*?transition: none;/,
    )
  })
})
