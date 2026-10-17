// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import { appCommands } from '../app-commands.js'
import { TestTransport } from '../test-transport.js'
import { ComposerResourcePicker, type ComposerResource } from './ComposerResourcePicker.js'
import type { ComposerResourcePickerHandle, ComposerResourceTrigger } from './composer-resource.js'

type CommandInventory = ResultOf<'commands.list'>

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ANIMATE_SKILL = {
  id: '/Users/me/.agents/skills/animate/SKILL.md',
  name: 'animate',
  displayName: 'Animate',
  description: 'Build an animation from scratch',
  source: { type: 'folder', path: '/Users/me/.agents/skills/animate' },
  scope: 'user',
  enabled: true,
  dependencyErrors: [],
}

function createResourceTransport(
  commands: () => CommandInventory = () => ({
    commands: [],
    loading: false,
  }),
  skills: unknown[] = [ANIMATE_SKILL],
) {
  return new TestTransport(async (method) => {
    if (method === 'skills.list') {
      return {
        capabilities: { inventory: true, configure: false, install: false },
        skills,
        errors: [],
      }
    }
    if (method === 'mcp.list') {
      return {
        capabilities: {
          inventory: false,
          add: true,
          update: true,
          remove: true,
          reload: false,
          startOAuth: false,
          cancelOAuth: false,
        },
        servers: [
          {
            id: 'officialDocs',
            displayName: 'Official Docs',
            description: 'Search official product documentation',
            scope: 'global',
            enabled: true,
            auth: { status: 'not_required' },
            startup: { state: 'ready' },
            tools: [],
            resources: [],
            resourceTemplates: [],
          },
        ],
      }
    }
    if (method === 'commands.list') return commands()
    throw new Error(`Unexpected request: ${method}`)
  })
}

function slash(query: string): ComposerResourceTrigger {
  return { marker: '/', query, start: 0, end: query.length + 1 }
}

function renderPicker(
  transport: TestTransport,
  trigger: ComposerResourceTrigger,
  extra: { provider?: 'codex' | 'claude-code'; threadId?: string } = {},
) {
  const onSelect = vi.fn<(resource: ComposerResource) => void>()
  const pickerRef = createRef<ComposerResourcePickerHandle>()
  const element = (next: ComposerResourceTrigger) => (
    <ComposerResourcePicker
      ref={pickerRef}
      transport={transport}
      provider={extra.provider ?? 'claude-code'}
      projectPath="/work/project"
      threadId={extra.threadId}
      trigger={next}
      selectedKeys={new Set()}
      onSelect={onSelect}
    />
  )
  const view = render(element(trigger))
  return {
    onSelect,
    pickerRef,
    retrigger: (next: ComposerResourceTrigger) => view.rerender(element(next)),
  }
}

function optionNames(): string[] {
  return screen
    .getAllByRole('option')
    .map((option) => option.querySelector('.composer-resource-picker__name')?.textContent ?? '')
}

