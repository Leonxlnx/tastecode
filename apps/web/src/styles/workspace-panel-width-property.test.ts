import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// apps/web/src, not the built dist next to it.
const source = fileURLToPath(new URL('..', import.meta.url))
const stylesheets = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return stylesheets(file)
    return entry.name.endsWith('.css') ? [file] : []
  })
const app = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('right panel width during a resize drag', () => {
  it('is a non-inherited property, so a drag frame restyles the layout grid only', () => {
    // panel-resize.ts writes --workspace-panel-w on .workspace-layout every frame.
    // Inherited, every write restyled the chat and Browser subtree under it.
    expect(app).toMatch(/@property --workspace-panel-w \{[^}]*inherits: false;/)
  })

  it('is read only by the element it is written on', () => {
    const readers = stylesheets(source).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/([^{}]*)\{[^{}]*var\(--workspace-panel-w\)/g)].map(
        (match) => match[1]!.trim(),
      ),
    )
    // A descendant reading it would see the initial value, not the drag width.
    expect(readers).toEqual(['.workspace-layout.is-panel-open'])
  })
})
