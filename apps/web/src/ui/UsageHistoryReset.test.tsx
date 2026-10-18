// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { UsageHistoryReset } from './Settings.js'

afterEach(cleanup)

describe('usage history reset', () => {
  it('resets the usage index and confirms that the cold scan started', async () => {
    const request = vi.fn(async () => ({ started: true as const }))
    const transport = { request } as unknown as Transport
    render(<UsageHistoryReset transport={transport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset and rescan' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('usage.resetHistory', {})
    })
    const status = await screen.findByRole('status', { name: 'Checking · Scan started' })
    expect(status.className).toContain('is-checking')
    expect(screen.getByText(/Sessions and Harness data are not deleted/)).toBeTruthy()
  })
})
