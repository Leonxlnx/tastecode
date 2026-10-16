import { useEffect, useRef, useState } from 'react'
import type { ProviderStatus } from '@harness/contracts'
import type { InstallTarget } from './provider-install.js'
import type { Transport } from './transport.js'

/** The shortest gap between two provider re-checks started by window focus. */
export const PROVIDER_RECHECK_INTERVAL_MS = 30_000

/**
 * Whether a fresh provider scan reports something the catalog has to act on:
 * a CLI that appeared or went away, a sign-in or a problem. Versions are
 * display data and do not count, so a scan that only learned one never
 * restarts every model listing.
 */
export function providerScanChanged(
  before: readonly ProviderStatus[],
  after: readonly ProviderStatus[],
): boolean {
  const signature = (statuses: readonly ProviderStatus[]) =>
    statuses
      .map((status) =>
        [
          status.id,
          status.installed,
          status.auth,
          status.problem ?? '',
          !!status.capabilities,
        ].join('\u0000'),
      )
      .sort()
      .join('\n')
  return signature(before) !== signature(after)
}

/**
 * Re-check when the window gets focus back while `needed` holds: that is the
 * moment someone returns from installing a CLI or signing in elsewhere. It
 * runs at most once per interval, counted from mount because launch has just
 * scanned. `recheck` is read through a ref, so a new identity on every render
 * never re-registers the listener or fires it again.
 */
export function useRecheckOnFocus(
  needed: boolean,
  recheck: () => void,
  intervalMs = PROVIDER_RECHECK_INTERVAL_MS,
): void {
  const latest = useRef({ needed, recheck })
  latest.current = { needed, recheck }
  useEffect(() => {
    let lastCheck = Date.now()
    const onFocus = () => {
      if (!latest.current.needed) return
      const now = Date.now()
      if (now - lastCheck < intervalMs) return
      lastCheck = now
      latest.current.recheck()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [intervalMs])
}

/** Longest a found provider keeps saying "Checking…" while the catalog reloads. */
const FOUND_HOLD_MS = 15_000

/**
 * "Check again" for a provider or ACP agent that was not found. It asks the
 * server once and leaves the catalog alone unless the target is there now;
 * then `onFound` reloads it and the row, replaced by an installed one, stays
 * "Checking…" until that happens.
 */
export function useInstallCheck(transport: Transport, target: InstallTarget, onFound: () => void) {
  const [checking, setChecking] = useState(false)
  // A ref, not the state: two clicks inside one frame must not start two scans.
  const busy = useRef(false)
  const mounted = useRef(true)
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(hold.current)
    }
  }, [])

  const check = () => {
    if (busy.current) return
    busy.current = true
    setChecking(true)
    const agent = target.agent
    const lookup = agent
      ? transport
          .request('acp.agents', {})
          .then(({ agents }) => agents.some((entry) => entry.id === agent && entry.installed))
      : transport
          .request('providers.list', {})
          .then(({ providers }) =>
            providers.some((entry) => entry.id === target.provider && entry.installed),
          )
    void lookup
      .catch(() => false)
      .then((found) => {
        if (!mounted.current) return
        if (!found) {
          busy.current = false
          setChecking(false)
          return
        }
        onFound()
        hold.current = setTimeout(() => {
          busy.current = false
          if (mounted.current) setChecking(false)
        }, FOUND_HOLD_MS)
      })
  }

  return { checking, check }
}
