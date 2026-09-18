// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { FileDiffOptions } from '@pierre/diffs'
import { PullRequestDiffRenderer } from './PullRequestDiffRenderer.js'

let reportRender: FileDiffOptions<unknown>['onPostRender']

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ options }: { options: FileDiffOptions<unknown> }) => {
    reportRender = options.onPostRender
    return <div data-testid="rendered-diff" />
  },
}))

afterEach(() => {
  cleanup()
  reportRender = undefined
})

function setup() {
  render(
    <PullRequestDiffRenderer
      file={{
        sha: 'file-oid',
        path: 'example.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: '@@ -1 +1 @@\n-old\n+new',
      }}
      cacheKey="example"
      annotations={[]}
      renderAnnotation={() => null}
      onCommentLine={vi.fn()}
    />,
  )
  return screen.getByTestId('rendered-diff')
}

describe('pull request diff loading', () => {
  it.each(['content', 'error'] as const)('uncovers the renderer after it paints %s', (result) => {
    const host = setup()
    expect(screen.getByRole('status').textContent).toContain('Preparing diff')
    const shadow = host.attachShadow({ mode: 'open' })
    const content = document.createElement(result === 'content' ? 'pre' : 'div')
    if (result === 'error') content.dataset['errorWrapper'] = ''
    const text = document.createElement('code')
    text.textContent = result === 'content' ? 'new' : 'Unable to highlight this file'
    content.append(text)
    shadow.append(content)

    act(() => reportRender?.(host, {} as never, 'mount'))

    expect(screen.queryByRole('status')).toBeNull()
    expect(host.shadowRoot?.textContent).toContain(text.textContent)
  })
})
