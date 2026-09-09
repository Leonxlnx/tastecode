import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapSkillList } from './skills.js'

describe('Codex skills inventory', () => {
  it('maps the captured wire shape and reports missing MCP dependencies', () => {
    const cwd = path.resolve('repo')
    const skillPath = path.join(cwd, '.agents', 'skills', 'docs', 'SKILL.md')
    const brokenPath = path.join(cwd, 'broken', 'SKILL.md')
    expect(
      mapSkillList(
        {
          data: [
            {
              cwd,
              skills: [
                {
                  name: 'docs',
                  description: 'Read product documentation',
                  interface: { displayName: 'Docs' },
                  dependencies: { tools: [{ type: 'mcp', value: 'officialDocs' }] },
                  path: skillPath,
                  scope: 'repo',
                  enabled: true,
                },
              ],
              errors: [{ path: brokenPath, message: 'invalid frontmatter' }],
            },
          ],
        },
        cwd,
        new Set(),
      ),
    ).toEqual({
      skills: [
        {
          id: skillPath,
          name: 'docs',
          displayName: 'Docs',
          description: 'Read product documentation',
          source: { type: 'folder', path: path.dirname(skillPath) },
          scope: 'project',
          enabled: true,
          dependencyErrors: [
            { dependency: 'officialDocs', message: 'Required MCP server is not configured' },
          ],
        },
      ],
      errors: [{ path: brokenPath, message: 'invalid frontmatter' }],
    })
  })

  it('keeps skills without a description so the inventory still names them', () => {
    const cwd = path.resolve('repo')
    const skillPath = path.join(cwd, '.agents', 'skills', 'animate', 'SKILL.md')
    expect(
      mapSkillList(
        {
          data: [
            {
              cwd,
              skills: [
                {
                  name: 'animate',
                  path: skillPath,
                  scope: 'user',
                  enabled: true,
                },
              ],
              errors: [],
            },
          ],
        },
        cwd,
      ),
    ).toEqual({
      skills: [
        {
          id: skillPath,
          name: 'animate',
          description: '',
          source: { type: 'folder', path: path.dirname(skillPath) },
          scope: 'user',
          enabled: true,
          dependencyErrors: [],
        },
      ],
      errors: [],
    })
  })
})
