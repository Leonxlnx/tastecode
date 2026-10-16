import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cursorAccount, isCursorSignedIn } from './auth.js'

type CapturedRun = { code: number; stdout: string; stderr: string }

const capture = JSON.parse(
  readFileSync(
    new URL('./fixtures/cursor-expired-sign-in-2026-10-14.json', import.meta.url),
    'utf8',
  ),
) as { status: CapturedRun; models: CapturedRun }

function runs(answers: Record<string, CapturedRun | Error>) {
  const calls: string[] = []
  const run = async (command: string, args: string[]) => {
    expect(command).toBe('cursor-agent')
    const key = args.join(' ')
    calls.push(key)
    const answer = answers[key]
    if (!answer) throw new Error(`unexpected cursor-agent ${key}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { run, calls }
}

describe('Cursor authentication', () => {
  it('does not mistake a negative status for a signed-in account', () => {
    expect(isCursorSignedIn('Not authenticated. Run cursor-agent login.')).toBe(false)
    expect(isCursorSignedIn('Authenticated as developer')).toBe(true)
  })

  it('reports an expired sign-in as signed out although status still says logged in', async () => {
    const { run, calls } = runs({ status: capture.status, models: capture.models })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: false })
    expect(calls).toEqual(['status', 'models'])
  })

  it('keeps a valid sign-in that only could not reach Cursor', async () => {
    const { run } = runs({
      status: capture.status,
      models: { code: 1, stdout: '', stderr: 'Error: getaddrinfo ENOTFOUND api2.cursor.sh\n' },
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: true })
  })

  it('keeps the account signed in when the confirming listing cannot run', async () => {
    const { run } = runs({
      status: capture.status,
      models: new Error('CLI did not respond within the time limit'),
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: true })
  })

  it('trusts a status that fetched the account without a second command', async () => {
    const { run, calls } = runs({
      status: { code: 0, stdout: '✓ Logged in as developer\n', stderr: '' },
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: true })
    expect(calls).toEqual(['status'])
  })
})
