import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Skill } from '@harness/contracts'
import { listSkillsIn } from './skill-inventory.js'

/** Ids of the skills that ship with TasteCode; no provider owns them, so none can switch them. */
export const DEFAULT_SKILL_ID_PREFIX = 'tastecode:'

export type DefaultSkills = {
  /**
   * The bundle folder. It is a plain skills tree (`skills/<name>/SKILL.md`)
   * and a Claude Code plugin (`.claude-plugin/plugin.json`) at once.
   */
  root: string
  skills: Skill[]
  /** A few lines for shared instructions, or '' when no skill is installed. */
  catalog: string
}

type BundledEntry = { folder?: unknown; summary?: unknown }

/**
 * A packaged app names its resources copy; an unpackaged run reads the folder
 * `pnpm --filter @harness/default-skills sync` fills. Both `src` and `dist`
 * sit one level under `apps/server`.
 */
export function defaultSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['HARNESS_DEFAULT_SKILLS_DIR']?.trim()
  if (configured) return path.resolve(configured)
  return fileURLToPath(new URL('../../../packages/default-skills/bundle', import.meta.url))
}

/**
 * Reads the bundled skills that are actually on disk. A checkout that never
 * fetched them, or a damaged install, lists none and adds no catalog rather
 * than pointing agents at files that are not there.
 */
export async function loadDefaultSkills(root = defaultSkillsRoot()): Promise<DefaultSkills> {
  let entries: BundledEntry[]
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'skills.json'), 'utf8')) as {
      skills?: unknown
    }
    entries = Array.isArray(manifest.skills) ? (manifest.skills as BundledEntry[]) : []
  } catch {
    return { root, skills: [], catalog: '' }
  }
  const listed = await listSkillsIn(path.join(root, 'skills'), 'system')
  const byFolder = new Map(
    listed.skills.flatMap((skill) =>
      skill.source.type === 'folder' ? [[path.basename(skill.source.path), skill] as const] : [],
    ),
  )
  const skills: Skill[] = []
  const lines: string[] = []
  for (const entry of entries) {
    if (typeof entry.folder !== 'string') continue
    const skill = byFolder.get(entry.folder)
    if (!skill || skill.source.type !== 'folder') continue
    skills.push({ ...skill, id: `${DEFAULT_SKILL_ID_PREFIX}${skill.name}` })
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
    const folder = path.basename(skill.source.path)
    const where = folder === skill.name ? '' : ` (folder ${folder})`
    lines.push(`- ${skill.name}${where}${summary ? `: ${summary}` : ''}`)
  }
  return {
    root,
    skills,
    catalog: lines.length ? catalogText(path.join(root, 'skills'), lines) : '',
  }
}

/**
 * Names, one line each and where to read more: every session pays for these
 * tokens, so the skill text itself is read only when a task needs it. Design
 * runs get their own direction and say not to use outside design skills.
 */
function catalogText(directory: string, lines: string[]): string {
  return [
    `Skills included with TasteCode, one folder each in ${directory}. Read a skill's SKILL.md only when the task calls for it, never in a Design mode run:`,
    ...lines,
  ].join('\n')
}

export function isDefaultSkillId(id: string): boolean {
  return id.startsWith(DEFAULT_SKILL_ID_PREFIX)
}
