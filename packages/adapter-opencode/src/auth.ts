import type { Account } from '@harness/contracts'
import { runCli } from '@harness/proc/cli'

/**
 * OpenCode has no account of its own: it is ready once it can reach at least
 * one model provider. `opencode auth list` names those providers without
 * printing a secret, and this never opens the auth.json it lists.
 *
 * Captured from 1.18.13 on Windows through pipes (fixtures/): a "Credentials"
 * section that ends with "N credentials", then, when provider keys are set in
 * the environment, an "Environment" section that ends with "N environment
 * variable(s)". Piped output uses the ASCII glyphs `T`, `|`, `•` and `—`; a
 * terminal draws `┌`, `│`, `●` and `└`. The counts read the same either way.
 */

/**
 * `opencode auth list` starts the whole CLI: 1.9 to 6.0 s on a quiet machine,
 * 16 s with the CPU at 100%. A check that runs out reports nothing.
 */
export const OPENCODE_AUTH_TIMEOUT_MS = 60_000

type RunCli = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number | null; stdout: string; stderr?: string | undefined }>

export type OpenCodeConnections = { credentials: number; environment: number }

// oxlint-disable-next-line no-control-regex -- terminal colour codes are stripped on purpose
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

/** The listing's counts, or undefined when it does not look like the captured format. */
export function parseOpenCodeAuthList(output: string): OpenCodeConnections | undefined {
  let credentials: number | undefined
  let environment = 0
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    const credentialCount = /(\d+)\s+credentials?\s*$/i.exec(line)
    if (credentialCount) credentials = Number(credentialCount[1])
    const environmentCount = /(\d+)\s+environment variables?\s*$/i.exec(line)
    if (environmentCount) environment = Number(environmentCount[1])
  }
  return credentials === undefined ? undefined : { credentials, environment }
}

/**
 * Signed in when at least one model provider is connected, by a stored
 * credential or a provider key in the environment. A listing that cannot be
 * read rejects, so the last confirmed answer can stand.
 */
export async function openCodeAccount(run: RunCli = runCli): Promise<Account> {
  const result = await run('opencode', ['auth', 'list'], OPENCODE_AUTH_TIMEOUT_MS)
  if (result.code !== 0) {
    throw new Error(`opencode auth list exited with code ${result.code ?? 'unknown'}`)
  }
  const connections = parseOpenCodeAuthList(result.stdout)
  if (!connections) throw new Error('opencode auth list printed no credential count')
  return { signedIn: connections.credentials + connections.environment > 0 }
}
