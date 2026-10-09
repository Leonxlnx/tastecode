import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { killTree, runCli, spawnCli } from '@harness/proc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeAccount, claudePlanLabel, parseClaudeAccount, startClaudeLogin } from './auth.js'

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(),
  killTree: vi.fn(async () => undefined),
}))

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
}

describe('Claude Code authentication', () => {
  it.each([
    { email: 'dev@example.test', subscriptionType: null },
    { email: null, subscriptionType: 'pro' },
    { email: null, subscriptionType: null },
  ])('accepts nullable account metadata: %j', async (metadata) => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...metadata }),
    })
    await expect(claudeAccount({ run, readRateLimitTier: async () => undefined })).resolves.toEqual(
      {
        signedIn: true,
        ...(metadata.email ? { email: metadata.email } : {}),
        ...(metadata.subscriptionType ? { plan: 'Pro' } : {}),
      },
    )
  })

  it.each([
    ['default_claude_max_5x', 'Max x5'],
    ['default_claude_max_20x', 'Max x20'],
    [undefined, 'Max'],
  ])('labels the Max plan with its rate-limit tier %s', async (tier, plan) => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout: '{"loggedIn":true,"subscriptionType":"max"}',
    })
    await expect(claudeAccount({ run, readRateLimitTier: async () => tier })).resolves.toEqual({
      signedIn: true,
      plan,
    })
  })

  it('keeps an unknown plan id instead of hiding it', () => {
    expect(claudePlanLabel('something_new')).toBe('something_new')
    expect(claudePlanLabel('pro', 'default_claude_ai')).toBe('Pro')
  })

  it('does not collapse a failed status command into signed out', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '' })
    await expect(claudeAccount({ run })).rejects.toThrow('claude auth status exited with code 1')
  })

  it('accepts the logged-out JSON that Claude emits with exit code one', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '{"loggedIn":false}' })
    await expect(claudeAccount({ run })).resolves.toEqual({ signedIn: false })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'])
  })

  it('maps the CLI status without retaining vendor-only account fields', () => {
    expect(
      parseClaudeAccount(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'dev@example.test',
          subscriptionType: 'pro',
          orgId: 'private-vendor-field',
        }),
      ),
    ).toEqual({ signedIn: true, email: 'dev@example.test', plan: 'pro' })
  })

  it('uses CLI auth status as the complete account authority', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout:
        '{"loggedIn":true,"authMethod":"third_party","apiProvider":"vertex","email":"dev@example.test"}',
    })

    await expect(claudeAccount({ run })).resolves.toEqual({
      signedIn: true,
      email: 'dev@example.test',
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'])
  })
})

describe('Claude Code sign-in', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(spawnCli).mockReset()
    vi.mocked(killTree).mockClear()
  })

  it('drains the CLI output so a chatty sign-in cannot block on a full pipe', () => {
    const child = new FakeChild()
    vi.mocked(spawnCli).mockReturnValue(child as ReturnType<typeof spawnCli>)
    startClaudeLogin(() => undefined)
    expect(child.stdout.readableFlowing).toBe(true)
    expect(child.stderr.readableFlowing).toBe(true)
  })

  it('stops and fails an abandoned sign-in after its deadline', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    vi.mocked(spawnCli).mockReturnValue(child as ReturnType<typeof spawnCli>)
    const onComplete = vi.fn()
    const { loginId } = startClaudeLogin(onComplete)

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(killTree).toHaveBeenCalledWith(child)
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      loginId,
      success: false,
      error: 'Claude Code sign-in timed out.',
    })
    child.emit('exit', 0)
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
