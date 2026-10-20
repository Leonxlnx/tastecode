import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type Item,
  type ProviderAccount,
  type ProviderId,
  type ProviderLimit,
  type ResultOf,
} from '@harness/contracts'
import { accountsOf, type ProviderAccountsSnapshot } from './provider-accounts-state.js'
import { sameAccount, type UsageSummaryState } from './usage-summary-state.js'

/** The plan-limit rows a provider account's summary knows, kept or freshly read. */
function knownLimits(state: UsageSummaryState | undefined): readonly ProviderLimit[] {
  const summary = state?.summary
  if (!summary) return []
  if (!summary.limitSource) return summary.limits
  return summary.limitSource.status === 'ready' ? summary.limitSource.limits : []
}

/**
 * A provider account is at a plan limit while one of its percent windows is
 * used up and has not reset yet. Rows that only hold a value, such as a credit
 * balance, say nothing about it.
 */
export function accountAtLimit(
  states: readonly UsageSummaryState[],
  provider: ProviderId,
  accountId: AccountId | undefined,
  now: number,
): boolean {
  const state = states.find(
    (candidate) => candidate.provider === provider && sameAccount(candidate.accountId, accountId),
  )
  return knownLimits(state).some(
    (limit) =>
      limit.valueLabel === undefined &&
      limit.usedPercent >= 100 &&
      (limit.resetsAt === undefined || limit.resetsAt > now),
  )
}

/**
 * The provider's other accounts a chat can carry on with: every account but
 * the chat's own that is known to be signed in. A further account counts once
 * its own sign-in check named who it is; the default one also when the
 * provider reports it signed in.
 */
export function continueAccounts(
  accounts: ProviderAccountsSnapshot,
  provider: ProviderId,
  chatAccount: AccountId | undefined,
  defaultSignedIn: boolean,
): ProviderAccount[] {
  return accountsOf(accounts, provider).filter(
    (account) =>
      !sameAccount(account.id, chatAccount) &&
      (account.email !== undefined ||
        account.plan !== undefined ||
        (account.id === DEFAULT_ACCOUNT_ID && defaultSignedIn)),
  )
}

type ContinuedSession = { id: string; createdAt: number; continuedFrom?: string | undefined }

/** The newest chat that carries this one on, if any. */
export function continuedIn<Session extends ContinuedSession>(
  projects: ReadonlyArray<{ sessions: readonly Session[] }>,
  threadId: string,
): Session | undefined {
  let newest: Session | undefined
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.continuedFrom !== threadId) continue
      if (!newest || session.createdAt > newest.createdAt) newest = session
    }
  }
  return newest
}

/** Where the uncommitted changes of the chat a new one continues went (`thread.start`). */
export type EarlierChanges = NonNullable<ResultOf<'thread.start'>['earlierChanges']>

/** The note a chat shows until its first message, when it continues another chat. */
export function continuationNote(
  title: string,
  account: string,
  changes: EarlierChanges | undefined,
): string {
  const note = `Continues “${title}” on ${account}. Its conversation goes with your first message`
  if (changes === undefined) return `${note}.`
  if (changes.carried) {
    return `${note}, and its uncommitted changes are already in this chat's checkout.`
  }
  return `${note}. Its uncommitted changes could not be carried over; they are still in ${changes.keptIn}.`
}

/** The user's last request in a chat, offered again where the chat continues. */
export function lastRequest(items: readonly Item[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.type !== 'message' || item.role !== 'user') continue
    const text = item.text?.trim()
    if (text) return text
  }
  return undefined
}
