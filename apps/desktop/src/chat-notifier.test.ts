import { describe, expect, it, vi } from 'vitest'
import { ChatNotifier, type ChatNotifierHost } from './chat-notifier.js'

function setup(options: { away?: boolean } = {}) {
  let away = options.away ?? true
  const shown: Array<{ title: string; body: string; click: () => void; close: () => void }> = []
  const host = {
    isAway: () => away,
    show: vi.fn((title: string, body: string, onClick: () => void) => {
      const notification = { title, body, click: onClick, close: vi.fn() }
      shown.push(notification)
      return notification
    }),
    setBadge: vi.fn(),
    openChat: vi.fn(),
  } satisfies ChatNotifierHost
  const notifier = new ChatNotifier(host)
  return {
    host,
    notifier,
    shown,
    setAway: (value: boolean) => {
      away = value
    },
  }
}

const working = (id: string, title = `Chat ${id}`) => ({ id, title, state: 'working' })
const waiting = (id: string, state: 'approval' | 'input' | 'failed', title = `Chat ${id}`) => ({
  id,
  title,
  state,
})

describe('ChatNotifier', () => {
  it('shows the chat title and what it needs, and badges it', () => {
    const { host, notifier, shown } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a', 'Fix login')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval', 'Fix login')] })
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'Fix login', body: 'Needs your approval' },
    ])
    expect(host.setBadge).toHaveBeenLastCalledWith(1)
  })

  it('opens the chat when its notification is clicked', () => {
    const { host, notifier, shown } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'input')] })
    shown[0]!.click()
    expect(host.openChat).toHaveBeenCalledWith('a')
    // A clicked notification leaves the centre; coming back does not close it twice.
    expect(shown[0]!.close).toHaveBeenCalledTimes(1)
    notifier.windowFocused()
    expect(shown[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('replaces a chat notification when the chat moves on', () => {
    const { notifier, shown } = setup()
    notifier.report({ mode: 'needs-you-or-finished', chats: [working('a')] })
    notifier.report({ mode: 'needs-you-or-finished', chats: [waiting('a', 'approval')] })
    notifier.report({ mode: 'needs-you-or-finished', chats: [] })
    expect(shown.map(({ body }) => body)).toEqual(['Needs your approval', 'Finished'])
    expect(shown[0]!.close).toHaveBeenCalledTimes(1)
    expect(shown[1]!.close).not.toHaveBeenCalled()
  })

  it('closes a notification whose chat stopped waiting without showing another', () => {
    const { notifier, shown } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval')] })
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    expect(shown).toHaveLength(1)
    expect(shown[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('clears every notification and the badge when the window comes back', () => {
    const { host, notifier, shown } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a'), working('b')] })
    notifier.report({
      mode: 'needs-you',
      chats: [waiting('a', 'approval'), waiting('b', 'failed')],
    })
    expect(host.setBadge).toHaveBeenLastCalledWith(2)
    notifier.windowFocused()
    expect(shown.every((notification) => notification.close.mock.calls.length === 1)).toBe(true)
    expect(host.setBadge).toHaveBeenLastCalledWith(0)
  })

  it('shows nothing for a chat that changes while the window is in front', () => {
    const { host, notifier } = setup({ away: false })
    notifier.report({ mode: 'needs-you-or-finished', chats: [working('a')] })
    notifier.report({ mode: 'needs-you-or-finished', chats: [waiting('a', 'approval')] })
    notifier.report({ mode: 'needs-you-or-finished', chats: [] })
    expect(host.show).not.toHaveBeenCalled()
    expect(host.setBadge).not.toHaveBeenCalled()
  })

  it('takes notifications and the badge down when they are turned off', () => {
    const { host, notifier, shown } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval')] })
    notifier.report({ mode: 'off', chats: [waiting('a', 'approval')] })
    expect(shown[0]!.close).toHaveBeenCalledTimes(1)
    expect(host.setBadge).toHaveBeenLastCalledWith(0)
  })

  it('does not repeat a notification after the page reloads', () => {
    const { host, notifier } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval')] })
    notifier.pageReplaced()
    // The reloaded page reports once its chat list has loaded.
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval'), waiting('b', 'input')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval'), waiting('b', 'input')] })
    expect(host.show).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed report', () => {
    const { host, notifier } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'loud', chats: [waiting('a', 'approval')] })
    notifier.report('approval')
    expect(host.show).not.toHaveBeenCalled()
  })

  it('touches the badge only when its count changes', () => {
    const { host, notifier } = setup()
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval'), working('b')] })
    expect(host.setBadge).toHaveBeenCalledTimes(1)
  })

  it('carries on when the OS cannot show a notification', () => {
    const { host, notifier } = setup()
    host.show.mockReturnValueOnce(undefined as never)
    notifier.report({ mode: 'needs-you', chats: [working('a')] })
    notifier.report({ mode: 'needs-you', chats: [waiting('a', 'approval')] })
    expect(host.setBadge).toHaveBeenLastCalledWith(1)
    notifier.dispose()
    expect(host.setBadge).toHaveBeenLastCalledWith(0)
  })
})
