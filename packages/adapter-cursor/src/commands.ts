import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProviderCommand } from '@harness/contracts'

/**
 * The custom commands and skills a `cursor-agent --print` turn expands.
 *
 * Read from cursor-agent 2026.07.23-e383d2b (`5627.index.js`, `index.js`,
 * `5305.index.js`). A headless turn loads the same commands and skills as the
 * TUI and attaches every `/name` in the prompt that names one: commands as
 * `cursorCommands` with the words after the name on that line as arguments,
 * skills as `selectedSkills`. Cursor's own built-ins (/model, /resume, /mcp …)
 * are TUI screens and do nothing in a headless turn, so none is listed.
 *
 * Not listed: team and global commands, which cursor-agent fetches from
 * Cursor's dashboard with the user's sign-in, and plugin skills.
 */

/** Cursor resolves `/name` only for names made of these (`findCommandReferences`). */
const NAME = /^[A-Za-z0-9_-]+$/
/** `findSkillMarkdownFiles` stops below this depth. */
const MAX_DEPTH = 10
/** Bundled Codex skills that cursor-agent never offers from a `.codex/skills` folder. */
const CODEX_SYSTEM_SKILLS = new Set([
  'imagegen',
  'openai-docs',
  'opneai-docs',
  'plugin-creator',
  'skill-creator',
  'skill-installer',
])
const SKIPPED_FOLDERS = new Set(['node_modules', '.git'])

export type CursorCommandOptions = { home?: string }

export async function listCursorCommands(
  projectPath: string,
  options: CursorCommandOptions = {},
): Promise<ProviderCommand[]> {
  const home = options.home ?? homedir()
  // Cursor fills one map in this order, so a later folder's command of the
  // same name replaces an earlier one.
  const commands = new Map<string, ProviderCommand>()
  for (const folder of [
    path.join(projectPath, '.claude', 'commands'),
    path.join(projectPath, '.cursor', 'commands'),
    path.join(home, '.claude', 'commands'),
    path.join(home, '.cursor', 'commands'),
  ]) {
    for (const command of await readCommandFolder(folder)) commands.set(command.name, command)
  }
  const skills = new Map<string, ProviderCommand>()
  const roots: [string, 'builtin' | 'custom'][] = [
    [path.join(home, '.cursor', 'skills-cursor'), 'builtin'],
    ...skillFolders(projectPath).map((folder) => [folder, 'custom'] as [string, 'custom']),
    ...skillFolders(home).map((folder) => [folder, 'custom'] as [string, 'custom']),
  ]
  for (const [root, source] of roots) {
    for (const skill of await readSkillRoot(root, source)) skills.set(skill.name, skill)
  }
  return [...commands.values(), ...skills.values()]
}

function skillFolders(base: string): string[] {
  return ['.claude', '.codex', '.agents', '.cursor'].map((folder) =>
    path.join(base, folder, 'skills'),
  )
}

async function entries(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
}

async function text(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Each `*.md` directly in the folder; the first line, less a `#` heading mark, describes it. */
async function readCommandFolder(folder: string): Promise<ProviderCommand[]> {
  const commands: ProviderCommand[] = []
  for (const entry of await entries(folder)) {
    if (entry.isDirectory() || !entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -'.md'.length)
    if (!NAME.test(name)) continue
    const markdown = await text(path.join(folder, entry.name))
    if (!markdown) continue
    const first = markdown.split('\n')[0]!.trim()
    const title = /^#+\s*(.+)$/.exec(first)?.[1]?.trim() ?? first
    commands.push({ name, description: title || name, source: 'custom' })
  }
  return commands
}

async function skillFiles(folder: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  const found: string[] = []
  for (const entry of await entries(folder)) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) found.push(...(await skillFiles(full, depth + 1)))
    } else if (entry.name === 'SKILL.md') found.push(full)
  }
  return found.sort((a, b) => a.localeCompare(b))
}

/**
 * A skill runs under its folder's name, not its frontmatter `name`; folders
 * of the same name in one root take their path from the root instead.
 */
async function readSkillRoot(
  root: string,
  source: 'builtin' | 'custom',
): Promise<ProviderCommand[]> {
  const files = (await skillFiles(root)).filter((file) => !isCodexSystemSkill(file))
  const folderCounts = new Map<string, number>()
  for (const file of files) {
    const folder = path.basename(path.dirname(file))
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1)
  }
  const used = new Set<string>()
  const skills: ProviderCommand[] = []
  for (const file of files) {
    const folder = path.basename(path.dirname(file))
    const base =
      (folderCounts.get(folder) ?? 0) > 1
        ? path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean).join('-')
        : folder
    let name = base
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`
    used.add(name)
    const markdown = await text(file)
    if (markdown === undefined || !NAME.test(name)) continue
    const fields = frontmatter(markdown)
    if (fields.userInvocable?.toLowerCase() === 'false') continue
    skills.push({
      name,
      description: fields.description || firstLine(markdown),
      kind: 'skill',
      source,
    })
  }
  return skills
}

function isCodexSystemSkill(file: string): boolean {
  const parts = file.split(/[\\/]/).filter(Boolean)
  const codex = parts.lastIndexOf('.codex')
  return (
    codex !== -1 && parts[codex + 1] === 'skills' && CODEX_SYSTEM_SKILLS.has(parts.at(-2) ?? '')
  )
}

/** Top-level `key: value` lines of a leading `---` block; nested and folded values are skipped. */
function frontmatter(markdown: string): SkillFields {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1]
  const fields: SkillFields = {}
  for (const line of block?.split(/\r?\n/) ?? []) {
    const field = /^(description|user-invocable)\s*:\s*(.*?)\s*$/.exec(line)
    if (!field) continue
    const value = field[2]!.replace(/^(["'])(.*)\1$/, '$2')
    if (/^[|>]/.test(value)) continue
    if (field[1] === 'description') fields.description = value
    else fields.userInvocable = value
  }
  return fields
}

type SkillFields = { description?: string; userInvocable?: string }

/** Cursor's fallback description: the first heading or text line after the frontmatter. */
function firstLine(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      const heading = line.replace(/^#+\s*/, '').trim()
      if (heading) return heading
    } else if (line.trim() && !line.startsWith('---')) return line.trim()
  }
  return ''
}
