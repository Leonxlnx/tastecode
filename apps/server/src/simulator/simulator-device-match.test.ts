import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SimulatorDevice } from '@harness/contracts'
import { LocalSimulatorHost } from './host.js'
import { SimulatorService } from './service.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const iphone = (id: string, version: string, booted: boolean): SimulatorDevice => ({
  id,
  name: 'iPhone 17 Pro',
  platform: 'ios',
  version,
  booted,
  physical: false,
})

describe('opening a simulator', () => {
  it('attaches the requested device, not a booted namesake on another runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-sim-match-'))
    roots.push(root)
    const host = new LocalSimulatorHost(root)
    vi.spyOn(host, 'summary').mockResolvedValue({
      platforms: [
        { platform: 'ios', available: true },
        { platform: 'android', available: false, reason: 'missing' },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
      tools: {
        hub: { requiredVersion: '0.22.1', installedVersions: ['0.22.1'], runningVersion: '0.22.1' },
        agent: {
          requiredVersion: '0.21.36',
          installedVersions: ['0.21.36'],
          runningVersion: '0.21.36',
        },
      },
    })
    vi.spyOn(host, 'ensureReady').mockResolvedValue({
      origin: 'http://127.0.0.1:49999',
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: null,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    let devices = [iphone('SIM-IOS-26', 'iOS 26.0', true), iphone('SIM-IOS-27', 'iOS 27.0', false)]
    vi.spyOn(host, 'listDevices').mockImplementation(async () => ({ devices }))
    vi.spyOn(host, 'bootDevice').mockImplementation(async (device) => {
      devices = devices.map((entry) =>
        entry.id === device.id ? { ...entry, booted: true } : entry,
      )
      return device.id
    })
    vi.spyOn(host, 'attachDevice').mockResolvedValue(undefined)
    let settings: string | undefined = JSON.stringify({
      enabled: true,
      agentAccessEnabled: true,
      onboardingCompleted: true,
    })
    const service = new SimulatorService({
      dataRoot: root,
      settings: { read: () => settings, write: (value) => (settings = value) },
      serverOrigin: () => ({
        httpOrigin: 'http://127.0.0.1:4311',
        wsOrigin: 'ws://127.0.0.1:4311',
      }),
      host,
    })

    const opened = await service.open({ threadId: 'thread-1', deviceId: 'SIM-IOS-27' })

    expect(opened.device.id).toBe('SIM-IOS-27')
    expect(opened.session.deviceId).toBe('SIM-IOS-27')
  })
})
