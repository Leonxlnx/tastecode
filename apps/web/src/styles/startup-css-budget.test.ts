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

  it('keeps the context ring and its styles behind a lazy boundary', () => {
    const composer = readSource('../ui/Composer.tsx')
    const contextUsage = readSource('../ui/ContextUsage.tsx')
    const appCss = readSource('./app.css')

    expect(composer).toContain("import('./ContextUsage.js')")
    expect(composer).not.toMatch(/from ['"]\.\/ContextUsage\.js['"]/)
    expect(contextUsage).toContain("import '../styles/context-usage.css'")
    expect(appCss).not.toContain('.context-usage')
  })

  it('reuses prepared terminal and workspace modules without eager runtime imports', () => {
    const app = readSource('../App.tsx')
    const workspaceTerminal = readSource('../ui/workspace/WorkspaceTerminal.tsx')

    expect(app).not.toContain("from './ui/TerminalPane.js'")
    expect(workspaceTerminal).toContain("from '../TerminalPane.js'")

    expect(app).toContain("typeof import('./ui/workspace/WorkspacePanel.js')")
    expect(app).toMatch(
      /workspacePanelPromise \?\?= import\('\.\/ui\/workspace\/WorkspacePanel\.js'\)\.then/s,
    )
    expect(app).toContain('let resolvedWorkspacePanel: WorkspacePanelComponent')
    expect(app).toContain('resolvedWorkspacePanel = module.WorkspacePanel')
    expect(app).toContain('rightPanelType.current ??= resolvedWorkspacePanel ?? WorkspacePanel')
    expect(app).toContain('bottomPanelType.current ??= resolvedWorkspacePanel ?? WorkspacePanel')
    expect(app).toContain('<RightWorkspacePanel')
    expect(app).toContain('<BottomWorkspacePanel')
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

  it('keeps the sidebar confirmation behind its project actions', () => {
    const sidebar = readSource('../ui/Sidebar.tsx')
    const dialog = readSource('../ui/SidebarConfirmDialog.tsx')

    expect(sidebar).toContain("import('./SidebarConfirmDialog.js')")
    expect(sidebar).not.toMatch(/from ['"]\.\/SidebarConfirmDialog\.js['"]/)
    expect(dialog).toContain("import '../styles/sidebar-confirm.css'")
  })

  it('keeps the dialog frame and the switch behind the modules that draw them', () => {
    const appCss = readSource('./app.css')
    expect(appCss).not.toMatch(/^\.sheet(__[a-z]+)? \{/m)
    expect(appCss).not.toMatch(/\.switch(__thumb)? \{/)
    for (const eager of ['../main.tsx', '../App.tsx', '../ui/Sidebar.tsx', '../ui/Composer.tsx']) {
      expect(readSource(eager)).not.toMatch(/styles\/(sheet|switch)\.css/)
    }

    for (const path of [
      '../ui/CheckoutDiscardDialog.tsx',
      '../ui/FeedbackDialog.tsx',
      '../ui/RollbackDialog.tsx',
      '../ui/SidebarConfirmDialog.tsx',
      '../ui/Settings.tsx',
    ]) {
      expect(readSource(path)).toContain("import '../styles/sheet.css'")
    }
    // The build may load a dialog's own stylesheet first; its panel class must
    // still win over the shared frame.
    expect(readSource('./sheet.css')).toMatch(/^:where\(\.sheet__panel\) \{/m)
    for (const path of [
      '../ui/FeedbackDialog.tsx',
      '../ui/McpSettings.tsx',
      '../ui/ModelVisibilityControls.tsx',
      '../ui/ProviderTuning.tsx',
      '../ui/Settings.tsx',
      '../ui/SkillsSettings.tsx',
    ]) {
      expect(readSource(path)).toContain("import '../styles/switch.css'")
    }
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
