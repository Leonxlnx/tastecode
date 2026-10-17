// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionDiff } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceReview } from './WorkspaceReview.js'

vi.mock('@pierre/diffs/react', () => ({
  CodeView: ({ items }: { items: Array<{ fileDiff: { name: string } }> }) => (
    <div>{items.map((item) => item.fileDiff.name).join(', ')}</div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WorkspaceReview', () => {
  it('loads the active checkout diff without requiring an isolated thread', async () => {
    const diff = {
      threadId: 'workspace-checkout',
      version: 'tree-1',
      files: [
        {
          path: 'src/index.ts',
          status: 'modified',
          binary: false,
          hunks: [
            {
              id: 'hunk-1',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'deletion', oldLine: 1, text: 'old' },
                { kind: 'addition', newLine: 1, text: 'new' },
              ],
            },
          ],
        },
      ],
    } satisfies SessionDiff
    const request = vi.fn(async () => diff)

    render(
      <WorkspaceReview
        transport={new TestTransport(request)}
        projectPath="/repo"
        branch="main"
        theme="dark"
      />,
    )

    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('workspace.diff', { projectPath: '/repo' })
    expect(screen.queryByText(/isolated session/i)).toBeNull()
  })

  it('names the whole branch on its truncated toolbar label', async () => {
    const branch = 'feature/a-branch-name-long-enough-to-truncate-in-a-narrow-panel'
    render(
      <WorkspaceReview
        transport={new TestTransport(async () => ({ threadId: 'w', version: 'v', files: [] }))}
        projectPath="/repo"
        branch={branch}
        theme="dark"
      />,
    )

    expect((await screen.findByText(branch)).getAttribute('title')).toBe(branch)
  })

  it('drafts a commit message through the configured background model', async () => {
    const diff = {
      threadId: 'thread-1',
      version: 'tree-1',
      files: [
        {
          path: 'src/index.ts',
          status: 'modified',
          binary: false,
          hunks: [],
        },
      ],
    } satisfies SessionDiff
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.diff') return diff
      if (method === 'backgroundModel.generateCommitMessage') {
        return { message: 'fix(review): keep commit drafts cheap' }
      }
      throw new Error(`unexpected method ${method}`)
    })

    render(
      <WorkspaceReview
        transport={new TestTransport(request)}
        projectPath="/repo"
        threadId="thread-1"
        branch="main"
        theme="dark"
      />,
    )

    await screen.findByText('src/index.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft commit message' }))

    expect(await screen.findByDisplayValue('fix(review): keep commit drafts cheap')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('backgroundModel.generateCommitMessage', {
      projectPath: '/repo',
      threadId: 'thread-1',
    })
  })

  it('reviews a provisional chat in the project checkout until its real id arrives', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.diff')
        return {
          threadId: 'workspace-checkout',
          version: 'tree-1',
          files: [{ path: 'src/index.ts', status: 'modified', binary: false, hunks: [] }],
        } satisfies SessionDiff
      if (method === 'backgroundModel.generateCommitMessage') return { message: 'chore: draft' }
      throw new Error(`unexpected method ${method}`)
    })

    render(
      <WorkspaceReview
        transport={new TestTransport(request)}
        projectPath="/repo"
        threadId="pending:new"
        branch="main"
        theme="dark"
      />,
    )

    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft commit message' }))
    expect(await screen.findByDisplayValue('chore: draft')).toBeTruthy()
    expect(request.mock.calls).toEqual([
      ['workspace.diff', { projectPath: '/repo' }],
      ['backgroundModel.generateCommitMessage', { projectPath: '/repo' }],
    ])
  })

  it('drops a draft still being written when a refresh finds other changes', async () => {
    let diff: SessionDiff = {
      threadId: 'workspace-checkout',
      version: 'tree-1',
      files: [
        {
          path: 'src/index.ts',
          status: 'modified',
          binary: false,
          hunks: [],
        },
      ],
    }
    let finishDraft!: (value: { message: string }) => void
    const draft = new Promise<{ message: string }>((resolve) => {
      finishDraft = resolve
    })
    const request = vi.fn((method: string) => {
      if (method === 'workspace.diff') return Promise.resolve(diff)
      if (method === 'backgroundModel.generateCommitMessage') return draft
      return Promise.reject(new Error(`unexpected method ${method}`))
    })

    render(
      <WorkspaceReview
        transport={new TestTransport(request)}
        projectPath="/repo"
        branch="main"
        theme="dark"
      />,
    )

    await screen.findByText('src/index.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    const generate = screen.getByRole('button', { name: 'Draft commit message' })
    fireEvent.click(generate)
    diff = { ...diff, version: 'tree-2' }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false))
    await act(async () => finishDraft({ message: 'stale draft' }))

    expect(screen.queryByDisplayValue('stale draft')).toBeNull()
  })

  it('refreshes after a turn in this chat completes and after a reconnect', async () => {
    vi.useFakeTimers()
    let diff: SessionDiff = { threadId: 'thread-1', version: 'tree-1', files: [] }
    const transport = new TestTransport((method) => {
      if (method === 'workspace.diff') return diff
      throw new Error(`unexpected method ${method}`)
    })
    const completeTurn = (threadId: string) =>
      transport.emit('thread.event', {
        threadId,
        event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
      })
    const diffRequests = () =>
      transport.requests.filter((request) => request.method === 'workspace.diff').length

    render(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        threadId="thread-1"
        branch="main"
        theme="dark"
      />,
    )
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Working tree is clean')).toBeTruthy()

    diff = {
      threadId: 'thread-1',
      version: 'tree-2',
      files: [{ path: 'src/index.ts', status: 'modified', binary: false, hunks: [] }],
    }
    act(() => completeTurn('thread-2'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(diffRequests()).toBe(1)

    act(() => completeTurn('thread-1'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(diffRequests()).toBe(2)
    expect(screen.getByText('src/index.ts')).toBeTruthy()
    expect(screen.queryByText('Working tree is clean')).toBeNull()

    act(() => transport.emitState('open'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(diffRequests()).toBe(3)
  })

  it('keeps a commit draft across an automatic refresh until the changes differ', async () => {
    vi.useFakeTimers()
    const file: SessionDiff['files'][number] = {
      path: 'src/index.ts',
      status: 'modified',
      binary: false,
      hunks: [],
    }
    let diff: SessionDiff = { threadId: 'thread-1', version: 'tree-1', files: [file] }
    let finishDraft!: (value: { message: string }) => void
    const transport = new TestTransport((method) => {
      if (method === 'workspace.diff') return diff
      if (method === 'backgroundModel.generateCommitMessage')
        return new Promise((resolve) => {
          finishDraft = resolve
        })
      throw new Error(`unexpected method ${method}`)
    })
    render(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        threadId="thread-1"
        branch="main"
        theme="dark"
      />,
    )
    await act(() => vi.advanceTimersByTimeAsync(0))

    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft commit message' }))
    act(() => transport.emitState('open'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    await act(async () => finishDraft({ message: 'fix: keep this draft' }))
    expect(screen.getByDisplayValue('fix: keep this draft')).toBeTruthy()

    act(() =>
      transport.emit('thread.event', {
        threadId: 'thread-1',
        event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getByDisplayValue('fix: keep this draft')).toBeTruthy()

    diff = { threadId: 'thread-1', version: 'tree-2', files: [file] }
    act(() => transport.emitState('open'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.queryByDisplayValue('fix: keep this draft')).toBeNull()

    // A message the user wrote is theirs: other changes do not erase it.
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'fix: my own words' },
    })
    diff = { threadId: 'thread-1', version: 'tree-3', files: [file] }
    act(() => transport.emitState('open'))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getByDisplayValue('fix: my own words')).toBeTruthy()
  })
})

const changed: SessionDiff = {
  threadId: 'thread-1',
  version: 'tree-1',
  files: [
    { path: 'src/index.ts', status: 'modified', binary: false, hunks: [] },
    { path: 'src/new.ts', status: 'added', binary: false, hunks: [] },
  ],
}
const clean: SessionDiff = { threadId: 'thread-1', version: 'tree-2', files: [] }

/** A checkout whose answers the test changes as git would. */
function gitCheckout(initial: { diff: SessionDiff }) {
  const state = { ...initial }
  const answers: Partial<Record<string, (params: unknown) => unknown>> = {}
  const transport = new TestTransport(async (method, params) => {
    if (method === 'workspace.diff') return state.diff
    const answer = answers[method]
    if (!answer) throw new Error(`unexpected method ${method}`)
    return answer(params)
  })
  const calls = (method: string) =>
    transport.requests.filter((request) => request.method === method).map((r) => r.params)
  return { state, answers, transport, calls }
}

function renderReview(transport: TestTransport, props: { turnRunning?: boolean } = {}) {
  return render(
    <WorkspaceReview
      transport={transport}
      projectPath="/repo"
      threadId="thread-1"
      branch="feature/review"
      theme="dark"
      {...props}
    />,
  )
}

describe('WorkspaceReview git actions', () => {
  it('commits the written message with untracked files and closes onto the new diff', async () => {
    const { state, answers, transport, calls } = gitCheckout({ diff: changed })
    answers['workspace.commit'] = () => {
      state.diff = clean
      return { commit: 'a'.repeat(40), branch: 'feature/review' }
    }
    renderReview(transport)

    await screen.findByText('src/index.ts, src/new.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    const submit = screen.getByRole('button', { name: 'Commit 2 files' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'feat: review commits\n\nWhy it matters.' },
    })
    fireEvent.click(submit)

    expect(await screen.findByText('Committed aaaaaaa to feature/review')).toBeTruthy()
    expect(calls('workspace.commit')).toEqual([
      {
        projectPath: '/repo',
        threadId: 'thread-1',
        message: 'feat: review commits\n\nWhy it matters.',
        includeUntracked: true,
      },
    ])
    // The status arrives with the new diff, never next to the committed changes.
    expect(screen.getByText('Working tree is clean')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Commit changes' })).toBeNull()
  })

  it('keeps the commit waiting while the chat works and shows why a commit failed', async () => {
    const { answers, transport } = gitCheckout({ diff: changed })
    answers['workspace.commit'] = () => {
      throw new Error('lint failed: src/index.ts')
    }
    const view = renderReview(transport, { turnRunning: true })

    await screen.findByText('src/index.ts, src/new.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'fix: wait' },
    })
    const submit = screen.getByRole('button', { name: 'Commit 2 files' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.title).toBe('Wait until the chat finishes its turn.')

    view.rerender(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        threadId="thread-1"
        branch="feature/review"
        theme="dark"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Commit 2 files' }))
    expect((await screen.findByRole('alert')).textContent).toBe('lint failed: src/index.ts')
    expect(screen.getByDisplayValue('fix: wait')).toBeTruthy()
  })

  it('submits with the keyboard shortcut and closes on Escape', async () => {
    const { state, answers, transport, calls } = gitCheckout({ diff: changed })
    answers['workspace.commit'] = () => {
      state.diff = clean
      return { commit: 'c'.repeat(40) }
    }
    renderReview(transport)

    await screen.findByText('src/index.ts, src/new.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    const field = screen.getByRole('textbox', { name: 'Commit message' })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Commit message' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'chore: keys' },
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit message' }), {
      key: 'Enter',
      ctrlKey: true,
    })
    expect(await screen.findByText('Committed ccccccc')).toBeTruthy()
    expect(calls('workspace.commit')).toHaveLength(1)
  })
})
