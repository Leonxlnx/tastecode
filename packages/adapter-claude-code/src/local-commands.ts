import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ProviderCommand } from '@harness/contracts'

/**
 * The skills and custom commands Claude Code reads from files, listed without
 * starting it. A project's full list (built-ins, MCP prompts) needs a running
 * agent, which takes 10-15 s on a cold start; until that answer lands these
 * are what the slash menu can offer at once. The agent's answer replaces them.
 *
 * Read from the folders Claude Code loads: `skills/<name>/SKILL.md` and
 * `commands/*.md` in the config folder (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`) and in the project's `.claude`, then the skills and commands of
 * the plugins `settings.json` turns on, named `plugin:name`.
 */
export type ClaudeLocalCommandOptions = {
  environment?: NodeJS.ProcessEnv
  home?: string
}

/** What Claude Code accepts after the slash (`commandName` in inventory.ts). */
const NAME = /^[^/\s:][^/\s]*$/
const MAX_DESCRIPTION = 400

export async function listClaudeLocalCommands(
  projectPath: string,
  options: ClaudeLocalCommandOptions = {},
): Promise<ProviderCommand[]> {
  const environment = options.environment ?? process.env
  const config =
    environment.CLAUDE_CONFIG_DIR?.trim() || path.join(options.home ?? os.homedir(), '.claude')
  const project = path.join(projectPath, '.claude')
  const found: ProviderCommand[][] = await Promise.all([
    readSkills(path.join(project, 'skills')),
    readCommands(path.join(project, 'commands')),
    readSkills(path.join(config, 'skills')),
    readCommands(path.join(config, 'commands')),
    readPlugins(config),
  ])
  // A project's own skill or command wins over the user's one of the same name.
  const commands = new Map<string, ProviderCommand>()
  for (const command of found.flat())
    if (!commands.has(command.name)) commands.set(command.name, command)
  return [...commands.values()]
}

async function readSkills(folder: string, prefix = ''): Promise<ProviderCommand[]> {
  const skills = await Promise.all(
    (await entries(folder)).map(async (entry) => {
      if (!entry.isDirectory()) return undefined
      const markdown = await text(path.join(folder, entry.name, 'SKILL.md'))
      if (markdown === undefined) return undefined
      const fields = frontmatter(markdown)
      if (fields.userInvocable?.toLowerCase() === 'false') return undefined
      const name = `${prefix}${fields.name || entry.name}`
      return NAME.test(`${fields.name || entry.name}`)
        ? command(name, fields, markdown, prefix ? 'plugin' : 'custom')
        : undefined
    }),
  )
  return skills.filter((skill) => skill !== undefined)
}

/** Each `*.md` directly in the folder runs as `/<file name>`. */
async function readCommands(folder: string, prefix = ''): Promise<ProviderCommand[]> {
  const commands = await Promise.all(
    (await entries(folder)).map(async (entry) => {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) return undefined
      const base = entry.name.slice(0, -'.md'.length)
      if (!NAME.test(base)) return undefined
      const markdown = await text(path.join(folder, entry.name))
      if (markdown === undefined) return undefined
      return command(
        `${prefix}${base}`,
        frontmatter(markdown),
        markdown,
        prefix ? 'plugin' : 'custom',
      )
    }),
  )
  return commands.filter((entry) => entry !== undefined)
}

/** Installed plugins that `settings.json` turns on; one that is off adds nothing. */
async function readPlugins(config: string): Promise<ProviderCommand[]> {
  const installed = json(await text(path.join(config, 'plugins', 'installed_plugins.json')))
  const plugins = record(installed?.plugins)
  if (!plugins) return []
  const enabled = record(json(await text(path.join(config, 'settings.json')))?.enabledPlugins)
  if (!enabled) return []
  const lists = await Promise.all(
    Object.entries(plugins).map(async ([key, installs]) => {
      if (enabled[key] !== true || !Array.isArray(installs)) return []
      const name = key.split('@')[0]
      const installPath = record(installs[0])?.installPath
      if (!name || !NAME.test(name) || typeof installPath !== 'string') return []
      const prefix = `${name}:`
      const [skills, commands] = await Promise.all([
        readSkills(path.join(installPath, 'skills'), prefix),
        readCommands(path.join(installPath, 'commands'), prefix),
      ])
      return [...skills, ...commands]
    }),
  )
  return lists.flat()
}

/**
 * A row shaped as the probe reports it, which marks no row as a skill (Claude
 * names its skills only once a prompt runs), so a row does not change its
 * group, icon or Enter behaviour when the probe's answer replaces it.
 */
function command(
  name: string,
  fields: SkillFields,
  markdown: string,
  source: 'custom' | 'plugin',
): ProviderCommand {
  const description = (fields.description || firstLine(markdown)).slice(0, MAX_DESCRIPTION)
  const hint = fields.argumentHint?.trim()
  return {
    name,
    description,
    ...(hint ? { argumentHint: hint.length > 200 ? `${hint.slice(0, 199)}…` : hint } : {}),
    source,
  }
}

/**
 * Top-level `key: value` lines of a leading `---` block. A block scalar
 * (`>-`, `|`) and plain continuation lines fold into one line, which is all a
 * menu row shows.
 */
function frontmatter(markdown: string): SkillFields {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1]
  const values = new Map<string, string>()
  let current: string | undefined
  for (const line of block?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (field) {
      current = field[1]!
      const value = field[2]!
      values.set(current, /^[|>][1-9+-]*$/.test(value) ? '' : unquote(value))
      continue
    }
    if (current && /^\s+\S/.test(line)) {
      const previous = values.get(current)
      values.set(current, previous ? `${previous} ${line.trim()}` : line.trim())
    }
  }
  const fields: SkillFields = {}
  for (const [key, field] of FIELDS) {
    const value = values.get(key)
    if (value) fields[field] = value
  }
  return fields
}

/** The frontmatter keys a menu row uses. */
type SkillFields = {
  name?: string
  description?: string
  argumentHint?: string
  userInvocable?: string
}
const FIELDS = [
  ['name', 'name'],
  ['description', 'description'],
  ['argument-hint', 'argumentHint'],
  ['user-invocable', 'userInvocable'],
] as const satisfies ReadonlyArray<readonly [string, keyof SkillFields]>

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? quoted[2]! : value
}

/** The first heading or text line after the frontmatter. */
function firstLine(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, '').trim()
    if (trimmed) return trimmed
  }
  return ''
}

async function entries(folder: string): Promise<Dirent[]> {
  try {
    const found = await readdir(folder, { withFileTypes: true })
    return found.sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

async function text(file: string): Promise<string | undefined> {
  try {
    // A byte order mark would hide the frontmatter, and JSON.parse rejects it.
    return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function json(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined
  try {
    return record(JSON.parse(source))
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
