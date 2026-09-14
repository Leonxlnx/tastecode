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
})
