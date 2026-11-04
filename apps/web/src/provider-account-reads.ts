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

/** Reads on their way, which a later visit joins rather than start another CLI. */
type Pending = { ticket: number; revision: number; answer: Promise<Account> }
const pending = new WeakMap<Transport, Map<string, Pending>>()

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
  // A read that started before this answer can only tell less; none may join it.
  const running = pending.get(transport)
  if ((running?.get(key)?.ticket ?? ticket) < ticket) running?.delete(key)
}

/**
 * Reads an account, or joins the read of it already on its way. Every read
 * starts the provider's CLI and outlives the page that started it, so
 * reopening Settings › Providers while the last visit's reads still ran
 * started a second CLI per provider. A read that must postdate something
 * passes `fresh`, as after a sign-in on the page; one asked for under a newer
 * `revision`, as after a sign-in in a terminal, does not join an older read.
 * The answer is kept as `rememberAccountRead` keeps it, with the ticket the
 * read took when it started, even when the page closed meanwhile.
 */
export function readAccount(
  transport: Transport,
  key: string,
  read: () => Promise<Account>,
  options: { fresh?: boolean; revision?: number } = {},
): Promise<Account> {
  const entries = pending.get(transport) ?? new Map<string, Pending>()
  pending.set(transport, entries)
  const revision = options.revision ?? 0
  const running = entries.get(key)
  if (running && !options.fresh && running.revision === revision) return running.answer
  const ticket = accountReadTicket()
  let started: Promise<Account>
  try {
    started = read()
  } catch (cause) {
    started = Promise.reject(cause instanceof Error ? cause : new Error(String(cause)))
  }
  const answer = started.then((account) => {
    rememberAccountRead(transport, key, account, ticket)
    return account
  })
  const entry: Pending = { ticket, revision, answer }
  const settle = () => {
    if (entries.get(key) === entry) entries.delete(key)
  }
  answer.then(settle, settle)
  entries.set(key, entry)
  return answer
}
