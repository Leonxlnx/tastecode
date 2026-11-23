// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SimulatorDetail, SimulatorState } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { SimulatorSettings } from '../SimulatorSettings.js'
import { WorkspacePanel } from './WorkspacePanel.js'
import { WorkspaceSimulator } from './WorkspaceSimulator.js'
import { fitSimulatorFrame, withHubTicket } from './simulator-hub-api.js'
import {
  AvccDemuxer,
  avcCodecString,
  hidUsageForCode,
  iosKeyMessageForEvent,
  parseSemuPacket,
  scanAccessUnit,
} from './simulator-stream.js'

afterEach(() => {
  cleanup()
})

function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    enabled: false,
    agentAccessEnabled: false,
    onboardingCompleted: false,
    hostStatus: 'disabled',
    platforms: [
      { platform: 'ios', available: true },
      { platform: 'android', available: false, reason: 'Android emulator not found.' },
    ],
    hubInstalled: false,
    agentDeviceInstalled: false,
    tools: {
      hub: {
        requiredVersion: '0.22.1',
        installedVersions: [],
        runningVersion: null,
      },
      agent: {
        requiredVersion: '0.21.36',
        installedVersions: [],
        runningVersion: null,
      },
    },
    devices: [],
    sessions: [],
    hubBasePath: '/api/device-hub',
    revision: 1,
    ...overrides,
  }
}

function makeDetail(deviceId: string, overrides: Partial<SimulatorDetail> = {}): SimulatorDetail {
  return {
    deviceId,
    platform: 'ios',
    appearance: 'dark',
    textSize: 'default',
    toggles: {},
    supportedActions: ['setAppearance', 'setTextSize', 'setOrientation'],
    ...overrides,
  }
}

function encodeAvccPacket(tag: number, payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(4 + 1 + payload.length)
  new DataView(packet.buffer).setUint32(0, 1 + payload.length, false)
  packet[4] = tag
  packet.set(payload, 5)
  return packet
}

describe('simulator stream & geometry helpers', () => {
  it('fits aspect ratios inside the host container with padding or per-edge insets', () => {
    expect(fitSimulatorFrame(0.5, 400, 800, 20)).toEqual({ width: 360, height: 720 })
    expect(fitSimulatorFrame(2, 400, 800, 20)).toEqual({ width: 360, height: 180 })
    expect(fitSimulatorFrame(0.5, 20, 20, 20)).toEqual({ width: 0, height: 0 })
    expect(fitSimulatorFrame(0.5, 400, 800, { top: 54, right: 14, bottom: 14, left: 14 })).toEqual({
      width: 366,
      height: 732,
    })
  })

  it('appends encoded hub tickets safely', () => {
    expect(withHubTicket('http://127.0.0.1:4311/api/device-hub/stream', 'a+b=c')).toBe(
      'http://127.0.0.1:4311/api/device-hub/stream?ticket=a%2Bb%3Dc',
    )
    expect(withHubTicket('http://127.0.0.1:4311/api/device-hub/stream?fps=30', 'tok')).toBe(
      'http://127.0.0.1:4311/api/device-hub/stream?fps=30&ticket=tok',
    )
  })

  it('demuxes AVCC description and keyframe packets across chunk boundaries', () => {
    const demuxer = new AvccDemuxer()
    const avcc = new Uint8Array([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1])
    const frame = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88])
    const p1 = encodeAvccPacket(1, avcc)
    const p2 = encodeAvccPacket(2, frame)
    const wire = new Uint8Array(p1.length + p2.length)
    wire.set(p1, 0)
    wire.set(p2, p1.length)

    // Feed in fragmented slices.
    const events = [...demuxer.push(wire.subarray(0, 7)), ...demuxer.push(wire.subarray(7))]
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('description')
    expect(avcCodecString(events[0]!.payload)).toBe('avc1.640028')
    expect(events[1]?.type).toBe('keyframe')
    expect(Array.from(events[1]!.payload)).toEqual(Array.from(frame))
  })

  it('parses SEMU headers and Annex-B access units', () => {
    const payload = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x00, 0x01, 0x65, 0x01,
    ])
    const packet = new ArrayBuffer(16 + payload.length)
    const view = new DataView(packet)
    view.setUint32(0, 0x53454d55, false)
    view.setUint8(4, 1)
    view.setUint8(5, 1)
    view.setBigUint64(8, 123456n, false)
    new Uint8Array(packet, 16).set(payload)

    const parsed = parseSemuPacket(packet)
    expect(parsed.isKey).toBe(true)
    expect(parsed.timestamp).toBe(123456)
    const scanned = scanAccessUnit(parsed.data)
    expect(scanned.isKey).toBe(true)
    expect(scanned.sps?.[0]).toBe(0x67)
  })
})

