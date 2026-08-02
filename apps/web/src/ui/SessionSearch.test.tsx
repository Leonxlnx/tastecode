// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SessionSearchResult } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { SessionSearch } from './SessionSearch.js'

const RESULT: SessionSearchResult = {
  projectPath: 'D:\\repo',
  projectName: 'Harness',
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

describe('cross-session search', () => {
  afterEach(() => vi.useRealTimers())

  it('debounces filtered search, highlights snippets, paginates, and navigates', async () => {
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
        projects={[{ path: 'D:\\repo', name: 'Harness' }]}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'D:\\repo' } })
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Search every chat'), {
      target: { value: 'regression' },
    })
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(220)
      await Promise.resolve()
    })

    expect(request).toHaveBeenCalledWith('search.sessions', {
      query: 'regression',
      projectPath: 'D:\\repo',
      provider: 'codex',
      limit: 20,
    })
    expect(screen.getByText('regression').tagName).toBe('MARK')
    fireEvent.click(screen.getByRole('button', { name: /Fix regression/ }))
    expect(onSelect).toHaveBeenCalledWith('thread-1', 'turn-2')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more results' }))
      await Promise.resolve()
    })
    expect(request).toHaveBeenLastCalledWith('search.sessions', {
      query: 'regression',
      projectPath: 'D:\\repo',
      provider: 'codex',
      cursor: 'page-2',
      limit: 20,
    })
    expect(screen.getAllByRole('button', { name: /Fix regression/ })).toHaveLength(2)
  })
})
