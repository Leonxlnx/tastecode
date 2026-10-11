import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8')
const css = readFileSync(new URL('./workspace-panel.css', import.meta.url), 'utf8')
const skeletonCss = readFileSync(new URL('../styles/surface-skeleton.css', import.meta.url), 'utf8')

/** Every `@container <query>` block in a stylesheet, joined, so a test can read its rules. */
function containerBlocks(source: string, query: string): string {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(`@container ${query} {`, from)
    if (start < 0) return blocks.join('\n')
    let depth = 0
    let end = source.indexOf('{', start)
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}' && (depth -= 1) === 0) break
    }
    blocks.push(source.slice(start, end + 1))
    from = end + 1
  }
}

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

  it('lays the tools out against the panel width and stacks the launcher when it is narrow', () => {
    const panel = css.match(/\.workspace-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const skeleton =
      skeletonCss.match(/\.workspace-panel-skeleton \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const narrow = containerBlocks(css, 'workspace-panel (max-width: 380px)')
    const narrowSkeleton = containerBlocks(skeletonCss, 'workspace-panel (max-width: 380px)')

    expect(panel).toContain('container: workspace-panel / inline-size')
    expect(skeleton).toContain('container: workspace-panel / inline-size')
    expect(narrow).toMatch(
      /\.workspace-selector__list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    )
    expect(narrow).toMatch(
      /\.workspace-selector__list > button:last-child:nth-child\(odd\) \{[^}]*width: auto;[^}]*grid-column: auto;[^}]*justify-self: stretch;/,
    )
    expect(narrowSkeleton).toMatch(
      /\.workspace-panel-skeleton__tools \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    )
    expect(narrowSkeleton).toMatch(
      /\.workspace-panel-skeleton__tool:last-child:nth-child\(odd\) \{[^}]*width: auto;[^}]*grid-column: auto;[^}]*justify-self: stretch;/,
    )
  })

  it('packs short Files and Review trees at the top instead of stretching their rows', () => {
    for (const list of ['workspace-files__tree-list', 'workspace-review__tree-list']) {
      const body =
        css.match(new RegExp(`\\.${list} \\{(?<body>[\\s\\S]*?)\\n\\}`))?.groups?.body ?? ''
      expect(body).toContain('display: grid')
      expect(body).toContain('align-content: start')
    }
  })
})
