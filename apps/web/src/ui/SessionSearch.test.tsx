// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionSearchResult } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { SessionSearch } from './SessionSearch.js'

const RESULT: SessionSearchResult = {
  projectPath: 'D:\\repo',
  projectName: 'TasteCode',
  threadId: 'thread-1',
  threadTitle: 'Fix regression',
  turnId: 'turn-2',
  provider: 'codex',
  createdAt: 42,
  snippet: [
    { text: 'The ', highlighted: false },
    { text: 'regression', highlighted: true },
    { text: ' started here.', highlighted: false },
  ],
}

const PROJECTS = [
  {
    path: 'D:\\repo',
    name: 'TasteCode',
    sessions: [
      {
        id: 'title-thread',
        title: 'Regression planning',
        provider: 'codex' as const,
        createdAt: 44,
      },
      {
        id: 'grok-thread',
        title: 'Unrelated Grok chat',
        provider: 'grok' as const,
        createdAt: 43,
      },
      {
        id: 'gemini-thread',
        title: 'Gemini roadmap',
        provider: 'acp' as const,
        agent: 'gemini',
        createdAt: 42,
      },
    ],
  },
]

describe('cross-session search', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('contains forward and reverse Tab navigation inside the modal', () => {
    render(
      <SessionSearch
        transport={{ request: vi.fn() } as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )
    const search = screen.getByRole('combobox', { name: 'Search every chat' })
    const agent = screen.getByRole('combobox', { name: 'Agent' })
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(agent)

    fireEvent.keyDown(agent, { key: 'Tab' })
    expect(document.activeElement).toBe(search)
  })

  it('finds titles immediately, searches quickly, and supports keyboard navigation', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce({ results: [RESULT], nextCursor: 'page-2' })
      .mockResolvedValueOnce({
        results: [{ ...RESULT, turnId: 'turn-3', createdAt: 43 }],
        nextCursor: null,
      })
    const onSelect = vi.fn()
    render(
      <SessionSearch
        transport={{ request } as unknown as Transport}
        projects={PROJECTS}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }))
    fireEvent.click(screen.getByRole('option', { name: 'TasteCode' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    expect(screen.getByRole('option', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Grok' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Cursor' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }))
    const search = screen.getByLabelText('Search every chat')
    fireEvent.change(search, { target: { value: 'regres' } })

    expect(screen.getByRole('option', { name: /Regression planning/ })).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('title-thread', undefined)
    onSelect.mockClear()
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(79)
      await Promise.resolve()
    })
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })

    expect(request).toHaveBeenCalledWith('search.sessions', {
      query: 'regres',
      projectPath: 'D:\\repo',
      provider: 'codex',
      limit: 20,
    })
    expect(screen.getByText('regression').tagName).toBe('MARK')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('thread-1', 'turn-2')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more results' }))
      await Promise.resolve()
    })
    expect(request).toHaveBeenLastCalledWith('search.sessions', {
      query: 'regres',
      projectPath: 'D:\\repo',
      provider: 'codex',
      cursor: 'page-2',
      limit: 20,
    })
    expect(screen.getAllByRole('option', { name: /Fix regression/ })).toHaveLength(2)
  })

  it('shows pending state immediately and ignores a stale response', async () => {
    vi.useFakeTimers()
    let resolveFirst:
      ((value: { results: SessionSearchResult[]; nextCursor: null }) => void) | undefined
    let resolveSecond:
      ((value: { results: SessionSearchResult[]; nextCursor: null }) => void) | undefined
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )
    render(
      <SessionSearch
        transport={{ request } as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    const search = screen.getByLabelText('Search every chat')
    fireEvent.change(search, { target: { value: 'first' } })
    expect(screen.getByText('Searching…')).toBeTruthy()
    await act(async () => vi.advanceTimersByTime(80))

    fireEvent.change(search, { target: { value: 'second' } })
    expect(screen.getByText('Searching…')).toBeTruthy()
    await act(async () => vi.advanceTimersByTime(80))

    await act(async () => {
      resolveFirst?.({ results: [RESULT], nextCursor: null })
      await Promise.resolve()
    })
    expect(screen.queryByText('regression')).toBeNull()

    await act(async () => {
      resolveSecond?.({
        results: [
          {
            ...RESULT,
            threadTitle: 'Second result',
            snippet: [{ text: 'second', highlighted: true }],
          },
        ],
        nextCursor: null,
      })
      await Promise.resolve()
    })
    expect(screen.getByRole('option', { name: /Second result/ })).toBeTruthy()
  })

  it('keeps settled message results visible while the next query loads', async () => {
    vi.useFakeTimers()
    let resolveRefresh:
      ((value: { results: SessionSearchResult[]; nextCursor: null }) => void) | undefined
    const request = vi
      .fn()
      .mockResolvedValueOnce({ results: [RESULT], nextCursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          }),
      )
    render(
      <SessionSearch
        transport={{ request } as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    const search = screen.getByLabelText('Search every chat')
    fireEvent.change(search, { target: { value: 'regres' } })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
    })
    expect(screen.getByText('Messages and output')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Fix regression/ })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'second' } })
    expect(screen.getByText('Messages and output')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Fix regression/ })).toBeTruthy()
    await act(async () => vi.advanceTimersByTime(80))
    expect(screen.getByText('Messages and output')).toBeTruthy()

    await act(async () => {
      resolveRefresh?.({
        results: [
          {
            ...RESULT,
            threadTitle: 'Second result',
            snippet: [{ text: 'second', highlighted: true }],
          },
        ],
        nextCursor: null,
      })
      await Promise.resolve()
    })
    expect(screen.queryByRole('option', { name: /Fix regression/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Second result/ })).toBeTruthy()
  })

  it('shows ACP title and content matches with their source product name', async () => {
    const transport = {
      request: vi.fn(async () => ({
        results: [
          { ...RESULT, threadId: 'gemini-thread', threadTitle: 'Gemini roadmap', provider: 'acp' },
        ],
        nextCursor: null,
      })),
    }
    render(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(screen.getByLabelText('Search every chat'), { target: { value: 'gemini' } })
    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: /Gemini roadmap.*Gemini CLI/ })).toHaveLength(2)
    })
    for (const option of screen.getAllByRole('option', { name: /Gemini roadmap.*Gemini CLI/ })) {
      const identity = option.querySelector('.source-identity')
      expect(identity?.getAttribute('title')).toBe('Gemini CLI')
      expect(identity?.querySelector('svg')?.getAttribute('width')).toBe('11')
      expect(identity?.querySelector('path')?.getAttribute('d')).toContain('M11.04 19.32')
    }
  })

  it('keeps same-turn, same-timestamp content hits distinct by server identity', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onSelect = vi.fn()
    const transport = {
      request: vi.fn(async () => ({
        results: [
          { ...RESULT, resultId: 'message:item-1' },
          { ...RESULT, resultId: 'tool:item-2' },
        ],
        nextCursor: null,
      })),
    }
    render(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={[]}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })

    const hits = await screen.findAllByRole('option', { name: /Fix regression/ })
    expect(hits).toHaveLength(2)
    fireEvent.click(hits[0]!)
    fireEvent.click(hits[1]!)
    expect(onSelect).toHaveBeenNthCalledWith(1, 'thread-1', 'turn-2')
    expect(onSelect).toHaveBeenNthCalledWith(2, 'thread-1', 'turn-2')
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  })

  it('keeps the focused result selected when title rows are inserted ahead of it', async () => {
    const transport = {
      request: vi.fn(async () => ({
        results: [{ ...RESULT, resultId: 'message:item-1' }],
        nextCursor: null,
      })),
    }
    const view = render(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })
    const contentHit = await screen.findByRole('option', { name: /Fix regression/ })
    act(() => contentHit.focus())
    await waitFor(() => expect(contentHit.getAttribute('aria-selected')).toBe('true'))

    view.rerender(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={[
          {
            ...PROJECTS[0]!,
            sessions: [
              ...PROJECTS[0]!.sessions,
              {
                id: 'new-title-thread',
                title: 'Regression urgent',
                provider: 'codex' as const,
                createdAt: 100,
              },
            ],
          },
        ]}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(screen.getByRole('option', { name: /Fix regression/ })).toBe(contentHit)
    expect(document.activeElement).toBe(contentHit)
    expect(contentHit.getAttribute('aria-selected')).toBe('true')
  })

  it('appends indistinguishable content hits without duplicate React keys', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ ...RESULT, resultId: 'message:item-1' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        results: [{ ...RESULT, resultId: 'message:item-2' }],
        nextCursor: null,
      })
    render(
      <SessionSearch
        transport={{ request } as unknown as Transport}
        projects={[]}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })
    expect(await screen.findAllByRole('option', { name: /Fix regression/ })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }))

    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: /Fix regression/ })).toHaveLength(2)
    })
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  })

  it('retains title and content row instances across equivalent rerenders', async () => {
    const transport = {
      request: vi.fn(async () => ({
        results: [{ ...RESULT, resultId: 'message:item-1' }],
        nextCursor: null,
      })),
    }
    const view = render(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={PROJECTS}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })
    const titleHit = screen.getByRole('option', { name: /Regression planning/ })
    const contentHit = await screen.findByRole('option', { name: /Fix regression/ })

    view.rerender(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={PROJECTS.map((project) => ({
          ...project,
          sessions: project.sessions.map((session) => ({ ...session })),
        }))}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(screen.getByRole('option', { name: /Regression planning/ })).toBe(titleHit)
    expect(screen.getByRole('option', { name: /Fix regression/ })).toBe(contentHit)
  })

  it('keeps duplicate legacy results usable when resultId is omitted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onSelect = vi.fn()
    const transport = {
      request: vi.fn(async () => ({ results: [RESULT, { ...RESULT }], nextCursor: null })),
    }
    const view = render(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={[]}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })
    const legacyHits = await screen.findAllByRole('option', { name: /Fix regression/ })

    fireEvent.click(legacyHits[0]!)
    fireEvent.click(legacyHits[1]!)
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')

    view.rerender(
      <SessionSearch
        transport={transport as unknown as Transport}
        projects={[{ path: 'D:\\other', name: 'Other', sessions: [] }]}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    )
    const rerenderedHits = screen.getAllByRole('option', { name: /Fix regression/ })
    expect(rerenderedHits[0]).toBe(legacyHits[0])
    expect(rerenderedHits[1]).toBe(legacyHits[1])
  })
})
