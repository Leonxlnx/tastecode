// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UsageResetNotice, type UsageResetNoticeProps } from './UsageResetNotice.js'

afterEach(cleanup)
const props = (): UsageResetNoticeProps => ({
  source: 'Codex · GPT',
  resetsAt: Date.now() + 3_600_000,
  scheduled: false,
  schedule: vi.fn(async () => {}),
  cancel: vi.fn(),
})

it('shows the provider reset, schedules on click and offers cancellation', async () => {
  const input = props()
  const view = render(<UsageResetNotice {...input} />)
  expect(screen.getByText(/Keep TasteCode open/)).toBeTruthy()
  expect(view.container.querySelector('time')?.dateTime).toBe(
    new Date(input.resetsAt!).toISOString(),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Resume at reset' }))
  await waitFor(() => expect(input.schedule).toHaveBeenCalledOnce())
  view.rerender(<UsageResetNotice {...input} scheduled />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel auto-resume' }))
  expect(input.cancel).toHaveBeenCalledOnce()
  expect(screen.getByText('Snoozed until usage resets')).toBeTruthy()
})

it('keeps scheduling disabled when no reset time was supplied', () => {
  const input = props()
  render(<UsageResetNotice {...input} resetsAt={undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume at reset' }))
  expect(input.schedule).not.toHaveBeenCalled()
  expect(screen.getByText('This provider has not shared a reset time yet.')).toBeTruthy()
})

it('shows a failed save and lets the user try again', async () => {
  const input = props()
  input.schedule = vi.fn().mockRejectedValue(new Error('Offline'))
  render(<UsageResetNotice {...input} />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume at reset' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Resume at reset' }).disabled,
    ).toBe(false),
  )
})
