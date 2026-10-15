// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

// happy-dom serves import.meta.url over http, so resolve from the run directory.
const rootCssPath = resolve(process.cwd(), 'apps/web/src/ui/workspace-panel.css')
const panelCss = readFileSync(
  existsSync(rootCssPath) ? rootCssPath : resolve(process.cwd(), 'src/ui/workspace-panel.css'),
  'utf8',
)

afterEach(() => {
  cleanup()
  document.head.querySelectorAll('style[data-test-panel-css]').forEach((style) => style.remove())
})

function containerNames(element: Element): string[] {
  const style = getComputedStyle(element)
  // happy-dom keeps the `container` shorthand unexpanded, so read either form.
  const names = style.containerName || (style.getPropertyValue('container').split('/')[0] ?? '')
  return names
    .trim()
    .split(/\s+/)
    .filter((name) => name && name !== 'none')
}

/**
 * The `@container` rules that can style `element` at some container size: the
 * query's named container has to be one of its ancestors. happy-dom parses
 * these rules but never evaluates them, so resolve the name the way a browser
 * does and leave the size out.
 */
function containerRulesFor(element: Element): string[] {
  const matched: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!rule.cssText.startsWith('@container')) continue
      const query = (rule as CSSConditionRule).conditionText
      const name = query.split(/\s+/)[0]!
      let container = element.parentElement
      while (container && !containerNames(container).includes(name)) {
        container = container.parentElement
      }
      if (!container) continue
      for (const inner of Array.from((rule as CSSConditionRule).cssRules)) {
        const selector = (inner as CSSStyleRule).selectorText
        if (selector && element.matches(selector)) matched.push(`${query} ${selector}`)
      }
    }
  }
  return matched
}

describe('WorkspacePanel layout by host', () => {
  it('stacks the launcher and file trees only in the full-height right panel', () => {
    const style = document.createElement('style')
    style.dataset['testPanelCss'] = ''
    style.textContent = panelCss
    document.head.append(style)
    const props = {
      open: true,
      expanded: false,
      width: 300,
      transport: new TestTransport(),
      theme: 'light' as const,
      sideChatParentStatus: 'idle' as const,
      sideChatStartOptions: { approval: 'ask' as const },
      nativeSurfacesVisible: true,
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onWidthChange: vi.fn(),
    }
    render(
      <>
        <WorkspacePanel {...props} placement="bottom" />
        <WorkspacePanel {...props} />
      </>,
    )
    const bottom = screen.getByRole('complementary', { name: 'Bottom workspace tools' })
    const right = screen.getByRole('complementary', { name: 'Workspace tools' })
    for (const host of [bottom, right]) {
      // Review, Files and Browser mount lazily against a live transport; their
      // layout containers are all these rules look at.
      host
        .querySelector('.workspace-panel__body')!
        .insertAdjacentHTML(
          'beforeend',
          '<div class="workspace-review__split"></div><div class="workspace-files__split"></div><div class="workspace-browser__toolbar"></div>',
        )
    }
    const stacking = (host: HTMLElement) =>
      ['.workspace-selector__list', '.workspace-review__split', '.workspace-files__split'].flatMap(
        (selector) => containerRulesFor(host.querySelector(selector)!),
      )

    // The bottom panel opens about 260px tall: a stacked launcher or a tree
    // row under the diff would leave the diff and the last tiles no room.
    expect(stacking(bottom)).toEqual([])
    expect(stacking(right)).toEqual([
      'workspace-panel-right (max-width: 380px) .workspace-selector__list',
      'workspace-panel-right (max-width: 500px) .workspace-review__split',
      'workspace-panel-right (max-width: 500px) .workspace-files__split',
    ])
    // Width-only fixes still reach both hosts.
    for (const host of [bottom, right]) {
      expect(containerRulesFor(host.querySelector('.workspace-browser__toolbar')!)).toEqual([
        'workspace-panel (max-width: 420px) .workspace-browser__toolbar',
      ])
    }
  })
})
