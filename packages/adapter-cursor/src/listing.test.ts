import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorAdapter } from './adapter.js'
import { cursorAccount } from './auth.js'
import { readCursorModels, resetCursorModelsForTests } from './listing.js'

type CapturedRun = { code: number; stdout: string; stderr: string }

const today = readFileSync(
  new URL('./fixtures/cursor-models-2026-10-16.txt', import.meta.url),
  'utf8',
)
const expired = JSON.parse(
  readFileSync(
    new URL('./fixtures/cursor-expired-sign-in-2026-10-14.json', import.meta.url),
    'utf8',
  ),
) as { status: CapturedRun; models: CapturedRun }

const answered: CapturedRun = { code: 0, stdout: today, stderr: '' }

afterEach(() => {
  vi.useRealTimers()
  resetCursorModelsForTests()
})

/**
 * A cursor-agent whose `status` is the ambiguous "unable to fetch user
 * details" answer, so the sign-in check asks `models` as well.
 */
function cursorAgent(models: () => Promise<CapturedRun>) {
  const calls: string[] = []
  const run = async (_command: string, args: string[], timeoutMs?: number) => {
    calls.push(`${args.join(' ')} ${timeoutMs}`)
    return args[0] === 'status' ? expired.status : models()
  }
  return { run, calls }
}

describe('shared Cursor model listing', () => {
  it('answers the sign-in check and the picker from one read', async () => {
    let answer: ((value: CapturedRun) => void) | undefined
    const { run, calls } = cursorAgent(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )

    const listing = new CursorAdapter({ run }).listModels()
    const account = cursorAccount(run)
    await new Promise((resolve) => setImmediate(resolve))
    answer?.(answered)

    await expect(listing).resolves.toHaveLength(53)
    await expect(account).resolves.toEqual({ signedIn: true })
    expect(calls).toEqual(['models 60000', 'status 30000'])
  })

  it('reuses an answered read for a minute and then reads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { run, calls } = cursorAgent(async () => answered)

    await readCursorModels(run)
    vi.setSystemTime(Date.now() + 59_000)
    await new CursorAdapter({ run }).listModels()
    expect(calls).toHaveLength(1)

    vi.setSystemTime(Date.now() + 2_000)
    await readCursorModels(run)
    expect(calls).toHaveLength(2)
  })

  it('never reuses a refused or failed read', async () => {
    const refused = cursorAgent(async () => expired.models)
    await readCursorModels(refused.run)
    await readCursorModels(refused.run)
    expect(refused.calls).toHaveLength(2)

    const failing = cursorAgent(async () => {
      throw new Error('CLI did not respond within the time limit')
    })
    await expect(readCursorModels(failing.run)).rejects.toThrow('time limit')
    await expect(readCursorModels(failing.run)).rejects.toThrow('time limit')
    expect(failing.calls).toHaveLength(2)
  })

  it('keeps each runner to its own reads', async () => {
    const builtIn = cursorAgent(async () => answered)
    const harness = cursorAgent(async () => answered)

    await Promise.all([readCursorModels(builtIn.run), readCursorModels(harness.run)])

    expect(builtIn.calls).toHaveLength(1)
    expect(harness.calls).toHaveLength(1)
  })
})
