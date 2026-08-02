import path from 'node:path'
import type { Skill, SkillCapabilities, SkillDiscoveryError } from '@harness/contracts'
import type { SkillsListResponse } from './generated/v2/SkillsListResponse.js'

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
  response: SkillsListResponse,
  cwd: string,
  configuredMcpIds?: ReadonlySet<string>,
): SkillInventory {
  const entry = response.data.find((candidate) => path.resolve(candidate.cwd) === path.resolve(cwd))
  if (!entry) return { skills: [], errors: [] }

  return {
    skills: entry.skills.map((skill) => {
      const skillPath = String(skill.path)
      return {
        id: skillPath,
        name: skill.name,
        ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
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
