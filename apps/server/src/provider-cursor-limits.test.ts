import { afterEach, describe, expect, it, vi } from 'vitest'

const cursor = vi.hoisted(() => ({
  account: vi.fn(async () => ({ signedIn: true })),
  limitSource: vi.fn(async () => ({
    status: 'ready' as const,
    limits: [
      {
        id: 'included',
        label: 'Included',
        usedPercent: 37,
        resetsAt: Date.parse('2026-11-15T00:00:00Z'),
        windowMinutes: 44_640,
      },
    ],
  })),
}))

vi.mock('@harness/adapter-cursor', () => ({
  cursorAccount: cursor.account,
  cursorLimitSource: cursor.limitSource,
}))

const { ProviderControls } = await import('./provider-controls.js')
const { PROVIDER_CAPABILITIES } = await import('./provider-capabilities.js')

const registries: InstanceType<typeof ProviderControls>[] = []
function setup() {
  const registry = new ProviderControls({ listModels: async () => [] })
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.disposeAll()
  cursor.account.mockClear()
  cursor.limitSource.mockReset()
})

describe('Cursor plan limits', () => {
  it('reads the adapter source and holds it for the read interval', async () => {
    expect(PROVIDER_CAPABILITIES.cursor.usageLimits).toBe(true)
    const control = setup().forProvider('cursor')

    await expect(control.usageLimitSource('visible')).resolves.toMatchObject({
      provider: 'cursor',
      status: 'ready',
      origin: 'read',
      limits: [{ id: 'included', label: 'Included', usedPercent: 37 }],
    })
    await control.usageLimitSource('visible')
    expect(cursor.limitSource).toHaveBeenCalledTimes(1)
  })

  it('passes a refused sign-in on as the error of the read, which the popup can retry', async () => {
    cursor.limitSource.mockRejectedValue(
      new Error('Your Cursor sign-in has expired or is missing. Sign in to Cursor again.'),
    )
    const control = setup().forProvider('cursor')
    await expect(control.usageLimitSource('visible')).rejects.toThrow(
      'Your Cursor sign-in has expired or is missing. Sign in to Cursor again.',
    )
  })
})
