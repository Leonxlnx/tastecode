import { afterEach, describe, expect, it, vi } from 'vitest'

const antigravity = vi.hoisted(() => ({
  account: vi.fn(async () => ({ signedIn: true })),
}))

vi.mock('@harness/adapter-antigravity', () => ({ antigravityAccount: antigravity.account }))

const { ProviderControls } = await import('./provider-controls.js')
const { PROVIDER_CAPABILITIES } = await import('./provider-capabilities.js')

const registries: InstanceType<typeof ProviderControls>[] = []
function setup() {
  const onAuthChanged = vi.fn()
  const registry = new ProviderControls({ listModels: async () => [], onAuthChanged })
  registries.push(registry)
  return { registry, onAuthChanged }
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.disposeAll()
  antigravity.account.mockClear()
})

describe('providers that sign in inside their own CLI', () => {
  it('asks agy for the Antigravity sign-in instead of assuming signed out', async () => {
    const { registry } = setup()
    const control = registry.forProvider('antigravity')
    expect(PROVIDER_CAPABILITIES.antigravity.account).toBe(true)
    expect(antigravity.account).not.toHaveBeenCalled()

    await expect(control.account()).resolves.toEqual({ signedIn: true })
    expect(antigravity.account).toHaveBeenCalledOnce()
  })

  it('refuses an Antigravity sign-out it cannot perform and keeps the account', async () => {
    const { registry, onAuthChanged } = setup()
    const control = registry.forProvider('antigravity')
    await control.account()

    await expect(control.signOut()).rejects.toThrow('/logout')
    expect(onAuthChanged).not.toHaveBeenCalled()
    await expect(control.account()).resolves.toEqual({ signedIn: true })
    expect(antigravity.account).toHaveBeenCalledOnce()
  })
})
