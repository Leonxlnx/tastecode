import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import {
  IconAdjustmentsHorizontal as SlidersHorizontal,
  IconArrowBackUp as BackIcon,
  IconCamera as Camera,
  IconCheck as Check,
  IconAlertCircle as CircleAlert,
  IconDeviceMobile as Smartphone,
  IconDots as MoreHorizontal,
  IconDownload as Download,
  IconHome as Home,
  IconLayoutGrid as AppSwitcher,
  IconLoader2 as LoaderCircle,
  IconMoon as Moon,
  IconPlayerPlay as Play,
  IconPlus as Plus,
  IconPower as Power,
  IconRefresh as RefreshCw,
  IconRotateClockwise as RotateCw,
  IconSun as Sun,
  IconSwitchHorizontal as SwitchDevice,
  IconTextSize as TextSizeIcon,
  IconTrash as Trash2,
  IconX as X,
} from '@tabler/icons-react'
import type {
  SimulatorActionInput,
  SimulatorDetail,
  SimulatorDevice,
  SimulatorHubAccess,
  SimulatorNewOptions,
  SimulatorOrientation,
  SimulatorPermission,
  SimulatorPlatform,
  SimulatorState,
  SimulatorTextSize,
  SimulatorToggleSetting,
} from '@harness/contracts'
import { errorMessage } from '../../boundary.js'
import type { Transport } from '../../transport.js'
import { Menu, MenuItem } from '../Menu.js'
import { RowIssue } from '../RowIssue.js'
import { Skeleton, SkeletonRows, SkeletonStatus } from '../Skeleton.js'
import {
  captureSimulatorScreenshot,
  fetchSimulatorAxTree,
  fitSimulatorFrame,
  SimulatorScreenshotError,
  type SimulatorAxElement,
} from './simulator-hub-api.js'
import {
  createSimulatorStreamClient,
  type SimulatorKeyInput,
  type SimulatorScreenInfo,
  type SimulatorStreamClient,
  type SimulatorStreamStatus,
} from './simulator-stream.js'
import './workspace-simulator.css'

/**
 * Command-key chords forwarded to the simulator instead of TasteCode / browser
 * defaults. Bare `Meta` presses are not held open in the simulator's HID state
 * so app shortcuts like Cmd+K, Cmd+B, Cmd+L, and Cmd+Tab never leave Command
 * stuck down inside the simulator.
 */
const SIMULATOR_META_CHORD_CODES = new Set([
  'KeyA',
  'KeyC',
  'KeyX',
  'KeyZ',
  'KeyR',
  'Backspace',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
])

export type SimulatorTabInfo = {
  readonly deviceId?: string | undefined
  readonly name: string
  readonly platform?: SimulatorPlatform | undefined
}

const LOCATION_PRESETS = [
  { label: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { label: 'New York', latitude: 40.7128, longitude: -74.006 },
  { label: 'London', latitude: 51.5074, longitude: -0.1278 },
  { label: 'Berlin', latitude: 52.52, longitude: 13.405 },
  { label: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
] as const

const TEXT_SIZES: ReadonlyArray<{ value: SimulatorTextSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'extra-large', label: 'Extra large' },
]

const IOS_PERMISSIONS: ReadonlyArray<{ value: SimulatorPermission; label: string }> = [
  { value: 'camera', label: 'Camera' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'photos', label: 'Photos' },
  { value: 'location', label: 'Location' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'reminders', label: 'Reminders' },
  { value: 'motion', label: 'Motion' },
  { value: 'media-library', label: 'Media library' },
  { value: 'faceid', label: 'Face ID' },
]

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: SimulatorPermission; label: string }> = [
  { value: 'camera', label: 'Camera' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'photos', label: 'Photos' },
  { value: 'location', label: 'Location' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'motion', label: 'Physical activity' },
]

const ANDROID_ORIENTATIONS: ReadonlyArray<{ value: SimulatorOrientation; label: string }> = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape_left', label: 'Landscape left' },
  { value: 'portrait_upside_down', label: 'Upside down' },
  { value: 'landscape_right', label: 'Landscape right' },
]

const DOWNLOAD_URL_LIFETIME_MS = 60_000

function screenAspect(platform: SimulatorPlatform, screen: SimulatorScreenInfo | null): number {
  if (!screen) return platform === 'ios' ? 9 / 19.5 : 9 / 20
  const landscape =
    screen.orientation === 'landscape_left' || screen.orientation === 'landscape_right'
  const w = landscape
    ? Math.max(screen.width, screen.height)
    : Math.min(screen.width, screen.height)
  const h = landscape
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height)
  return w / h
}

function screenRotation(platform: SimulatorPlatform, screen: SimulatorScreenInfo | null): number {
  if (platform !== 'ios' || !screen || screen.width > screen.height) return 0
  switch (screen.orientation) {
    case 'landscape_left':
      return 90
    case 'landscape_right':
      return -90
    case 'portrait_upside_down':
      return 180
    default:
      return 0
  }
}

