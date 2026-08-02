import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ErrorCode, RequestSchema, methods, type ConnectionAddress } from '@harness/contracts'
import { MobileAccess, type MobileConnectionAccess } from './mobile-access.js'
import { Store } from './store.js'
import { WebSocket } from 'ws'

const FAKE_INTERFACES = {
  tailscale0: [
    {
      address: '100.101.22.33',
      netmask: '255.192.0.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '100.101.22.33/10',
    },
  ],
  en0: [
    {
      address: '192.168.1.44',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.44/24',
    },
  ],
}

type WelcomeFrame = {
  channel: 'server.welcome'
  sequence: 1
  data: {
    access: MobileConnectionAccess['kind']
  }
}

describe('mobile access websocket integration', () => {
  it('authenticates pairing over a real socket, mints a durable token, and revokes it', async () => {
    const store = new Store(':memory:')
    let access: MobileAccess
    access = new MobileAccess({
      store,
      port: 0,
      serverName: 'Karol MacBook',
      networkInterfaces: () => FAKE_INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
      onConnection: (socket, _request, connectionAccess) => {
        socket.send(
          JSON.stringify({
            channel: 'server.welcome',
            sequence: 1,
            data: { access: connectionAccess.kind },
          } satisfies WelcomeFrame),
        )

        socket.on('message', (raw) => {
          const envelope = RequestSchema.parse(JSON.parse(asText(raw)))
          if (envelope.method !== 'connections.claim') {
            socket.send(
              JSON.stringify({
                id: envelope.id,
                error: {
                  code: ErrorCode.BAD_REQUEST,
                  message: `unknown method: ${envelope.method}`,
                },
              }),
            )
            return
          }

          if (connectionAccess.kind !== 'pairing') {
            socket.send(
              JSON.stringify({
                id: envelope.id,
                error: {
                  code: ErrorCode.FORBIDDEN,
                  message: 'A current pairing ticket is required',
                },
              }),
            )
            return
          }

          const params = methods['connections.claim'].params.parse(envelope.params)
          const result = access.claim(connectionAccess, params.name)
          socket.send(JSON.stringify({ id: envelope.id, result }))
        })
      },
    })

    const sockets = new Set<WebSocket>()
    try {
      const offer = await access.startPairing()

      const denied = trackSocket(sockets, new WebSocket(`ws://127.0.0.1:${offer.port}`))
      const deniedClose = await waitForClose(denied)
      expect(deniedClose).toMatchObject({ code: 1008, reason: 'Access denied' })

      const pairingTicket = decodePairingTicket(offer.pairingUri)
      const bootstrap = trackSocket(
        sockets,
        new WebSocket(
          `ws://127.0.0.1:${offer.port}/?pairing_ticket=${encodeURIComponent(pairingTicket)}`,
        ),
      )
      const bootstrapWelcome = readJson<WelcomeFrame>(bootstrap)
      await once(bootstrap, 'open')
      expect(await bootstrapWelcome).toEqual({
        channel: 'server.welcome',
        sequence: 1,
        data: { access: 'pairing' },
      })

      const claimed = methods['connections.claim'].result.parse(
        await request(bootstrap, {
          id: 'claim-1',
          method: 'connections.claim',
          params: { name: 'Karol iPhone' },
        }),
      )
      expect(claimed.serverName).toBe('Karol MacBook')
      expect(claimed.addresses).toEqual<ConnectionAddress[]>([
        {
          kind: 'tailscale',
          label: 'Tailscale · 100.101.22.33',
          url: `ws://100.101.22.33:${offer.port}`,
        },
        {
          kind: 'lan',
          label: 'en0 · 192.168.1.44',
          url: `ws://192.168.1.44:${offer.port}`,
        },
      ])
      expect(store.pairedDevices()).toMatchObject([{ id: claimed.deviceId, name: 'Karol iPhone' }])

      bootstrap.close()
      await waitForClose(bootstrap)

      const firstDevice = trackSocket(
        sockets,
        new WebSocket(
          `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
        ),
      )
      const firstDeviceWelcome = readJson<WelcomeFrame>(firstDevice)
      await once(firstDevice, 'open')
      expect(await firstDeviceWelcome).toEqual({
        channel: 'server.welcome',
        sequence: 1,
        data: { access: 'device' },
      })
      firstDevice.close()
      await waitForClose(firstDevice)

      const activeDevice = trackSocket(
        sockets,
        new WebSocket(
          `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
        ),
      )
      const activeDeviceWelcome = readJson<WelcomeFrame>(activeDevice)
      await once(activeDevice, 'open')
      expect(await activeDeviceWelcome).toEqual({
        channel: 'server.welcome',
        sequence: 1,
        data: { access: 'device' },
      })

      access.revoke(claimed.deviceId)
      const revokedClose = await waitForClose(activeDevice)
      expect(revokedClose.code).toBe(1006)
      expect(store.pairedDevices()).toEqual([])

      const deniedAfterRevoke = trackSocket(
        sockets,
        new WebSocket(
          `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
        ),
      )
      const deniedAfterRevokeClose = await waitForClose(deniedAfterRevoke)
      expect(deniedAfterRevokeClose).toMatchObject({ code: 1008, reason: 'Access denied' })
    } finally {
      for (const socket of sockets) socket.terminate()
      await access.stop()
      store.close()
    }
  })
})

function decodePairingTicket(pairingUri: string): string {
  const encoded = new URL(pairingUri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket: string }
  return payload.ticket
}

function trackSocket(sockets: Set<WebSocket>, socket: WebSocket): WebSocket {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  return socket
}

async function request(
  socket: WebSocket,
  envelope: { id: string; method: string; params: unknown },
): Promise<unknown> {
  const response = new Promise<unknown>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const parsed = JSON.parse(asText(raw)) as
        | { id: string; result: unknown }
        | { id: string; error: { code: string; message: string } }
        | { channel: string }
      if ('channel' in parsed || parsed.id !== envelope.id) return
      socket.off('message', onMessage)
      socket.off('close', onClose)
      if ('error' in parsed) {
        reject(new Error(`${parsed.error.code}: ${parsed.error.message}`))
        return
      }
      resolve(parsed.result)
    }
    const onClose = () => {
      socket.off('message', onMessage)
      reject(new Error('socket closed before response'))
    }

    socket.on('message', onMessage)
    socket.once('close', onClose)
  })

  socket.send(JSON.stringify(envelope))
  return response
}

async function readJson<T>(socket: WebSocket): Promise<T> {
  const [raw] = await once(socket, 'message')
  return JSON.parse(asText(raw)) as T
}

async function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) return { code: 1005, reason: '' }
  const [code, reason] = (await once(socket, 'close')) as [number, Buffer]
  return { code, reason: reason.toString() }
}

function asText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString()
  if (Array.isArray(raw)) return Buffer.concat(raw).toString()
  return Buffer.from(raw as ArrayBufferLike).toString()
}
