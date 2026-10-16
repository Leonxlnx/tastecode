import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'

export async function cursorAccount(run: typeof runCli = runCli): Promise<Account> {
  const status = await run('cursor-agent', ['status'])
  if (status.code !== 0 || !isCursorSignedIn(status.stdout)) return { signedIn: false }
  // `status` calls any stored token pair logged in, even one that expired
  // weeks ago. It only adds that it could not fetch the user, which an
  // offline machine reports as well. `models` checks the expiry locally
  // before it goes online, so in that one ambiguous case it decides: an
  // expired sign-in becomes signed out and the app offers Sign in again,
  // while an offline machine with a valid sign-in stays signed in.
  if (!/unable to fetch user details/i.test(status.stdout)) return { signedIn: true }
  const probe = await run('cursor-agent', ['models']).catch(() => undefined)
  return { signedIn: !(probe && cursorNeedsSignIn(probe)) }
}

export function isCursorSignedIn(output: string): boolean {
  return !/not authenticated|not logged in/i.test(output) && /authenticated|logged in/i.test(output)
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
  const child = spawnCli('cursor-agent', ['login'])
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
  const result = await runCli('cursor-agent', ['logout'], 15_000)
  if (result.code !== 0) throw new Error('Cursor could not sign out.')
}
