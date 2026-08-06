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

export function startCursorLogin(
  onComplete: (result: { loginId: string; success: boolean; error: string | null }) => void,
): { loginId: string; cancel: () => void } {
  const loginId = crypto.randomUUID()
  const child = spawnCli('cursor-agent', ['login'])
  let settled = false
  const finish = (success: boolean, error: string | null) => {
    if (settled) return
    settled = true
    onComplete({ loginId, success, error })
  }
  child.on('error', () => finish(false, 'Cursor could not start its sign-in flow.'))
  child.on('exit', (code) => finish(code === 0, code === 0 ? null : 'Cursor sign-in failed.'))
  return { loginId, cancel: () => killTree(child) }
}

export async function signOutCursor(): Promise<void> {
  const result = await runCli('cursor-agent', ['logout'], 15_000)
  if (result.code !== 0) throw new Error('Cursor could not sign out.')
}
