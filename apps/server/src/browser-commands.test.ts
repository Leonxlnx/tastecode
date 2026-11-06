import type { BrowserCommand } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCommandCoordinator, BrowserCommandError } from './browser-commands.js'

type Window = { name: string }

function coordinator(timeoutMs = 30_000) {
  const sent: Array<{ window: Window; command: BrowserCommand }> = []
  const cancelled: Array<{ window: Window; commandId: string }> = []
  const browser = new BrowserCommandCoordinator<Window>(
    (window, command) => sent.push({ window, command }),
    (window, commandId) => cancelled.push({ window, commandId }),
    timeoutMs,
  )
  return { browser, sent, cancelled }
}

afterEach(() => vi.useRealTimers())

describe('browser commands', () => {
  it('fails at once when no window shows the chat', async () => {
    const { browser, sent } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['other-chat'])
    browser.setCapability({ name: 'old client' }, undefined, ['chat-1'])
    await expect(browser.run('chat-1', { action: 'screenshot' })).rejects.toThrow(
      'No TasteCode window shows this chat',
    )
    expect(sent).toEqual([])
  })

  it('runs a command in the window showing the chat and returns its answer', async () => {
    const { browser, sent } = coordinator()
    const window = { name: 'a' }
    browser.setCapability({ name: 'b' }, true, ['chat-2'])
    browser.setCapability(window, true, ['chat-1'])
    const running = browser.run('chat-1', { action: 'open', url: 'http://127.0.0.1:5173/' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      window,
      command: { threadId: 'chat-1', action: 'open', url: 'http://127.0.0.1:5173/' },
    })
    browser.complete(window, { commandId: sent[0]!.command.commandId, ok: true, title: 'Shop' })
    await expect(running).resolves.toMatchObject({ ok: true, title: 'Shop' })
  })

  // main's three cases for P5b.
  it('replaces a window’s chats when it sends them again, instead of adding them', async () => {
    const { browser } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1'])
    browser.setCapability(window, true, ['chat-2'])
    await expect(browser.run('chat-1', { action: 'screenshot' })).rejects.toThrow(
      'No TasteCode window shows this chat',
    )
  })

  it('drops the chats of a window that disconnects, and ends its running commands', async () => {
    const { browser, sent } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1'])
    const running = browser.run('chat-1', { action: 'screenshot' })
    browser.remove(window)
    await expect(running).rejects.toThrow('The TasteCode window showing the chat closed.')
    await expect(browser.run('chat-1', { action: 'screenshot' })).rejects.toThrow(
      'No TasteCode window shows this chat',
    )
    expect(sent).toHaveLength(1)
  })

  it('sends one command to one window when two windows show the chat', async () => {
    const { browser, sent } = coordinator()
    browser.setCapability({ name: 'a' }, true, ['chat-1'])
    browser.setCapability({ name: 'b' }, true, ['chat-1'])
    void browser.run('chat-1', { action: 'screenshot' }).catch(() => undefined)
    void browser.run('chat-1', { action: 'read_text' }).catch(() => undefined)
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map(({ command }) => command.commandId)).size).toBe(2)
    for (const { command } of sent)
      expect(sent.filter((entry) => entry.command.commandId === command.commandId)).toHaveLength(1)
  })

  it('passes a refusal on with its reason', async () => {
    const { browser, sent } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1'])
    const running = browser.run('chat-1', { action: 'type', selector: '#pw', text: 'x' })
    browser.complete(window, {
      commandId: sent[0]!.command.commandId,
      ok: false,
      error: 'That is a password field.',
    })
    await expect(running).rejects.toThrow(new BrowserCommandError('That is a password field.'))
  })

  it('ends a command after its time, a stopped turn or a cancelled call, and says so', async () => {
    vi.useFakeTimers()
    const { browser, sent, cancelled } = coordinator(30_000)
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1', 'chat-2'])

    const slow = browser.run('chat-1', { action: 'screenshot' })
    const slowFailure = expect(slow).rejects.toThrow('The browser did not answer within 30 s.')
    await vi.advanceTimersByTimeAsync(30_000)
    await slowFailure

    const stopped = browser.run('chat-2', { action: 'screenshot' })
    browser.cancelThread('chat-2')
    await expect(stopped).rejects.toThrow('The turn stopped.')

    const controller = new AbortController()
    const call = browser.run('chat-1', { action: 'screenshot' }, controller.signal)
    controller.abort()
    await expect(call).rejects.toThrow('The call was cancelled.')

    expect(cancelled.map(({ commandId }) => commandId)).toEqual(
      sent.map(({ command }) => command.commandId),
    )
  })

  it('ends a command when its window stops showing the chat', async () => {
    const { browser } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1'])
    const running = browser.run('chat-1', { action: 'screenshot' })
    browser.setCapability(window, true, ['chat-2'])
    await expect(running).rejects.toThrow('The chat is no longer shown in TasteCode.')
  })

  it('refuses a page outside http and https, and an answer from another window', () => {
    const { browser, sent } = coordinator()
    const window = { name: 'a' }
    browser.setCapability(window, true, ['chat-1'])
    expect(() => browser.run('chat-1', { action: 'open', url: 'file:///C:/secret.txt' })).toThrow()
    expect(sent).toEqual([])
    void browser.run('chat-1', { action: 'screenshot' }).catch(() => undefined)
    expect(() =>
      browser.complete({ name: 'b' }, { commandId: sent[0]!.command.commandId, ok: true }),
    ).toThrow('Unknown browser command')
  })
})
