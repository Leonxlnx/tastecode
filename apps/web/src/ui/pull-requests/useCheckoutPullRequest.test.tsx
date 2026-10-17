// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckoutPullRequest, CheckoutPullRequestResult } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { useCheckoutPullRequest } from './useCheckoutPullRequest.js'

afterEach(cleanup)

const pullRequest: CheckoutPullRequest = {
  repository: 'Leonxlnx/tastecode',
  number: 1778,
  title: "feat(server): find the pull request for a chat's checkout",
  url: 'https://github.com/Leonxlnx/tastecode/pull/1778',
  state: 'OPEN',
  isDraft: false,
  checks: 'passing',
  headRefName: 'n16/agents-j3-pr-for-checkout',
}

function found(overrides: Partial<CheckoutPullRequest> = {}): CheckoutPullRequestResult {
  return {
    available: true,
    branch: 'n16/agents-j3-pr-for-checkout',
    repository: 'Leonxlnx/tastecode',
    pullRequest: { ...pullRequest, ...overrides },
    fetchedAt: 1,
  }
}

type Props = {
  projectPath: string | undefined
  sessionId: string | undefined
  running: boolean
  enabled: boolean
}

function setup(answer: (params: unknown) => unknown, initial: Partial<Props> = {}) {
  const transport = new TestTransport(async (method, params) => {
    if (method !== 'pullRequests.forCheckout') throw new Error(`unexpected ${method}`)
    return answer(params)
  })
  const hook = renderHook(
    (props: Props) =>
      useCheckoutPullRequest(
        transport,
        props.projectPath,
        props.sessionId,
        props.running,
        props.enabled,
      ),
    {
      initialProps: {
        projectPath: '/work/project',
        sessionId: 'thread-1',
        running: false,
        enabled: true,
        ...initial,
      },
    },
  )
  const asked = () => transport.requests.map((request) => request.params)
  return { transport, hook, asked }
}

describe('the chat checkout pull request', () => {
  it('asks once for the chat checkout and shows its pull request', async () => {
    const { hook, asked } = setup(() => found())
    await waitFor(() => expect(hook.result.current?.number).toBe(1778))
    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: false,
      enabled: true,
    })
    expect(asked()).toEqual([{ projectPath: '/work/project', threadId: 'thread-1' }])
  })

  it('asks for the project folder while a chat has not started', async () => {
    const { asked } = setup(() => found(), { sessionId: 'pending:new' })
    await waitFor(() => expect(asked()).toEqual([{ projectPath: '/work/project' }]))
  })

  it('shows nothing without a pull request, when unavailable or on an older server', async () => {
    for (const answer of [
      () => ({ available: true, branch: 'feature', fetchedAt: 1 }),
      () => ({ available: false, reason: 'gh_missing', fetchedAt: 1 }),
      () => {
        throw new Error('unknown method: pullRequests.forCheckout')
      },
    ]) {
      const { hook, transport } = setup(answer)
      await waitFor(() => expect(transport.requests).toHaveLength(1))
      await act(async () => {})
      expect(hook.result.current).toBeUndefined()
      hook.unmount()
    }
  })

  it('asks again when the chat turn ends, not while it runs', async () => {
    let state: CheckoutPullRequest['state'] = 'OPEN'
    const { hook, asked } = setup(() => found({ state }))
    await waitFor(() => expect(hook.result.current?.state).toBe('OPEN'))

    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: true,
      enabled: true,
    })
    expect(asked()).toHaveLength(1)
    state = 'MERGED'
    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: false,
      enabled: true,
    })
    await waitFor(() => expect(hook.result.current?.state).toBe('MERGED'))
    expect(asked()).toHaveLength(2)
  })

  it('keeps each chat answer, so switching back shows it at once', async () => {
    const { hook, asked } = setup((params) =>
      (params as { threadId?: string }).threadId === 'thread-2'
        ? { available: true, branch: 'main', fetchedAt: 1 }
        : found(),
    )
    await waitFor(() => expect(hook.result.current?.number).toBe(1778))

    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-2',
      running: false,
      enabled: true,
    })
    expect(hook.result.current).toBeUndefined()
    await waitFor(() => expect(asked()).toHaveLength(2))

    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: false,
      enabled: true,
    })
    // Shown from the last answer while the new one is on its way.
    expect(hook.result.current?.number).toBe(1778)
    await waitFor(() => expect(asked()).toHaveLength(3))
  })

  it('ignores an older answer that arrives after a newer one', async () => {
    const replies: Array<(value: CheckoutPullRequestResult) => void> = []
    const { hook } = setup(
      () => new Promise<CheckoutPullRequestResult>((resolve) => replies.push(resolve)),
    )
    await waitFor(() => expect(replies).toHaveLength(1))
    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: true,
      enabled: true,
    })
    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: false,
      enabled: true,
    })
    await waitFor(() => expect(replies).toHaveLength(2))

    await act(async () => replies[1]!(found({ state: 'MERGED' })))
    await act(async () => replies[0]!(found({ state: 'OPEN' })))
    expect(hook.result.current?.state).toBe('MERGED')
  })

  it('waits while the chat surface is hidden and asks again when it returns', async () => {
    const { hook, asked } = setup(() => found(), { enabled: false })
    await act(async () => {})
    expect(asked()).toEqual([])

    hook.rerender({
      projectPath: '/work/project',
      sessionId: 'thread-1',
      running: false,
      enabled: true,
    })
    await waitFor(() => expect(asked()).toHaveLength(1))
  })

  it('asks again when the connection reopens', async () => {
    const { transport, asked } = setup(() => found())
    await waitFor(() => expect(asked()).toHaveLength(1))
    act(() => transport.emitState('open'))
    await waitFor(() => expect(asked()).toHaveLength(2))
  })
})
