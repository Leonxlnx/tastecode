import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { AgentSession } from './adapters.js'
import type { DomainEvent, Thread } from '@harness/contracts'
import { mapProviderSession } from './provider-session.js'

it('resumes the native identity and maps emitted events back to the stable local chat', async () => {
  const emitter = new EventEmitter()
  const native = Object.assign(emitter, {
    capabilities: {
      steer: true,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: true,
    },
    sendTurn: vi.fn(async () => 'turn'),
    interrupt: vi.fn(async () => {}),
    dispose: vi.fn(),
    respondToApproval: vi.fn(),
  }) as unknown as AgentSession
  const thread: Thread = { id: 'native', provider: 'codex', workspacePath: '/work', createdAt: 1 }
  const mapped = mapProviderSession('external:codex:native', { thread, session: native })
  const events: DomainEvent[] = []
  mapped.session.on('event', (event) => events.push(event))
  emitter.emit('event', {
    type: 'turn.started',
    turn: { id: 'turn', threadId: 'native', createdAt: 1, status: 'running' },
  })
  await mapped.session.sendTurn(mapped.thread.id, 'Continue')
  await mapped.session.interrupt(mapped.thread.id)
  expect(native.sendTurn).toHaveBeenCalledWith('native', 'Continue')
  expect(native.interrupt).toHaveBeenCalledWith('native')
  expect(events[0]).toMatchObject({ turn: { threadId: 'external:codex:native' } })
  mapped.session.dispose()
  expect(native.dispose).toHaveBeenCalledOnce()
})
