import { describe, expect, it, vi } from 'vitest'
import { CURSOR_SIGN_IN_REQUIRED } from './auth.js'
import {
  CURSOR_USAGE_URL,
  cursorAuthFile,
  cursorLimitSource,
  cursorLimitsFromUsage,
  decodeCurrentPeriodUsage,
} from './limits.js'

// Not captured from Cursor: TasteCode never reads a real sign-in, so these
// bytes are encoded here from the field numbers and types in cursor-agent
// 2026.07.23-e383d2b (index.js ~7682025, GetCurrentPeriodUsageResponse).
function varint(value: bigint): number[] {
  const out: number[] = []
  let rest = BigInt.asUintN(64, value)
  do {
    const byte = Number(rest & 0x7fn)
    rest >>= 7n
    out.push(rest > 0n ? byte | 0x80 : byte)
  } while (rest > 0n)
  return out
}
const key = (field: number, wire: number) => varint(BigInt((field << 3) | wire))
const int = (field: number, value: number) => [...key(field, 0), ...varint(BigInt(value))]
const double = (field: number, value: number) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, true)
  return [...key(field, 1), ...bytes]
}
const message = (field: number, body: number[]) => [
  ...key(field, 2),
  ...varint(BigInt(body.length)),
  ...body,
]
const text = (field: number, value: string) => message(field, [...new TextEncoder().encode(value)])

const START = Date.UTC(2026, 9, 15)
const END = Date.UTC(2026, 10, 15)
const usageBytes = (plan: number[] | undefined) =>
  new Uint8Array([
    ...int(1, START),
    ...int(2, END),
    ...(plan ? message(3, plan) : []),
    // Fields this read does not use, including a fixed32 and a string.
    ...message(4, [...int(1, 1200), ...text(5, 'team')]),
    ...key(9, 5),
    1,
    2,
    3,
    4,
    ...int(6, 1),
    ...text(7, 'You have used 37% of your included usage'),
  ])
const PLAN = [
  ...int(1, 740),
  ...int(2, 740),
  ...int(5, 2000),
  ...double(12, 21.5),
  ...double(13, 15.5),
  ...double(14, 37),
]

const SECRET = 'fake-access-token-for-tests'
const signedIn = async () => JSON.stringify({ accessToken: SECRET, refreshToken: 'fake-refresh' })
const answer = (body: Uint8Array | string, status = 200) =>
  vi.fn(async () => new Response(body, { status }))

describe('cursorAuthFile', () => {
  it('finds the file cursor-agent writes on each platform, and none on macOS', () => {
    expect(
      cursorAuthFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\Cursor\\auth.json')
    expect(cursorAuthFile({}, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Cursor\\auth.json',
    )
    expect(cursorAuthFile({ XDG_CONFIG_HOME: '/x/config' }, 'linux', '/home/u')).toBe(
      '/x/config/cursor/auth.json',
    )
    expect(cursorAuthFile({}, 'linux', '/home/u')).toBe('/home/u/.config/cursor/auth.json')
    expect(cursorAuthFile({}, 'darwin', '/Users/u')).toBeUndefined()
  })
})

describe('decodeCurrentPeriodUsage', () => {
  it('reads the billing cycle and plan shares and skips everything else', () => {
    expect(decodeCurrentPeriodUsage(usageBytes(PLAN))).toEqual({
      billingCycleStart: START,
      billingCycleEnd: END,
      planUsage: {
        includedSpend: 740,
        limit: 2000,
        autoPercentUsed: 21.5,
        apiPercentUsed: 15.5,
        totalPercentUsed: 37,
      },
    })
    expect(decodeCurrentPeriodUsage(new Uint8Array())).toEqual({})
  })

  it('refuses truncated bytes instead of guessing', () => {
    const bytes = usageBytes(PLAN)
    expect(() => decodeCurrentPeriodUsage(bytes.subarray(0, bytes.length - 3))).toThrow(
      'Cursor sent a truncated answer.',
    )
  })
})

describe('cursorLimitsFromUsage', () => {
  it('shows Included, Auto and API like /usage, ending with the billing cycle', () => {
    const timing = { resetsAt: END, windowMinutes: (END - START) / 60_000 }
    expect(cursorLimitsFromUsage(decodeCurrentPeriodUsage(usageBytes(PLAN)))).toEqual({
      status: 'ready',
      limits: [
        { id: 'included', label: 'Included', usedPercent: 37, ...timing },
        { id: 'auto', label: 'Auto', usedPercent: 21.5, ...timing },
        { id: 'api', label: 'API', usedPercent: 15.5, ...timing },
      ],
    })
  })

  it('works out the share from spend and limit when Cursor leaves the percentage out', () => {
    expect(cursorLimitsFromUsage({ planUsage: { includedSpend: 2500, limit: 2000 } })).toEqual({
      status: 'ready',
      limits: [{ id: 'included', label: 'Included', usedPercent: 100 }],
    })
  })

  it('reports nothing for an account without plan usage, as the CLI does', () => {
    expect(cursorLimitsFromUsage({ billingCycleEnd: END })).toEqual({ status: 'unavailable' })
    expect(cursorLimitsFromUsage({ planUsage: {} })).toEqual({ status: 'unavailable' })
  })
})

describe('cursorLimitSource', () => {
  const win = {
    env: { APPDATA: 'C:\\fake\\Roaming' },
    platform: 'win32' as const,
    home: 'C:\\fake',
  }

  it('asks Cursor once with the stored token and maps the answer', async () => {
    const fetch = answer(usageBytes(PLAN))
    const readText = vi.fn(signedIn)
    const source = await cursorLimitSource({ ...win, readText, fetch })
    expect(readText).toHaveBeenCalledWith('C:\\fake\\Roaming\\Cursor\\auth.json')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(CURSOR_USAGE_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
    })
    expect(source.status === 'ready' && source.limits.map((limit) => limit.label)).toEqual([
      'Included',
      'Auto',
      'API',
    ])
  })

  it('makes no request when cursor-agent is signed out or the store is unreadable', async () => {
    for (const readText of [
      async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      async () => '{not json',
      async () => JSON.stringify({ apiKey: 'only-a-key' }),
      async () => JSON.stringify({ accessToken: '' }),
    ]) {
      const fetch = answer(usageBytes(PLAN))
      await expect(cursorLimitSource({ ...win, readText, fetch })).resolves.toEqual({
        status: 'unavailable',
      })
      expect(fetch).not.toHaveBeenCalled()
    }
    const fetch = answer(usageBytes(PLAN))
    await expect(
      cursorLimitSource({ platform: 'darwin', home: '/Users/u', readText: signedIn, fetch }),
    ).resolves.toEqual({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for a new sign-in when Cursor refuses the token, without repeating it', async () => {
    for (const fetch of [
      answer('', 401),
      answer(JSON.stringify({ code: 'unauthenticated', message: 'token expired' }), 403),
    ]) {
      const read = cursorLimitSource({ ...win, readText: signedIn, fetch })
      await expect(read).rejects.toThrow(CURSOR_SIGN_IN_REQUIRED)
      await read.catch((error: Error) => expect(error.message).not.toContain(SECRET))
    }
    await expect(
      cursorLimitSource({ ...win, readText: signedIn, fetch: answer('busy', 503) }),
    ).rejects.toThrow('Cursor did not report its plan usage (HTTP 503).')
  })
})
