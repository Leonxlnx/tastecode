import { DEFAULT_ACCOUNT_ID, type AccountId, type Model, type ProviderId } from '@harness/contracts'
import {
  choicesFor,
  isCustomModelChoice,
  modelChoiceKey,
  providerDisplayName,
  providerMark,
  sourceKey,
  type ModelChoice,
} from './model-catalog.js'
import {
  accountLabelOf,
  accountsOf,
  activeAccountOf,
  type ProviderAccountsSnapshot,
} from './provider-accounts-state.js'

/** The source an account's models are kept under: its provider's own for the default account. */
export function accountSourceKey(provider: ProviderId, accountId: AccountId | undefined): string {
  return sourceKey({
    provider,
    accountId: accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId,
  })
}

/** The key one account's choices about a model are kept under, whichever list shows it. */
export function accountModelKey(
  provider: ProviderId,
  accountId: AccountId | undefined,
  modelId: string,
): string {
  return modelChoiceKey(accountSourceKey(provider, accountId), modelId)
}

/** Custom harnesses, connections and custom models have no provider account of their own. */
function runsAsProviderAccount(choice: ModelChoice): boolean {
  return !choice.agent && !choice.connectionId && !isCustomModelChoice(choice)
}

/**
 * The key a listed choice's visibility is kept under. A provider's own list
 * stands for the account new chats start on, so its plain `provider:model` rows
 * belong to that account, which need not be the default one.
 */
export function ownModelKey(choice: ModelChoice, accounts: ProviderAccountsSnapshot): string {
  if (!runsAsProviderAccount(choice)) return choice.key
  return accountModelKey(
    choice.provider,
    choice.accountId ?? activeAccountOf(accounts, choice.provider),
    choice.model.id,
  )
}

/** The choices keyed by what their visibility is kept under, in the same order. */
export function withOwnModelKeys(
  choices: readonly ModelChoice[],
  accounts: ProviderAccountsSnapshot,
): ModelChoice[] {
  return choices.map((choice) => ({ ...choice, key: ownModelKey(choice, accounts) }))
}

/** Back from keys that visibility is kept under to the keys of the choices a list shows. */
export function hiddenListedKeys(
  choices: readonly ModelChoice[],
  hiddenOwnKeys: ReadonlySet<string>,
  accounts: ProviderAccountsSnapshot,
): Set<string> {
  const hidden = new Set<string>()
  for (const choice of choices) {
    if (hiddenOwnKeys.has(ownModelKey(choice, accounts))) hidden.add(choice.key)
  }
  return hidden
}

/** An account as `models.list` lists it, in the one key the effects below pass around. */
export function accountListKey(provider: ProviderId, accountId: AccountId): string {
  return `${provider}\u0000${accountId}`
}

export function parseAccountListKey(key: string): { provider: ProviderId; accountId: AccountId } {
  const [provider = '', accountId = DEFAULT_ACCOUNT_ID] = key.split('\u0000')
  return { provider: provider as ProviderId, accountId }
}

/** One account's own rows, as Settings lists them. A row for the default account names none. */
export function accountModelRows(
  provider: ProviderId,
  accountId: AccountId,
  models: readonly Model[],
): ModelChoice[] {
  return choicesFor(
    {
      provider,
      accountId: accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId,
      sourceName: providerDisplayName(provider),
      mark: providerMark(provider),
    },
    [...models],
    false,
  )
}

/**
 * Every model once per account that lists it, for what is kept per account:
 * a provider with more than one account gets one source per signed-in account,
 * named as Settings names its rows ("Claude Code · Work"). The account the
 * catalog lists keeps those rows, and any other waits for its own list. The
 * rest of the catalog is unchanged.
 */
export function modelsByAccount(
  models: readonly ModelChoice[],
  accounts: ProviderAccountsSnapshot,
  signedIn: ReadonlySet<string>,
  lists: ReadonlyMap<string, readonly Model[]>,
): ModelChoice[] {
  const split = new Set<ProviderId>()
  for (const key of signedIn) split.add(parseAccountListKey(key).provider)
  for (const choice of models) {
    if (runsAsProviderAccount(choice) && accountsOf(accounts, choice.provider).length > 1) {
      split.add(choice.provider)
    }
  }

  const rowsOf = (provider: ProviderId): ModelChoice[] => {
    const active = activeAccountOf(accounts, provider)
    const listed = models.filter(
      (choice) => choice.provider === provider && runsAsProviderAccount(choice),
    )
    return accountsOf(accounts, provider).flatMap((account) => {
      const own = account.id === DEFAULT_ACCOUNT_ID ? undefined : account.id
      const known = signedIn.has(accountListKey(provider, account.id))
      const rows =
        account.id === active && listed.length > 0
          ? listed.map((choice) => ({
              ...choice,
              accountId: own,
              key: accountModelKey(provider, account.id, choice.model.id),
            }))
          : known
            ? accountModelRows(
                provider,
                account.id,
                lists.get(accountListKey(provider, account.id)) ?? [],
              )
            : []
      const label = accountLabelOf(accounts, provider, account.id)
      return rows.map((choice) => ({
        ...choice,
        sourceName: `${providerDisplayName(provider)} · ${label}`,
      }))
    })
  }

  const result: ModelChoice[] = []
  const placed = new Set<ProviderId>()
  for (const choice of models) {
    if (!runsAsProviderAccount(choice) || !split.has(choice.provider)) {
      result.push(choice)
    } else if (!placed.has(choice.provider)) {
      placed.add(choice.provider)
      result.push(...rowsOf(choice.provider))
    }
  }
  // A signed-in account of a provider whose own list has nothing to show yet.
  for (const provider of split) {
    if (!placed.has(provider)) result.push(...rowsOf(provider))
  }
  return result
}
