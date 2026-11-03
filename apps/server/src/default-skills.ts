import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderCommand, Skill } from '@harness/contracts'
import { parseSkillFrontmatter, skillName } from './skill-inventory.js'

/** Ids of the skills that ship with TasteCode; no provider owns them, so none can switch them. */
export const DEFAULT_SKILL_ID_PREFIX = 'tastecode:'

export type DefaultSkills = {
  /**
   * The bundle folder. It is a plain skills tree (`skills/<name>/SKILL.md`)
   * and a Claude Code plugin (`.claude-plugin/plugin.json`) at once.
   */
  root: string
  skills: Skill[]
  /**
   * The skills as slash commands, listed the way a runtime that loads the
   * bundle as a plugin lists them. None when skills.json names no plugin.
   */
  commands: ProviderCommand[]
  /** A few lines for shared instructions, or '' when no skill is installed. */
  catalog: string
}

type BundledEntry = { folder?: unknown; summary?: unknown }

const BUNDLE_NAME = /^[\w.-]+$/
/** The longest command name or alias the contracts accept. */
const MAX_COMMAND_NAME = 200

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
 * than pointing agents at files that are not there. It reads a few small
 * files once, synchronously, so a session start never waits a tick for it:
 * resume and Stop races depend on a session being created right away.
 */
export function loadDefaultSkills(root = defaultSkillsRoot()): DefaultSkills {
  let entries: BundledEntry[]
  let plugin: string | undefined
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'skills.json'), 'utf8')) as {
      skills?: unknown
      plugin?: { name?: unknown }
    }
    entries = Array.isArray(manifest.skills) ? (manifest.skills as BundledEntry[]) : []
    const name = manifest.plugin?.name
    plugin = typeof name === 'string' && BUNDLE_NAME.test(name) ? name : undefined
  } catch {
    return { root, skills: [], commands: [], catalog: '' }
  }
  const skills: Skill[] = []
  const commands: ProviderCommand[] = []
  const lines: string[] = []
  for (const entry of entries) {
    if (typeof entry.folder !== 'string' || !BUNDLE_NAME.test(entry.folder)) continue
    const dir = path.join(root, 'skills', entry.folder)
    let markdown: string
    try {
      markdown = readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const frontmatter = parseSkillFrontmatter(markdown)
    const name = skillName(frontmatter.name, entry.folder)
    skills.push({
      id: `${DEFAULT_SKILL_ID_PREFIX}${name}`,
      name,
      description: frontmatter.description ?? '',
      source: { type: 'folder', path: dir },
      scope: 'system',
      enabled: true,
      dependencyErrors: [],
    })
    const command = plugin ? pluginCommand(plugin, entry.folder, frontmatter) : undefined
    if (command) commands.push(command)
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
    const where = entry.folder === name ? '' : ` (folder ${entry.folder})`
    lines.push(`- ${name}${where}${summary ? `: ${summary}` : ''}`)
  }
  return {
    root,
    skills,
    commands,
    catalog: lines.length ? catalogText(path.join(root, 'skills'), lines) : '',
  }
}

/**
 * Claude Code 2.1.296 lists a plugin's skill as `<plugin>:<folder>` and gives
 * it its SKILL.md name, when that has no colon, as an alias that runs it too
 * (the acme-docs row of inventory-claude-2.1.296.json).
 */
function pluginCommand(
  plugin: string,
  folder: string,
  frontmatter: { name?: string; description?: string },
): ProviderCommand | undefined {
  const name = `${plugin}:${folder}`
  if (name.length > MAX_COMMAND_NAME) return undefined
  const alias = frontmatter.name?.trim()
  const aliased = alias && alias.length <= MAX_COMMAND_NAME && /^[^/\s:][^\s:]*$/.test(alias)
  return {
    name,
    description: frontmatter.description ?? '',
    ...(aliased ? { aliases: [alias] } : {}),
    kind: 'skill',
    source: 'plugin',
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
