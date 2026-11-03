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
 * A read that answers after the page closed is kept as well, so leaving the
 * page early does not cost the next visit its rows. Each answer carries the
 * ticket its read took when it started: an answer from a read that started
 * before a newer one was kept, such as a sign-out finished on the page, does
 * not replace it.
 *
 * Kept in memory only, keyed by a provider id or an ACP agent's roster key.
 */
type Kept = { account: Account; ticket: number }

const reads = new WeakMap<Transport, Map<string, Kept>>()
let tickets = 0

/** Taken when a read starts; pass it to `rememberAccountRead` with the answer. */
export function accountReadTicket(): number {
  tickets += 1
  return tickets
}

export function rememberedAccountReads(transport: Transport): ReadonlyMap<string, Account> {
  const entries = reads.get(transport)
  return new Map([...(entries ?? [])].map(([key, kept]) => [key, kept.account]))
}

/** Without a ticket the answer is as new as can be, as a finished sign-out is. */
export function rememberAccountRead(
  transport: Transport,
  key: string,
  account: Account,
  ticket = accountReadTicket(),
): void {
  let entries = reads.get(transport)
  if (!entries) {
    entries = new Map()
    reads.set(transport, entries)
  }
  const kept = entries.get(key)
  if (kept && kept.ticket > ticket) return
  entries.set(key, { account, ticket })
}
