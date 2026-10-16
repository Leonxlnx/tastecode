import { describe, expect, it } from 'vitest'
import { redactAttachedText, redactLabel, redactUserText } from './feedback-redact.js'

const windowsHome = 'C:\\Users\\Ada Lovelace'
const attach = (text: string, workspaces: string[] = [], home = windowsHome) =>
  redactAttachedText(text, { home, workspaces })

describe('attached error text', () => {
  it('removes the chat workspace with everything below it, in either slash style', () => {
    const result = attach(
      'failed to read D:\\Work\\My App\\src\\index.ts: permission denied; also d:/work/my app/README.md',
      ['D:\\Work\\My App'],
    )
    expect(result.text).toBe('failed to read <path>: permission denied; also <path>')
    expect(result.redactions).toBe(2)
  })

  it('removes the home folder and any other absolute path', () => {
    const text = [
      'cwd C:\\Users\\Ada Lovelace\\proj',
      'other C:\\Users\\bob\\x.txt',
      'share \\\\fileserver\\team\\notes.md',
      'url file:///Users/ada/secret.txt',
      'posix /home/ada/.config/app.json',
      'tilde ~/notes/today.md',
    ].join('\n')
    expect(attach(text).text).toBe(
      [
        'cwd <path>',
        'other <path>',
        'share <path>',
        'url <path>',
        'posix <path>',
        'tilde <path>',
      ].join('\n'),
    )
  })

  it('keeps web hosts and paths but drops query strings and fragments', () => {
    expect(
      attach(
        'GET https://api.example.com/v1/models?key=abc&x=1 failed, see https://status.example.com/',
      ).text,
    ).toBe(
      'GET https://api.example.com/v1/models?[redacted] failed, see https://status.example.com/',
    )
  })

  it.each([
    ['an OpenAI key', 'key sk-proj-abcdefghijklmnopqrstuvwx used'],
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123 used'],
    ['a JWT', 'jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl used'],
    ['a feedback key', 'key fb_test_000 used'],
  ])('redacts %s', (_label, text) => {
    const result = attach(text)
    expect(result.text).toMatch(/\[redacted\] used$/)
    expect(result.redactions).toBe(1)
  })

  it('redacts bearer, keyed secrets, PEM blocks, URL credentials and emails', () => {
    const result = attach(
      [
        'Authorization: Bearer abc.def.ghi',
        'api_key=hunter2hunter2',
        '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
        'git https://ada:pa55word@git.example.com/repo',
        'contact ada@example.com',
      ].join('\n'),
    )
    expect(result.text).toBe(
      [
        'Authorization: Bearer [redacted]',
        'api_key=[redacted]',
        '[redacted]',
        'git https://ada:[redacted]@git.example.com/repo',
        'contact [email]',
      ].join('\n'),
    )
    expect(result.redactions).toBe(5)
  })

  it('redacts long opaque ids but keeps commit hashes and UUIDs for debugging', () => {
    expect(attach('session a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7 lost').text).toBe(
      'session [redacted] lost',
    )
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const uuid = '7f8c3c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f'
    expect(attach(`at ${sha} for ${uuid}`).text).toBe(`at ${sha} for ${uuid}`)
  })

  it('strips control characters, collapses blank runs and caps the excerpt', () => {
    expect(attach('a\u0007b\r\n\r\n\r\n\r\nc').text).toBe('ab\n\nc')
    const long = redactAttachedText('x '.repeat(2000), { home: windowsHome, workspaces: [] })
    expect(long.text.length).toBeLessThanOrEqual(1500)
    expect(long.text.endsWith('... [truncated]')).toBe(true)
  })
})

describe('user text', () => {
  it('keeps paths and emails the user typed but removes secrets and the home folder name', () => {
    const result = redactUserText(
      'Broke in C:\\Users\\Ada Lovelace\\proj and D:\\other. Mail me at ada@example.com. My key: sk-ant-api03-abcdefghijklmnopqrst',
      { home: windowsHome, max: 4000 },
    )
    expect(result.text).toBe(
      'Broke in ~\\proj and D:\\other. Mail me at ada@example.com. My key: [redacted]',
    )
    expect(result.redactions).toBe(2)
  })

  it('makes metadata labels one short line', () => {
    expect(redactLabel('gpt-5\n codex', { home: windowsHome, max: 8 }).text).toBe('gpt-5 co')
  })
})
