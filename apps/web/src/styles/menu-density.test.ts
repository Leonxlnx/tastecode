import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const workspaceCss = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')
const pullRequestsCss = readFileSync(
  new URL('../ui/pull-requests/pull-requests.css', import.meta.url),
  'utf8',
)

describe('menu density', () => {
  it('keeps shared action menus compact without a taller sidebar override', () => {
    expect(appCss).toMatch(/\.menu \{[^}]*gap: 1px;[^}]*padding: 4px;/s)
    expect(appCss).toMatch(/\.menu__item \{[^}]*padding: 3px 7px;[^}]*line-height: 1\.35;/s)
    expect(appCss).toMatch(/\.menu__name \{[^}]*font-size: var\(--t-sm\);/s)
    expect(appCss).toMatch(/\.menu__desc \{[^}]*line-height: 1\.25;/s)
    expect(appCss).not.toMatch(/\.menu--sidebar \.menu__item \{/)
  })

  it('uses the same compact scale for selectors and the standalone workspace menu', () => {
    expect(appCss).toMatch(
      /\.app-select__option \{[^}]*min-height: 25px;[^}]*padding: 2px 6px;[^}]*font-size: var\(--t-sm\);[^}]*line-height: 1\.35;/s,
    )
    expect(workspaceCss).toMatch(
      /\.workspace-panel__add-menu button \{[^}]*min-height: 27px;[^}]*gap: 6px;[^}]*font-size: var\(--t-sm\);/s,
    )
  })

  it('does not let pull request menu shells restore the old padding', () => {
    expect(pullRequestsCss).toMatch(/\.pr-filter-menu \{[^}]*padding: 4px;/s)
    expect(pullRequestsCss).toMatch(/\.pr-metadata-menu \{[^}]*padding: 4px;/s)
  })
})
