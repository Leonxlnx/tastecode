import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8')
const css = readFileSync(new URL('./workspace-panel.css', import.meta.url), 'utf8')

describe('workspace panel layout', () => {
  it('keeps the panel free of chrome and the launcher compact and balanced', () => {
    const panel = css.match(/\.workspace-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const layout = appCss.match(/\.workspace-layout \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const openLayout =
      appCss.match(/\.workspace-layout\.is-panel-open \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const launcher =
      css.match(/\.workspace-selector__list \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const launcherButton =
      css.match(/\.workspace-selector__list > button \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const lastLauncherButton =
      css.match(
        /\.workspace-selector__list > button:last-child:nth-child\(odd\) \{(?<body>[\s\S]*?)\n\}/,
      )?.groups?.body ?? ''

    expect(panel).toContain('border-top: 1px solid var(--line)')
    expect(panel).toContain('border-left: 1px solid var(--line)')
    expect(layout).toContain('display: grid')
    expect(layout).toContain('grid-template-rows: minmax(0, 1fr)')
    expect(openLayout).toContain(
      'grid-template-columns: minmax(360px, 1fr) min(var(--workspace-panel-w), calc(100% - 360px))',
    )
    expect(css).not.toContain('.workspace-layout')
    expect(css).not.toContain('.workspace-panel__chrome')
    expect(panel).toContain('grid-template-rows: auto minmax(0, 1fr)')
    expect(launcher).toContain('width: min(100%, 420px)')
    expect(launcher).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(launcherButton).toContain('grid-template-columns: 20px minmax(0, 1fr)')
    expect(launcherButton).toContain('min-height: 52px')
    expect(launcherButton).toContain('font-size: var(--t-sm)')
    expect(launcherButton).toContain('font-weight: 500')
    expect(lastLauncherButton).toContain('grid-column: 1 / -1')
    expect(lastLauncherButton).toContain('justify-self: center')
  })
})
