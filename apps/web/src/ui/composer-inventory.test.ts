import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { cachedInventory, inventoryChanged, loadInventory } from './composer-inventory.js'

const place = { provider: 'claude-code' as const, projectPath: '/work/site' }
const answer = (name: string) => ({
  commands: [{ name, description: `${name} command` }],
  loading: false,
})

function transport(request: (method: string, params: unknown) => Promise<unknown>): Transport {
  return { request: vi.fn(request) } as unknown as Transport
}

describe('composer inventory cache', () => {
  it('keeps the last answer per connection, provider, project and chat', async () => {
    const first = transport(async () => answer('taste-pro'))
    const second = transport(async () => answer('other'))

    expect(cachedInventory(first, 'commands', place)).toBeUndefined()
    await loadInventory(first, 'commands', place)

    expect(cachedInventory(first, 'commands', place)).toEqual(answer('taste-pro'))
    expect(cachedInventory(second, 'commands', place)).toBeUndefined()
    expect(cachedInventory(first, 'commands', { ...place, threadId: 'chat-1' })).toBeUndefined()
    expect(cachedInventory(first, 'commands', { ...place, provider: 'codex' })).toBeUndefined()
    // Skills and servers are the project's, whichever chat asks.
    await loadInventory(first, 'skills', { ...place, threadId: 'chat-1' })
    expect(cachedInventory(first, 'skills', { ...place, threadId: 'chat-2' })).toBeDefined()
  })

  it('shares one request between everyone asking for the same list at once', async () => {
    let resolve!: (value: unknown) => void
    const connection = transport(() => new Promise((done) => (resolve = done)))

    const one = loadInventory(connection, 'commands', place)
    const two = loadInventory(connection, 'commands', place)
    await Promise.resolve()
    resolve(answer('taste-pro'))

    await expect(one).resolves.toEqual(answer('taste-pro'))
    await expect(two).resolves.toEqual(answer('taste-pro'))
    expect(connection.request).toHaveBeenCalledTimes(1)
    expect(connection.request).toHaveBeenCalledWith('commands.list', place)
  })

  it('asks again after a change instead of joining an answer that predates it', async () => {
    const answers = [answer('before'), answer('after')]
    const pending: Array<(value: unknown) => void> = []
    const connection = transport(() => new Promise((done) => pending.push(done)))

    const stale = loadInventory(connection, 'commands', place)
    await Promise.resolve()
    inventoryChanged(connection, ['commands'], place)
    const fresh = loadInventory(connection, 'commands', place)
    await Promise.resolve()
    pending[1]!(answers[1])
    pending[0]!(answers[0])

    await expect(fresh).resolves.toEqual(answers[1])
    await expect(stale).resolves.toEqual(answers[0])
    expect(cachedInventory(connection, 'commands', place)).toEqual(answers[1])
  })

  it('keeps the last answer through a failed request', async () => {
    let fail = false
    const connection = transport(async () => {
      if (fail) throw new Error('offline')
      return answer('taste-pro')
    })
    await loadInventory(connection, 'commands', place)
    fail = true

    await expect(loadInventory(connection, 'commands', place)).rejects.toThrow('offline')
    expect(cachedInventory(connection, 'commands', place)).toEqual(answer('taste-pro'))
  })

  it('answers no commands from a server that does not know the method', async () => {
    const connection = transport(async () => {
      throw new Error('Unknown method: commands.list')
    })

    await expect(loadInventory(connection, 'commands', place)).resolves.toEqual({
      commands: [],
      loading: false,
    })
  })
})
