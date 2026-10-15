// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FeedbackSubmitResult } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeedbackRequest } from '../feedback-state.js'
import type { Transport } from '../transport.js'
import { FeedbackDialog } from './FeedbackDialog.js'

afterEach(cleanup)

type Call = { method: string; params: Record<string, unknown> }

function fakeTransport(submit: () => FeedbackSubmitResult | Promise<FeedbackSubmitResult>) {
  const calls: Call[] = []
  const transport = {
    state: 'open',
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'feedback.preview') {
        return {
          payload: JSON.stringify({ kind: params['kind'], message: params['message'] }, null, 2),
          redactions: 2,
        }
      }
      if (method === 'feedback.submit') return submit()
      throw new Error(`Unexpected request: ${method}`)
    }),
  } as unknown as Transport
  return { transport, calls }
}

const errorRequest: FeedbackRequest = {
  id: 1,
  source: 'error_report',
  context: {
    threadId: 'th1',
    provider: 'codex',
    model: 'gpt-5-codex',
    surface: 'chat',
    error: { kind: 'turn', message: 'Codex exited unexpectedly' },
  },
}

function renderDialog(
  submit: () => FeedbackSubmitResult | Promise<FeedbackSubmitResult> = () => ({ ok: true }),
  overrides: Partial<Parameters<typeof FeedbackDialog>[0]> = {},
) {
  const { transport, calls } = fakeTransport(submit)
  const onSent = vi.fn()
  const onClose = vi.fn()
  const onStatusChange = vi.fn()
  render(
    <FeedbackDialog
      transport={transport}
      request={errorRequest}
      status={{ enabled: true }}
      onSent={onSent}
      onClose={onClose}
      onStatusChange={onStatusChange}
      {...overrides}
    />,
  )
  return { calls, onSent, onClose, onStatusChange }
}

const sendButton = () => screen.getByRole('button', { name: /^(Send|Sending…|Wait .*)$/ })

describe('FeedbackDialog', () => {
  it('reports an error as a bug and shows the exact server-built payload before sending', async () => {
    const { calls } = renderDialog()
    expect(screen.getByRole('dialog', { name: 'Report a problem' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveProperty('checked', true)
    expect(screen.getByLabelText('Add a note (optional)')).toBe(document.activeElement)
    expect(
      screen
        .getByRole('switch', { name: 'Include the error message' })
        .getAttribute('aria-checked'),
    ).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Show exactly what will be sent' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Feedback payload').textContent).toContain('"kind": "bug"'),
    )
    expect(screen.getByText('2 items were redacted.')).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({
      method: 'feedback.preview',
      params: {
        includeError: true,
        includeDiagnostics: true,
        context: { source: 'error_report', error: { kind: 'turn' } },
      },
    })
  })

  it('sends only on Send, once, and hands success back to the app', async () => {
    let finish!: (result: FeedbackSubmitResult) => void
    const { calls, onSent, onStatusChange } = renderDialog(
      () => new Promise((resolve) => (finish = resolve)),
    )
    expect(calls.filter((call) => call.method === 'feedback.submit')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Add a note (optional)'), {
      target: { value: 'Happened twice today.' },
    })
    fireEvent.click(sendButton())
    fireEvent.click(sendButton())
    await waitFor(() => expect(sendButton().textContent).toBe('Sending…'))
    finish({ ok: true })
    await waitFor(() => expect(onSent).toHaveBeenCalledOnce())
    const submits = calls.filter((call) => call.method === 'feedback.submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]?.params).toMatchObject({
      kind: 'bug',
      message: 'Happened twice today.',
      submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(onStatusChange).toHaveBeenCalled()
  })

  it('keeps the text and counts down when the server asks to wait', async () => {
    const { onSent } = renderDialog(() => ({
      ok: false,
      code: 'cooldown',
      message: 'Wait 30 s before sending again.',
      retryAfterMs: 30_000,
    }))
    fireEvent.change(screen.getByLabelText('Add a note (optional)'), {
      target: { value: 'Second report' },
    })
    fireEvent.click(sendButton())
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Wait 30 s before sending again.',
    )
    expect(sendButton().textContent).toBe('Wait 30 s')
    expect(sendButton()).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Add a note (optional)')).toHaveProperty('value', 'Second report')
    expect(onSent).not.toHaveBeenCalled()
  })

  it('needs words or an attached error, and a full email when one is typed', () => {
    renderDialog(undefined, {
      request: { id: 2, source: 'account_menu', context: { provider: 'codex' } },
    })
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Other' })).toHaveProperty('checked', true)
    expect(screen.queryByRole('switch', { name: 'Include the error message' })).toBeNull()
    expect(sendButton()).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Love the new sidebar' },
    })
    expect(sendButton()).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@' } })
    expect(screen.getByText('Enter a full email address, or leave it empty.')).toBeTruthy()
    expect(sendButton()).toHaveProperty('disabled', true)
  })

  it('sends with Ctrl+Enter and closes with Escape', async () => {
    const { calls, onClose } = renderDialog()
    const note = screen.getByLabelText('Add a note (optional)')
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'feedback.submit')).toHaveLength(1),
    )
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows a paused inbox and its wait instead of a working Send', () => {
    renderDialog(undefined, { status: { enabled: true, reason: 'paused', retryAfterMs: 600_000 } })
    expect(screen.getByRole('alert').textContent).toBe(
      'Feedback is paused right now. Try again later.',
    )
    expect(sendButton().textContent).toBe('Wait 10 min')
    expect(sendButton()).toHaveProperty('disabled', true)
  })
})
