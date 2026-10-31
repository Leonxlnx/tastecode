import type { Account } from '@harness/contracts'
import type { Transport } from './transport.js'

/**
 * The last answer of each account read the Providers page made, per server
 * connection, for as long as the window runs. A read starts the provider's CLI
 * or agent: 1 to 9 s apiece on a busy machine, longer for a CLI that is signed
 * out, because the server never reuses that answer. The page used to forget
 * every answer when it closed, so each visit opened on rows that said
 * "Checking account…" for that long. It now opens on these answers and reads
 * again behind them.
 *
 * Kept in memory only, keyed by a provider id or an ACP agent's roster key.
 */
const reads = new WeakMap<Transport, Map<string, Account>>()

export function rememberedAccountReads(transport: Transport): ReadonlyMap<string, Account> {
  return reads.get(transport) ?? new Map()
}

export function rememberAccountRead(transport: Transport, key: string, account: Account): void {
  let entries = reads.get(transport)
  if (!entries) {
    entries = new Map()
    reads.set(transport, entries)
  }
  entries.set(key, account)
}
