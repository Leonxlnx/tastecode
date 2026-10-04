import { useEffect } from 'react'
import type { ProviderId } from '@harness/contracts'
import type { Transport } from './transport.js'

/** List requests acquire the lease. Only the mounted viewer renews it. */
export function useProviderWatch(
  transport: Transport,
  provider: ProviderId,
  projectPath: string | undefined,
  target: 'mcp' | 'skills',
): void {
  useEffect(() => {
    if (!projectPath) return
    let pending = false
    const renew = () => {
      if (pending || transport.state !== 'open') return
      pending = true
      void transport
        .request('providers.watch', { provider, projectPath, targets: [target] })
        .catch(() => undefined)
        .finally(() => {
          pending = false
        })
    }
    const interval = setInterval(renew, 30_000)
    const off = transport.onState((state) => {
      if (state === 'open') renew()
    })
    return () => {
      clearInterval(interval)
      off()
    }
  }, [transport, provider, projectPath, target])
}
