// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpdateChannelToggle } from './UpdateChannelToggle.js'

const setAppUpdateChannel = vi.hoisted(() => vi.fn())
vi.mock('../bridge.js', () => ({ setAppUpdateChannel }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  ['stable', false, 'beta'],
  ['beta', true, 'stable'],
] as const)('shows %s and asks the updater for the other channel', (channel, checked, next) => {
  setAppUpdateChannel.mockResolvedValue({ status: 'checking', currentVersion: '0.1.2' })
  render(<UpdateChannelToggle channel={channel} />)
  const toggle = screen.getByRole('switch', { name: 'Beta updates' })

  expect(toggle.getAttribute('aria-checked')).toBe(String(checked))
  fireEvent.click(toggle)
  expect(setAppUpdateChannel).toHaveBeenCalledWith(next)
})

it('keeps a refused switch from surfacing as an unhandled rejection', async () => {
  setAppUpdateChannel.mockRejectedValue(new Error('Unknown update channel'))
  render(<UpdateChannelToggle channel="stable" />)
  fireEvent.click(screen.getByRole('switch', { name: 'Beta updates' }))
  await expect(setAppUpdateChannel.mock.results[0]!.value).rejects.toThrow()
})
