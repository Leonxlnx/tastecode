import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cursorAccount, cursorEmail, cursorPlan, isCursorSignedIn } from './auth.js'

type CapturedRun = { code: number; stdout: string; stderr: string }

const capture = JSON.parse(
  readFileSync(
    new URL('./fixtures/cursor-expired-sign-in-2026-10-14.json', import.meta.url),
    'utf8',
  ),
) as { status: CapturedRun; models: CapturedRun }
const signedIn = JSON.parse(
  readFileSync(new URL('./fixtures/cursor-status-2026-10-16.json', import.meta.url), 'utf8'),
) as { status: CapturedRun }

const ABOUT = 'about --format json'

/**
 * What `cursor-agent about --format json` prints, rebuilt from the
 * 2026.07.23-e383d2b bundle (`./src/commands/about.ts` in 5814.index.js:
 * `JSON.stringify(info, null, 2)` of these keys). Not a capture: no
 * cursor-agent was started for it, and "Pro" stands in for whatever
 * `GetPlanInfo` names.
 */
function about(subscriptionTier: string | null): CapturedRun {
  const info = {
    cliVersion: '2026.07.23-e383d2b',
    model: 'Auto',
    subscriptionTier,
    osPlatform: 'win32',
    osArch: 'x64',
    userEmail: subscriptionTier === null ? null : 'developer@example.com',
    terminalProgram: 'unknown',
    shell: 'cmd',
    lastRequestId: null,
  }
  return { code: 0, stdout: `${JSON.stringify(info, null, 2)}\n`, stderr: '' }
}

function runs(answers: Record<string, CapturedRun | Error>) {
  const calls: string[] = []
  const run = async (command: string, args: string[], timeoutMs?: number) => {
    expect(command).toBe('cursor-agent')
    // Measured 3.5–14.5 s on a busy machine; the five-second default failed
    // it. The listing, shared with the picker, gets a minute.
    const key = args.join(' ')
    expect(timeoutMs).toBe(key === 'models' ? 60_000 : 30_000)
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
    const { run, calls } = runs({
      status: capture.status,
      models: capture.models,
      [ABOUT]: about(null),
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: false })
    expect(calls).toEqual(['status', ABOUT, 'models'])
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

  it('trusts a status that fetched the account and reads its address', async () => {
    const { run, calls } = runs({ status: signedIn.status, [ABOUT]: about(null) })

    await expect(cursorAccount(run)).resolves.toEqual({
      signedIn: true,
      email: 'developer@example.com',
    })
    expect(calls).toEqual(['status', ABOUT])
  })

  it('names the plan about reports, as Claude Code, Codex and Grok rows do', async () => {
    const { run } = runs({ status: signedIn.status, [ABOUT]: about('Pro') })

    await expect(cursorAccount(run)).resolves.toEqual({
      signedIn: true,
      email: 'developer@example.com',
      plan: 'Pro',
    })
  })

  it('stays at plain sign-in when about fails or cannot run', async () => {
    for (const answer of [
      new Error('cursor-agent did not answer within 30 seconds.'),
      { code: 1, stdout: '{"status":"error","message":"Failed to get about info"}', stderr: '' },
    ]) {
      const { run } = runs({ status: signedIn.status, [ABOUT]: answer })

      await expect(cursorAccount(run)).resolves.toEqual({
        signedIn: true,
        email: 'developer@example.com',
      })
    }
  })

  it('drops a plan when status says signed out', async () => {
    const { run } = runs({
      status: { code: 0, stdout: 'Not logged in\n', stderr: '' },
      [ABOUT]: about('Pro'),
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: false })
  })

  it('reads only a short one-line plan name from about', () => {
    expect(cursorPlan(about('  Ultra  ').stdout)).toBe('Ultra')
    expect(cursorPlan(`Update available\n${about('Pro+').stdout}`)).toBe('Pro+')
    expect(cursorPlan(about(null).stdout)).toBeUndefined()
    expect(cursorPlan(about('').stdout)).toBeUndefined()
    expect(cursorPlan(about('Pro\u001b[0m').stdout)).toBeUndefined()
    expect(cursorPlan(about('x'.repeat(61)).stdout)).toBeUndefined()
    expect(cursorPlan('Subscription Tier   Pro')).toBeUndefined()
  })

  it('claims no address the status did not print', async () => {
    const { run } = runs({
      status: { code: 0, stdout: '✓ Logged in as developer\n', stderr: '' },
    })

    await expect(cursorAccount(run)).resolves.toEqual({ signedIn: true })
    expect(cursorEmail('\u001b[32m✓ Logged in as a@b.co\u001b[0m\n')).toBe('a@b.co')
  })

  it('rejects when status does not answer in time, so the last answer stays', async () => {
    const { run, calls } = runs({
      status: new Error('cursor-agent did not answer within 30 seconds.'),
    })

    await expect(cursorAccount(run)).rejects.toThrow('did not answer within 30 seconds')
    expect(calls).toEqual(['status', ABOUT])
  })
})
