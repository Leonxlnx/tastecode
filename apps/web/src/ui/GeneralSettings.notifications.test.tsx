// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const desktop = vi.hoisted(() => ({ canNotifyChats: true }))

vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  get canNotifyChats() {
    return desktop.canNotifyChats
  },
}))

const { CHAT_NOTIFICATIONS_KEY, writeChatNotificationMode } =
  await import('../chat-notifications.js')
const { GeneralSettings } = await import('./GeneralSettings.js')

/** Other settings offer their own Off; these queries stay inside Notifications. */
const notifications = () => within(screen.getByRole('radiogroup', { name: 'Notifications' }))

function renderGeneral() {
  return render(
    <GeneralSettings
      sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
      onSidebarSettingsChange={() => {}}
    />,
  )
}

afterEach(() => {
  cleanup()
  desktop.canNotifyChats = true
  act(() => writeChatNotificationMode('needs-you'))
  localStorage.clear()
})

describe('notification setting', () => {
  it('offers three choices, telling the user when a chat needs them by default', () => {
    renderGeneral()
    const group = screen.getByRole('radiogroup', {
      name: 'Notifications',
      description:
        'While TasteCode is in the background, for approvals, questions and failures, or also when a chat finishes.',
    })
    const choices = [...group.querySelectorAll('[role=radio]')].map((radio) => ({
      label: radio.textContent,
      checked: radio.getAttribute('aria-checked'),
    }))
    expect(choices).toEqual([
      { label: 'Off', checked: 'false' },
      { label: 'Needs me', checked: 'true' },
      { label: 'Also finished', checked: 'false' },
    ])
  })

  it('pictures the notifications each choice sends', () => {
    renderGeneral()
    const toasts = (name: string) =>
      [...notifications().getByRole('radio', { name }).querySelectorAll('.gwin__toast')].map(
        (toast) => toast.getAttribute('data-kind'),
      )
    expect(toasts('Off')).toEqual([])
    expect(toasts('Needs me')).toEqual(['needs-you'])
    expect(toasts('Also finished')).toEqual(['finished', 'needs-you'])
  })

  it('saves a choice made by click or with the arrow keys', () => {
    renderGeneral()
    fireEvent.click(notifications().getByRole('radio', { name: 'Also finished' }))
    expect(localStorage.getItem(CHAT_NOTIFICATIONS_KEY)).toBe('needs-you-or-finished')
    const chosen = notifications().getByRole('radio', { name: 'Also finished' })
    expect(chosen.getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(chosen, { key: 'ArrowRight' })
    expect(localStorage.getItem(CHAT_NOTIFICATIONS_KEY)).toBe('off')
    expect(document.activeElement).toBe(notifications().getByRole('radio', { name: 'Off' }))
  })

  it('is not offered where nothing could show a notification', () => {
    desktop.canNotifyChats = false
    renderGeneral()
    expect(screen.queryByRole('radiogroup', { name: 'Notifications' })).toBeNull()
  })
})
