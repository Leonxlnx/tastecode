import { statSync } from 'node:fs'
import { DEFAULT_ACCOUNT_ID, type AccountId, type ProviderId } from '@harness/contracts'

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

/** Every provider as its default account only, for a server without a registry. */
export const DEFAULT_ACCOUNTS_ONLY: AccountDirectory = {
  home: (_provider, accountId) => {
    if (accountId === undefined || accountId === DEFAULT_ACCOUNT_ID) return undefined
    throw new Error('This provider runs as one account only.')
  },
  active: () => DEFAULT_ACCOUNT_ID,
}

/**
 * The account a request for a source names. A custom harness runs with its
 * own sign-in, so a request for one names no other account.
 */
export function sourceAccount(
  agent: string | undefined,
  requested: AccountId | undefined,
): AccountId | undefined {
  if (agent === undefined) return requested
  if (requested !== undefined && requested !== DEFAULT_ACCOUNT_ID) {
    throw new Error('A custom harness runs with its own sign-in, not as another account.')
  }
  return undefined
}

/**
 * The account a new chat is pinned to: the one asked for, else the
 * provider's active account. A custom harness's chats stay on the default.
 */
export function accountForNewThread(
  directory: AccountDirectory,
  provider: ProviderId,
  agent: string | undefined,
  requested: AccountId | undefined,
): AccountId {
  if (agent !== undefined) return sourceAccount(agent, requested) ?? DEFAULT_ACCOUNT_ID
  return requested ?? directory.active(provider)
}

/**
 * The folder an account's processes run in; undefined for the default
 * account. A folder can be moved or deleted while TasteCode runs, and a CLI
 * started in its place would quietly make a new, signed-out account there.
 */
export function existingAccountHome(
  directory: AccountDirectory,
  provider: ProviderId,
  accountId: AccountId | undefined,
): string | undefined {
  const home = directory.home(provider, accountId)
  if (home !== undefined && statSync(home, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(
      `This account's folder is missing (${home}). Put it back, or remove the account.`,
    )
  }
  return home
}

/** A chat always runs as the account it started on, so a removed account ends it. */
export function threadAccountHome(
  directory: AccountDirectory,
  thread: { provider: ProviderId; accountId?: string | undefined },
): string | undefined {
  try {
    return existingAccountHome(directory, thread.provider, thread.accountId)
  } catch (error) {
    if (!(error instanceof AccountNotFoundError)) throw error
    throw new Error(
      'The account this chat ran on was removed, so the chat cannot continue. Start a new chat.',
    )
  }
}
