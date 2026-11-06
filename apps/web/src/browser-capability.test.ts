// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('./bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge.js')>()),
  isDesktop: true,
}))

const {
  clearAgentBrowserEvents,
  clientCapabilities,
  deliverAgentBrowserEvent,
  receiveAgentBrowserEvents,
  showBrowserThread,
} = await import('./browser-capability.js')

const ID = '00000000-0000-4000-8000-000000000001'

describe('agent browser capability', () => {
  it('names the shown chat, again on each switch, and none once it is gone', async () => {
    const sent: unknown[] = []
    const send = async (capabilities: unknown) => sent.push(capabilities)
    const hideFirst = showBrowserThread(send, 'chat-1')
    const hideSecond = showBrowserThread(send, 'chat-2')
    hideFirst()
    hideSecond()
    expect(sent.map((value) => (value as { browserThreads: string[] }).browserThreads)).toEqual([
      ['chat-1'],
      ['chat-1', 'chat-2'],
      ['chat-2'],
      [],
    ])
    expect(clientCapabilities()).toMatchObject({ browserTools: true, browserThreads: [] })
  })

  // The workspace panel loads on first use; a command that came first must still reach it.
  it('keeps what arrived before the panel listened, and hands it over in order', () => {
    const command = { threadId: 'chat-1', commandId: ID, action: 'screenshot' as const }
    deliverAgentBrowserEvent({ kind: 'command', command })
    deliverAgentBrowserEvent({ kind: 'cancel', commandId: ID })
    const heard: unknown[] = []
    const stop = receiveAgentBrowserEvents((event) => heard.push(event))
    expect(heard).toEqual([
      { kind: 'command', command },
      { kind: 'cancel', commandId: ID },
    ])
    deliverAgentBrowserEvent({ kind: 'cancel', commandId: ID })
    expect(heard).toHaveLength(3)
    stop()
    deliverAgentBrowserEvent({ kind: 'cancel', commandId: ID })
    expect(heard).toHaveLength(3)
    // What waited for a later panel does not grow without bound.
    for (let index = 0; index < 20; index++)
      deliverAgentBrowserEvent({ kind: 'cancel', commandId: ID })
    const later: unknown[] = []
    receiveAgentBrowserEvents((event) => later.push(event))()
    expect(later).toHaveLength(8)
  })

  // A command the server already timed out must not run when a panel loads minutes later.
  it('drops what waited longer than a command may take, and what waited for another chat', () => {
    const command = {
      threadId: 'chat-1',
      commandId: ID,
      action: 'click' as const,
      selector: '#buy',
    }
    deliverAgentBrowserEvent({ kind: 'command', command }, 1_000)
    deliverAgentBrowserEvent({ kind: 'cancel', commandId: ID }, 25_000)
    const heard: unknown[] = []
    receiveAgentBrowserEvents((event) => heard.push(event), 31_000)()
    expect(heard).toEqual([{ kind: 'cancel', commandId: ID }])

    deliverAgentBrowserEvent({ kind: 'command', command }, 40_000)
    clearAgentBrowserEvents()
    const afterSwitch: unknown[] = []
    receiveAgentBrowserEvents((event) => afterSwitch.push(event), 41_000)()
    expect(afterSwitch).toEqual([])
  })
})
