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
    // At rest the panel is not a layer of its own, so its text keeps subpixel
    // antialiasing; translate3d(0, 0, 0) kept it promoted for good.
    expect(rule('.workspace-panel.is-open')).toContain('transform: none;')
    expect(rule('.workspace-panel__body')).toContain('contain: layout paint;')
    expect(rule('.workspace-panel')).not.toContain('var(--dur-rail)')
    expect(appRule('.stage')).toContain('min-height: 0;')
  })

  it('lets a hidden panel leave over the chat', () => {
    // The grid column goes at once; the panel keeps its width while it fades.
    const leaving = rule('.workspace-panel[data-leaving]')
    expect(leaving).toContain('position: absolute;')
    expect(leaving).toContain('right: 0;')
    expect(leaving).toContain('width: var(--workspace-panel-leave-w);')
    expect(component).toContain("panel.setAttribute('data-leaving', '')")
    expect(component).toContain('const PANEL_LEAVE_MS = 260')
  })

  it('gives the first open, which mounts the panel already open, its entrance', () => {
    expect(css).toMatch(
      /@starting-style \{\s*\.workspace-panel\.is-open:not\(\.workspace-panel--bottom\) \{\s*opacity: 0;\s*transform: translate3d\(24px, 0, 0\);/,
    )
  })

  it('keeps the closed panel mounted but inert so tab state survives', () => {
    expect(component).toContain('aria-hidden={!props.open}')
    expect(component).toContain('inert={props.open ? undefined : true}')
    expect(component).not.toContain('onTransitionCancel')
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
