// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionDiff } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport.js'
import { WorkspaceReview } from './WorkspaceReview.js'

vi.mock('@pierre/diffs/react', () => ({
  CodeView: ({ items }: { items: Array<{ fileDiff: { name: string } }> }) => (
    <div>{items.map((item) => item.fileDiff.name).join(', ')}</div>
  ),
}))

afterEach(cleanup)

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
        transport={{ request } as unknown as Transport}
        projectPath="/repo"
        branch="main"
        theme="dark"
      />,
    )

    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('workspace.diff', { projectPath: '/repo' })
    expect(screen.queryByText(/isolated session/i)).toBeNull()
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
        transport={{ request } as unknown as Transport}
        projectPath="/repo"
        threadId="thread-1"
        branch="main"
        theme="dark"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Draft commit message' }))

    expect(await screen.findByText('fix(review): keep commit drafts cheap')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('backgroundModel.generateCommitMessage', {
      projectPath: '/repo',
      threadId: 'thread-1',
    })
  })

  it('drops an obsolete commit draft when the diff is refreshed', async () => {
    const diff = {
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
    } satisfies SessionDiff
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
        transport={{ request } as unknown as Transport}
        projectPath="/repo"
        branch="main"
        theme="dark"
      />,
    )

    const generate = await screen.findByRole('button', { name: 'Draft commit message' })
    fireEvent.click(generate)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false))
    await act(async () => finishDraft({ message: 'stale draft' }))

    expect(screen.queryByText('stale draft')).toBeNull()
  })
})
