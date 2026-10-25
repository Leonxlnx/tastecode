// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhoneAccessStatus } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { PhoneSettings } from './PhoneSettings.js'

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => undefined),
}))

vi.mock('../bridge.js', () => ({ writeClipboardText }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const off: PhoneAccessStatus = {
  enabled: false,
  listening: false,
  port: 4317,
  serverName: 'Studio Mac',
  addresses: [],
  devices: [],
}

const on: PhoneAccessStatus = {
  ...off,
  enabled: true,
  listening: true,
  addresses: [
    { host: 'Studio-Mac.local', kind: 'hostname' },
    { host: '192.168.1.20', kind: 'lan' },
  ],
}

function client(request: (method: string, params: unknown) => Promise<unknown>) {
  const listeners = new Map<string, (data: unknown) => void>()
  const transport = {
    state: 'open',
    request: vi.fn(request),
    on: vi.fn((channel: string, listener: (data: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    }),
    onState: vi.fn(() => () => {}),
  } as unknown as Transport
  return { transport, push: (channel: string, data: unknown) => listeners.get(channel)?.(data) }
}

describe('Phone settings', () => {
  it('turns phone access on and lists where the computer can be reached', async () => {
    const { transport } = client(async (method) => {
      if (method === 'phone.status') return off
      if (method === 'phone.setEnabled') return on
      throw new Error(`unexpected ${method}`)
    })
    render(<PhoneSettings transport={transport} />)
    const toggle = await screen.findByRole('switch', { name: 'Phone access' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(transport.request).toHaveBeenCalledWith('phone.setEnabled', { enabled: true })
    expect(screen.getByText('Studio-Mac.local')).toBeTruthy()
    expect(screen.getByText('192.168.1.20')).toBeTruthy()
    expect(screen.getByText('No phone is paired yet.')).toBeTruthy()
  })

  it('shows a pairing code until a phone pairs, then names the phone', async () => {
    const { transport, push } = client(async (method) => {
      if (method === 'phone.status') return on
      if (method === 'phone.startPairing') {
        return {
          status: { ...on, pairingExpiresAt: Date.now() + 600_000 },
          pairing: { uri: 'tastecode://pair?p=abc', expiresAt: Date.now() + 600_000 },
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    render(<PhoneSettings transport={transport} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show pairing code' }))
    expect(await screen.findByRole('img', { name: /Pairing code/ })).toBeTruthy()
    expect(screen.getByText(/Expires in 9:5\d|Expires in 10:00/)).toBeTruthy()

    act(() =>
      push('phone.changed', {
        ...on,
        devices: [{ id: 'd1', name: 'Karol’s iPhone', pairedAt: Date.now(), connected: true }],
      }),
    )
    expect(screen.queryByRole('img', { name: /Pairing code/ })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Paired with Karol’s iPhone')
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('copies the pairing link for a phone that cannot scan', async () => {
    const { transport } = client(async (method) => {
      if (method === 'phone.status') return on
      if (method === 'phone.startPairing') {
        return {
          status: { ...on, pairingExpiresAt: Date.now() + 600_000 },
          pairing: { uri: 'tastecode://pair?p=abc', expiresAt: Date.now() + 600_000 },
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    render(<PhoneSettings transport={transport} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show pairing code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(writeClipboardText).toHaveBeenCalledWith('tastecode://pair?p=abc')

    writeClipboardText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Copy failed')
  })

  it('removes a paired phone', async () => {
    const paired = {
      ...on,
      devices: [
        { id: 'd1', name: 'iPhone', pairedAt: 1, lastSeenAt: Date.now(), connected: false },
      ],
    }
    const { transport } = client(async (method) => {
      if (method === 'phone.status') return paired
      if (method === 'phone.removeDevice') return on
      throw new Error(`unexpected ${method}`)
    })
    render(<PhoneSettings transport={transport} />)
    expect(await screen.findByText('Seen just now')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove iPhone' }))
    await waitFor(() => expect(screen.getByText('No phone is paired yet.')).toBeTruthy())
    expect(transport.request).toHaveBeenCalledWith('phone.removeDevice', { deviceId: 'd1' })
  })
})