describe('WorkspaceSimulator', () => {
  it('walks through setup onboarding and enables hub + agent control', async () => {
    let current = makeState()
    const configure = vi.fn((patch: Partial<SimulatorState>) => {
      current = {
        ...current,
        ...patch,
        hostStatus: (patch.enabled ?? current.enabled) ? 'ready' : 'disabled',
        hubInstalled: patch.enabled ?? current.hubInstalled,
        agentDeviceInstalled: patch.agentAccessEnabled ?? current.agentDeviceInstalled,
        devices:
          (patch.enabled ?? current.enabled)
            ? [
                {
                  id: 'IOS-1',
                  name: 'iPhone 17 Pro',
                  platform: 'ios',
                  booted: true,
                  physical: false,
                  version: 'iOS 27.0',
                },
              ]
            : [],
        revision: current.revision + 1,
      }
      return current
    })
    const transport = new TestTransport((method, params) => {
      if (method === 'simulator.state' || method === 'simulator.list') return current
      if (method === 'simulator.configure') return configure(params as Partial<SimulatorState>)
      throw new Error(`Unexpected method ${method}`)
    })

    render(<WorkspaceSimulator tabId="sim-1" active transport={transport} threadId="thread-1" />)

    await screen.findByText('Set up Simulator')
    const hubSwitch = screen.getByRole('switch', { name: 'Enable local simulator hub' })
    const agentSwitch = screen.getByRole('switch', { name: 'Allow agents to control simulators' })
    const continueButton = screen.getByRole('button', { name: 'Continue to Simulator' })
    expect(agentSwitch.hasAttribute('disabled')).toBe(true)
    expect(continueButton.hasAttribute('disabled')).toBe(true)

    fireEvent.click(hubSwitch)
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ enabled: true }))

    await waitFor(() => expect(agentSwitch.hasAttribute('disabled')).toBe(false))
    fireEvent.click(agentSwitch)
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ agentAccessEnabled: true }))

    fireEvent.click(continueButton)
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ onboardingCompleted: true }))

    await screen.findByText('iPhone 17 Pro')
    expect(screen.getByRole('button', { name: 'Watch' })).toBeTruthy()
  })

  it('lists running and stopped simulators and opens one into the stage', async () => {
    const ready = makeState({
      enabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
      devices: [
        {
          id: 'IOS-1',
          name: 'iPhone 17 Pro',
          platform: 'ios',
          booted: true,
          physical: false,
          version: 'iOS 27.0',
        },
        {
          id: 'IOS-2',
          name: 'iPhone Air',
          platform: 'ios',
          booted: false,
          physical: false,
          version: 'iOS 27.0',
        },
      ],
    })
    const openSpy = vi.fn((_params: unknown) => ({
      device: ready.devices[0]!,
      session: {
        deviceId: 'IOS-1',
        platform: 'ios' as const,
        threadId: 'thread-1',
        openedBy: 'user' as const,
        openedAt: Date.now(),
      },
      hubAccess: {
        httpBase: 'http://127.0.0.1:4311/api/device-hub',
        wsBase: 'ws://127.0.0.1:4311/api/device-hub',
        ticket: 'test-ticket',
        expiresAt: Date.now() + 60_000,
      },
    }))
    const transport = new TestTransport((method, params) => {
      if (method === 'simulator.state' || method === 'simulator.list') return ready
      if (method === 'simulator.open') return openSpy(params)
      if (method === 'simulator.hubAccess') {
        return {
          httpBase: 'http://127.0.0.1:4311/api/device-hub',
          wsBase: 'ws://127.0.0.1:4311/api/device-hub',
          ticket: 'test-ticket',
          expiresAt: Date.now() + 60_000,
        }
      }
      if (method === 'simulator.detail') return makeDetail('IOS-1')
      throw new Error(`Unexpected method ${method}`)
    })

    const onDeviceInfo = vi.fn()
    render(
      <WorkspaceSimulator
        tabId="sim-1"
        active={false}
        transport={transport}
        threadId="thread-1"
        onDeviceInfo={onDeviceInfo}
      />,
    )

    await screen.findByText('iPhone 17 Pro')
    expect(screen.getByText('iPhone Air')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }))

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith({
        threadId: 'thread-1',
        deviceId: 'IOS-1',
        platform: 'ios',
      })
    })
    const toolbar = await screen.findByRole('toolbar', { name: 'Simulator controls' })
    expect(within(toolbar).getByRole('button', { name: 'More simulator actions' })).toBeTruthy()
    expect(onDeviceInfo).toHaveBeenCalledWith('sim-1', {
      deviceId: 'IOS-1',
      name: 'iPhone 17 Pro',
      platform: 'ios',
    })
  })

  it('creates and removes an Android emulator from the Simulator picker', async () => {
    let current = makeState({
      enabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
      platforms: [
        { platform: 'ios', available: true },
        { platform: 'android', available: true },
      ],
      androidSdk: {
        root: '/sdk',
        defaultRoot: '/sdk',
        adb: true,
        emulator: true,
        cmdlineTools: true,
        javaAvailable: true,
        javaPath: '/jdk',
        hostAbi: 'arm64-v8a',
        systemImages: [
          {
            packageId: 'system-images;android-35;google_apis_playstore;arm64-v8a',
            label: 'Android API 35 · Google Play (arm64-v8a)',
            apiLevel: 35,
            tag: 'google_apis_playstore',
            abi: 'arm64-v8a',
            installed: true,
          },
        ],
      },
      devices: [],
    })

    const createSpy = vi.fn((params: Record<string, unknown>) => {
      const created = {
        id: String(params['name']),
        name: String(params['name']),
        platform: 'android' as const,
        version: 'Android API 35',
        booted: false,
        physical: false,
      }
      current = { ...current, devices: [created], revision: current.revision + 1 }
      return { device: created, state: current }
    })
    const removeSpy = vi.fn(() => {
      current = { ...current, devices: [], revision: current.revision + 1 }
      return current
    })
    const transport = new TestTransport((method, params) => {
      if (method === 'simulator.state' || method === 'simulator.list') return current
      if (method === 'simulator.newOptions') {
        return {
          ios: { runtimes: [] },
          android: {
            runtimes: [
              {
                value: 'system-images;android-35;google_apis_playstore;arm64-v8a',
                label: 'Android API 35 · Google Play (arm64-v8a)',
                models: [{ value: 'pixel_9', label: 'Pixel 9', supported: true }],
              },
            ],
          },
          errors: [],
        }
      }
      if (method === 'simulator.create') return createSpy(params as Record<string, unknown>)
      if (method === 'simulator.remove') return removeSpy()
      throw new Error(`Unexpected method ${method}`)
    })

    render(<WorkspaceSimulator tabId="sim-android" active transport={transport} threadId="t1" />)

    const [newButton] = await screen.findAllByRole('button', { name: 'New simulator' })
    fireEvent.click(newButton!)
    fireEvent.click(screen.getByRole('button', { name: 'Android' }))
    await screen.findByLabelText('Android system image')

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({
        platform: 'android',
        name: 'Pixel_9',
        runtime: 'system-images;android-35;google_apis_playstore;arm64-v8a',
        deviceType: 'pixel_9',
        boot: false,
      })
    })

    await screen.findByText('Pixel_9')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pixel_9' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removeSpy).toHaveBeenCalledOnce())
  })

  it('exposes Android parity controls (Back, Recents, Orientation, Network, Physical activity)', async () => {
    const ready = makeState({
      enabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
      platforms: [
        { platform: 'ios', available: false },
        { platform: 'android', available: true },
      ],
      devices: [
        {
          id: 'emulator-5554',
          name: 'Pixel_9_API_35',
          platform: 'android',
          version: 'Android 15.0',
          booted: true,
          physical: false,
        },
      ],
    })
    const actionSpy = vi.fn(() =>
      makeDetail('emulator-5554', {
        platform: 'android',
        orientation: 'landscape_left',
        toggles: { reduceMotion: false, networkEnabled: true },
      }),
    )
    const transport = new TestTransport((method) => {
      if (method === 'simulator.state' || method === 'simulator.list') return ready
      if (method === 'simulator.hubAccess') {
        return {
          httpBase: 'http://127.0.0.1:4311/api/device-hub',
          wsBase: 'ws://127.0.0.1:4311/api/device-hub',
          ticket: 't',
          expiresAt: Date.now() + 60_000,
        }
      }
      if (method === 'simulator.detail') {
        return makeDetail('emulator-5554', {
          platform: 'android',
          orientation: 'portrait',
          toggles: { reduceMotion: false, networkEnabled: true },
        })
      }
      if (method === 'simulator.action') return actionSpy()
      throw new Error(`Unexpected method ${method}`)
    })

    render(
      <WorkspaceSimulator
        tabId="sim-and"
        active={false}
        transport={transport}
        threadId="t1"
        initialDeviceId="emulator-5554"
      />,
    )

    const toolbar = await screen.findByRole('toolbar', { name: 'Simulator controls' })
    expect(within(toolbar).getByRole('button', { name: 'Back button' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Recents' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Rotate simulator' })).toBeTruthy()

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Simulator tools' }))
    const orientation = await screen.findByLabelText('Orientation')
    fireEvent.change(orientation, { target: { value: 'landscape_left' } })
    await waitFor(() => expect(actionSpy).toHaveBeenCalled())
    expect(screen.getByRole('switch', { name: 'High contrast text' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Network enabled' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Physical activity' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy()
  })

  it('parses serve-emu Android accessibility snapshots using screen dimensions and contentDescription', async () => {
    const { fetchSimulatorAxTree } = await import('./simulator-hub-api.js')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          screen: { width: 1080, height: 2424 },
          nodes: [
            {
              id: '0',
              text: '',
              contentDescription: 'Navigate up',
              resourceId: 'com.example:id/back',
              className: 'android.widget.ImageButton',
              bounds: { left: 0, top: 121, right: 162, bottom: 242 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    try {
      const elements = await fetchSimulatorAxTree(
        {
          httpBase: 'http://127.0.0.1:4311/api/device-hub',
          wsBase: 'ws://127.0.0.1:4311/api/device-hub',
          ticket: 'tk',
          expiresAt: Date.now() + 60_000,
        },
        'android',
        'emulator-5554',
      )
      expect(elements).toHaveLength(1)
      expect(elements[0]!.label).toBe('Navigate up')
      expect(elements[0]!.width).toBeCloseTo(162 / 1080, 4)
      expect(elements[0]!.height).toBeCloseTo(121 / 2424, 4)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('WorkspacePanel simulator integration', () => {
  it('opens and labels a Simulator tab when an agent opens a device', async () => {
    const ready = makeState({
      enabled: true,
      agentAccessEnabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
      agentDeviceInstalled: true,
      devices: [
        {
          id: 'IOS-AGENT',
          name: 'iPhone 17 Pro',
          platform: 'ios',
          booted: true,
          physical: false,
          version: 'iOS 27.0',
        },
      ],
    })
    const transport = new TestTransport((method) => {
      if (method === 'simulator.state' || method === 'simulator.list') return ready
      if (method === 'simulator.hubAccess') {
        return {
          httpBase: 'http://127.0.0.1:4311/api/device-hub',
          wsBase: 'ws://127.0.0.1:4311/api/device-hub',
          ticket: 't',
          expiresAt: Date.now() + 60_000,
        }
      }
      if (method === 'simulator.detail') return makeDetail('IOS-AGENT')
      throw new Error(`Unexpected method ${method}`)
    })

    const onOpen = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={420}
        transport={transport}
        threadId="thread-agent"
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible={false}
        onOpen={onOpen}
        onClose={vi.fn()}
        onWidthChange={vi.fn()}
        simulatorOpenRequest={{ requestId: 1, deviceId: 'IOS-AGENT', name: 'iPhone 17 Pro' }}
      />,
    )

    expect(onOpen).toHaveBeenCalled()
    await waitFor(() => {
      const tablist = screen.getByRole('tablist')
      expect(within(tablist).getByRole('tab', { name: 'Simulator: iPhone 17 Pro' })).toBeTruthy()
    })
  })
})

describe('SimulatorSettings', () => {
  it('toggles simulator viewing and agent access through simulator.configure', async () => {
    const state = makeState({
      enabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
    })
    const configure = vi.fn((patch: Record<string, unknown>) => ({
      ...state,
      ...patch,
    }))
    const transport = new TestTransport((method, params) => {
      if (method === 'simulator.state') return state
      if (method === 'simulator.configure') return configure(params as Record<string, unknown>)
      throw new Error(`Unexpected method ${method}`)
    })

    render(<SimulatorSettings transport={transport} />)

    const agentSwitch = await screen.findByRole('switch', {
      name: 'Allow agents to control simulators',
    })
    fireEvent.click(agentSwitch)

    await waitFor(() => {
      expect(configure).toHaveBeenCalledWith({ agentAccessEnabled: true })
    })
  })

  it('installs and removes Android system images and simulators in Settings', async () => {
    const state = makeState({
      enabled: true,
      onboardingCompleted: true,
      hostStatus: 'ready',
      hubInstalled: true,
      platforms: [
        { platform: 'ios', available: true },
        { platform: 'android', available: true },
      ],
      androidSdk: {
        root: '/sdk',
        defaultRoot: '/sdk',
        adb: true,
        emulator: true,
        cmdlineTools: true,
        javaAvailable: true,
        javaPath: '/jdk',
        hostAbi: 'arm64-v8a',
        systemImages: [
          {
            packageId: 'system-images;android-35;google_apis_playstore;arm64-v8a',
            label: 'Android API 35 · Google Play (arm64-v8a)',
            apiLevel: 35,
            tag: 'google_apis_playstore',
            abi: 'arm64-v8a',
            installed: true,
          },
          {
            packageId: 'system-images;android-36;google_apis_playstore;arm64-v8a',
            label: 'Android API 36 · Google Play (arm64-v8a)',
            apiLevel: 36,
            tag: 'google_apis_playstore',
            abi: 'arm64-v8a',
            installed: false,
          },
        ],
      },
      devices: [
        {
          id: 'Pixel_9_API_35',
          name: 'Pixel_9_API_35',
          platform: 'android',
          version: 'Android API 35',
          booted: false,
          physical: false,
        },
      ],
    })
    const installSpy = vi.fn((_params: unknown) => state)
    const uninstallSpy = vi.fn((_params: unknown) => state)
    const removeSpy = vi.fn((_params: unknown) => state)
    const transport = new TestTransport((method, params) => {
      if (method === 'simulator.state') return state
      if (method === 'simulator.installAndroid') return installSpy(params)
      if (method === 'simulator.uninstallAndroidImage') return uninstallSpy(params)
      if (method === 'simulator.remove') return removeSpy(params)
      throw new Error(`Unexpected method ${method}`)
    })

    render(<SimulatorSettings transport={transport} />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Install Android API 36 · Google Play (arm64-v8a)',
      }),
    )
    await waitFor(() =>
      expect(installSpy).toHaveBeenCalledWith({
        systemImage: 'system-images;android-36;google_apis_playstore;arm64-v8a',
        createDefaultAvd: false,
      }),
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove Android API 35 · Google Play (arm64-v8a)',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(uninstallSpy).toHaveBeenCalledWith({
        packageId: 'system-images;android-35;google_apis_playstore;arm64-v8a',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pixel_9_API_35' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(removeSpy).toHaveBeenCalledWith({
        platform: 'android',
        deviceId: 'Pixel_9_API_35',
        name: 'Pixel_9_API_35',
      }),
    )
  })
})

describe('iOS simulator keyboard encoding', () => {
  const keyEvent = (
    overrides: Partial<{
      code: string
      key: string
      shiftKey: boolean
      metaKey: boolean
      ctrlKey: boolean
      altKey: boolean
    }>,
  ) => ({
    code: 'KeyA',
    key: 'a',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  })

  it('includes key and shifted flags for uppercase, symbols, and non-US layouts', () => {
    expect(
      iosKeyMessageForEvent(keyEvent({ code: 'KeyA', key: 'A', shiftKey: true }), 'down'),
    ).toEqual({
      type: 'down',
      usage: 0x04,
      key: 'A',
      shifted: true,
    })

    // German QWERTZ Z key (physical KeyY) and Option+L (@) carry the actual character.
    expect(iosKeyMessageForEvent(keyEvent({ code: 'KeyY', key: 'z' }), 'down')).toEqual({
      type: 'down',
      usage: 0x1c,
      key: 'z',
    })
    expect(
      iosKeyMessageForEvent(keyEvent({ code: 'KeyL', key: '@', altKey: true }), 'down'),
    ).toEqual({
      type: 'down',
      usage: 0x0f,
      key: '@',
    })
    expect(iosKeyMessageForEvent(keyEvent({ code: 'IntlBackslash', key: '<' }), 'down')).toEqual({
      type: 'down',
      usage: 0x64,
      key: '<',
    })
  })

  it('omits character metadata on keyup, non-printable keys, and Space shift', () => {
    expect(
      iosKeyMessageForEvent(keyEvent({ code: 'KeyA', key: 'A', shiftKey: true }), 'up'),
    ).toEqual({
      type: 'up',
      usage: 0x04,
    })
    expect(
      iosKeyMessageForEvent(keyEvent({ code: 'Space', key: ' ', shiftKey: true }), 'down'),
    ).toEqual({
      type: 'down',
      usage: 0x2c,
      key: ' ',
    })
    expect(
      iosKeyMessageForEvent(keyEvent({ code: 'Backspace', key: 'Backspace' }), 'down'),
    ).toEqual({
      type: 'down',
      usage: 0x2a,
    })
    expect(hidUsageForCode('Home')).toBe(0x4a)
    expect(hidUsageForCode('End')).toBe(0x4d)
    expect(hidUsageForCode('CapsLock')).toBe(0x39)
  })
})
