import path from 'node:path'
import type { Skill, SkillCapabilities, SkillDiscoveryError } from '@harness/contracts'
import type { ParsedSkillsListResponse } from './schemas.js'

export const CODEX_SKILL_CAPABILITIES: SkillCapabilities = {
  inventory: true,
  configure: true,
  install: true,
}

export type SkillInventory = {
  skills: Skill[]
  errors: SkillDiscoveryError[]
}

export function mapSkillList(
  response: ParsedSkillsListResponse,
  cwd: string,
  configuredMcpIds?: ReadonlySet<string>,
): SkillInventory {
  // Windows paths compare case-insensitively — Codex echoing `c:\proj` for a
  // requested `C:\proj` made the whole skills list silently disappear. A
  // single-entry response is trusted as ours regardless, since we only ever
  // ask about one cwd.
  const samePath = (a: string, b: string) => {
    const left = path.resolve(a)
    const right = path.resolve(b)
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  }
  const entry =
    response.data.find((candidate) => samePath(candidate.cwd, cwd)) ??
    (response.data.length === 1 ? response.data[0] : undefined)
  if (!entry) return { skills: [], errors: [] }

  return {
    skills: entry.skills.map((skill) => {
      const skillPath = String(skill.path)
      return {
        id: skillPath,
        name: skill.name,
        ...(skill.interface?.displayName
          ? {
              displayName: skill.interface?.displayName,
            }
          : {}),
        description: skill.description,
        source: { type: 'folder' as const, path: path.dirname(skillPath) },
        scope: skill.scope === 'repo' ? 'project' : skill.scope,
        enabled: skill.enabled,
        dependencyErrors:
          configuredMcpIds === undefined
            ? []
            : (skill.dependencies?.tools.flatMap((dependency) =>
                dependency.type === 'mcp' && !configuredMcpIds.has(dependency.value)
                  ? [
                      {
                        dependency: dependency.value,
                        message: 'Required MCP server is not configured',
                      },
                    ]
                  : [],
              ) ?? []),
      }
    }),
    errors: entry.errors.map((error) => ({ path: error.path, message: error.message })),
  }
}
