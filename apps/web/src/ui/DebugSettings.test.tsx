// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { DebugSettings } from './Settings.js'

afterEach(cleanup)

describe('debug settings', () => {
  it('resets the usage index and confirms that the cold scan started', async () => {
    const request = vi.fn(async () => ({ started: true as const }))
    const transport = { request } as unknown as Transport
    render(<DebugSettings transport={transport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset and rescan' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('usage.resetHistory', {})
    })
    expect((await screen.findByRole('status')).textContent).toBe('Scan started')
    expect(screen.getByText(/Sessions and Harness data are not deleted/)).toBeTruthy()
  })
})
