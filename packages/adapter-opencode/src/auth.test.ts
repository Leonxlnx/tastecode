import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { OPENCODE_AUTH_TIMEOUT_MS, openCodeAccount, parseOpenCodeAuthList } from './auth.js'

/** `opencode auth list` 1.18.13 on Windows through pipes, colour codes kept (2026-10-17). */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/opencode-auth-list-${name}1.18.13.txt`, import.meta.url), 'utf8')

const answering = (stdout: string, code: number | null = 0) =>
  vi.fn(async (_command: string, _args: string[], _timeoutMs?: number) => ({ code, stdout }))

describe('parseOpenCodeAuthList', () => {
  it('counts stored credentials and provider keys in the environment', () => {
    expect(parseOpenCodeAuthList(fixture(''))).toEqual({ credentials: 1, environment: 0 })
    expect(parseOpenCodeAuthList(fixture('env-only-'))).toEqual({ credentials: 0, environment: 1 })
    expect(parseOpenCodeAuthList(fixture('with-env-'))).toEqual({ credentials: 1, environment: 2 })
    expect(parseOpenCodeAuthList(fixture('empty-'))).toEqual({ credentials: 0, environment: 0 })
  })

  it('reads the box glyphs a terminal draws as well', () => {
    const drawn = [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      '●  Anthropic oauth',
      '│',
      '└  1 credentials',
      '',
    ].join('\n')
    expect(parseOpenCodeAuthList(drawn)).toEqual({ credentials: 1, environment: 0 })
  })

  it('cannot tell from output in another shape', () => {
    expect(parseOpenCodeAuthList('')).toBeUndefined()
    expect(parseOpenCodeAuthList('Usage: opencode auth <command>\n')).toBeUndefined()
  })
})

describe('openCodeAccount', () => {
  it('is signed in with one connected model provider', async () => {
    const run = answering(fixture(''))
    await expect(openCodeAccount(run)).resolves.toEqual({ signedIn: true })
    expect(run).toHaveBeenCalledWith('opencode', ['auth', 'list'], OPENCODE_AUTH_TIMEOUT_MS)
    expect(OPENCODE_AUTH_TIMEOUT_MS).toBe(60_000)
  })

  it('is signed in with only a provider key in the environment', async () => {
    await expect(openCodeAccount(answering(fixture('env-only-')))).resolves.toEqual({
      signedIn: true,
    })
  })

  it('is signed out with no credential and no provider key', async () => {
    await expect(openCodeAccount(answering(fixture('empty-')))).resolves.toEqual({
      signedIn: false,
    })
  })

  it('rejects what it cannot read, so the last known answer can stand', async () => {
    await expect(openCodeAccount(answering('', 1))).rejects.toThrow(
      'opencode auth list exited with code 1',
    )
    await expect(openCodeAccount(answering('something else\n'))).rejects.toThrow(
      'printed no credential count',
    )
  })
})