describe('ComposerResourcePicker', () => {
  it('keeps hover highlight and selectActive in sync', async () => {
    const { onSelect, pickerRef } = renderPicker(
      createResourceTransport(),
      { marker: '@', query: '', start: 0, end: 1 },
      { provider: 'codex' },
    )

    const docs = await screen.findByRole('option', { name: /Official Docs/ })
    fireEvent.mouseEnter(docs)

    expect(docs.getAttribute('aria-selected')).toBe('true')
    expect(pickerRef.current?.selectActive()).toBe('selected')
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mcp:officialDocs', name: 'Official Docs' }),
    )
  })

  it('lists provider commands before skills and asks the open chat for them', async () => {
    const transport = createResourceTransport(() => ({
      commands: [
        { name: 'pdf', description: 'Work with PDF files', kind: 'skill' },
        { name: 'context', description: 'Show current context usage' },
      ],
      loading: false,
    }))
    renderPicker(transport, slash(''), { threadId: 'thread-1' })

    await screen.findByRole('option', { name: /\/context/ })
    expect(optionNames()).toEqual(['/context', '/pdf', 'Animate'])
    expect(transport.requests.map(({ method }) => method).sort()).toEqual([
      'commands.list',
      'skills.list',
    ])
    expect(transport.requests.find(({ method }) => method === 'commands.list')?.params).toEqual({
      provider: 'claude-code',
      projectPath: '/work/project',
      threadId: 'thread-1',
    })
  })

  it('ranks exact names, then name prefixes, then aliases, then other matches', async () => {
    const transport = createResourceTransport(
      () => ({
        commands: [
          { name: 'security-review', description: 'Complete a security review' },
          { name: 'plan-review', description: 'Review a plan', aliases: ['rv'] },
          { name: 'review', description: 'Review a pull request' },
          { name: 'reviewer', description: 'Pick a reviewer' },
          { name: 'notes', description: 'Write review notes' },
        ],
        loading: false,
      }),
      [],
    )
    const { onSelect, pickerRef, retrigger } = renderPicker(transport, slash('review'))

    await screen.findByRole('option', { name: /\/security-review/ })
    expect(optionNames()).toEqual([
      '/review',
      '/reviewer',
      '/security-review',
      '/plan-review',
      '/notes',
    ])

    retrigger(slash('rv'))
    await waitFor(() => expect(optionNames()).toEqual(['/plan-review']))
    expect(pickerRef.current?.selectActive('Tab')).toBe('selected')
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ token: '/rv' }))
  })

  it('offers a skill that is also a provider command once, as the command', async () => {
    const transport = createResourceTransport(() => ({
      commands: [{ name: 'animate', description: 'Animate a page', kind: 'skill' }],
      loading: false,
    }))
    renderPicker(transport, slash(''))

    await screen.findByRole('option', { name: /\/animate/ })
    expect(optionNames()).toEqual(['/animate'])
  })

  it('runs an exactly typed command without arguments and completes everything else', async () => {
    const transport = createResourceTransport(
      () => ({
        commands: [
          { name: 'context', description: 'Show current context usage' },
          { name: 'compact', description: 'Summarize', argumentHint: '<instructions>' },
          { name: 'pdf', description: 'Work with PDF files', kind: 'skill' },
        ],
        loading: false,
      }),
      [],
    )
    const { onSelect, pickerRef, retrigger } = renderPicker(transport, slash('context'))

    await screen.findByRole('option', { name: /\/context/ })
    expect(pickerRef.current?.selectActive('Enter')).toBe('run')
    expect(pickerRef.current?.selectActive('Tab')).toBe('selected')
    retrigger(slash('compact'))
    await waitFor(() => expect(optionNames()[0]).toBe('/compact'))
    expect(pickerRef.current?.selectActive('Enter')).toBe('selected')
    retrigger(slash('pdf'))
    await waitFor(() => expect(optionNames()[0]).toBe('/pdf'))
    expect(pickerRef.current?.selectActive('Enter')).toBe('selected')
    retrigger(slash('cont'))
    await waitFor(() => expect(optionNames()[0]).toBe('/context'))
    expect(pickerRef.current?.selectActive('Enter')).toBe('selected')
    expect(onSelect).toHaveBeenCalledTimes(4)
  })

  it('shows loading rows while discovery runs and refreshes on commands.changed', async () => {
    let commands: CommandInventory = {
      commands: [{ name: 'context', description: 'Show current context usage' }],
      loading: true,
    }
    const transport = createResourceTransport(() => commands, [])
    renderPicker(transport, slash(''))

    await screen.findByRole('option', { name: /\/context/ })
    expect(screen.getByText('Loading commands and skills…')).toBeTruthy()

    commands = {
      commands: [...commands.commands, { name: 'init', description: 'Initialize a CLAUDE.md' }],
      loading: false,
    }
    act(() =>
      transport.emit('commands.changed', { provider: 'grok', projectPath: '/work/project' }),
    )
    act(() =>
      transport.emit('commands.changed', { provider: 'claude-code', projectPath: '/work/project' }),
    )

    await screen.findByRole('option', { name: /\/init/ })
    expect(optionNames()).toEqual(['/context', '/init'])
    expect(screen.queryByText('Loading commands and skills…')).toBeNull()
    expect(transport.requests.filter(({ method }) => method === 'commands.list')).toHaveLength(2)
  })

  it("puts TasteCode's commands first and leaves out provider commands with their names", async () => {
    const transport = createResourceTransport(
      () => ({
        commands: [
          { name: 'init', description: 'Initialize a CLAUDE.md' },
          { name: 'side', description: 'Provider side command' },
          { name: 'aside', description: 'Provider aside', aliases: ['btw', 'as'] },
        ],
        loading: false,
      }),
      [{ ...ANIMATE_SKILL, name: 'feedback', displayName: undefined }],
    )
    const onSelect = vi.fn<(resource: ComposerResource) => void>()
    const pickerRef = createRef<ComposerResourcePickerHandle>()
    render(
      <ComposerResourcePicker
        ref={pickerRef}
        transport={transport}
        provider="grok"
        projectPath="/work/project"
        appCommands={appCommands({ sideChat: true, feedback: true })}
        trigger={slash('')}
        selectedKeys={new Set()}
        onSelect={onSelect}
      />,
    )

    await screen.findByRole('option', { name: /\/init/ })
    expect(optionNames()).toEqual(['/side', '/feedback', '/init', '/aside'])
    expect(screen.getByRole('option', { name: /\/side/ }).getAttribute('title')).toBe(
      '/side [question]',
    )
    expect(pickerRef.current?.selectActive('Tab')).toBe('selected')
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'app:side', token: '/side', aliases: ['btw'] }),
    )
  })

  it('lists TasteCode commands without a project, before any inventory', () => {
    const transport = createResourceTransport()
    render(
      <ComposerResourcePicker
        transport={transport}
        provider="codex"
        projectPath={undefined}
        appCommands={appCommands({ sideChat: false, feedback: true })}
        trigger={slash('fee')}
        selectedKeys={new Set()}
        onSelect={vi.fn()}
      />,
    )

    expect(optionNames()).toEqual(['/feedback'])
    expect(transport.requests).toEqual([])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('treats a server without provider commands as having none', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'skills.list') {
        return {
          capabilities: { inventory: true, configure: false, install: false },
          skills: [],
          errors: [],
        }
      }
      throw new Error(`unknown method: ${method}`)
    })
    renderPicker(transport, slash(''))

    expect(
      await screen.findByText('Claude Code has no commands or skills for this project.'),
    ).toBeTruthy()
  })
})
