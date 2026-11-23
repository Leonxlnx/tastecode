import { useEffect, useState } from 'react'
import type { SimulatorDevice, SimulatorState } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { Skeleton, SkeletonStatus } from './Skeleton.js'
import {
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './settings/SettingsLayout.js'

export function SimulatorSettings(props: { transport: Transport }) {
  const { transport } = props
  const [state, setState] = useState<SimulatorState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmRemoveDevice, setConfirmRemoveDevice] = useState<string>()
  const [confirmRemoveImage, setConfirmRemoveImage] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const off = transport.on('simulator.changed', (next) => {
      if (!cancelled) setState(next)
    })
    transport
      .request('simulator.state', {})
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      off()
    }
  }, [transport])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const configure = (patch: {
    enabled?: boolean
    agentAccessEnabled?: boolean
    onboardingCompleted?: boolean
  }) =>
    run(async () => {
      setState(await transport.request('simulator.configure', patch))
    })

  const refresh = () =>
    run(async () => {
      setState(await transport.request('simulator.list', {}))
    })

  const installAndroid = (options?: { systemImage?: string; createDefaultAvd?: boolean }) =>
    run(async () => {
      setState(
        await transport.request('simulator.installAndroid', {
          ...(options?.systemImage ? { systemImage: options.systemImage } : {}),
          ...(options?.createDefaultAvd !== undefined
            ? { createDefaultAvd: options.createDefaultAvd }
            : {}),
        }),
      )
    })

  const uninstallAndroidImage = (packageId: string) =>
    run(async () => {
      setConfirmRemoveImage(undefined)
      setState(await transport.request('simulator.uninstallAndroidImage', { packageId }))
    })

  const removeDevice = (device: SimulatorDevice) =>
    run(async () => {
      setConfirmRemoveDevice(undefined)
      setState(
        await transport.request('simulator.remove', {
          platform: device.platform,
          deviceId: device.id,
          name: device.name,
        }),
      )
    })

  const hubBusy = state?.hostStatus === 'installing' || state?.hostStatus === 'starting'
  const androidBusy =
    state?.androidSetupStatus === 'installing' || state?.androidSetupStatus === 'removing'
  const androidSdk = state?.androidSdk
  const javaMissing = androidSdk ? !androidSdk.javaAvailable : false
  const hasInstalledAndroidImage = Boolean(
    androidSdk?.systemImages.some((image) => image.installed),
  )
  const virtualDevices = (state?.devices ?? []).filter((device) => !device.physical)

  return (
    <SettingsPage
      title="Simulator"
      description="Run live iOS Simulators and Android Emulators in the right sidebar, and optionally let coding agents launch, tap, and inspect your mobile apps."
    >
      {state === undefined ? (
        error ? (
          <SettingsNotice tone="error">{error}</SettingsNotice>
        ) : (
          <SkeletonStatus label="Loading simulator settings…">
            <Skeleton width={260} height={11} />
          </SkeletonStatus>
        )
      ) : (
        <>
          {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
          {state.hostStatus === 'failed' && state.hostStatusDetail ? (
            <SettingsNotice tone="error">{state.hostStatusDetail}</SettingsNotice>
          ) : null}
          {androidBusy && state.androidSetupDetail ? (
            <SettingsNotice tone="progress">{state.androidSetupDetail}</SettingsNotice>
          ) : state.androidSetupStatus === 'failed' && state.androidSetupDetail ? (
            <SettingsNotice tone="error">{state.androidSetupDetail}</SettingsNotice>
          ) : null}

          <SettingsSection title="Local simulators">
            <SettingsRow
              name="Use simulators"
              note="Runs the pinned expo-device-hub helper locally on loopback so the Simulator panel can list, boot, and stream iOS Simulators and Android Emulators. Turning this off stops helper processes; running simulators stay open until powered off."
              tone={state.enabled ? 'active' : undefined}
            >
              <button
                type="button"
                role="switch"
                aria-checked={state.enabled}
                aria-label="Use simulators"
                className={`switch${state.enabled ? ' is-on' : ''}`}
                disabled={busy || hubBusy}
                onClick={() =>
                  void configure({
                    enabled: !state.enabled,
                    ...(state.enabled ? {} : { onboardingCompleted: true }),
                  })
                }
              />
            </SettingsRow>

            <SettingsRow
              name="Allow agents to control simulators"
              note="Installs agent-device and injects the device_list, device_open, device_screenshot, and device_close MCP tools into new and resumed agent sessions."
              tone={state.agentAccessEnabled ? 'active' : undefined}
            >
              <button
                type="button"
                role="switch"
                aria-checked={state.agentAccessEnabled}
                aria-label="Allow agents to control simulators"
                className={`switch${state.agentAccessEnabled ? ' is-on' : ''}`}
                disabled={!state.enabled || busy || hubBusy}
                onClick={() => void configure({ agentAccessEnabled: !state.agentAccessEnabled })}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Platforms">
            {state.platforms.map((platform) => {
              const isAndroid = platform.platform === 'android'
              const androidNeedsInstall =
                isAndroid && (!platform.available || !hasInstalledAndroidImage)
              return (
                <SettingsRow
                  key={platform.platform}
                  name={platform.platform === 'ios' ? 'iOS Simulator' : 'Android Emulator'}
                  note={
                    platform.available
                      ? isAndroid && !hasInstalledAndroidImage
                        ? 'SDK tools are installed. Install a system image below to create Android emulators.'
                        : 'Available on this machine.'
                      : isAndroid && javaMissing && androidSdk?.javaReason
                        ? androidSdk.javaReason
                        : (platform.reason ?? 'Unavailable on this machine.')
                  }
                >
                  {androidNeedsInstall ? (
                    <button
                      type="button"
                      className="set-button"
                      disabled={busy || androidBusy || javaMissing}
                      onClick={() => void installAndroid({ createDefaultAvd: true })}
                    >
                      {androidBusy ? 'Installing…' : 'Install'}
                    </button>
                  ) : (
                    <span className="set-value">
                      {platform.available ? 'Ready' : 'Unavailable'}
                    </span>
                  )}
                </SettingsRow>
              )
            })}
            <SettingsRow
              name="Check devices and platforms"
              note={
                hubBusy
                  ? (state.hostStatusDetail ?? 'Starting simulator hub…')
                  : `Status: ${state.hostStatus} · ${state.devices.length} detected`
              }
            >
              <button
                type="button"
                className="set-button"
                disabled={busy || hubBusy || androidBusy}
                onClick={() => void refresh()}
              >
                Refresh
              </button>
            </SettingsRow>
          </SettingsSection>

          {androidSdk ? (
            <SettingsSection
              title="Android system images"
              note={`SDK directory: ${androidSdk.root ?? androidSdk.defaultRoot} · Architecture: ${androidSdk.hostAbi}`}
            >
              {androidSdk.systemImages.map((image) => {
                const confirming = confirmRemoveImage === image.packageId
                return (
                  <SettingsRow
                    key={image.packageId}
                    name={image.label}
                    note={image.packageId}
                    tone={image.installed ? 'active' : undefined}
                  >
                    {image.installed ? (
                      confirming ? (
                        <>
                          <button
                            type="button"
                            className="set-button set-button--danger"
                            disabled={busy || androidBusy}
                            onClick={() => void uninstallAndroidImage(image.packageId)}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            className="set-button set-button--quiet"
                            disabled={busy || androidBusy}
                            onClick={() => setConfirmRemoveImage(undefined)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="set-button"
                          aria-label={`Remove ${image.label}`}
                          disabled={busy || androidBusy}
                          onClick={() => setConfirmRemoveImage(image.packageId)}
                        >
                          Remove
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="set-button"
                        aria-label={`Install ${image.label}`}
                        disabled={busy || androidBusy || javaMissing}
                        onClick={() =>
                          void installAndroid({
                            systemImage: image.packageId,
                            createDefaultAvd: false,
                          })
                        }
                      >
                        {androidBusy ? 'Installing…' : 'Install'}
                      </button>
                    )}
                  </SettingsRow>
                )
              })}
            </SettingsSection>
          ) : null}

          {state.enabled && virtualDevices.length > 0 ? (
            <SettingsSection
              title="Installed simulators"
              note="Create new iOS Simulators and Android Emulators from the Simulator panel's New button."
            >
              {virtualDevices.map((device) => {
                const rowKey = `${device.platform}:${device.id}`
                const confirming = confirmRemoveDevice === rowKey
                return (
                  <SettingsRow
                    key={rowKey}
                    name={device.name}
                    note={`${device.platform === 'ios' ? 'iOS' : 'Android'} · ${device.version}${device.booted ? ' · Running' : ''}`}
                  >
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          className="set-button set-button--danger"
                          disabled={busy}
                          onClick={() => void removeDevice(device)}
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          className="set-button set-button--quiet"
                          disabled={busy}
                          onClick={() => setConfirmRemoveDevice(undefined)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="set-button"
                        aria-label={`Remove ${device.name}`}
                        disabled={busy}
                        onClick={() => setConfirmRemoveDevice(rowKey)}
                      >
                        Remove
                      </button>
                    )}
                  </SettingsRow>
                )
              })}
            </SettingsSection>
          ) : null}

          {state.tools ? (
            <SettingsSection title="Installed tools">
              <SettingsRow
                name="expo-device-hub"
                note={`Required ${state.tools.hub.requiredVersion}${
                  state.tools.hub.runningVersion
                    ? ` · Running ${state.tools.hub.runningVersion}`
                    : ''
                }`}
              >
                <span className="set-value">
                  {state.hubInstalled ? 'Installed' : 'Not installed'}
                </span>
              </SettingsRow>
              <SettingsRow
                name="agent-device"
                note={`Required ${state.tools.agent.requiredVersion}${
                  state.tools.agent.runningVersion
                    ? ` · Running ${state.tools.agent.runningVersion}`
                    : ''
                }`}
              >
                <span className="set-value">
                  {state.agentDeviceInstalled ? 'Installed' : 'Not installed'}
                </span>
              </SettingsRow>
            </SettingsSection>
          ) : null}
        </>
      )}
    </SettingsPage>
  )
}
