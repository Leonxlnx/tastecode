import type { Account } from '@harness/contracts'

/** Who the last account reads named: the newest read, with details it left out kept from before. */
export type AccountIdentity = Readonly<Account>

/** The identity to compare the next read with, and whether this read named another account. */
export type AccountReadResult = { identity: AccountIdentity; switched: boolean }

/**
 * Compares an account read with the identity the reads before it named. Only
 * a sign-in change, or an email or plan that both name differently, is
 * another account. A read that leaves a detail out, as one does when the
 * provider cannot name it in time, says nothing about that detail, so the
 * identity keeps the one named before and a later read naming another still
 * counts as a switch.
 */
export function accountRead(
  previous: AccountIdentity | undefined,
  account: Account,
): AccountReadResult {
  const switched =
    previous !== undefined &&
    (previous.signedIn !== account.signedIn ||
      differs(previous.email, account.email) ||
      differs(previous.plan, account.plan))
  if (previous === undefined || switched) return { identity: identityOf(account), switched }
  const email = account.email ?? previous.email
  const plan = account.plan ?? previous.plan
  return {
    identity: {
      signedIn: account.signedIn,
      ...(email !== undefined ? { email } : {}),
      ...(plan !== undefined ? { plan } : {}),
    },
    switched,
  }
}

function differs(previous: string | undefined, next: string | undefined): boolean {
  return previous !== undefined && next !== undefined && previous !== next
}

function identityOf(account: Account): AccountIdentity {
  return {
    signedIn: account.signedIn,
    ...(account.email !== undefined ? { email: account.email } : {}),
    ...(account.plan !== undefined ? { plan: account.plan } : {}),
  }
}
