import type { CSSProperties } from 'react'
import type { Project } from './Sidebar.js'

export function projectName(project: Project): string {
  return project.name ?? project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path
}

const PROJECT_HUES = [212, 262, 330, 20, 45, 150, 185, 290, 95, 0, 240, 170]

type ProjectMarkPresentation = { monogram: string; style: CSSProperties }
const projectMarks = new Map<string, ProjectMarkPresentation>()

/**
 * Two-letter badge with a hue derived from the name, so a project reads the same everywhere.
 * The monogram and hue rules are adapted from T3 Code (MIT); see THIRD_PARTY_NOTICES.md.
 */
export function ProjectMark(props: { project: Project; className?: string }) {
  const name = projectName(props.project)
  let mark = projectMarks.get(name)
  if (!mark) {
    let hash = 0
    for (const glyph of name.normalize('NFKC').toLocaleLowerCase()) {
      hash = (hash * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_HUES.length
    }
    mark = {
      monogram: projectMonogram(name),
      style: { '--project-hue': PROJECT_HUES[hash] } as CSSProperties,
    }
    projectMarks.set(name, mark)
  }
  return (
    <span
      className={`project-mark${props.className ? ` ${props.className}` : ''}`}
      style={mark.style}
      aria-hidden
    >
      {mark.monogram}
    </span>
  )
}

function projectMonogram(name: string): string {
  const words =
    name
      .normalize('NFKC')
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  const firstWord = words[0]
  if (!firstWord) return 'PR'
  const glyphs = Array.from(firstWord)
  const first = glyphs[0] ?? 'P'
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? '')[0] : glyphs.at(-1)) ??
    first
  return Array.from(`${first}${second}`.toLocaleUpperCase()).slice(0, 2).join('')
}
