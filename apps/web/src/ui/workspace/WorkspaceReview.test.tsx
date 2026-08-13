// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
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
})
