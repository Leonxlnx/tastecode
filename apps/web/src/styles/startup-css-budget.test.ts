import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const STARTUP_CSS_BUDGET_BYTES = 80_000
const MODEL_SELECTOR_TRIGGER_CSS_BUDGET_BYTES = 2_500

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('startup CSS budget', () => {
  it('keeps the eagerly parsed stylesheet below its performance budget', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url))

    expect(css.byteLength).toBeLessThanOrEqual(STARTUP_CSS_BUDGET_BYTES)
  })

  it('keeps thread and design styles out of the startup entry point', () => {
    const main = readSource('../main.tsx')
    const markdown = readSource('../ui/Markdown.tsx')
    const completedMarkdown = readSource('../ui/CompletedMarkdown.tsx')
    const designBeam = readSource('../ui/DesignBeam.tsx')

    expect(main).not.toContain('streamdown/styles.css')
    expect(main).not.toContain('design-beam.css')
    expect(markdown).toContain("import('./CompletedMarkdown.js')")
    expect(markdown).not.toContain('streamdown/styles.css')
    expect(markdown).not.toContain("from 'streamdown'")
    expect(completedMarkdown).toContain("import 'streamdown/styles.css'")
    expect(completedMarkdown).toContain("from 'streamdown'")
    expect(designBeam).toContain("import('../styles/design-beam.css')")
  })

  it('keeps the model selector menu behind the lazy panel boundary', () => {
    const selector = readSource('../ui/ModelSelector.tsx')
    const panel = readSource('../ui/ModelSelectorPanel.tsx')
    const triggerCss = readFileSync(new URL('./model-selector.css', import.meta.url))

    expect(selector).toContain("typeof import('./ModelSelectorPanel.js')")
    expect(selector).toMatch(
      /modelSelectorPanelPromise \?\?= import\('\.\/ModelSelectorPanel\.js'\)\.then/s,
    )
    expect(selector).toContain('let resolvedModelSelectorPanel: ModelSelectorPanelComponent')
    expect(selector).toContain('resolvedModelSelectorPanel = module.ModelSelectorPanel')
    expect(selector).toContain('const ResolvedModelSelectorPanel = resolvedModelSelectorPanel')
    expect(selector).toContain('<ResolvedModelSelectorPanel {...props} />')
    expect(selector).not.toMatch(/from ['"]\.\/ModelSelectorPanel\.js['"]/)
    expect(selector).toContain("import '../styles/model-selector.css'")
    expect(selector).not.toContain('model-selector-menu.css')
    expect(panel).toContain("import '../styles/model-selector-menu.css'")
    expect(triggerCss.byteLength).toBeLessThanOrEqual(MODEL_SELECTOR_TRIGGER_CSS_BUDGET_BYTES)
  })

  it('reuses prepared terminal and workspace modules without eager runtime imports', () => {
    const app = readSource('../App.tsx')

    expect(app).toContain("typeof import('./ui/TerminalPane.js')")
    expect(app).toMatch(/terminalPanePromise \?\?= import\('\.\/ui\/TerminalPane\.js'\)\.then/s)
    expect(app).toContain('let resolvedTerminalPane: TerminalPaneComponent')
    expect(app).toContain('resolvedTerminalPane = module.TerminalPane')
    expect(app).toContain('const RenderedTerminalPane = resolvedTerminalPane ?? TerminalPane')
    expect(app).toContain('<RenderedTerminalPane')
    expect(app).not.toContain("from './ui/TerminalPane.js'")

    expect(app).toContain("typeof import('./ui/workspace/WorkspacePanel.js')")
    expect(app).toMatch(
      /workspacePanelPromise \?\?= import\('\.\/ui\/workspace\/WorkspacePanel\.js'\)\.then/s,
    )
    expect(app).toContain('let resolvedWorkspacePanel: WorkspacePanelComponent')
    expect(app).toContain('resolvedWorkspacePanel = module.WorkspacePanel')
    expect(app).toContain('const RenderedWorkspacePanel = resolvedWorkspacePanel ?? WorkspacePanel')
    expect(app).toContain('<RenderedWorkspacePanel')
    expect(app).not.toMatch(
      /import \{[^}]*WorkspacePanel[^}]*\} from ['"]\.\/ui\/workspace\/WorkspacePanel\.js['"]/s,
    )
  })

  it('keeps the inactive inbox sidebar out of classic startup', () => {
    const sidebar = readSource('../ui/Sidebar.tsx')
    const inbox = readSource('../ui/InboxSidebar.tsx')

    expect(sidebar).toContain("import('./InboxSidebar.js')")
    expect(sidebar).not.toContain('import { InboxSidebar')
    expect(inbox).toContain("import '../styles/inbox-sidebar.css'")
  })

  it('warms account limits at startup without adding them to the main bundle', () => {
    const sidebar = readSource('../ui/Sidebar.tsx')
    const limits = readSource('../ui/AccountLimits.tsx')

    expect(sidebar).toMatch(/accountLimitsPromise \?\?= import\('\.\/AccountLimits\.js'\)/)
    expect(sidebar).toContain('resolvedAccountLimits = module.AccountLimits')
    expect(sidebar).toContain('resolvedAccountLimits ?? AccountLimits')
    expect(sidebar).toContain('void loadAccountLimits()')
    expect(sidebar).not.toContain('import { AccountLimits')
    expect(limits).toContain("import '../styles/account-limits.css'")
  })

  it('keeps optional thread overlays behind their user actions', () => {
    const thread = readSource('../ui/Thread.tsx')

    const mediaViewer = readSource('../ui/LazyMediaViewer.tsx')
    expect(thread).toContain("from './LazyMediaViewer.js'")
    expect(mediaViewer).toContain("import('./MediaViewer.js')")
    expect(thread).toContain("import('./ThreadSearch.js')")
    expect(thread).not.toContain("from './MediaViewer.js'")
    expect(thread).not.toContain("from './ThreadSearch.js'")
  })
})
