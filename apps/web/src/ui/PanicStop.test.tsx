// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { PanicStop } from './PanicStop.js'

describe('panic stop', () => {
  it('stays keyboard reachable and reports partial failures', async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [
        { threadId: 'thread-1', status: 'interrupted' },
        { threadId: 'thread-2', status: 'failed', error: 'Adapter did not respond' },
      ],
    })
    render(<PanicStop transport={{ request } as unknown as Transport} />)

    expect(
      screen.getByRole('button', { name: 'Stop all agents' }).getAttribute('aria-keyshortcuts'),
    ).toBe('Meta+Shift+. Control+Shift+.')
    fireEvent.keyDown(window, { key: '.', ctrlKey: true, shiftKey: true })

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Stopped 1 of 2. thread-2: Adapter did not respond',
    )
    expect(request).toHaveBeenCalledWith('system.panicStop', {})
  })
})
