import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Account } from '@harness/contracts'
import { probeAgentSession } from './adapter.js'
import { captureCli, findAgentSpec } from './agents.js'

/** A status command may take a moment while the CLI refreshes its token. */
const STATUS_TIMEOUT_MS = 10_000

/**
 * Sign-in state as far as the agent lets us observe it, cheapest check
 * first: the CLI's own status output (`authStatus`), the file a completed
 * login leaves behind (`credentialProbe`, existence only — reading it would
 * cross the credential boundary in rules/security.md), or a session the agent
 * either opens or refuses for want of a login (`sessionModels`). Without any
 * of them the state is unknown and reported as signed-out, which keeps the
 * sign-in flow reachable.
 */
export async function acpAccount(agentId: string, home = homedir()): Promise<Account> {
  const spec = findAgentSpec(agentId)
  if (!spec) return { signedIn: false }
  if (spec.authStatus) {
    const output = await captureCli(spec.command, spec.authStatus.args, STATUS_TIMEOUT_MS, {
      anyExit: true,
    })
    return { signedIn: spec.authStatus.signedIn.test(output) }
  }
  if (spec.credentialProbe) return { signedIn: existsSync(join(home, spec.credentialProbe)) }
  if (spec.sessionModels) return { signedIn: (await probeAgentSession(agentId)).signedIn }
  return { signedIn: false }
}

/**
 * Sign out through the CLI's own command where it has one. Otherwise remove
 * the credential the login left behind — deleting the file is exactly what
 * one would do by hand. The file is removed, never read. Throws for agents
 * with neither, so the UI knows not to offer the action.
 */
export async function acpSignOut(agentId: string, home = homedir()): Promise<void> {
  const spec = findAgentSpec(agentId)
  if (spec?.logoutArgs) {
    await captureCli(spec.command, spec.logoutArgs, STATUS_TIMEOUT_MS)
    return
  }
  if (!spec?.credentialProbe) {
    throw new Error(`${spec?.name ?? agentId} does not support signing out from here`)
  }
  rmSync(join(home, spec.credentialProbe), { force: true })
}
