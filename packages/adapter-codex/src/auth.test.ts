import { describe, expect, it, vi } from 'vitest'
import { codexLoginStatus, parseCodexLoginStatus } from './auth.js'

describe('Codex login status', () => {
  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key - sk-redacted',
    'Logged in using workload identity',
    'Logged in using access token',
  ])('recognizes the provider-owned signed-in response: %s', (stdout) => {
    expect(parseCodexLoginStatus(`${stdout}\n`, 0)).toBe('authenticated')
  })

  it('recognizes the provider-owned signed-out response', () => {
    expect(parseCodexLoginStatus('Not logged in\n', 1)).toBe('unauthenticated')
  })

  it('does not guess from an unsuccessful or unknown response', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT\n', 1)).toBe('unknown')
    expect(parseCodexLoginStatus('unexpected output\n', 0)).toBe('unknown')
  })

  it('runs the short status command and contains failures as unknown', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    })
    await expect(codexLoginStatus(run)).resolves.toBe('authenticated')
    expect(run).toHaveBeenCalledWith('codex', ['login', 'status'])

    await expect(codexLoginStatus(vi.fn().mockRejectedValue(new Error('missing')))).resolves.toBe(
      'unknown',
    )
  })
})
