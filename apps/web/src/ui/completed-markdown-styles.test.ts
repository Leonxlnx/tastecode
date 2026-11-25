import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const importsOf = (source: string) =>
  [...source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!)

describe('the rich Markdown renderer stylesheets', () => {
  it('come from a module of their own, so they can load before the renderer', () => {
    const renderer = importsOf(read('./CompletedMarkdown.tsx'))
    // A stylesheet the renderer imports itself arrives only with the renderer,
    // during a chat's first open; KaTeX's font faces then lay the whole
    // transcript out again before its first paint.
    expect(renderer.filter((path) => path.endsWith('.css'))).toEqual([])
    expect(renderer).toContain('./completed-markdown-styles.js')

    // Stylesheets only: preloading them must not load or run renderer code.
    const styles = importsOf(read('./completed-markdown-styles.ts'))
    expect(styles).toEqual(['streamdown/styles.css', 'katex/dist/katex.min.css'])
    expect(
      read('./completed-markdown-styles.ts')
        .replace(/^\s*(?:\/\/.*|import\s+['"][^'"]+['"])\s*$/gm, '')
        .trim(),
    ).toBe('')
  })

  it('are loaded by the app in an idle moment once the sidebar is up', () => {
    const app = read('../App.tsx')
    expect(app).toMatch(/import\(\s*['"]\.\/ui\/completed-markdown-styles\.js['"]\s*\)/)
    expect(app).toMatch(/preloadWhenIdle\(loadCompletedMarkdownStyles\)/)
    // A static import would put them, and their font faces, in the startup chunk.
    expect(importsOf(app)).not.toContain('./ui/completed-markdown-styles.js')
  })
})
