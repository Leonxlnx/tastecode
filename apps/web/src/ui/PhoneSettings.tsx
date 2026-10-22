import { useEffect, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { PhoneAccessStatus, PhoneAddress, PhonePairing } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { RowIssue } from './RowIssue.js'
import { Skeleton, SkeletonStatus } from './Skeleton.js'
import {
  SettingsEmpty,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './settings/SettingsLayout.js'
import '../styles/phone-settings.css'

const ADDRESS_LABELS = {
  hostname: 'Local name',
  lan: 'Wi-Fi',
  tailscale: 'Tailscale',
} as const satisfies Record<PhoneAddress['kind'], string>

/**
 * Pairing a phone and the phones already paired. The pairing code is the page:
 * while it is open the computer is waiting for exactly one phone, and the code
 * gives way to that phone's name the moment it pairs.
 */
export function PhoneSettings(props: { transport: Transport }) {
  const { transport } = props
  const [status, setStatus] = useState<PhoneAccessStatus>()
  const [pairing, setPairing] = useState<PhonePairing>()
  const [paired, setPaired] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const knownDevices = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const accept = (next: PhoneAccessStatus) => {
      if (cancelled) return
      setStatus(next)
      if (next.pairingExpiresAt === undefined) setPairing(undefined)
      const added = next.devices.find((device) => !knownDevices.current.has(device.id))
      if (added && knownDevices.current.size + 1 === next.devices.length) setPaired(added.name)
      knownDevices.current = new Set(next.devices.map((device) => device.id))
    }
    const off = transport.on('phone.changed', accept)
    transport
      .request('phone.status', {})
      .then((next) => {
        knownDevices.current = new Set(next.devices.map((device) => device.id))
        accept(next)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      off()
    }
  }, [transport])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggle = () =>
    run(async () => {
      setStatus(await transport.request('phone.setEnabled', { enabled: !status?.enabled }))
    })

  const startPairing = () =>
    run(async () => {
      setPaired(undefined)
      const result = await transport.request('phone.startPairing', {})
      setStatus(result.status)
      setPairing(result.pairing)
    })

  const cancelPairing = () =>
    run(async () => {
      setStatus(await transport.request('phone.cancelPairing', {}))
      setPairing(undefined)
    })

  const removeDevice = (deviceId: string) =>
    run(async () => {
      setStatus(await transport.request('phone.removeDevice', { deviceId }))
    })

  return (
    <SettingsPage
      title="Phone"
      description="Use TasteCode from your iPhone. Agents keep running here; the phone follows the same chats, models and access levels, live."
    >
      {status === undefined ? (
        error ? (
          <SettingsNotice tone="error">{error}</SettingsNotice>
        ) : (
          <SkeletonStatus label="Loading phone access…">
            <Skeleton width={260} height={11} />
          </SkeletonStatus>
        )
      ) : (
        <>
          <SettingsRow
            name="Phone access"
            note="Phones reach this computer over your Wi-Fi or Tailscale. Every link is end-to-end encrypted and pinned to this computer's key; nothing passes through a server."
            tone={status.enabled ? 'active' : undefined}
          >
            <button
              className={`switch${status.enabled ? ' is-on' : ''}`}
              type="button"
              role="switch"
              aria-label="Phone access"
              aria-checked={status.enabled}
              disabled={busy}
              onClick={() => void toggle()}
            >
              <span className="switch__thumb" />
            </button>
          </SettingsRow>
          {status.enabled && status.addresses.length > 0 ? (
            <SettingsRow name="Reachable at" note={`Port ${status.port}`}>
              <span className="phone-addresses">
                {status.addresses.map((address) => (
                  <span key={address.host} title={ADDRESS_LABELS[address.kind]}>
                    {address.host}
                  </span>
                ))}
              </span>
            </SettingsRow>
          ) : null}
          {status.error ? <SettingsNotice tone="error">{status.error}</SettingsNotice> : null}
          {error ? <RowIssue message={error} /> : null}

          <SettingsSection
            title="Pair a phone"
            note={
              pairing
                ? undefined
                : 'Open TasteCode on your iPhone and choose Pair, then scan the code shown here. One code pairs one phone.'
            }
          >
            {pairing ? (
              <PairingCode
                pairing={pairing}
                serverName={status.serverName}
                busy={busy}
                onCancel={() => void cancelPairing()}
              />
            ) : (
              <div className="phone-pair">
                {paired ? (
                  <p className="phone-pair__done" role="status">
                    Paired with <strong>{paired}</strong>
                  </p>
                ) : null}
                <button
                  className="set-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void startPairing()}
                >
                  {paired ? 'Pair another phone' : 'Show pairing code'}
                </button>
              </div>
            )}
          </SettingsSection>

          <SettingsSection title="Paired phones">
            {status.devices.length === 0 ? (
              <SettingsEmpty title="No phone is paired yet." />
            ) : (
              status.devices.map((device) => (
                <article
                  className="set-entity"
                  key={device.id}
                  data-tone={device.connected ? undefined : 'muted'}
                >
                  <div className="set-entity__main">
                    <div className="set-entity__head">
                      <h2 className="set-entity__name">{device.name}</h2>
                      <span className="set-leader" aria-hidden />
                      <span
                        className="set-entity__status"
                        data-connected={device.connected || undefined}
                      >
                        {device.connected ? 'Connected' : lastSeen(device.lastSeenAt)}
                      </span>
                    </div>
                    <p className="set-entity__detail">Paired {formatDate(device.pairedAt)}</p>
                  </div>
                  <div className="set-entity__actions">
                    <button
                      className="set-button set-button--quiet"
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${device.name}`}
                      onClick={() => void removeDevice(device.id)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))
            )}
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  )
}

function PairingCode(props: {
  pairing: PhonePairing
  serverName: string
  busy: boolean
  onCancel: () => void
}) {
  const path = useMemo(() => qrPath(props.pairing.uri), [props.pairing.uri])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const left = Math.max(0, props.pairing.expiresAt - now)
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1_000)
  return (
    <div className="phone-code">
      <svg
        className="phone-code__qr"
        viewBox={`0 0 ${path.size} ${path.size}`}
        role="img"
        aria-label="Pairing code for the TasteCode phone app"
        shapeRendering="crispEdges"
      >
        <rect width={path.size} height={path.size} fill="#fff" />
        <path d={path.d} fill="#111" />
      </svg>
      <div className="phone-code__copy">
        <p className="phone-code__title">Scan with TasteCode on your iPhone</p>
        <p className="phone-code__note">
          The phone pairs with <strong>{props.serverName}</strong> and remembers it. Anyone who sees
          this code in the next minutes can pair, so keep it to yourself.
        </p>
        <p className="phone-code__expiry">
          Expires in {minutes}:{String(seconds).padStart(2, '0')}
        </p>
        <button
          className="set-button set-button--quiet"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

const QR_MARGIN = 2

type QrPath = { d: string; size: number }

/** One path of unit squares, so the code stays sharp at any size. */
function qrPath(text: string): QrPath {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const count = code.getModuleCount()
  let d = ''
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) d += `M${column + QR_MARGIN} ${row + QR_MARGIN}h1v1h-1z`
    }
  }
  return { d, size: count + QR_MARGIN * 2 }
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function lastSeen(at: number | undefined): string {
  if (at === undefined) return 'Not connected'
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'Seen just now'
  if (minutes < 60) return `Seen ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Seen ${hours} h ago`
  return `Seen ${formatDate(at)}`
}
