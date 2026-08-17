// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionDiff } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { requiredInstance } from '../../test-dom.js'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceReview, type WorkspaceCodeView } from './WorkspaceReview.js'

const TestCodeView = (() => <div>src/index.ts</div>) satisfies WorkspaceCodeView

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
    const transport = new TestTransport(async (method) => {
      if (method === 'workspace.diff') return diff
      throw new Error(`unexpected method ${method}`)
    })

    render(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        branch="main"
        theme="dark"
        codeViewComponent={TestCodeView}
      />,
    )

    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    expect(transport.requests).toContainEqual({
      method: 'workspace.diff',
      params: { projectPath: '/repo' },
    })
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
    const transport = new TestTransport(async (method) => {
      if (method === 'workspace.diff') return diff
      if (method === 'backgroundModel.generateCommitMessage') {
        return { message: 'fix(review): keep commit drafts cheap' }
      }
      throw new Error(`unexpected method ${method}`)
    })

    render(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        threadId="thread-1"
        branch="main"
        theme="dark"
        codeViewComponent={TestCodeView}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Draft commit message' }))

    expect(await screen.findByText('fix(review): keep commit drafts cheap')).toBeTruthy()
    expect(transport.requests).toContainEqual({
      method: 'backgroundModel.generateCommitMessage',
      params: { projectPath: '/repo', threadId: 'thread-1' },
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
    const transport = new TestTransport(async (method) => {
      if (method === 'workspace.diff') return diff
      if (method === 'backgroundModel.generateCommitMessage') return draft
      throw new Error(`unexpected method ${method}`)
    })

    render(
      <WorkspaceReview
        transport={transport}
        projectPath="/repo"
        branch="main"
        theme="dark"
        codeViewComponent={TestCodeView}
      />,
    )

    const generate = await screen.findByRole('button', { name: 'Draft commit message' })
    fireEvent.click(generate)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect(requiredInstance(generate, HTMLButtonElement).disabled).toBe(false))
    await act(async () => finishDraft({ message: 'stale draft' }))

    expect(screen.queryByText('stale draft')).toBeNull()
  })
})
