import { describe, expect, it } from 'vitest'
import { pairingMessage, pairingServerErrorMessage, parseCliOptions } from './headless-cli.js'

describe('headless CLI', () => {
  it('parses pair and listener options without exposing the admin socket', () => {
    expect(parseCliOptions(['pair', '--port', '4400', '--mobile-port', '4401', '--no-qr'])).toEqual(
      {
        command: 'pair',
        port: 4400,
        mobilePort: 4401,
        showQr: false,
      },
    )
  })

  it('uses environment ports and rejects a shared control and mobile port', () => {
    expect(parseCliOptions(['serve'], { HARNESS_PORT: '5500' })).toMatchObject({
      command: 'serve',
      port: 5500,
    })
    expect(() =>
      parseCliOptions(['pair'], { HARNESS_PORT: '5500', HARNESS_MOBILE_PORT: '5500' }),
    ).toThrow('must use different ports')
  })

  it('prints the link, expiry, and advertised route without changing the ticket', () => {
    const message = pairingMessage({
      enabled: true,
      serverName: 'build-box',
      port: 4312,
      addresses: [
        {
          kind: 'tailscale',
          label: 'Tailscale · 100.101.22.33',
          url: 'ws://100.101.22.33:4312',
        },
      ],
      devices: [],
      pairingUri: 'harness://pair?payload=short-lived-ticket',
      expiresAt: Date.now() + 300_000,
    })

    expect(message).toContain('Pair build-box with Harness Mobile')
    expect(message).toContain('harness://pair?payload=short-lived-ticket')
    expect(message).toContain('Tailscale · 100.101.22.33')
    expect(message).toContain('Do not share this link')
  })

  it('explains how to replace a running desktop server that predates mobile pairing', () => {
    expect(pairingServerErrorMessage('unknown method: connections.startPairing', 4311)).toBe(
      'The Harness desktop server on port 4311 is running without mobile pairing support. ' +
        'Quit and restart the desktop app from this checkout, then run ' +
        '`pnpm harness pair --no-qr` again.',
    )
    expect(pairingServerErrorMessage('pairing failed', 4311)).toBe(
      'The running Harness server could not create a pairing link: pairing failed',
    )
  })
})
