import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_HUB_ROUTE_PREFIX,
  SimulatorActionInputSchema,
  SimulatorDetailSchema,
  SimulatorStateSchema,
  channels,
  methods,
} from './index.js'

describe('simulator contracts', () => {
  it('validates simulator service state and sessions', () => {
    const parsed = SimulatorStateSchema.parse({
      enabled: true,
      agentAccessEnabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      platforms: [
        { platform: 'ios', available: true },
        { platform: 'android', available: false, reason: 'Android SDK was not found.' },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
      devices: [
        {
          id: '9800ECC5-45A5-4E33-B1E4-2A2E1CDD1BA2',
          name: 'iPhone 17 Pro',
          platform: 'ios',
          version: 'iOS 27.0',
          booted: true,
          physical: false,
        },
      ],
      sessions: [
        {
          threadId: 'codex-1',
          deviceId: '9800ECC5-45A5-4E33-B1E4-2A2E1CDD1BA2',
          platform: 'ios',
          openedAt: 1_700_000_000_000,
          openedBy: 'agent',
        },
      ],
      hubBasePath: SIMULATOR_HUB_ROUTE_PREFIX,
      revision: 3,
    })
    expect(parsed.devices).toHaveLength(1)
    expect(parsed.sessions[0]?.openedBy).toBe('agent')
  })

  it('validates typed simulator actions and rejects out-of-range coordinates or scheme-less URLs', () => {
    expect(
      SimulatorActionInputSchema.parse({
        deviceId: 'sim-1',
        type: 'setLocation',
        latitude: 37.7749,
        longitude: -122.4194,
      }),
    ).toMatchObject({ type: 'setLocation' })

    expect(
      SimulatorActionInputSchema.safeParse({
        deviceId: 'sim-1',
        type: 'setLocation',
        latitude: 95,
        longitude: 0,
      }).success,
    ).toBe(false)

    expect(
      SimulatorActionInputSchema.safeParse({
        deviceId: 'sim-1',
        type: 'openUrl',
        url: 'not a url',
      }).success,
    ).toBe(false)

    expect(
      SimulatorActionInputSchema.parse({
        deviceId: 'sim-1',
        type: 'openUrl',
        url: 'myapp://settings/profile',
      }),
    ).toMatchObject({ type: 'openUrl' })
  })

  it('validates simulator detail and exposes protocol methods and channels', () => {
    const detail = SimulatorDetailSchema.parse({
      deviceId: 'sim-1',
      platform: 'ios',
      appearance: 'dark',
      textSize: 'default',
      toggles: { reduceMotion: true },
      supportedActions: ['setAppearance', 'setTextSize', 'setToggle'],
    })
    expect(detail.toggles.reduceMotion).toBe(true)

    expect(methods['simulator.state']).toBeDefined()
    expect(methods['simulator.configure']).toBeDefined()
    expect(methods['simulator.list']).toBeDefined()
    expect(methods['simulator.open']).toBeDefined()
    expect(methods['simulator.close']).toBeDefined()
    expect(methods['simulator.shutdown']).toBeDefined()
    expect(methods['simulator.hubAccess']).toBeDefined()
    expect(methods['simulator.detail']).toBeDefined()
    expect(methods['simulator.action']).toBeDefined()
    expect(methods['simulator.newOptions']).toBeDefined()
    expect(methods['simulator.create']).toBeDefined()
    expect(methods['simulator.remove']).toBeDefined()
    expect(methods['simulator.installAndroid']).toBeDefined()
    expect(methods['simulator.uninstallAndroidImage']).toBeDefined()
    expect(channels['simulator.changed']).toBeDefined()
    expect(channels['simulator.opened']).toBeDefined()
  })
})
