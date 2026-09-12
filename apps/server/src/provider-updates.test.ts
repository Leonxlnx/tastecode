import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderUpdateService } from './provider-updates.js'
import { providerUpdateSources } from './providers.js'

function fixture() {
  const check = vi.fn().mockResolvedValue({ latestVersion: '0.11.0', command: 'codex update' })
  const source = {
    provider: 'codex' as const,
    displayName: 'Codex',
    updater: { command: 'codex', url: 'https://developers.openai.com/codex/cli', check },
  }
  const system = {
    isInstalled: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('codex-cli 0.9.0'),
  }
  return { check, system, source, service: new ProviderUpdateService([source], system) }
}

afterEach(() => vi.useRealTimers())

describe('provider update service', () => {
  it('covers every shipped provider through its adapter', () => {
    expect(providerUpdateSources().map((entry) => entry.provider)).toEqual([
      'codex',
      'claude-code',
      'grok',
    ])
  })

  it('reports a newer release without exposing executable command text', async () => {
    const { service } = fixture()
    const [update] = await service.list()
    expect(update).toMatchObject({
      currentVersion: '0.9.0',
      latestVersion: '0.11.0',
      updateAvailable: true,
      canUpdate: true,
    })
    expect(update).not.toHaveProperty('command')
    await expect(service.commandFor('codex')).resolves.toBe('codex update')
  })

  it('does not query releases or offer updates for missing CLIs', async () => {
    const { service, system, check } = fixture()
    system.isInstalled.mockResolvedValue(false)
    expect(await service.list()).toMatchObject([{ updateAvailable: false, canUpdate: false }])
    expect(check).not.toHaveBeenCalled()
  })

  it('does not downgrade newer installations and rejects parked or current targets', async () => {
    const { service, system } = fixture()
    system.version.mockResolvedValue('0.12.0')
    await expect(service.commandFor('codex')).rejects.toThrow('no newer version')
    await expect(service.commandFor('opencode')).rejects.toThrow('does not support')
  })

  it('shares concurrent checks, caches them, and rechecks after a requested refresh', async () => {
    const { service, check, system } = fixture()
    await Promise.all([service.list(), service.list()])
    await service.list()
    expect(check).toHaveBeenCalledTimes(1)
    system.version.mockResolvedValue('0.11.0')
    expect(await service.list(true)).toMatchObject([{ updateAvailable: false }])
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('does not use an in-flight old version read to verify a completed update', async () => {
    const { service, system } = fixture()
    let release!: (version: string) => void
    system.version.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const before = service.list()
    await Promise.resolve()
    const after = service.list(true)
    system.version.mockResolvedValue('0.11.0')
    release('0.9.0')
    expect(await before).toMatchObject([{ updateAvailable: true }])
    expect(await after).toMatchObject([{ updateAvailable: false, currentVersion: '0.11.0' }])
  })

  it('isolates offline failures and retries them after a short cache', async () => {
    vi.useFakeTimers()
    const { source, system, check } = fixture()
    check.mockRejectedValue(new Error('offline'))
    const other = {
      ...source,
      provider: 'grok' as const,
      updater: {
        ...source.updater,
        check: async () => ({ latestVersion: '1.0.0', command: 'grok update' }),
      },
    }
    const service = new ProviderUpdateService([source, other], system)
    expect(await service.list()).toMatchObject([
      { error: 'offline', updateAvailable: false },
      { updateAvailable: true },
    ])
    await service.list()
    expect(check).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_001)
    await service.list()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('offers a guide for an installation with no supported updater', async () => {
    const { service, check } = fixture()
    check.mockResolvedValue({ latestVersion: '0.11.0' })
    expect(await service.list()).toMatchObject([{ updateAvailable: true, canUpdate: false }])
    await expect(service.commandFor('codex')).rejects.toThrow('setup guide')
  })

  it('requires a readable current and latest version before an update', async () => {
    const { service, system, check } = fixture()
    system.version.mockResolvedValue('unknown')
    expect(await service.list()).toMatchObject([
      { updateAvailable: false, error: expect.stringContaining('installed version') },
    ])
    expect(check).not.toHaveBeenCalled()
    system.version.mockResolvedValue('0.9.0')
    check.mockResolvedValue({ latestVersion: 'invalid', command: 'codex update' })
    await expect(service.commandFor('codex')).rejects.toThrow('release version')
  })
})
