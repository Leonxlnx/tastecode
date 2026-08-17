// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { methods, type ResultOf } from '@harness/contracts'
import { requiredInstance } from '../test-dom.js'
import { TestTransport, type TestRequestResolver } from '../test-transport.js'
import { SkillsSettings } from './SkillsSettings.js'

const pickSkillFolder = vi.fn<() => Promise<string | undefined>>()

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function client(request: TestRequestResolver): TestTransport {
  return new TestTransport(request)
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
        pickSkillFolder={pickSkillFolder}
      />,
    )

    expect(await screen.findByText('Design Taste')).toBeTruthy()
    expect(screen.getByText('Codex · Agent Skills inventory available')).toBeTruthy()
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByText('Available in Project')).toBeNull()
    expect(screen.getByText('Project')).toBeTruthy()
    expect(screen.getByText(/screenshots/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Design Taste' }))
    await waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: 'skills.setEnabled',
        params: {
          provider: 'codex',
          projectPath: '/work/project',
          skillId: skill.id,
          enabled: false,
        },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Install from folder' }))
    expect(await screen.findByText('New Skill')).toBeTruthy()
    expect(transport.requests).toContainEqual({
      method: 'skills.installFromFolder',
      params: {
        provider: 'codex',
        projectPath: '/work/project',
        folderPath: '/downloads/new-skill',
      },
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
    expect(screen.getByText('Claude Code · Agent Skills inventory unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install from folder' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('starts empty when the provider only reports managed skills', async () => {
    const transport = client(async () => ({
      capabilities: { inventory: true, configure: true, install: true },
      skills: [{ ...skill, id: 'managed', scope: 'system', source: { type: 'provider' } }],
      errors: [],
    }))
    render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(
      await screen.findByText('No Agent Skills have been imported into this project.'),
    ).toBeTruthy()
    expect(screen.queryByText('Design Taste')).toBeNull()
    expect(screen.getByRole('button', { name: 'Install from folder' })).toBeTruthy()
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
    expect(screen.getByText('Codex · Agent Skills status unavailable')).toBeTruthy()
    expect(screen.queryByText('Discovering skills…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(transport.requests).toHaveLength(2))
  })

  it('reports a rejected folder picker without starting an install', async () => {
    let rejectPicker!: (cause: Error) => void
    const transport = client(async (method) => {
      if (method === 'skills.list') {
        return {
          capabilities: { inventory: true, configure: false, install: true },
          skills: [skill],
          errors: [],
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    pickSkillFolder.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectPicker = reject
      }),
    )
    render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
        pickSkillFolder={pickSkillFolder}
      />,
    )

    const install = await screen.findByRole('button', { name: 'Install from folder' })
    fireEvent.click(install)

    expect(
      (await screen.findByRole('button', { name: 'Installing…' })).hasAttribute('disabled'),
    ).toBe(true)
    rejectPicker(new Error('Folder picker unavailable'))

    expect((await screen.findByRole('alert')).textContent).toContain('Folder picker unavailable')
    expect(transport.requests.some(({ method }) => method === 'skills.installFromFolder')).toBe(
      false,
    )
  })

  it('recovers inventory after the connection reopens', async () => {
    let reads = 0
    const transport = new TestTransport(async (method) => {
      if (method !== 'skills.list') throw new Error(`unexpected ${method}`)
      reads += 1
      if (reads === 1) throw new Error('Connection to the server was lost.')
      return {
        capabilities: { inventory: true, configure: false, install: false },
        skills: [],
        errors: [],
      }
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

    expect(await screen.findByRole('alert')).toBeTruthy()
    act(() => transport.emitState('reconnecting'))
    act(() => transport.emitState('open'))

    expect(
      await screen.findByText('No Agent Skills have been imported into this project.'),
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a completed toggle after switching projects', async () => {
    let finishToggle: ((value: { enabled: boolean }) => void) | undefined
    const toggle = new Promise<{ enabled: boolean }>((resolve) => {
      finishToggle = resolve
    })
    const transport = client(async (method, params) => {
      if (method === 'skills.list') {
        const { projectPath } = methods[method].params.parse(params)
        return {
          capabilities: { inventory: true, configure: true, install: false },
          skills: [
            {
              ...skill,
              id: 'shared-skill',
              displayName: projectPath === '/work/alpha' ? 'Alpha Skill' : 'Beta Skill',
              enabled: true,
            },
          ],
          errors: [],
        }
      }
      if (method === 'skills.setEnabled') return toggle
      throw new Error(`unexpected ${method}`)
    })
    const view = render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/alpha"
        projectName="Alpha"
      />,
    )

    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Alpha Skill' }))
    view.rerender(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/beta"
        projectName="Beta"
      />,
    )
    expect(screen.getByText('Checking Codex Agent Skills support…')).toBeTruthy()
    const beta = await screen.findByRole('switch', { name: 'Disable Beta Skill' })
    expect(requiredInstance(beta, HTMLButtonElement).disabled).toBe(false)

    await act(async () => finishToggle?.({ enabled: false }))

    expect(screen.getByRole('switch', { name: 'Disable Beta Skill' })).toBeTruthy()
  })

  it('keeps a confirmed toggle ahead of an older inventory refresh', async () => {
    let resolveRefresh: ((value: ResultOf<'skills.list'>) => void) | undefined
    const staleRefresh = new Promise<ResultOf<'skills.list'>>((resolve) => {
      resolveRefresh = resolve
    })
    let lists = 0
    const inventory = {
      capabilities: { inventory: true, configure: true, install: false },
      skills: [{ ...skill, dependencyErrors: [], enabled: true }],
      errors: [],
    }
    const transport = new TestTransport(async (method) => {
      if (method === 'skills.list') return lists++ === 0 ? inventory : staleRefresh
      if (method === 'skills.setEnabled') return { enabled: false }
      throw new Error(`unexpected ${method}`)
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

    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Design Taste' }))
    act(() =>
      transport.emit('skills.changed', {
        provider: 'codex',
        projectPath: '/work/project',
      }),
    )
    expect(await screen.findByRole('switch', { name: 'Enable Design Taste' })).toBeTruthy()

    await act(async () => resolveRefresh?.(inventory))

    expect(screen.getByRole('switch', { name: 'Enable Design Taste' })).toBeTruthy()
  })
})
