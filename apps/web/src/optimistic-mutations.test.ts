import { describe, expect, it, vi } from 'vitest'
import { OptimisticMutations } from './optimistic-mutations.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('optimistic mutation recovery', () => {
  it.each(['project:name', 'project:pinned', 'thread:title', 'thread:pinned'])(
    'reads saved state after a failed %s write',
    async (key) => {
      const notice = vi.fn(),
        apply = vi.fn()
      const mutations = new OptimisticMutations(notice)
      await mutations.run(
        key,
        async () => {
          throw new Error('Save refused')
        },
        async () => apply,
      )
      expect(notice).toHaveBeenCalledWith('Save refused')
      expect(apply).toHaveBeenCalledOnce()
    },
  )

  it('does not let an older failed write or late recovery undo a newer edit', async () => {
    const read = deferred<() => void>()
    const oldApply = vi.fn(),
      newSave = vi.fn(async () => {})
    const mutations = new OptimisticMutations(() => {})
    const recover = vi.fn(() => read.promise)
    const first = mutations.run(
      'thread:title',
      async () => {
        throw new Error('refused')
      },
      recover,
    )
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    const second = mutations.run('thread:title', newSave, async () => () => {})
    read.resolve(oldApply)
    await Promise.all([first, second])
    expect(oldApply).not.toHaveBeenCalled()
    expect(newSave).toHaveBeenCalledOnce()
  })

  it('retries a failed recovery read on reconnect without repeating the write', async () => {
    const save = vi.fn(async () => {
      throw new Error('Connection lost')
    })
    const apply = vi.fn()
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(apply)
    const mutations = new OptimisticMutations(() => {})
    await mutations.run('project:pinned', save, read)
    mutations.reconcile()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
    mutations.reconcile()
    expect(save).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
