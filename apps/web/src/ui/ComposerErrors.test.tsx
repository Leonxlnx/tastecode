// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerErrors } from './ComposerErrors.js'

afterEach(cleanup)

describe('ComposerErrors', () => {
  it('dismisses one error while keeping the others and their recovery actions', () => {
    const retry = vi.fn()
    const errors = [
      { id: 'chat:1', message: 'Request failed' },
      {
        id: 'model:1',
        message: 'Models could not be loaded',
        action: { label: 'Retry models', run: retry },
      },
    ]
    const view = render(<ComposerErrors errors={errors} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error: Request failed' }))
    view.rerender(<ComposerErrors errors={errors.map((error) => ({ ...error }))} />)
    expect(screen.queryByText('Request failed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry models' }))
    expect(retry).toHaveBeenCalledOnce()
    view.rerender(
      <ComposerErrors errors={[...errors, { id: 'chat:2', message: 'Request failed' }]} />,
    )
    expect(screen.getByText('Request failed')).toBeTruthy()
  })

  it('groups duplicate errors and keeps them dismissed after a dialog closes', () => {
    const dismiss = vi.fn()
    const errors = [
      { id: 'request:1', message: 'Connection failed', dismiss },
      { id: 'chat:1', message: 'Connection failed' },
    ]
    const view = render(<ComposerErrors errors={errors} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error: Connection failed' }))
    expect(dismiss).toHaveBeenCalledOnce()
    view.rerender(<ComposerErrors errors={errors} visible={false} />)
    view.rerender(<ComposerErrors errors={errors} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers Report on errors the app made reportable, but never on status rows', () => {
    const report = vi.fn()
    render(
      <ComposerErrors
        errors={[
          { id: 'turn:1', message: 'Codex exited unexpectedly', report },
          { id: 'offline', message: 'Reconnecting to the server…', role: 'status', report },
          { id: 'plain', message: 'Attachment too large' },
        ]}
      />,
    )
    const buttons = screen.getAllByRole('button', { name: 'Report' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(report).toHaveBeenCalledOnce()
  })

  it('offers several places to go as a menu and runs the one chosen', async () => {
    const work = vi.fn()
    const spare = vi.fn()
    render(
      <ComposerErrors
        errors={[
          {
            id: 'turn:1',
            message: "You've hit your usage limit.",
            choices: {
              label: 'Continue on another account',
              options: [
                { id: 'work', label: 'Work', detail: 'work@example.test', run: work },
                { id: 'spare', label: 'Spare', run: spare },
              ],
            },
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue on another account' }))
    expect(await screen.findByText('work@example.test')).toBeTruthy()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Spare/ }))
    expect(spare).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
  })

  it('draws a shelf of notes neutral and one with an error in the error tint', () => {
    const note = {
      id: 'note',
      message: 'Continues “Webhook retries” on Work.',
      tone: 'info' as const,
    }
    const view = render(<ComposerErrors errors={[note]} />)
    const shelf = () => screen.getByLabelText('Errors')
    expect(shelf().classList.contains('composer__provider-shelf--info')).toBe(true)
    view.rerender(<ComposerErrors errors={[note, { id: 'turn:1', message: 'Request failed' }]} />)
    expect(shelf().classList.contains('composer__provider-shelf--info')).toBe(false)
  })
})
