import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'

export async function cursorAccount(): Promise<Account> {
  const result = await runCli('cursor-agent', ['status'])
  if (result.code !== 0) return { signedIn: false }
  return { signedIn: isCursorSignedIn(result.stdout) }
}

export function isCursorSignedIn(output: string): boolean {
  return !/not authenticated|not logged in/i.test(output) && /authenticated|logged in/i.test(output)
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
