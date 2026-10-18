import type { AccountId, ProviderId } from '@harness/contracts'

const ACCOUNT_NOT_FOUND = 'That account does not exist any more.'

/** The account was removed, or never existed. */
export class AccountNotFoundError extends Error {
  constructor() {
    super(ACCOUNT_NOT_FOUND)
    this.name = 'AccountNotFoundError'
  }
}

/**
 * Where each provider account runs. `ProviderAccounts` is the real one; the
 * orchestrator only needs to ask it these two things.
 */
export type AccountDirectory = {
  /**
   * The config folder an account's processes run in, for its adapter to map
   * onto the CLI's own variable. Undefined for the default account. Throws
   * `AccountNotFoundError` for an account that is gone, and refuses one the
   * provider cannot have.
   */
  home(provider: ProviderId, accountId: AccountId | undefined): string | undefined
  /** The account a new chat with this provider starts on. */
  active(provider: ProviderId): AccountId
}
