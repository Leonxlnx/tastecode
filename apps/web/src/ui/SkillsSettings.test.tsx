// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    state: 'open',
    request: vi.fn(request),
    on: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
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

    expect(await screen.findByRole('heading', { name: 'Design Taste', level: 2 })).toBeTruthy()
    // The page names the provider and the project instead of an inventory status.
    expect(screen.getByText('Codex · Project')).toBeTruthy()
    expect(screen.queryByText(/inventory/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Review interface decisions.')).toBeTruthy()
    expect(screen.getByText(/screenshots/).closest('.set-entity__detail--error')).toBeTruthy()
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

    expect(
      await screen.findByText(
        'Skills from Claude Code’s own settings are loaded in chats but can’t be listed here.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/No Agent Skills/)).toBeNull()
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

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Skill discovery failed')
    expect(alert.classList.contains('set-notice')).toBe(true)
    expect(screen.getByText('Codex · Project')).toBeTruthy()
    expect(screen.queryByText('Discovering skills…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
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
      />,
    )

    const install = await screen.findByRole('button', { name: 'Install from folder' })
    fireEvent.click(install)

    expect(
      (await screen.findByRole('button', { name: 'Installing…' })).hasAttribute('disabled'),
    ).toBe(true)
    rejectPicker(new Error('Folder picker unavailable'))

    expect((await screen.findByRole('alert')).textContent).toContain('Folder picker unavailable')
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.some(([method]) => method === 'skills.installFromFolder'),
    ).toBe(false)
  })

  it('recovers inventory after the connection reopens', async () => {
    let onState: ((state: 'open' | 'reconnecting') => void) | undefined
    const transport = {
      state: 'open',
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection to the server was lost.'))
        .mockResolvedValueOnce({
          capabilities: { inventory: true, configure: false, install: false },
          skills: [],
          errors: [],
        }),
      on: vi.fn(() => () => {}),
      onState: vi.fn((listener: typeof onState) => {
        onState = listener
        return () => undefined
      }),
    } as unknown as Transport
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
    act(() => onState?.('reconnecting'))
    act(() => onState?.('open'))

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
      const projectPath = (params as { projectPath: string }).projectPath
      if (method === 'skills.list') {
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
    expect(screen.getByText('Codex · Beta')).toBeTruthy()
    expect(screen.getByText('Discovering skills…')).toBeTruthy()
    const beta = await screen.findByRole('switch', { name: 'Disable Beta Skill' })
    expect((beta as HTMLButtonElement).disabled).toBe(false)

    await act(async () => finishToggle?.({ enabled: false }))

    expect(screen.getByRole('switch', { name: 'Disable Beta Skill' })).toBeTruthy()
  })

  it('keeps a switch locked until its own toggle settles', async () => {
    const finishToggle = new Map<string, () => void>()
    const transport = client(async (method, params) => {
      if (method === 'skills.list') {
        return {
          capabilities: { inventory: true, configure: true, install: false },
          skills: ['alpha', 'beta'].map((id) => ({
            ...skill,
            id,
            displayName: id,
            dependencyErrors: [],
          })),
          errors: [],
        }
      }
      if (method === 'skills.setEnabled') {
        return new Promise((resolve) =>
          finishToggle.set((params as { skillId: string }).skillId, () =>
            resolve({ enabled: false }),
          ),
        )
      }
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

    const alpha = await screen.findByRole('switch', { name: 'Disable alpha' })
    const beta = screen.getByRole('switch', { name: 'Disable beta' })
    fireEvent.click(alpha)
    fireEvent.click(beta)
    expect((alpha as HTMLButtonElement).disabled).toBe(true)
    act(() => finishToggle.get('alpha')?.())

    await waitFor(() => expect((alpha as HTMLButtonElement).disabled).toBe(false))
    expect((beta as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(beta)
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.filter(([method]) => method === 'skills.setEnabled')
        .map(([, params]) => (params as { skillId: string }).skillId),
    ).toEqual(['alpha', 'beta'])
  })

  it('keeps a confirmed toggle ahead of an older inventory refresh', async () => {
    const listeners = new Map<string, (value: never) => void>()
    let resolveRefresh: ((value: unknown) => void) | undefined
    const staleRefresh = new Promise((resolve) => {
      resolveRefresh = resolve
    })
    let lists = 0
    const inventory = {
      capabilities: { inventory: true, configure: true, install: false },
      skills: [{ ...skill, dependencyErrors: [], enabled: true }],
      errors: [],
    }
    const transport = {
      state: 'open',
      request: vi.fn(async (method: string) => {
        if (method === 'skills.list') return lists++ === 0 ? inventory : staleRefresh
        if (method === 'skills.setEnabled') return { enabled: false }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (value: never) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
      onState: vi.fn(() => () => {}),
    } as unknown as Transport
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
      listeners.get('skills.changed')?.({
        provider: 'codex',
        projectPath: '/work/project',
      } as never),
    )
    expect(await screen.findByRole('switch', { name: 'Enable Design Taste' })).toBeTruthy()

    await act(async () => resolveRefresh?.(inventory))

    expect(screen.getByRole('switch', { name: 'Enable Design Taste' })).toBeTruthy()
  })

  it('asks for a project with the shared empty line, not a card', () => {
    const transport = client(async () => {
      throw new Error('unexpected request')
    })
    render(
      <SkillsSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath={undefined}
        projectName={undefined}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Skills', level: 1 })).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(
      screen.getByText('Select a project in the sidebar first.').closest('.set-empty'),
    ).toBeTruthy()
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('states each skill on its row and lists discovery failures in one notice', async () => {
    const transport = client(async () => ({
      capabilities: { inventory: true, configure: false, install: false },
      skills: [
        { ...skill, dependencyErrors: [] },
        { ...skill, id: 'off', displayName: 'Release Notes', enabled: false, dependencyErrors: [] },
      ],
      errors: [
        { path: '/work/project/.agents/skills/broken', message: 'SKILL.md has no name' },
        { path: '/work/project/.agents/skills/empty', message: 'SKILL.md is empty' },
      ],
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

    const design = (await screen.findByText('Design Taste')).closest('.set-entity')!
    const notes = screen.getByText('Release Notes').closest('.set-entity')!
    // Without a switch the row says the state itself; a skill that is off reads quieter.
    expect(design.querySelector('.set-entity__status')?.textContent).toBe('Enabled')
    expect(design.hasAttribute('data-tone')).toBe(false)
    expect(notes.querySelector('.set-entity__status')?.textContent).toBe('Disabled')
    expect(notes.getAttribute('data-tone')).toBe('muted')
    expect(screen.queryByRole('switch')).toBeNull()

    const failures = screen.getByRole('alert')
    expect(failures.textContent).toContain('Some skills could not be loaded.')
    expect(failures.querySelectorAll('.set-notice__line')).toHaveLength(2)
    expect(failures.textContent).toContain('SKILL.md is empty · /work/project/.agents/skills/empty')
  })
})
