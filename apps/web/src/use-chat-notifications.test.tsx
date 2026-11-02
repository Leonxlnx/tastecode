// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session } from './ui/Sidebar.js'

const bridge = vi.hoisted(() => ({
  reports: [] as unknown[],
  openChat: undefined as ((chatId: string) => void) | undefined,
  unsubscribed: 0,
}))

vi.mock('./bridge.js', () => ({
  canNotifyChats: true,
  reportChatAttention: (report: unknown) => bridge.reports.push(report),
  onOpenChatRequest: (listener: (chatId: string) => void) => {
    bridge.openChat = listener
    return () => {
      bridge.unsubscribed += 1
    }
  },
}))

const { useChatNotifications } = await import('./use-chat-notifications.js')
const { writeChatNotificationMode } = await import('./chat-notifications.js')

function projects(status: Session['status']): Project[] {
  return [
    {
      path: '/one',
      sessions: [
        {
          id: 'a',
          title: 'Fix login',
          provider: 'claude-code',
          createdAt: 0,
          status,
          lifecycle: { state: 'active', keepActive: false },
          unread: false,
        },
      ],
    },
  ]
}

beforeEach(() => {
  bridge.reports = []
  bridge.openChat = undefined
  bridge.unsubscribed = 0
})

afterEach(() => {
  cleanup()
  writeChatNotificationMode('needs-you')
  localStorage.clear()
})

describe('useChatNotifications', () => {
  it('waits for the chat list before reporting anything', () => {
    const view = renderHook(({ loaded, list }) => useChatNotifications(list, loaded, () => {}), {
      initialProps: { loaded: false, list: [] as Project[] },
    })
    expect(bridge.reports).toEqual([])
    view.rerender({ loaded: true, list: projects('working') })
    expect(bridge.reports).toEqual([
      { mode: 'needs-you', chats: [{ id: 'a', title: 'Fix login', state: 'working' }] },
    ])
  })

  it('reports each change once, and again when the setting changes', () => {
    const view = renderHook(({ list }) => useChatNotifications(list, true, () => {}), {
      initialProps: { list: projects('working') },
    })
    view.rerender({ list: projects('working') })
    expect(bridge.reports).toHaveLength(1)
    view.rerender({ list: projects('approval') })
    expect(bridge.reports).toHaveLength(2)
    act(() => writeChatNotificationMode('off'))
    expect(bridge.reports.at(-1)).toEqual({
      mode: 'off',
      chats: [{ id: 'a', title: 'Fix login', state: 'approval' }],
    })
  })

  it('opens a clicked chat with the latest callback, subscribed once', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = renderHook(({ open }) => useChatNotifications([], true, open), {
      initialProps: { open: first },
    })
    view.rerender({ open: second })
    bridge.openChat?.('a')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('a')
    expect(bridge.unsubscribed).toBe(0)
    view.unmount()
    expect(bridge.unsubscribed).toBe(1)
  })
})