export const WorkspaceSimulator = memo(function WorkspaceSimulator(props: {
  tabId: string
  active: boolean
  transport: Transport
  threadId?: string | undefined
  initialDeviceId?: string | undefined
  initialDeviceRequestId?: number | undefined
  onDeviceInfo?: ((tabId: string, info: SimulatorTabInfo) => void) | undefined
  onClose?: (() => void) | undefined
}) {
  const {
    tabId,
    active,
    transport,
    threadId,
    initialDeviceId,
    initialDeviceRequestId,
    onDeviceInfo,
  } = props
  const effectiveThreadId = threadId ?? `panel:${tabId}`

  const [state, setState] = useState<SimulatorState>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [bootingDeviceId, setBootingDeviceId] = useState<string>()
  const [error, setError] = useState<string>()
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(initialDeviceId)

  useEffect(() => {
    if (initialDeviceId) setSelectedDeviceId(initialDeviceId)
  }, [initialDeviceId, initialDeviceRequestId])

  useEffect(() => {
    let cancelled = false
    const off = transport.on('simulator.changed', (next) => {
      if (!cancelled) setState(next)
    })
    void transport
      .request('simulator.state', {})
      .then((next) => {
        if (cancelled) return
        setState(next)
        setLoading(false)
        if (next.enabled && next.onboardingCompleted) {
          return transport
            .request('simulator.list', {})
            .then((refreshed) => {
              if (!cancelled) setState(refreshed)
            })
            .catch(() => undefined)
        }
        return undefined
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
      off()
    }
  }, [transport])

  const selectedDevice = useMemo(
    () =>
      selectedDeviceId
        ? state?.devices.find((device) => device.id === selectedDeviceId)
        : undefined,
    [selectedDeviceId, state?.devices],
  )

  useEffect(() => {
    onDeviceInfo?.(tabId, {
      deviceId: selectedDevice?.id,
      name: selectedDevice?.name ?? 'Simulator',
      platform: selectedDevice?.platform,
    })
  }, [onDeviceInfo, selectedDevice?.id, selectedDevice?.name, selectedDevice?.platform, tabId])

  const refreshDevices = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await transport.request('simulator.list', {})
      setState(next)
    } catch (cause: unknown) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [transport])

  const configure = useCallback(
    async (patch: {
      enabled?: boolean
      agentAccessEnabled?: boolean
      onboardingCompleted?: boolean
    }) => {
      setBusy(true)
      setError(undefined)
      try {
        const next = await transport.request('simulator.configure', patch)
        setState(next)
      } catch (cause: unknown) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [transport],
  )

  const openDevice = useCallback(
    async (device: SimulatorDevice) => {
      setBootingDeviceId(device.id)
      setError(undefined)
      try {
        const result = await transport.request('simulator.open', {
          threadId: effectiveThreadId,
          deviceId: device.id,
          platform: device.platform,
        })
        setSelectedDeviceId(result.device.id)
      } catch (cause: unknown) {
        setError(errorMessage(cause))
      } finally {
        setBootingDeviceId(undefined)
      }
    },
    [effectiveThreadId, transport],
  )

  const detachDevice = useCallback(async () => {
    const deviceId = selectedDeviceId
    setSelectedDeviceId(undefined)
    if (!deviceId) return
    await transport
      .request('simulator.close', { threadId: effectiveThreadId, deviceId })
      .catch(() => undefined)
  }, [effectiveThreadId, selectedDeviceId, transport])

  const powerOffDevice = useCallback(async () => {
    const deviceId = selectedDeviceId
    if (!deviceId) return
    setBusy(true)
    setError(undefined)
    try {
      await transport.request('simulator.shutdown', { deviceId })
      setSelectedDeviceId(undefined)
    } catch (cause: unknown) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [selectedDeviceId, transport])

  const installAndroid = useCallback(
    async (options?: { systemImage?: string; createDefaultAvd?: boolean }) => {
      setBusy(true)
      setError(undefined)
      try {
        const next = await transport.request('simulator.installAndroid', {
          ...(options?.systemImage ? { systemImage: options.systemImage } : {}),
          ...(options?.createDefaultAvd !== undefined
            ? { createDefaultAvd: options.createDefaultAvd }
            : {}),
        })
        setState(next)
      } catch (cause: unknown) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [transport],
  )

  const createDevice = useCallback(
    async (input: {
      platform: SimulatorPlatform
      name: string
      runtime: string
      deviceType: string
      boot: boolean
    }) => {
      setBusy(true)
      setError(undefined)
      try {
        const result = await transport.request('simulator.create', input)
        setState(result.state)
        if (input.boot) {
          const opened = await transport.request('simulator.open', {
            threadId: effectiveThreadId,
            deviceId: result.device.id,
            platform: result.device.platform,
          })
          setSelectedDeviceId(opened.device.id)
        }
      } catch (cause: unknown) {
        setError(errorMessage(cause))
        throw cause
      } finally {
        setBusy(false)
      }
    },
    [effectiveThreadId, transport],
  )

  const removeDevice = useCallback(
    async (device: SimulatorDevice) => {
      setBusy(true)
      setError(undefined)
      try {
        const next = await transport.request('simulator.remove', {
          platform: device.platform,
          deviceId: device.id,
          name: device.name,
        })
        setState(next)
        if (selectedDeviceId === device.id) {
          setSelectedDeviceId(undefined)
        }
      } catch (cause: unknown) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectedDeviceId, transport],
  )

  if (loading || !state) {
    return (
      <SkeletonStatus label="Loading simulator…" className="workspace-panel__loading">
        <div className="workspace-panel__loading-bar">
          <Skeleton className="skeleton--icon" />
          <Skeleton width={120} height={9} />
        </div>
        <SkeletonRows rows={6} icon detail density="tall" />
      </SkeletonStatus>
    )
  }

  if (!state.enabled || !state.onboardingCompleted) {
    return (
      <SimulatorSetupView
        state={state}
        busy={busy}
        error={error}
        onConfigure={configure}
        onRefresh={refreshDevices}
        onInstallAndroid={() => void installAndroid({ createDefaultAvd: true })}
      />
    )
  }

  if (selectedDevice) {
    return (
      <SimulatorStage
        key={selectedDevice.id}
        active={active}
        transport={transport}
        device={selectedDevice}
        busy={busy}
        onSwitchDevice={() => void detachDevice()}
        onPowerOff={() => void powerOffDevice()}
      />
    )
  }

  return (
    <SimulatorDevicePicker
      transport={transport}
      state={state}
      busy={busy}
      bootingDeviceId={bootingDeviceId}
      error={error}
      onRefresh={() => void refreshDevices()}
      onSelect={(device) => void openDevice(device)}
      onToggleAgent={(enabled) => void configure({ agentAccessEnabled: enabled })}
      onInstallAndroid={installAndroid}
      onCreateDevice={createDevice}
      onRemoveDevice={removeDevice}
    />
  )
})

function SimulatorSetupView(props: {
  state: SimulatorState
  busy: boolean
  error?: string | undefined
  onConfigure: (patch: {
    enabled?: boolean
    agentAccessEnabled?: boolean
    onboardingCompleted?: boolean
  }) => Promise<void>
  onRefresh: () => Promise<void>
  onInstallAndroid: () => void
}) {
  const { state, busy, error, onConfigure, onRefresh, onInstallAndroid } = props
  const hubBusy = state.hostStatus === 'installing' || state.hostStatus === 'starting'
  const androidBusy =
    state.androidSetupStatus === 'installing' || state.androidSetupStatus === 'removing'
  const anyPlatform = state.platforms.some((entry) => entry.available)
  const canContinue = state.enabled && !hubBusy && state.hostStatus !== 'failed'
  const javaMissing = state.androidSdk ? !state.androidSdk.javaAvailable : false

  return (
    <div className="workspace-simulator">
      <div className="workspace-simulator__bar">
        <div className="workspace-simulator__identity">
          <strong>Simulator</strong>
          <span>iOS Simulator &amp; Android Emulator</span>
        </div>
      </div>
      <div className="workspace-simulator__scroll">
        <div className="workspace-simulator__setup">
          <div className="workspace-simulator__setup-header">
            <h3>Set up Simulator</h3>
            <p>
              Stream live iOS Simulators and Android Emulators right next to your chat, and
              optionally let coding agents launch, inspect, and tap through your mobile apps.
            </p>
          </div>

          {error ? <RowIssue message={error} announce /> : null}
          {state.hostStatus === 'failed' && state.hostStatusDetail ? (
            <RowIssue message={state.hostStatusDetail} announce />
          ) : null}
          {state.androidSetupStatus === 'failed' && state.androidSetupDetail ? (
            <RowIssue message={state.androidSetupDetail} announce />
          ) : null}

          <div className="workspace-simulator__card">
            <div className="workspace-simulator__card-row">
              <div className="workspace-simulator__card-copy">
                <strong>1. Local simulator hub</strong>
                <span>
                  {state.hubInstalled
                    ? 'The pinned expo-device-hub package is already installed locally.'
                    : 'Installs expo-device-hub on demand to discover and stream local simulators.'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={state.enabled}
                aria-label="Enable local simulator hub"
                className={`switch${state.enabled ? ' is-on' : ''}`}
                disabled={busy || hubBusy}
                onClick={() => void onConfigure({ enabled: !state.enabled })}
              />
            </div>
            {hubBusy ? (
              <p className="workspace-simulator__status-line" role="status">
                <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
                <span>{state.hostStatusDetail ?? 'Starting simulator hub…'}</span>
              </p>
            ) : state.enabled && state.hostStatus === 'ready' ? (
              <p className="workspace-simulator__status-line" role="status">
                <Check size={13} aria-hidden />
                <span>Simulator hub is ready.</span>
              </p>
            ) : null}
          </div>

          <div className="workspace-simulator__card">
            <div className="workspace-simulator__card-row">
              <div className="workspace-simulator__card-copy">
                <strong>2. Platform support</strong>
                <span>Either iOS (macOS + Xcode) or Android (Android SDK) can be used.</span>
              </div>
              <button
                type="button"
                className="workspace-simulator__btn workspace-simulator__btn--quiet"
                disabled={busy || hubBusy || androidBusy}
                onClick={() => void onRefresh()}
              >
                <RefreshCw size={13} aria-hidden />
                <span>Check</span>
              </button>
            </div>
            <div className="workspace-simulator__platforms">
              {state.platforms.map((entry) => (
                <div className="workspace-simulator__platform" key={entry.platform}>
                  <span
                    className="workspace-simulator__platform-icon"
                    data-ready={entry.available ? '' : undefined}
                  >
                    {entry.available ? (
                      <Check size={14} aria-hidden />
                    ) : (
                      <CircleAlert size={14} aria-hidden />
                    )}
                  </span>
                  <div className="workspace-simulator__platform-copy">
                    <strong>
                      {entry.platform === 'ios' ? 'iOS Simulator' : 'Android Emulator'}
                    </strong>
                    <span>
                      {entry.available
                        ? 'Ready on this machine.'
                        : entry.platform === 'android' &&
                            javaMissing &&
                            state.androidSdk?.javaReason
                          ? state.androidSdk.javaReason
                          : (entry.reason ?? 'Not available on this machine.')}
                    </span>
                  </div>
                  {entry.platform === 'android' && !entry.available ? (
                    <button
                      type="button"
                      className="workspace-simulator__btn"
                      disabled={busy || androidBusy || javaMissing}
                      onClick={onInstallAndroid}
                    >
                      {androidBusy ? (
                        <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
                      ) : (
                        <Download size={13} aria-hidden />
                      )}
                      <span>{androidBusy ? 'Installing…' : 'Install'}</span>
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {androidBusy ? (
              <p className="workspace-simulator__status-line" role="status">
                <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
                <span>{state.androidSetupDetail ?? 'Installing Android Emulator…'}</span>
              </p>
            ) : null}
          </div>

          <div className="workspace-simulator__card">
            <div className="workspace-simulator__card-row">
              <div className="workspace-simulator__card-copy">
                <strong>3. Allow agents to control simulators</strong>
                <span>
                  Installs agent-device and exposes device_list, device_open, device_screenshot, and
                  device_close tools to new agent sessions.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={state.agentAccessEnabled}
                aria-label="Allow agents to control simulators"
                className={`switch${state.agentAccessEnabled ? ' is-on' : ''}`}
                disabled={!state.enabled || busy || hubBusy}
                onClick={() => void onConfigure({ agentAccessEnabled: !state.agentAccessEnabled })}
              />
            </div>
          </div>

          <div className="workspace-simulator__setup-footer">
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--primary"
              disabled={!canContinue || !anyPlatform || busy}
              onClick={() => void onConfigure({ onboardingCompleted: true })}
            >
              <span>Continue to Simulator</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SimulatorCreateForm(props: {
  transport: Transport
  state: SimulatorState
  busy: boolean
  onCreate: (input: {
    platform: SimulatorPlatform
    name: string
    runtime: string
    deviceType: string
    boot: boolean
  }) => Promise<void>
  onInstallAndroid: (options?: {
    systemImage?: string
    createDefaultAvd?: boolean
  }) => Promise<void>
  onClose: () => void
}) {
  const { transport, state, busy, onCreate, onInstallAndroid, onClose } = props
  const iosAvailable = Boolean(state.platforms.find((p) => p.platform === 'ios')?.available)
  const androidSdk = state.androidSdk
  const androidBusy =
    state.androidSetupStatus === 'installing' || state.androidSetupStatus === 'removing'

  const [platform, setPlatform] = useState<SimulatorPlatform>(iosAvailable ? 'ios' : 'android')
  const [options, setOptions] = useState<SimulatorNewOptions>()
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [runtime, setRuntime] = useState('')
  const [deviceType, setDeviceType] = useState('')
  const [name, setName] = useState('')
  const [installImage, setInstallImage] = useState('')

  const reloadOptions = useCallback(() => {
    setLoadingOptions(true)
    setLoadError(undefined)
    void transport
      .request('simulator.newOptions', {})
      .then((next) => {
        setOptions(next)
        setLoadingOptions(false)
      })
      .catch((cause: unknown) => {
        setLoadError(errorMessage(cause))
        setLoadingOptions(false)
      })
  }, [transport])

  useEffect(() => {
    reloadOptions()
  }, [reloadOptions, state.revision])

  const platformRuntimes = useMemo(
    () => (platform === 'ios' ? (options?.ios.runtimes ?? []) : (options?.android.runtimes ?? [])),
    [options, platform],
  )

  const selectedRuntime = useMemo(
    () => platformRuntimes.find((item) => item.value === runtime) ?? platformRuntimes[0],
    [platformRuntimes, runtime],
  )

  const models = useMemo(() => selectedRuntime?.models ?? [], [selectedRuntime])

  const selectedModel = useMemo(
    () => models.find((item) => item.value === deviceType) ?? models[0],
    [deviceType, models],
  )

  useEffect(() => {
    if (selectedRuntime && selectedRuntime.value !== runtime) {
      setRuntime(selectedRuntime.value)
    }
  }, [runtime, selectedRuntime])

  useEffect(() => {
    if (selectedModel && selectedModel.value !== deviceType) {
      setDeviceType(selectedModel.value)
    }
  }, [deviceType, selectedModel])

  const defaultName = selectedModel
    ? platform === 'android'
      ? selectedModel.label.replaceAll(/\s+/g, '_').replaceAll(/[^A-Za-z0-9._-]/g, '')
      : selectedModel.label
    : ''
  const effectiveName = name.trim() || defaultName

  const installableAndroidImages = useMemo(
    () => androidSdk?.systemImages ?? [],
    [androidSdk?.systemImages],
  )
  const chosenInstallImage =
    installImage ||
    installableAndroidImages.find(
      (img) => img.apiLevel === 35 && img.tag === 'google_apis_playstore',
    )?.packageId ||
    installableAndroidImages[0]?.packageId ||
    ''

  const androidNeedsRuntime =
    platform === 'android' &&
    (!androidSdk?.cmdlineTools ||
      !androidSdk.adb ||
      !androidSdk.emulator ||
      platformRuntimes.length === 0)

  const submit = async (boot: boolean) => {
    if (!selectedRuntime || !selectedModel || !effectiveName) return
    try {
      await onCreate({
        platform,
        name: effectiveName,
        runtime: selectedRuntime.value,
        deviceType: selectedModel.value,
        boot,
      })
      onClose()
    } catch {
      // Error surfaced in parent picker banner.
    }
  }

  return (
    <div className="workspace-simulator__create-form">
      <div className="workspace-simulator__card-row">
        <strong>New simulator</strong>
        <button
          type="button"
          className="workspace-simulator__icon-btn"
          aria-label="Close new simulator form"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="workspace-simulator__segmented" role="group" aria-label="Simulator platform">
        <button
          type="button"
          className={`workspace-simulator__seg-btn${platform === 'ios' ? ' is-active' : ''}`}
          disabled={!iosAvailable}
          onClick={() => {
            setPlatform('ios')
            setName('')
          }}
        >
          iOS
        </button>
        <button
          type="button"
          className={`workspace-simulator__seg-btn${platform === 'android' ? ' is-active' : ''}`}
          onClick={() => {
            setPlatform('android')
            setName('')
          }}
        >
          Android
        </button>
      </div>

      {loadError ? <RowIssue message={loadError} /> : null}

      {androidNeedsRuntime ? (
        <div className="workspace-simulator__android-install">
          <p>
            {androidSdk && !androidSdk.javaAvailable
              ? (androidSdk.javaReason ?? 'Java 17+ is required for Android SDK tools.')
              : 'Install Android SDK tools and a system image to create Android emulators right here.'}
          </p>
          {installableAndroidImages.length > 0 ? (
            <label className="workspace-simulator__field">
              <span>System image</span>
              <select
                className="workspace-simulator__select"
                aria-label="Android system image to install"
                value={chosenInstallImage}
                disabled={busy || androidBusy}
                onChange={(event) => setInstallImage(event.target.value)}
              >
                {installableAndroidImages.map((img) => (
                  <option key={img.packageId} value={img.packageId}>
                    {img.label}
                    {img.installed ? ' (installed)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {androidBusy ? (
            <p className="workspace-simulator__status-line" role="status">
              <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
              <span>{state.androidSetupDetail ?? 'Installing Android Emulator…'}</span>
            </p>
          ) : null}
          <div className="workspace-simulator__input-row">
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--primary"
              disabled={busy || androidBusy || Boolean(androidSdk && !androidSdk.javaAvailable)}
              onClick={() =>
                void onInstallAndroid({
                  ...(chosenInstallImage ? { systemImage: chosenInstallImage } : {}),
                  createDefaultAvd: true,
                }).then(() => reloadOptions())
              }
            >
              {androidBusy ? (
                <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
              ) : (
                <Download size={13} aria-hidden />
              )}
              <span>{androidBusy ? 'Installing…' : 'Install Android Emulator'}</span>
            </button>
          </div>
        </div>
      ) : loadingOptions ? (
        <p className="workspace-simulator__status-line" role="status">
          <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
          <span>Loading available runtimes…</span>
        </p>
      ) : platformRuntimes.length === 0 ? (
        <p className="workspace-simulator__status-line">
          No {platform === 'ios' ? 'iOS runtimes' : 'Android system images'} installed yet.
        </p>
      ) : (
        <>
          <label className="workspace-simulator__field">
            <span>{platform === 'ios' ? 'Runtime' : 'System image'}</span>
            <select
              className="workspace-simulator__select"
              aria-label={platform === 'ios' ? 'iOS runtime' : 'Android system image'}
              value={selectedRuntime?.value ?? ''}
              disabled={busy}
              onChange={(event) => setRuntime(event.target.value)}
            >
              {platformRuntimes.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="workspace-simulator__field">
            <span>Device model</span>
            <select
              className="workspace-simulator__select"
              aria-label="Device model"
              value={selectedModel?.value ?? ''}
              disabled={busy}
              onChange={(event) => {
                setDeviceType(event.target.value)
                const match = models.find((m) => m.value === event.target.value)
                if (match) {
                  setName(
                    platform === 'android'
                      ? match.label.replaceAll(/\s+/g, '_').replaceAll(/[^A-Za-z0-9._-]/g, '')
                      : match.label,
                  )
                }
              }}
            >
              {models.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <label className="workspace-simulator__field">
            <span>Name</span>
            <input
              className="workspace-simulator__input"
              aria-label="Simulator name"
              placeholder={
                defaultName || (platform === 'android' ? 'Pixel_9_API_35' : 'iPhone 17 Pro')
              }
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="workspace-simulator__input-row">
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--primary"
              disabled={busy || !effectiveName || !selectedRuntime || !selectedModel}
              onClick={() => void submit(true)}
            >
              {busy ? (
                <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
              ) : (
                <Play size={12} aria-hidden />
              )}
              <span>Create &amp; start</span>
            </button>
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !effectiveName || !selectedRuntime || !selectedModel}
              onClick={() => void submit(false)}
            >
              <span>Create</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SimulatorDevicePicker(props: {
  transport: Transport
  state: SimulatorState
  busy: boolean
  bootingDeviceId?: string | undefined
  error?: string | undefined
  onRefresh: () => void
  onSelect: (device: SimulatorDevice) => void
  onToggleAgent: (enabled: boolean) => void
  onInstallAndroid: (options?: {
    systemImage?: string
    createDefaultAvd?: boolean
  }) => Promise<void>
  onCreateDevice: (input: {
    platform: SimulatorPlatform
    name: string
    runtime: string
    deviceType: string
    boot: boolean
  }) => Promise<void>
  onRemoveDevice: (device: SimulatorDevice) => Promise<void>
}) {
  const {
    transport,
    state,
    busy,
    bootingDeviceId,
    error,
    onRefresh,
    onSelect,
    onToggleAgent,
    onInstallAndroid,
    onCreateDevice,
    onRemoveDevice,
  } = props
  const [creating, setCreating] = useState(false)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string>()

  const running = state.devices.filter((device) => device.booted)
  const stopped = state.devices.filter((device) => !device.booted)
  const hubBusy = state.hostStatus === 'installing' || state.hostStatus === 'starting'
  const androidBusy =
    state.androidSetupStatus === 'installing' || state.androidSetupStatus === 'removing'
  const androidPlatform = state.platforms.find((p) => p.platform === 'android')
  const androidSdk = state.androidSdk
  const hasInstalledAndroidImage = Boolean(
    androidSdk?.systemImages.some((image) => image.installed),
  )
  const showAndroidInstallBanner =
    !creating &&
    androidPlatform !== undefined &&
    (!androidPlatform.available || !hasInstalledAndroidImage)

  const renderDeviceRow = (device: SimulatorDevice) => {
    const isBooting = bootingDeviceId === device.id
    const rowKey = `${device.platform}:${device.id}`
    const confirming = confirmRemoveKey === rowKey

    return (
      <div className="workspace-simulator__device-row" key={rowKey}>
        <span
          className="workspace-simulator__dot"
          data-booted={device.booted ? '' : undefined}
          aria-hidden
        />
        <div className="workspace-simulator__device-meta">
          <strong>{device.name}</strong>
          <span>{device.version}</span>
        </div>
        <span className="workspace-simulator__badge">
          {device.platform === 'ios' ? 'iOS' : 'Android'}
        </span>
        {confirming ? (
          <div className="workspace-simulator__confirm-row">
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--danger"
              disabled={busy}
              onClick={() => {
                setConfirmRemoveKey(undefined)
                void onRemoveDevice(device)
              }}
            >
              Remove
            </button>
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--quiet"
              disabled={busy}
              onClick={() => setConfirmRemoveKey(undefined)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={
                device.booted
                  ? 'workspace-simulator__btn workspace-simulator__btn--primary'
                  : 'workspace-simulator__btn'
              }
              disabled={Boolean(bootingDeviceId) || busy}
              onClick={() => onSelect(device)}
            >
              {isBooting ? (
                <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
              ) : device.booted ? null : (
                <Play size={12} aria-hidden />
              )}
              <span>
                {isBooting
                  ? device.booted
                    ? 'Opening…'
                    : 'Starting…'
                  : device.booted
                    ? 'Watch'
                    : 'Start'}
              </span>
            </button>
            {!device.physical ? (
              <button
                type="button"
                className="workspace-simulator__icon-btn workspace-simulator__icon-btn--danger"
                aria-label={`Remove ${device.name}`}
                title={`Remove ${device.name}`}
                disabled={Boolean(bootingDeviceId) || busy}
                onClick={() => setConfirmRemoveKey(rowKey)}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            ) : null}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="workspace-simulator">
      <div className="workspace-simulator__bar">
        <div className="workspace-simulator__identity">
          <strong>Simulator</strong>
          <span>
            {state.devices.length} {state.devices.length === 1 ? 'device' : 'devices'}
            {state.agentAccessEnabled ? ' · Agent control on' : ''}
          </span>
        </div>
        <div className="workspace-simulator__controls">
          <button
            type="button"
            className="workspace-simulator__btn"
            aria-label="New simulator"
            disabled={busy || hubBusy}
            onClick={() => setCreating((open) => !open)}
          >
            <Plus size={13} aria-hidden />
            <span>New</span>
          </button>
          <button
            type="button"
            className="workspace-simulator__btn workspace-simulator__btn--quiet"
            disabled={busy || hubBusy}
            title={
              state.agentAccessEnabled
                ? 'Agents can open and drive simulators'
                : 'Enable agent control for simulators'
            }
            onClick={() => onToggleAgent(!state.agentAccessEnabled)}
          >
            <span>Agent: {state.agentAccessEnabled ? 'On' : 'Off'}</span>
          </button>
          <button
            type="button"
            className="workspace-simulator__icon-btn"
            aria-label="Refresh simulators"
            title="Refresh simulators"
            disabled={busy || hubBusy}
            onClick={onRefresh}
          >
            <RefreshCw
              size={15}
              className={busy || hubBusy ? 'workspace-simulator__spin' : undefined}
              aria-hidden
            />
          </button>
        </div>
      </div>

      <div className="workspace-simulator__scroll">
        <div className="workspace-simulator__picker">
          {error ? <RowIssue message={error} announce /> : null}
          {state.hostStatusDetail ? <RowIssue message={state.hostStatusDetail} /> : null}
          {state.androidSetupStatus === 'failed' && state.androidSetupDetail ? (
            <RowIssue message={state.androidSetupDetail} announce />
          ) : null}

          {hubBusy ? (
            <p className="workspace-simulator__status-line" role="status">
              <LoaderCircle size={14} className="workspace-simulator__spin" aria-hidden />
              <span>{state.hostStatusDetail ?? 'Starting simulator hub…'}</span>
            </p>
          ) : null}

          {androidBusy && !creating ? (
            <p className="workspace-simulator__status-line" role="status">
              <LoaderCircle size={14} className="workspace-simulator__spin" aria-hidden />
              <span>{state.androidSetupDetail ?? 'Updating Android Emulator…'}</span>
            </p>
          ) : null}

          {creating ? (
            <SimulatorCreateForm
              transport={transport}
              state={state}
              busy={busy}
              onCreate={onCreateDevice}
              onInstallAndroid={onInstallAndroid}
              onClose={() => setCreating(false)}
            />
          ) : null}

          {showAndroidInstallBanner ? (
            <div className="workspace-simulator__android-banner">
              <div className="workspace-simulator__card-copy">
                <strong>Android Emulator</strong>
                <span>
                  {androidSdk && !androidSdk.javaAvailable
                    ? (androidSdk.javaReason ?? 'Java 17+ is required for Android SDK tools.')
                    : 'Install Android SDK tools and a system image to create and run Android emulators.'}
                </span>
              </div>
              <button
                type="button"
                className="workspace-simulator__btn"
                disabled={busy || androidBusy || Boolean(androidSdk && !androidSdk.javaAvailable)}
                onClick={() => void onInstallAndroid({ createDefaultAvd: true })}
              >
                {androidBusy ? (
                  <LoaderCircle size={13} className="workspace-simulator__spin" aria-hidden />
                ) : (
                  <Download size={13} aria-hidden />
                )}
                <span>{androidBusy ? 'Installing…' : 'Install Android'}</span>
              </button>
            </div>
          ) : null}

          {running.length > 0 ? (
            <section>
              <p className="workspace-simulator__section-label">Running</p>
              <div className="workspace-simulator__device-list">{running.map(renderDeviceRow)}</div>
            </section>
          ) : null}

          {stopped.length > 0 ? (
            <section>
              <p className="workspace-simulator__section-label">Stopped</p>
              <div className="workspace-simulator__device-list">{stopped.map(renderDeviceRow)}</div>
            </section>
          ) : null}

          {!hubBusy && !creating && state.devices.length === 0 ? (
            <div className="workspace-empty">
              <Smartphone size={28} strokeWidth={1.6} aria-hidden />
              <strong>No simulators found</strong>
              <span>Create an iOS Simulator or install an Android Emulator to get started.</span>
              <div className="workspace-simulator__input-row">
                <button
                  type="button"
                  className="workspace-simulator__btn workspace-simulator__btn--primary"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={13} aria-hidden />
                  <span>New simulator</span>
                </button>
                <button type="button" className="workspace-simulator__btn" onClick={onRefresh}>
                  <RefreshCw size={13} aria-hidden />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SimulatorStage(props: {
  active: boolean
  transport: Transport
  device: SimulatorDevice
  busy: boolean
  onSwitchDevice: () => void
  onPowerOff: () => void
}) {
  const { active, transport, device, busy, onSwitchDevice, onPowerOff } = props
  const [access, setAccess] = useState<SimulatorHubAccess>()
  const [accessEpoch, setAccessEpoch] = useState(0)
  const [status, setStatus] = useState<SimulatorStreamStatus>('connecting')
  const [statusDetail, setStatusDetail] = useState<string>()
  const [screenInfo, setScreenInfo] = useState<SimulatorScreenInfo | null>(null)
  const [inputConnected, setInputConnected] = useState(false)
  const [inputDetail, setInputDetail] = useState<string>()
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null)
  const [reconnectCount, setReconnectCount] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [axOverlay, setAxOverlay] = useState(false)
  const [axElements, setAxElements] = useState<SimulatorAxElement[]>([])
  const [detail, setDetail] = useState<SimulatorDetail>()
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [screenshotPending, setScreenshotPending] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<SimulatorStreamClient | null>(null)
  const activePointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const pressedKeysRef = useRef(new Map<string, SimulatorKeyInput>())
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 })

  const releasePressedKeys = useCallback(() => {
    if (pressedKeysRef.current.size === 0) return
    const held = [...pressedKeysRef.current.values()].reverse()
    pressedKeysRef.current.clear()
    for (const keyInput of held) {
      clientRef.current?.sendKey(keyInput, 'up')
    }
  }, [])

  useEffect(() => {
    const onWindowBlur = () => releasePressedKeys()
    const onVisibilityChange = () => {
      if (document.hidden) releasePressedKeys()
    }
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      releasePressedKeys()
    }
  }, [releasePressedKeys])

  // Mint/renew authenticated proxy ticket when active.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let renewTimer: ReturnType<typeof setTimeout> | undefined
    const fetchAccess = () => {
      void transport
        .request('simulator.hubAccess', {})
        .then((next) => {
          if (cancelled) return
          setAccess(next)
          const renewInMs = Math.max(30_000, next.expiresAt - Date.now() - 60_000)
          renewTimer = setTimeout(fetchAccess, renewInMs)
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setStatus('error')
            setStatusDetail(errorMessage(cause))
          }
        })
    }
    fetchAccess()
    return () => {
      cancelled = true
      if (renewTimer !== undefined) clearTimeout(renewTimer)
    }
  }, [active, accessEpoch, transport])

  // Load device detail (appearance, text size, toggles, foreground app).
  const refreshDetail = useCallback(() => {
    void transport
      .request('simulator.detail', { deviceId: device.id })
      .then(setDetail)
      .catch(() => undefined)
  }, [device.id, transport])

  useEffect(() => {
    if (!active) return
    refreshDetail()
  }, [active, refreshDetail, toolsOpen])

  const runAction = useCallback(
    async (input: SimulatorActionInput) => {
      setActionBusy(true)
      setActionError(undefined)
      try {
        const next = await transport.request('simulator.action', input)
        setDetail(next)
      } catch (cause: unknown) {
        setActionError(errorMessage(cause))
      } finally {
        setActionBusy(false)
      }
    },
    [transport],
  )

  // Track stage container size for aspect-fitted simulator frame.
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const update = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      setHostSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active])

  // Start and stop stream client strictly while visible.
  useEffect(() => {
    if (!active || !access || !canvasRef.current) {
      clientRef.current?.stop()
      clientRef.current = null
      return
    }
    setStatus('connecting')
    setStatusDetail(undefined)
    setMjpegUrl(null)
    setInputConnected(false)

    const client = createSimulatorStreamClient(
      { platform: device.platform, deviceId: device.id, access },
      canvasRef.current,
      {
        onStatus: (nextStatus, nextDetail) => {
          setStatus(nextStatus)
          setStatusDetail(nextDetail)
        },
        onScreen: setScreenInfo,
        onUnauthorized: () => setAccessEpoch((n) => n + 1),
        onMjpegFallback: (url) => setMjpegUrl(url),
        onInputConnected: (connected, reason) => {
          setInputConnected(connected)
          setInputDetail(reason)
          if (!connected) {
            activePointer.current = null
            pressedKeysRef.current.clear()
          }
        },
      },
    )
    clientRef.current = client
    client.start()
    return () => {
      releasePressedKeys()
      client.stop()
      if (clientRef.current === client) clientRef.current = null
      activePointer.current = null
    }
  }, [access, active, device.id, device.platform, reconnectCount, releasePressedKeys])

  // Poll accessibility overlay frames only while enabled and visible.
  useEffect(() => {
    if (!axOverlay || !active || !access) {
      setAxElements([])
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const poll = () => {
      void fetchSimulatorAxTree(access, device.platform, device.id, controller.signal)
        .then((elements) => {
          if (!cancelled) setAxElements(elements)
        })
        .catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, 1_500)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [access, active, axOverlay, device.id, device.platform])

  const saveScreenshot = useCallback(async () => {
    if (!access || screenshotPending) return
    setScreenshotPending(true)
    setActionError(undefined)
    try {
      const blob = await captureSimulatorScreenshot(access, device.platform, device.id)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${device.name.replace(/[^a-z0-9-]/gi, '-')}-${Date.now()}.png`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
    } catch (cause: unknown) {
      if (cause instanceof SimulatorScreenshotError && cause.status === 401) {
        setAccessEpoch((n) => n + 1)
      }
      setActionError(errorMessage(cause))
    } finally {
      setScreenshotPending(false)
    }
  }, [access, device.id, device.name, device.platform, screenshotPending])

  const aspect = screenAspect(device.platform, screenInfo)
  const frame = fitSimulatorFrame(aspect, hostSize.width, hostSize.height, {
    top: 54,
    right: 14,
    bottom: 14,
    left: 14,
  })
  const rotation = screenRotation(device.platform, screenInfo)
  const sideways = rotation === 90 || rotation === -90
  const mediaStyle: CSSProperties = sideways
    ? {
        width: frame.height,
        height: frame.width,
        left: (frame.width - frame.height) / 2,
        top: (frame.height - frame.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: '100%',
        height: '100%',
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      }

  const normalizedPoint = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }

  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = activePointer.current
    if (pointer?.id !== event.pointerId) return
    activePointer.current = null
    const { x, y } = event.type === 'lostpointercapture' ? pointer : normalizedPoint(event)
    clientRef.current?.sendTouch('end', x, y)
  }

  const nextAppearance = detail?.appearance === 'dark' ? 'light' : 'dark'

  return (
    <div className="workspace-simulator workspace-simulator--stage">
      <div className="workspace-simulator__stage-wrap">
        <div
          ref={stageRef}
          className="workspace-simulator__stage"
          tabIndex={0}
          role="application"
          aria-label={
            device.platform === 'ios' ? 'iOS Simulator screen' : 'Android Emulator screen'
          }
          onBlur={releasePressedKeys}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Escape' && event.shiftKey) {
              event.preventDefault()
              event.stopPropagation()
              releasePressedKeys()
              event.currentTarget.blur()
              return
            }
            if (event.nativeEvent.isComposing || event.key === 'Dead' || event.key === 'Process') {
              return
            }
            const isPasteShortcut =
              ((event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                !event.shiftKey &&
                event.code === 'KeyV') ||
              (event.shiftKey && event.key === 'Insert')
            if (isPasteShortcut) {
              releasePressedKeys()
              return
            }
            if (event.metaKey) {
              const isSimulatorChord =
                !event.ctrlKey && !event.altKey && SIMULATOR_META_CHORD_CODES.has(event.code)
              if (!isSimulatorChord) {
                releasePressedKeys()
                return
              }
              event.preventDefault()
              event.stopPropagation()
              if (!event.repeat) {
                releasePressedKeys()
                clientRef.current?.sendMetaChord(event.code, event.shiftKey)
              }
              return
            }
            if (event.code === 'MetaLeft' || event.code === 'MetaRight') return

            const keyInput: SimulatorKeyInput = {
              code: event.code,
              key: event.key,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
            }
            event.preventDefault()
            event.stopPropagation()
            if (clientRef.current?.sendKey(keyInput, 'down')) {
              pressedKeysRef.current.set(event.code || event.key, keyInput)
            }
          }}
          onKeyUp={(event) => {
            if (event.target !== event.currentTarget) return
            const keyId = event.code || event.key
            const tracked = pressedKeysRef.current.get(keyId)
            if (!tracked) return
            pressedKeysRef.current.delete(keyId)
            event.preventDefault()
            event.stopPropagation()
            clientRef.current?.sendKey(
              {
                code: event.code || tracked.code,
                key: event.key || tracked.key,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
              },
              'up',
            )
          }}
          onPaste={(event) => {
            if (event.target !== event.currentTarget) return
            event.preventDefault()
            event.stopPropagation()
            releasePressedKeys()
            clientRef.current?.sendText(event.clipboardData.getData('text/plain'))
          }}
        >
          <div className="workspace-simulator__floating-wrap">
            <div
              className="workspace-simulator__floating-bar"
              role="toolbar"
              aria-label="Simulator controls"
            >
              <button
                type="button"
                className="workspace-simulator__icon-btn"
                aria-label="Home button"
                title="Home"
                disabled={!inputConnected}
                onClick={() => clientRef.current?.pressButton('home')}
              >
                <Home size={14} aria-hidden />
              </button>
              {device.platform === 'android' ? (
                <button
                  type="button"
                  className="workspace-simulator__icon-btn"
                  aria-label="Back button"
                  title="Back"
                  disabled={!inputConnected}
                  onClick={() => clientRef.current?.pressButton('back')}
                >
                  <BackIcon size={14} aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className="workspace-simulator__icon-btn"
                aria-label={device.platform === 'ios' ? 'App Switcher' : 'Recents'}
                title={device.platform === 'ios' ? 'App Switcher' : 'Recents'}
                disabled={!inputConnected}
                onClick={() =>
                  clientRef.current?.pressButton(
                    device.platform === 'ios' ? 'appSwitcher' : 'recents',
                  )
                }
              >
                <AppSwitcher size={14} aria-hidden />
              </button>
              {device.platform === 'ios' ? (
                <button
                  type="button"
                  className="workspace-simulator__icon-btn"
                  aria-label="Rotate simulator"
                  title="Rotate"
                  disabled={!inputConnected}
                  onClick={() => clientRef.current?.rotate()}
                >
                  <RotateCw size={14} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  className="workspace-simulator__icon-btn"
                  aria-label="Rotate simulator"
                  title="Rotate"
                  disabled={actionBusy}
                  onClick={() => {
                    const current = detail?.orientation ?? screenInfo?.orientation ?? 'portrait'
                    const isLandscape =
                      current === 'landscape_left' || current === 'landscape_right'
                    const nextOrientation = isLandscape ? 'portrait' : 'landscape_left'
                    void runAction({
                      deviceId: device.id,
                      type: 'setOrientation',
                      value: nextOrientation,
                    })
                  }}
                >
                  <RotateCw size={14} aria-hidden />
                </button>
              )}
              <span className="workspace-simulator__divider" aria-hidden />
              <button
                type="button"
                className="workspace-simulator__icon-btn"
                aria-label={`Switch to ${nextAppearance} mode`}
                title={`Switch to ${nextAppearance} mode`}
                disabled={actionBusy}
                onClick={() =>
                  void runAction({
                    deviceId: device.id,
                    type: 'setAppearance',
                    value: nextAppearance,
                  })
                }
              >
                {detail?.appearance === 'dark' ? (
                  <Sun size={14} aria-hidden />
                ) : (
                  <Moon size={14} aria-hidden />
                )}
              </button>
              <Menu
                label="Text size"
                align="right"
                triggerClassName="workspace-simulator__icon-btn"
                trigger={() => <TextSizeIcon size={14} aria-hidden />}
              >
                {(close) => (
                  <>
                    {TEXT_SIZES.map((option) => (
                      <MenuItem
                        key={option.value}
                        title={option.label}
                        icon={<TextSizeIcon size={14} aria-hidden />}
                        active={detail?.textSize === option.value}
                        checked={detail?.textSize === option.value}
                        onClick={() => {
                          close()
                          void runAction({
                            deviceId: device.id,
                            type: 'setTextSize',
                            value: option.value,
                          })
                        }}
                      />
                    ))}
                  </>
                )}
              </Menu>
              <button
                type="button"
                className="workspace-simulator__icon-btn"
                aria-label="Save screenshot"
                title="Save screenshot"
                disabled={status !== 'streaming' || screenshotPending}
                onClick={() => void saveScreenshot()}
              >
                <Camera size={14} aria-hidden />
              </button>
              <button
                type="button"
                className={`workspace-simulator__icon-btn${toolsOpen ? ' is-active' : ''}`}
                aria-label="Simulator tools"
                aria-pressed={toolsOpen}
                title="Simulator tools"
                onClick={() => setToolsOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} aria-hidden />
              </button>
              <span className="workspace-simulator__divider" aria-hidden />
              <Menu
                label="More simulator actions"
                align="right"
                triggerClassName="workspace-simulator__icon-btn"
                trigger={() => <MoreHorizontal size={14} aria-hidden />}
              >
                {(close) => (
                  <>
                    <MenuItem
                      title="Switch simulator"
                      detail={`${device.name} · ${device.version}`}
                      icon={<SwitchDevice size={14} aria-hidden />}
                      onClick={() => {
                        close()
                        onSwitchDevice()
                      }}
                    />
                    <MenuItem
                      title="Power off simulator"
                      icon={<Power size={14} aria-hidden />}
                      disabled={busy}
                      onClick={() => {
                        close()
                        onPowerOff()
                      }}
                    />
                  </>
                )}
              </Menu>
            </div>
          </div>

          <div
            className="workspace-simulator__frame"
            style={{ width: frame.width, height: frame.height }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !inputConnected || activePointer.current !== null) return
              event.currentTarget.setPointerCapture(event.pointerId)
              stageRef.current?.focus({ preventScroll: true })
              const { x, y } = normalizedPoint(event)
              activePointer.current = { id: event.pointerId, x, y }
              clientRef.current?.sendTouch('begin', x, y)
            }}
            onPointerMove={(event) => {
              if (activePointer.current?.id !== event.pointerId) return
              const { x, y } = normalizedPoint(event)
              activePointer.current = { id: event.pointerId, x, y }
              clientRef.current?.sendTouch('move', x, y)
            }}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onLostPointerCapture={endPointer}
          >
            <canvas
              ref={canvasRef}
              className="workspace-simulator__media"
              hidden={Boolean(mjpegUrl)}
              style={mediaStyle}
            />
            {mjpegUrl ? (
              <img
                ref={(img) => clientRef.current?.setMjpegImage(img)}
                alt=""
                draggable={false}
                className="workspace-simulator__media"
                style={mediaStyle}
              />
            ) : null}
            {axOverlay && axElements.length > 0 ? (
              <div className="workspace-simulator__ax-layer" aria-hidden>
                {axElements.map((element) => (
                  <div
                    key={element.id}
                    className="workspace-simulator__ax-box"
                    style={{
                      left: `${element.x * 100}%`,
                      top: `${element.y * 100}%`,
                      width: `${element.width * 100}%`,
                      height: `${element.height * 100}%`,
                    }}
                  >
                    {element.label ? (
                      <span className="workspace-simulator__ax-label">{element.label}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {status === 'streaming' && !inputConnected ? (
            <div className="workspace-simulator__toast">
              {inputDetail
                ? `Input disconnected (${inputDetail}), reconnecting…`
                : 'Input connecting…'}
            </div>
          ) : null}

          {actionError && !toolsOpen ? (
            <div className="workspace-simulator__toast" role="alert">
              {actionError}
            </div>
          ) : null}

          {status !== 'streaming' ? (
            <div className="workspace-simulator__overlay">
              {status === 'connecting' ? (
                <LoaderCircle size={22} className="workspace-simulator__spin" aria-hidden />
              ) : (
                <CircleAlert size={22} aria-hidden />
              )}
              <strong>{device.name}</strong>
              <p>
                {status === 'error'
                  ? (statusDetail ?? 'Stream disconnected.')
                  : (statusDetail ?? 'Connecting to simulator stream…')}
              </p>
              {status === 'error' ? (
                <button
                  type="button"
                  className="workspace-simulator__btn"
                  onClick={() => setReconnectCount((count) => count + 1)}
                >
                  <RefreshCw size={13} aria-hidden />
                  <span>Reconnect</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {toolsOpen ? (
          <SimulatorToolsDrawer
            device={device}
            detail={detail}
            busy={actionBusy}
            error={actionError}
            axOverlay={axOverlay}
            onAxOverlayChange={setAxOverlay}
            onAction={runAction}
            onClose={() => setToolsOpen(false)}
          />
        ) : null}
      </div>
    </div>
  )
}

function SimulatorToolsDrawer(props: {
  device: SimulatorDevice
  detail?: SimulatorDetail | undefined
  busy: boolean
  error?: string | undefined
  axOverlay: boolean
  onAxOverlayChange: (value: boolean) => void
  onAction: (input: SimulatorActionInput) => Promise<void>
  onClose: () => void
}) {
  const { device, detail, busy, error, axOverlay, onAxOverlayChange, onAction, onClose } = props
  const [deepLink, setDeepLink] = useState('')
  const [appId, setAppId] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [permission, setPermission] = useState<SimulatorPermission>('camera')
  const [pushText, setPushText] = useState('')

  const resolvedAppId = appId.trim() || detail?.foregroundApp?.id || ''
  const permissions = device.platform === 'ios' ? IOS_PERMISSIONS : ANDROID_PERMISSIONS
  const toggles: ReadonlyArray<{ key: SimulatorToggleSetting; label: string }> =
    device.platform === 'ios'
      ? [
          { key: 'reduceMotion', label: 'Reduce motion' },
          { key: 'increaseContrast', label: 'Increase contrast' },
          { key: 'reduceTransparency', label: 'Reduce transparency' },
          { key: 'showBorders', label: 'Show borders' },
          { key: 'voiceOver', label: 'VoiceOver' },
        ]
      : [
          { key: 'reduceMotion', label: 'Reduce motion' },
          { key: 'increaseContrast', label: 'High contrast text' },
          { key: 'networkEnabled', label: 'Network enabled' },
        ]

  const parsedLat = Number.parseFloat(latitude)
  const parsedLng = Number.parseFloat(longitude)
  const validCoords =
    Number.isFinite(parsedLat) &&
    Number.isFinite(parsedLng) &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    parsedLng >= -180 &&
    parsedLng <= 180

  return (
    <aside className="workspace-simulator__drawer" aria-label="Simulator tools">
      <div className="workspace-simulator__drawer-head">
        <strong>Tools</strong>
        <button
          type="button"
          className="workspace-simulator__icon-btn"
          aria-label="Close simulator tools"
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="workspace-simulator__drawer-body">
        {error ? <RowIssue message={error} announce /> : null}

        <div className="workspace-simulator__tool-group">
          <h4>App</h4>
          {detail?.foregroundApp ? (
            <div className="workspace-simulator__tool-row">
              <span>Foreground</span>
              <code>{detail.foregroundApp.id}</code>
            </div>
          ) : null}
          <input
            className="workspace-simulator__input"
            placeholder={detail?.foregroundApp?.id || 'Bundle / package ID'}
            value={appId}
            disabled={busy}
            onChange={(event) => setAppId(event.target.value)}
          />
          <div className="workspace-simulator__input-row">
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !resolvedAppId}
              onClick={() =>
                void onAction({ deviceId: device.id, type: 'launchApp', appId: resolvedAppId })
              }
            >
              Launch
            </button>
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !resolvedAppId}
              onClick={() =>
                void onAction({ deviceId: device.id, type: 'terminateApp', appId: resolvedAppId })
              }
            >
              Terminate
            </button>
          </div>
        </div>

        <div className="workspace-simulator__tool-group">
          <h4>Deep link</h4>
          <div className="workspace-simulator__input-row">
            <input
              className="workspace-simulator__input"
              placeholder="myapp://path or https://…"
              value={deepLink}
              disabled={busy}
              onChange={(event) => setDeepLink(event.target.value)}
            />
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !deepLink.trim()}
              onClick={() =>
                void onAction({ deviceId: device.id, type: 'openUrl', url: deepLink.trim() })
              }
            >
              Open
            </button>
          </div>
        </div>

        {device.platform === 'android' ? (
          <div className="workspace-simulator__tool-group">
            <h4>Orientation</h4>
            <select
              className="workspace-simulator__select"
              aria-label="Orientation"
              value={detail?.orientation ?? 'portrait'}
              disabled={busy}
              onChange={(event) =>
                void onAction({
                  deviceId: device.id,
                  type: 'setOrientation',
                  value: event.target.value as SimulatorOrientation,
                })
              }
            >
              {ANDROID_ORIENTATIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="workspace-simulator__tool-group">
          <h4>Accessibility</h4>
          <div className="workspace-simulator__tool-row">
            <span>Element frames overlay</span>
            <button
              type="button"
              role="switch"
              aria-checked={axOverlay}
              aria-label="Accessibility element frames overlay"
              className={`switch${axOverlay ? ' is-on' : ''}`}
              onClick={() => onAxOverlayChange(!axOverlay)}
            />
          </div>
          {toggles.map((toggle) => {
            const value = Boolean(detail?.toggles[toggle.key])
            return (
              <div className="workspace-simulator__tool-row" key={toggle.key}>
                <span>{toggle.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={value}
                  aria-label={toggle.label}
                  className={`switch${value ? ' is-on' : ''}`}
                  disabled={busy}
                  onClick={() =>
                    void onAction({
                      deviceId: device.id,
                      type: 'setToggle',
                      setting: toggle.key,
                      value: !value,
                    })
                  }
                />
              </div>
            )
          })}
        </div>

        <div className="workspace-simulator__tool-group">
          <h4>Location</h4>
          <select
            className="workspace-simulator__select"
            aria-label="Location preset"
            value=""
            disabled={busy}
            onChange={(event) => {
              const preset = LOCATION_PRESETS.find((item) => item.label === event.target.value)
              if (!preset) return
              setLatitude(String(preset.latitude))
              setLongitude(String(preset.longitude))
              void onAction({
                deviceId: device.id,
                type: 'setLocation',
                latitude: preset.latitude,
                longitude: preset.longitude,
              })
            }}
          >
            <option value="">Choose preset…</option>
            {LOCATION_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>
                {preset.label}
              </option>
            ))}
          </select>
          <div className="workspace-simulator__input-row">
            <input
              className="workspace-simulator__input"
              placeholder="Lat"
              value={latitude}
              disabled={busy}
              onChange={(event) => setLatitude(event.target.value)}
            />
            <input
              className="workspace-simulator__input"
              placeholder="Lng"
              value={longitude}
              disabled={busy}
              onChange={(event) => setLongitude(event.target.value)}
            />
          </div>
          <div className="workspace-simulator__input-row">
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !validCoords}
              onClick={() =>
                void onAction({
                  deviceId: device.id,
                  type: 'setLocation',
                  latitude: parsedLat,
                  longitude: parsedLng,
                })
              }
            >
              Set
            </button>
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--quiet"
              disabled={busy}
              onClick={() => {
                setLatitude('')
                setLongitude('')
                void onAction({ deviceId: device.id, type: 'clearLocation' })
              }}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="workspace-simulator__tool-group">
          <h4>Permissions</h4>
          <select
            className="workspace-simulator__select"
            aria-label="Permission"
            value={permission}
            disabled={busy}
            onChange={(event) => setPermission(event.target.value as SimulatorPermission)}
          >
            {permissions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="workspace-simulator__input-row">
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !resolvedAppId}
              onClick={() =>
                void onAction({
                  deviceId: device.id,
                  type: 'setPermission',
                  appId: resolvedAppId,
                  permission,
                  decision: 'grant',
                })
              }
            >
              Grant
            </button>
            <button
              type="button"
              className="workspace-simulator__btn"
              disabled={busy || !resolvedAppId}
              onClick={() =>
                void onAction({
                  deviceId: device.id,
                  type: 'setPermission',
                  appId: resolvedAppId,
                  permission,
                  decision: 'revoke',
                })
              }
            >
              Revoke
            </button>
            <button
              type="button"
              className="workspace-simulator__btn workspace-simulator__btn--quiet"
              disabled={busy || !resolvedAppId}
              onClick={() =>
                void onAction({
                  deviceId: device.id,
                  type: 'setPermission',
                  appId: resolvedAppId,
                  permission,
                  decision: 'reset',
                })
              }
            >
              Reset
            </button>
          </div>
        </div>

        {device.platform === 'ios' ? (
          <div className="workspace-simulator__tool-group">
            <h4>Test push notification</h4>
            <div className="workspace-simulator__input-row">
              <input
                className="workspace-simulator__input"
                placeholder="Alert message…"
                value={pushText}
                disabled={busy}
                onChange={(event) => setPushText(event.target.value)}
              />
              <button
                type="button"
                className="workspace-simulator__btn"
                disabled={busy || !resolvedAppId || !pushText.trim()}
                onClick={() =>
                  void onAction({
                    deviceId: device.id,
                    type: 'sendPush',
                    appId: resolvedAppId,
                    payload: pushText.trim(),
                  })
                }
              >
                Send
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
