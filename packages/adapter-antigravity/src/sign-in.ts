import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Account } from '@harness/contracts'
import { spawnOwned } from '@harness/proc'
import { captureCli, type CapturedCli } from '@harness/proc/cli'
import { antigravityCommand } from './command.js'

/**
 * Whether agy is signed in, from its public `agy models` output. agy has no
 * status subcommand (1.4.0 lists none in `--help`) and keeps its Google sign-in
 * in the OS keyring, which is never read.
 *
 * Captured on Windows through pipes with stdin closed:
 *   signed in (1.4.0):  exit 0, stderr "Fetching available models...", stdout
 *                       the `slug<TAB>Display Name` table
 *   signed out (1.4.0): exit 1, "Fetching available models..." then
 *                       "Error: Please sign in to view available models. Launch
 *                       the CLI without arguments to sign in."
 *
 * Every agy start launches its language server and may launch its
 * self-updater, so the sign-in check and the model picker share one read.
 */

type AgySpawn = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessWithoutNullStreams

/**
 * A cold agy start took 12.8 s on a busy machine. Killing it early also kills
 * an updater it started, so the limit is generous.
 */
export const AGY_MODELS_TIMEOUT_MS = 60_000

/** How long a signed-in read also answers the next sign-in check or listing. */
const SIGNED_IN_SHARE_MS = 30_000

export const ANTIGRAVITY_SIGN_IN_REQUIRED =
  'Sign in to Antigravity first, from Settings > Providers.'

type SharedRead = { output: Promise<CapturedCli>; sharedUntil: number }

/** The newest built-in `agy models` read; shared without limit while it runs. */
let shared: SharedRead | undefined

/** One `agy models` run. The CLI waits forever on a piped stdin that stays open. */
export function readAgyModels(spawn: AgySpawn = spawnOwned): Promise<CapturedCli> {
  const child = spawn(antigravityCommand(), ['models'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const captured = captureCli(child, AGY_MODELS_TIMEOUT_MS)
  child.stdin.on('error', () => undefined)
  child.stdin.end()
  return captured
}

/**
 * The built-in CLI's answer: a read already under way, or a signed-in one
 * from the last 30 s, before starting another agy. A signed-out or failed
 * answer is never reused, so a sign-in finished in agy shows at the next check.
 */
export function sharedAgyModels(): Promise<CapturedCli> {
  const current = shared
  if (current && current.sharedUntil > Date.now()) return current.output
  const read: SharedRead = { output: readAgyModels(), sharedUntil: Number.POSITIVE_INFINITY }
  shared = read
  read.output.then(
    (result) => {
      if (shared !== read) return
      if (antigravitySignIn(result)) read.sharedUntil = Date.now() + SIGNED_IN_SHARE_MS
      else shared = undefined
    },
    () => {
      if (shared === read) shared = undefined
    },
  )
  return read.output
}

/** The sign-in `agy models` reported, or undefined when its answer says neither. */
export function antigravitySignIn(result: CapturedCli): boolean | undefined {
  if (/please sign in|not logged into antigravity/i.test(`${result.stdout}\n${result.stderr}`)) {
    return false
  }
  return result.code === 0 ? true : undefined
}

/** A read that cannot tell rejects, so the last confirmed sign-in can stand. */
export async function antigravityAccount(): Promise<Account> {
  const result = await sharedAgyModels()
  const signedIn = antigravitySignIn(result)
  if (signedIn === undefined) {
    throw new Error(`agy models exited with code ${result.code ?? result.signal ?? 'unknown'}`)
  }
  return { signedIn }
}

export function resetAntigravitySignInForTests(): void {
  shared = undefined
}
