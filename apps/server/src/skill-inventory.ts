import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Skill, SkillDiscoveryError, SkillScope } from '@harness/contracts'

export const LOCAL_SKILL_CAPABILITIES = {
  inventory: true,
  configure: false,
  install: false,
} as const

export function userSkillsDir(home = os.homedir()): string {
  return path.join(home, '.agents', 'skills')
}

export function projectSkillsDir(projectPath: string): string {
  return path.join(projectPath, '.agents', 'skills')
}

export async function listLocalSkills(
  projectPath: string,
  options: { userSkillsDir?: string } = {},
): Promise<{ skills: Skill[]; errors: SkillDiscoveryError[] }> {
  const roots: Array<{ dir: string; scope: SkillScope }> = [
    { dir: projectSkillsDir(projectPath), scope: 'project' },
    { dir: options.userSkillsDir ?? userSkillsDir(), scope: 'user' },
  ]
  const skills: Skill[] = []
  const errors: SkillDiscoveryError[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    const listed = await listSkillsIn(root.dir, root.scope)
    errors.push(...listed.errors)
    for (const skill of listed.skills) {
      const key = skillKey(skill)
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(skill)
    }
  }

  return { skills, errors }
}

export function mergeSkills(primary: Skill[], extra: Skill[]): Skill[] {
  const seen = new Set(primary.map(skillKey))
  const merged = [...primary]
  for (const skill of extra) {
    const key = skillKey(skill)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(skill)
  }
  return merged
}

async function listSkillsIn(
  root: string,
  scope: SkillScope,
): Promise<{ skills: Skill[]; errors: SkillDiscoveryError[] }> {
  const skills: Skill[] = []
  const errors: SkillDiscoveryError[] = []
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    if (isMissing(error)) return { skills, errors }
    errors.push({ path: root, message: message(error) })
    return { skills, errors }
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const dir = path.join(root, entry)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(dir)
    } catch (error) {
      if (isMissing(error)) continue
      errors.push({ path: dir, message: message(error) })
      continue
    }
    if (!info.isDirectory()) continue

    const skillFile = path.join(dir, 'SKILL.md')
    let markdown: string
    try {
      const file = await stat(skillFile)
      if (!file.isFile()) continue
      markdown = await readFile(skillFile, 'utf8')
    } catch (error) {
      if (isMissing(error)) continue
      errors.push({ path: skillFile, message: message(error) })
      continue
    }

    const frontmatter = parseSkillFrontmatter(markdown)
    const name = skillName(frontmatter.name, entry)
    skills.push({
      id: skillFile,
      name,
      description: frontmatter.description ?? '',
      source: { type: 'folder', path: dir },
      scope,
      enabled: true,
      dependencyErrors: [],
    })
  }

  return { skills, errors }
}

type SkillFrontmatter = {
  name?: string
  description?: string
}

function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return {}
  const fields: Record<string, string> = {}
  let current: string | undefined
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (field) {
      current = field[1]!
      fields[current] = unquote(field[2] ?? '')
      continue
    }
    if (current && /^\s+\S/.test(line)) {
      const next = line.trim()
      const previous = fields[current]
      fields[current] = previous ? `${previous} ${next}` : next
    }
  }
  const frontmatter: SkillFrontmatter = {}
  if (fields.name) frontmatter.name = fields.name
  if (fields.description) frontmatter.description = fields.description
  return frontmatter
}

function skillName(frontmatterName: string | undefined, folder: string): string {
  const candidate = frontmatterName?.trim() || folder
  return candidate.length > 0 ? candidate : folder
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const start = value[0]
    const end = value.at(-1)
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function skillKey(skill: Skill): string {
  const identity = skill.source.type === 'folder' ? skill.source.path : skill.id
  const resolved = path.resolve(identity)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Skill folder could not be read'
}
