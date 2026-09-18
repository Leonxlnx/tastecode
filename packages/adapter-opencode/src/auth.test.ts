import { describe, expect, it, vi } from 'vitest'
import {
  openCodeAccount,
  openCodeLoginStatus,
  parseOpenCodeAuthList,
  signOutOpenCode,
} from './auth.js'

const AUTH_LIST_SIGNED_IN = [
  '\u001b[0m',
  '┌  Credentials \u001b[90m~/.local/share/opencode/auth.json',
  '│',
  '●  OpenRouter \u001b[90mapi',
  '│',
  '●  OpenCode Zen \u001b[90moauth',
  '│',
  '└  2 credentials',
  '',
  '┌  Environment',
  '│',
  '●  Google \u001b[90mGEMINI_API_KEY',
  '│',
  '└  1 environment variable',
  '',
].join('\n')

const AUTH_LIST_SIGNED_OUT = [
  '\u001b[0m',
  '┌  Credentials \u001b[90m~/.local/share/opencode/auth.json',
  '│',
  '└  0 credentials',
  '',
].join('\n')

describe('parseOpenCodeAuthList', () => {
  it('reads names and counts only the credentials section', () => {
    expect(parseOpenCodeAuthList(AUTH_LIST_SIGNED_IN)).toEqual({
      names: ['OpenRouter', 'OpenCode Zen'],
      credentials: 2,
    })
  })

  it('reports a rendered table with zero credentials', () => {
    expect(parseOpenCodeAuthList(AUTH_LIST_SIGNED_OUT)).toEqual({ names: [], credentials: 0 })
  })

  it('trusts the footer over unparseable entries', () => {
    const output = [
      '┌  Credentials',
      '│',
      '◇  Some New Shape api',
      '│',
      '└  1 credentials',
      '',
    ].join('\n')
    expect(parseOpenCodeAuthList(output)).toEqual({ names: [], credentials: 1 })
  })

  it('refuses to guess from unrelated output', () => {
    expect(parseOpenCodeAuthList('error: something failed\n')).toBeUndefined()
    expect(parseOpenCodeAuthList('')).toBeUndefined()
  })
})

describe('openCodeLoginStatus', () => {
  it('treats a clean auth listing as usable even with no stored credentials', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: AUTH_LIST_SIGNED_OUT })
    await expect(openCodeLoginStatus(run)).resolves.toBe('authenticated')
    expect(run).toHaveBeenCalledWith('opencode', ['auth', 'list'])
  })

  it('contains failed or unreadable answers as unknown', async () => {
    await expect(
      openCodeLoginStatus(vi.fn().mockResolvedValue({ code: 1, stdout: '' })),
    ).resolves.toBe('unknown')
    await expect(
      openCodeLoginStatus(vi.fn().mockResolvedValue({ code: 0, stdout: 'garbage' })),
    ).resolves.toBe('unknown')
    await expect(
      openCodeLoginStatus(vi.fn().mockRejectedValue(new Error('missing'))),
    ).resolves.toBe('unknown')
  })
})

describe('openCodeAccount', () => {
  it('reports stored credentials as the sign-in state', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: AUTH_LIST_SIGNED_IN })
    await expect(openCodeAccount(run)).resolves.toEqual({ signedIn: true })
    run.mockResolvedValue({ code: 0, stdout: AUTH_LIST_SIGNED_OUT })
    await expect(openCodeAccount(run)).resolves.toEqual({ signedIn: false })
  })

  it('rejects answers it cannot read instead of guessing signed-out', async () => {
    await expect(
      openCodeAccount(vi.fn().mockResolvedValue({ code: 1, stdout: '' })),
    ).rejects.toThrow('exited with code 1')
    await expect(
      openCodeAccount(vi.fn().mockResolvedValue({ code: 0, stdout: 'garbage' })),
    ).rejects.toThrow('did not report credentials')
  })
})

describe('signOutOpenCode', () => {
  it('asks the CLI to drop every credential it listed', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: AUTH_LIST_SIGNED_IN })
      .mockResolvedValue({ code: 0, stdout: '└  Logout successful' })
    await signOutOpenCode(run)
    expect(run).toHaveBeenNthCalledWith(2, 'opencode', ['auth', 'logout', 'OpenRouter'])
    expect(run).toHaveBeenNthCalledWith(3, 'opencode', ['auth', 'logout', 'OpenCode Zen'])
  })

  it('surfaces logout failures the CLI reports inside a zero exit', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: AUTH_LIST_SIGNED_IN })
      .mockResolvedValue({ code: 0, stdout: 'Error: Unknown configured provider "OpenRouter"' })
    await expect(signOutOpenCode(run)).rejects.toThrow('could not sign out OpenRouter')
  })
})
