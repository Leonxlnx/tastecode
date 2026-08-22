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

    expect(selector).toContain("import('./ModelSelectorPanel.js')")
    expect(selector).toContain("import '../styles/model-selector.css'")
    expect(selector).not.toContain('model-selector-menu.css')
    expect(panel).toContain("import '../styles/model-selector-menu.css'")
    expect(triggerCss.byteLength).toBeLessThanOrEqual(MODEL_SELECTOR_TRIGGER_CSS_BUDGET_BYTES)
  })

  it('keeps optional thread overlays behind their user actions', () => {
    const thread = readSource('../ui/Thread.tsx')

    expect(thread).toContain("import('./MediaViewer.js')")
    expect(thread).toContain("import('./ThreadSearch.js')")
    expect(thread).not.toContain("from './MediaViewer.js'")
    expect(thread).not.toContain("from './ThreadSearch.js'")
  })
})
