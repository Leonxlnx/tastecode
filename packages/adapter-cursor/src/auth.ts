import type { Account } from '@harness/contracts'
import { killTree, type runCli } from '@harness/proc'
import { CURSOR_COMMAND_TIMEOUT_MS, runCursorAgent, spawnCursorAgent } from './launch.js'
import { readCursorModels } from './listing.js'

/**
 * A read that runs out of time rejects, so the caller keeps the last answer
 * it had instead of hearing that a signed-in account is signed out.
 */
export async function cursorAccount(run: typeof runCli = runCursorAgent): Promise<Account> {
  const status = await run('cursor-agent', ['status'], CURSOR_COMMAND_TIMEOUT_MS)
  if (status.code !== 0 || !isCursorSignedIn(status.stdout)) return { signedIn: false }
  // `status` calls any stored token pair logged in, even one that expired
  // weeks ago. It only adds that it could not fetch the user, which an
  // offline machine reports as well. `models` checks the expiry locally
  // before it goes online, so in that one ambiguous case it decides: an
  // expired sign-in becomes signed out and the app offers Sign in again,
  // while an offline machine with a valid sign-in stays signed in. The picker
  // asks for the same listing, so a read already under way answers both.
  if (!/unable to fetch user details/i.test(status.stdout)) {
    const email = cursorEmail(status.stdout)
    return { signedIn: true, ...(email ? { email } : {}) }
  }
  const probe = await readCursorModels(run).catch(() => undefined)
  return { signedIn: !(probe && cursorNeedsSignIn(probe)) }
}

export function isCursorSignedIn(output: string): boolean {
  return !/not authenticated|not logged in/i.test(output) && /authenticated|logged in/i.test(output)
}

/**
 * The address `status` prints for a fetched account, "✓ Logged in as
 * <email>" in 2026.07.23-e383d2b (fixtures/cursor-status-2026-10-16.json).
 * The character class leaves out color codes a terminal build might add.
 */
export function cursorEmail(output: string): string | undefined {
  return /logged in as\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(output)?.[1]
}

export const CURSOR_SIGN_IN_REQUIRED =
  'Your Cursor sign-in has expired or is missing. Sign in to Cursor again.'

/**
 * Whether cursor-agent refused a command because it has no usable sign-in.
 *
 * Before any account command the CLI checks its stored sign-in locally and
 * exits with "Authentication required" when the access token is missing or
 * about to expire. It does not renew a browser sign-in by itself, so once
 * that token runs out every listing and every turn fails until the user signs
 * in again. Captured from 2026.07.23-e383d2b in
 * fixtures/cursor-expired-sign-in-2026-10-14.json.
 */
export function cursorNeedsSignIn(result: {
  code: number | null
  stdout: string
  stderr?: string | undefined
}): boolean {
  return (
    result.code !== 0 && /authentication required/i.test(`${result.stdout}\n${result.stderr ?? ''}`)
  )
}

export type CursorLogin = { loginId: string; cancel: () => Promise<void> }

export function startCursorLogin(
  onComplete: (result: { loginId: string; success: boolean; error: string | null }) => void,
): CursorLogin {
  const loginId = crypto.randomUUID()
  const child = spawnCursorAgent('cursor-agent', ['login'])
  // Nothing reads these pipes; an undrained pipe blocks the CLI once it has
  // written a buffer's worth (device codes, verbose retries) and the sign-in
  // would hang forever.
  child.stdout.resume()
  child.stderr.resume()
  let settled = false
  const finish = (success: boolean, error: string | null) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    void killTree(child).then(
      () => onComplete({ loginId, success, error }),
      () => onComplete({ loginId, success: false, error: 'Cursor sign-in could not stop.' }),
    )
  }
  const deadline = setTimeout(
    () => {
      finish(false, 'Cursor sign-in timed out.')
    },
    10 * 60 * 1000,
  )
  deadline.unref?.()
  child.on('error', () => finish(false, 'Cursor could not start its sign-in flow.'))
  child.on('exit', (code) => finish(code === 0, code === 0 ? null : 'Cursor sign-in failed.'))
  return { loginId, cancel: () => killTree(child) }
}

export async function signOutCursor(): Promise<void> {
  const result = await runCursorAgent('cursor-agent', ['logout'])
  if (result.code !== 0) throw new Error('Cursor could not sign out.')
}
