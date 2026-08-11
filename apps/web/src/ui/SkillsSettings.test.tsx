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

    expect(await screen.findByText('No skills were discovered for this project.')).toBeTruthy()
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
    const beta = await screen.findByRole('switch', { name: 'Disable Beta Skill' })
    expect((beta as HTMLButtonElement).disabled).toBe(false)

    await act(async () => finishToggle?.({ enabled: false }))

    expect(screen.getByRole('switch', { name: 'Disable Beta Skill' })).toBeTruthy()
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
})
