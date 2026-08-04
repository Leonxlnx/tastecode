// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Transport } from '../transport.js'
import { SkillsSettings } from './SkillsSettings.js'

const pickSkillFolder = vi.hoisted(() => vi.fn())
vi.mock('../bridge.js', () => ({ pickSkillFolder }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function client(request: (method: string, params: unknown) => Promise<unknown>): Transport {
  return {
    request: vi.fn(request),
    on: vi.fn(() => () => {}),
  } as unknown as Transport
}

const skill = {
  id: '/work/project/.agents/skills/design/SKILL.md',
  name: 'design',
  displayName: 'Design Taste',
  description: 'Review interface decisions.',
  source: { type: 'folder' as const, path: '/work/project/.agents/skills/design' },
  scope: 'project' as const,
  enabled: true,
  dependencyErrors: [
    { dependency: 'screenshots', message: 'Required MCP server is not configured' },
  ],
}

describe('Agent Skills settings', () => {
  it('shows inventory, toggles a skill, and installs from a selected folder', async () => {
    const transport = client(async (method) => {
      if (method === 'skills.list') {
        return {
          capabilities: { inventory: true, configure: true, install: true },
          skills: [skill],
          errors: [],
        }
      }
      if (method === 'skills.setEnabled') return { enabled: false }
      if (method === 'skills.installFromFolder') {
        return { skill: { ...skill, id: '/new/SKILL.md', name: 'new', displayName: 'New Skill' } }
      }
      throw new Error(`unexpected ${method}`)
    })
    pickSkillFolder.mockResolvedValue('/downloads/new-skill')
    render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('Design Taste')).toBeTruthy()
    expect(screen.getByText('Project')).toBeTruthy()
    expect(screen.getByText(/screenshots/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Design Taste' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('skills.setEnabled', {
        provider: 'codex',
        projectPath: '/work/project',
        skillId: skill.id,
        enabled: false,
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Install from folder' }))
    expect(await screen.findByText('New Skill')).toBeTruthy()
    expect(transport.request).toHaveBeenCalledWith('skills.installFromFolder', {
      provider: 'codex',
      projectPath: '/work/project',
      folderPath: '/downloads/new-skill',
    })
  })

  it('hides unsupported-provider actions', async () => {
    const transport = client(async () => ({
      capabilities: { inventory: false, configure: false, install: false },
      skills: [],
      errors: [],
    }))
    render(
      <SkillsSettings
        transport={transport}
        provider="claude-code"
        providerName="Claude Code"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText(/does not expose Agent Skills/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install from folder' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('replaces discovery with a retryable error', async () => {
    const transport = client(async () => {
      throw new Error('Skill discovery failed')
    })
    render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('Skill discovery failed')
    expect(screen.queryByText('Discovering skills…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
  })
})
