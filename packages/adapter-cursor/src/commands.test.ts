import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listCursorCommands } from './commands.js'

const roots: string[] = []

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cursor-commands-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Cursor commands', () => {
  it('lists custom commands from the folders cursor-agent reads, later folders winning', async () => {
    const project = tree({
      '.claude/commands/release.md': '# Draft release notes\n\nRead the merged PRs.',
      '.cursor/commands/review.md': 'Review the diff\nCheck tests too.',
      '.cursor/commands/has space.md': 'Not invocable',
      '.cursor/commands/notes.txt': 'Not a command',
      '.cursor/commands/empty.md': '',
    })
    const home = tree({ '.cursor/commands/review.md': '## Review like the team does' })

    await expect(listCursorCommands(project, { home })).resolves.toEqual([
      { name: 'release', description: 'Draft release notes', source: 'custom' },
      { name: 'review', description: 'Review like the team does', source: 'custom' },
    ])
  })

  it('lists skills under their folder names with the description Cursor shows', async () => {
    const project = tree({
      '.agents/skills/pdf/SKILL.md': '---\nname: PDF tools\ndescription: "Read PDFs"\n---\n# x',
      '.cursor/skills/plain/SKILL.md': '---\nname: plain\n---\n\n# Plain skill\n\nBody',
      '.cursor/skills/hidden/SKILL.md': '---\nuser-invocable: false\n---\nHidden',
      '.codex/skills/skill-creator/SKILL.md': '---\ndescription: Codex system skill\n---\n',
      '.claude/skills/a/lint/SKILL.md': '---\ndescription: A lint\n---\n',
      '.claude/skills/b/lint/SKILL.md': '---\ndescription: B lint\n---\n',
    })
    const home = tree({
      '.cursor/skills-cursor/canvas/SKILL.md': '---\ndescription: Draw on a canvas\n---\n',
    })

    await expect(listCursorCommands(project, { home })).resolves.toEqual([
      { name: 'canvas', description: 'Draw on a canvas', kind: 'skill', source: 'builtin' },
      { name: 'a-lint', description: 'A lint', kind: 'skill', source: 'custom' },
      { name: 'b-lint', description: 'B lint', kind: 'skill', source: 'custom' },
      { name: 'pdf', description: 'Read PDFs', kind: 'skill', source: 'custom' },
      { name: 'plain', description: 'Plain skill', kind: 'skill', source: 'custom' },
    ])
  })

  it('lists nothing for a project and home without these folders', async () => {
    const empty = tree({})
    await expect(listCursorCommands(empty, { home: empty })).resolves.toEqual([])
  })
})
