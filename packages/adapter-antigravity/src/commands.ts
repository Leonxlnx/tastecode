import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProviderCommand } from '@harness/contracts'

/**
 * The slash commands an `agy -p` turn runs, from agy's changelog in agy.exe
 * 1.4.7 (near offsets 70107200 and 70113844):
 *
 * - 1.1.9: print mode expands slash commands and skills, so
 *   `-p "/my-skill review this diff"` applies the skill.
 * - 1.1.11 and 1.1.12: print mode answers /usage, /quota, /credits, /model,
 *   /effort, /skills, /permissions, /hooks, /help, /changelog and /config
 *   itself, "without starting an agent turn, spending quota or leaving a
 *   conversation behind", and refuses every other interactive-only command.
 *
 * TasteCode opens its own screen for /usage, /model, /skills, /permissions and
 * /config typed alone; they are listed so the words still reach agy with an
 * argument.
 */
export const AGY_ANSWERED_COMMANDS: ProviderCommand[] = [
  { name: 'quota', description: 'Show the quota left per model group', source: 'builtin' },
  { name: 'credits', description: 'Show your AI credits', source: 'builtin' },
  { name: 'effort', description: 'Show the reasoning effort agy uses', source: 'builtin' },
  { name: 'hooks', description: 'List the hooks agy runs', source: 'builtin' },
  { name: 'help', description: 'List the commands agy answers here', source: 'builtin' },
  { name: 'changelog', description: "Show agy's release notes", source: 'builtin' },
  { name: 'usage', description: 'Show plan limits and when they reset', source: 'builtin' },
  { name: 'model', description: 'Show the model agy uses', source: 'builtin' },
  { name: 'skills', description: 'List the skills agy loads', source: 'builtin' },
  { name: 'permissions', description: 'Show the permission mode and rules', source: 'builtin' },
  { name: 'config', description: "Show agy's settings", source: 'builtin' },
]

const ANSWERED = new Set(AGY_ANSWERED_COMMANDS.map((command) => command.name))
const COMMAND = /^\/([^/\s]+)(?:\s|$)/
const SKILL_NAME = /^[^/\s]\S*$/

/** The command a prompt starts with, such as `quota` for "/quota"; undefined for other text. */
export function agyCommandName(text: string): string | undefined {
  return COMMAND.exec(text.trimStart())?.[1]
}

/** Whether agy answers this prompt itself, with no agent turn. */
export function isAgyAnsweredCommand(text: string): boolean {
  const name = agyCommandName(text)
  return name !== undefined && ANSWERED.has(name.toLowerCase())
}

export type AntigravityCommandOptions = { home?: string }

/**
 * agy's answered commands, then the skills `/name` runs: one folder each under
 * `.agents/skills` or `_agents/skills` in the project and `~/.gemini/config/skills`
 * (agy.exe's bundled migrate-workflows skill names these). Skills built into
 * agy or added by plugins are not on disk and are not listed.
 */
export async function listAntigravityCommands(
  projectPath: string,
  options: AntigravityCommandOptions = {},
): Promise<ProviderCommand[]> {
  const home = options.home ?? homedir()
  const skills = new Map<string, ProviderCommand>()
  for (const root of [
    path.join(projectPath, '.agents', 'skills'),
    path.join(projectPath, '_agents', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
  ]) {
    for (const skill of await readSkills(root)) {
      if (!skills.has(skill.name)) skills.set(skill.name, skill)
    }
  }
  return [...AGY_ANSWERED_COMMANDS.map((command) => ({ ...command })), ...skills.values()]
}

async function readSkills(root: string): Promise<ProviderCommand[]> {
  let folders: string[]
  try {
    folders = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
  const skills: ProviderCommand[] = []
  for (const folder of folders) {
    let markdown: string
    try {
      markdown = await readFile(path.join(root, folder, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const fields = frontmatter(markdown)
    // agy 1.1.12: this flag hides a skill from the / menu and /name.
    if (fields.disableSlashCommand === 'true') continue
    const name = fields.name || folder
    if (!SKILL_NAME.test(name) || ANSWERED.has(name)) continue
    skills.push({ name, description: fields.description ?? '', kind: 'skill', source: 'custom' })
  }
  return skills
}

type SkillFields = { name?: string; description?: string; disableSlashCommand?: string }

/** The three top-level keys read here, from a leading `---` block. */
function frontmatter(markdown: string): SkillFields {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1]
  const fields: SkillFields = {}
  for (const line of block?.split(/\r?\n/) ?? []) {
    const field = /^(name|description|disable-slash-command)\s*:\s*(.*?)\s*$/.exec(line)
    if (!field) continue
    const value = field[2]!.replace(/^(["'])(.*)\1$/, '$2')
    if (/^[|>]/.test(value)) continue
    if (field[1] === 'name') fields.name = value
    else if (field[1] === 'description') fields.description = value
    else fields.disableSlashCommand = value.toLowerCase()
  }
  return fields
}
