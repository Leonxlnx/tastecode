import type {
  SimulatorActionInput,
  SimulatorActionType,
  SimulatorAppearance,
  SimulatorDetail,
  SimulatorForegroundApp,
  SimulatorOrientation,
  SimulatorPlatform,
  SimulatorTextSize,
  SimulatorToggleSetting,
} from '@harness/contracts'
import type { HostRunResult, ReadySimulatorHost } from './host.js'

const IOS_ACTIONS: readonly SimulatorActionType[] = [
  'setAppearance',
  'setTextSize',
  'setToggle',
  'setLocation',
  'clearLocation',
  'setPermission',
  'openUrl',
  'launchApp',
  'terminateApp',
  'sendPush',
]

const ANDROID_ACTIONS: readonly SimulatorActionType[] = [
  'setAppearance',
  'setTextSize',
  'setToggle',
  'setOrientation',
  'setLocation',
  'clearLocation',
  'setPermission',
  'openUrl',
  'launchApp',
  'terminateApp',
]

const IOS_TOGGLES: ReadonlySet<SimulatorToggleSetting> = new Set([
  'reduceMotion',
  'increaseContrast',
  'reduceTransparency',
  'showBorders',
  'voiceOver',
])

const ANDROID_TOGGLES: ReadonlySet<SimulatorToggleSetting> = new Set([
  'reduceMotion',
  'increaseContrast',
  'networkEnabled',
])

const IOS_TEXT_SIZES = {
  small: 'small',
  default: 'large',
  large: 'extra-extra-large',
  'extra-large': 'accessibility-large',
} as const satisfies Record<SimulatorTextSize, string>

const ANDROID_TEXT_SIZES = {
  small: '0.85',
  default: '1.0',
  large: '1.15',
  'extra-large': '1.3',
} as const satisfies Record<SimulatorTextSize, string>

const IOS_TOGGLE_OPTIONS = new Map<SimulatorToggleSetting, string>([
  ['reduceMotion', 'reduce-motion'],
  ['increaseContrast', 'increase-contrast'],
  ['reduceTransparency', 'reduce-transparency'],
  ['showBorders', 'show-borders'],
  ['voiceOver', 'voiceover'],
])

const IOS_TCC_SERVICES = new Map<string, string>([
  ['camera', 'camera'],
  ['microphone', 'microphone'],
  ['photos', 'photos'],
  ['contacts', 'contacts'],
  ['calendar', 'calendar'],
  ['reminders', 'reminders'],
  ['location', 'location'],
  ['motion', 'motion'],
  ['media-library', 'media-library'],
  ['faceid', 'faceid'],
])

const ANDROID_PERMISSIONS = new Map<string, readonly string[]>([
  ['camera', ['android.permission.CAMERA']],
  ['microphone', ['android.permission.RECORD_AUDIO']],
  ['photos', ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE']],
  ['contacts', ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS']],
  ['calendar', ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR']],
  [
    'location',
    ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  ],
  ['notifications', ['android.permission.POST_NOTIFICATIONS']],
  ['motion', ['android.permission.ACTIVITY_RECOGNITION']],
])

/**
 * Android's `Display.getRotation()` numbers counterclockwise turns of the
 * device: rotation 1 puts the bottom on the right (`landscape_right`).
 */
const ANDROID_COUNTERCLOCKWISE_POSES: readonly SimulatorOrientation[] = [
  'portrait',
  'landscape_right',
  'portrait_upside_down',
  'landscape_left',
]

const ANDROID_GRAVITY = {
  portrait: '0:9.81:0',
  landscape_right: '-9.81:0:0',
  portrait_upside_down: '0:-9.81:0',
  landscape_left: '9.81:0:0',
} as const satisfies Record<SimulatorOrientation, string>

const ANDROID_WINDOW_DETECTORS: readonly RegExp[] = [
  /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.-]+)\//,
  /mFocusedApp=ActivityRecord\{[^}]*\s([A-Za-z0-9_.-]+)\//,
  /mInputMethodTarget=Window\{[^}]*\s([A-Za-z0-9_.-]+)\//,
]

const ANDROID_ACTIVITY_DETECTORS: readonly RegExp[] = [
  /topResumedActivity=ActivityRecord\{[^}]*\s([A-Za-z0-9_.-]+)\//,
  /mResumedActivity:\s*ActivityRecord\{[^}]*\s([A-Za-z0-9_.-]+)\//,
  /ResumedActivity:\s*ActivityRecord\{[^}]*\s([A-Za-z0-9_.-]+)\//,
]

function parseAndroidOrientation(
  rotationIndex: number,
  landscapeNative: boolean,
): SimulatorOrientation | undefined {
  if (!Number.isInteger(rotationIndex) || rotationIndex < 0 || rotationIndex > 3) {
    return undefined
  }
  const offset = landscapeNative ? 1 : 0
  return ANDROID_COUNTERCLOCKWISE_POSES[(offset + rotationIndex) % 4]
}

function rotationIndexForAndroidOrientation(
  orientation: SimulatorOrientation,
  landscapeNative: boolean,
): number {
  const index = ANDROID_COUNTERCLOCKWISE_POSES.indexOf(orientation)
  const offset = landscapeNative ? 1 : 0
  return (index - offset + 4) % 4
}

function parseAndroidForegroundPackage(
  dump: string,
  detectors: readonly RegExp[],
): string | undefined {
  for (const pattern of detectors) {
    const match = pattern.exec(dump)?.[1]
    if (match) return match
  }
  return undefined
}

function assertOk(operation: string, result: HostRunResult): string {
  if (result.code === 0) return result.stdout
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(
    `Simulator ${operation} failed (exit ${result.code})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
  )
}

function textSizeFromIos(category: string): SimulatorTextSize {
  const entry = (Object.entries(IOS_TEXT_SIZES) as Array<[SimulatorTextSize, string]>).find(
    ([, value]) => value === category,
  )
  if (entry) return entry[0]
  if (category.startsWith('accessibility')) return 'extra-large'
  if (category === 'extra-small' || category === 'small' || category === 'medium') return 'small'
  return category.includes('extra') ? 'large' : 'default'
}

function textSizeFromAndroid(scale: number): SimulatorTextSize {
  if (scale <= 0.9) return 'small'
  if (scale >= 1.25) return 'extra-large'
  if (scale >= 1.1) return 'large'
  return 'default'
}

function isLandscapeNative(wmSize: string | undefined): boolean {
  if (!wmSize) return false
  const matches = [...wmSize.matchAll(/size: (\d+)x(\d+)/g)]
  const last = matches.at(-1)
  return last !== undefined && Number(last[1]) > Number(last[2])
}

async function simctl(
  host: ReadySimulatorHost,
  udid: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const result = await host.run('xcrun', ['simctl', args[0]!, udid, ...args.slice(1)])
  return assertOk(operation, result)
}

async function runAxSettings(
  host: ReadySimulatorHost,
  udid: string,
  args: readonly string[],
): Promise<string> {
  const helper = host.helpers.serveSimAxSettings
  if (!helper) {
    throw new Error('iOS accessibility settings helper is not available in this simulator hub.')
  }
  const result = await host.run('xcrun', ['simctl', 'spawn', udid, helper, ...args])
  return assertOk('accessibility', result)
}

async function fetchIosForeground(
  origin: string,
  udid: string,
): Promise<SimulatorForegroundApp | undefined> {
  try {
    const response = await fetch(
      `${origin}/vendor/serve-sim/helper/${encodeURIComponent(udid)}/foreground`,
      { signal: AbortSignal.timeout(3_000) },
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as Record<string, unknown>
    const id =
      typeof body['bundleId'] === 'string'
        ? body['bundleId']
        : typeof body['id'] === 'string'
          ? body['id']
          : undefined
    if (!id) return undefined
    const label =
      typeof body['name'] === 'string'
        ? body['name']
        : typeof body['label'] === 'string'
          ? body['label']
          : undefined
    const pid =
      typeof body['pid'] === 'number' && Number.isInteger(body['pid']) && body['pid'] >= 0
        ? body['pid']
        : undefined
    return { id, ...(label ? { label } : {}), ...(pid !== undefined ? { pid } : {}) }
  } catch {
    return undefined
  }
}

export async function readSimulatorDetail(
  host: ReadySimulatorHost,
  deviceId: string,
  platform: SimulatorPlatform,
): Promise<SimulatorDetail> {
  if (platform === 'ios') {
    const [appearanceRes, contentSizeRes, contrastRes, axRes, foregroundApp] = await Promise.all([
      host.run('xcrun', ['simctl', 'ui', deviceId, 'appearance']),
      host.run('xcrun', ['simctl', 'ui', deviceId, 'content_size']),
      host.run('xcrun', ['simctl', 'ui', deviceId, 'increase_contrast']),
      host.helpers.serveSimAxSettings
        ? host.run('xcrun', [
            'simctl',
            'spawn',
            deviceId,
            host.helpers.serveSimAxSettings,
            'status',
          ])
        : Promise.resolve({ code: 1, stdout: '', stderr: '' }),
      fetchIosForeground(host.origin, deviceId),
    ])

    const appearanceRaw = appearanceRes.code === 0 ? appearanceRes.stdout.trim() : ''
    const appearance: SimulatorAppearance | undefined =
      appearanceRaw === 'light' || appearanceRaw === 'dark' ? appearanceRaw : undefined

    const contentSizeRaw = contentSizeRes.code === 0 ? contentSizeRes.stdout.trim() : ''
    const textSize = contentSizeRaw ? textSizeFromIos(contentSizeRaw) : undefined

    const toggles: Partial<Record<SimulatorToggleSetting, boolean>> = {}
    if (contrastRes.code === 0) {
      const value = contrastRes.stdout.trim()
      if (value === 'enabled' || value === 'disabled') {
        toggles.increaseContrast = value === 'enabled'
      }
    }
    if (axRes.code === 0) {
      try {
        const parsed = JSON.parse(axRes.stdout) as Record<string, string>
        const boolOf = (key: string) =>
          parsed[key] === 'on' ? true : parsed[key] === 'off' ? false : undefined
        const rm = boolOf('reduce-motion')
        const rt = boolOf('reduce-transparency')
        const sb = boolOf('show-borders')
        const vo = boolOf('voiceover')
        if (rm !== undefined) toggles.reduceMotion = rm
        if (rt !== undefined) toggles.reduceTransparency = rt
        if (sb !== undefined) toggles.showBorders = sb
        if (vo !== undefined) toggles.voiceOver = vo
      } catch {
        // Ignore unparseable ax helper status.
      }
    }

    return {
      deviceId,
      platform,
      ...(foregroundApp ? { foregroundApp } : {}),
      ...(appearance ? { appearance } : {}),
      ...(textSize ? { textSize } : {}),
      toggles,
      supportedActions: [...IOS_ACTIONS],
    }
  }

  // Android detail via adb
  const [
    nightRes,
    fontRes,
    animRes,
    contrastRes,
    wifiRes,
    mobileDataRes,
    airplaneRes,
    rotationRes,
    wmSizeRes,
    focusRes,
  ] = await Promise.all([
    host.run('adb', ['-s', deviceId, 'shell', 'cmd', 'uimode', 'night']),
    host.run('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'system', 'font_scale']),
    host.run('adb', [
      '-s',
      deviceId,
      'shell',
      'settings',
      'get',
      'global',
      'animator_duration_scale',
    ]),
    host.run('adb', [
      '-s',
      deviceId,
      'shell',
      'settings',
      'get',
      'secure',
      'high_text_contrast_enabled',
    ]),
    host.run('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'wifi_on']),
    host.run('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'mobile_data']),
    host.run('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'airplane_mode_on']),
    host.run('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'system', 'user_rotation']),
    host.run('adb', ['-s', deviceId, 'shell', 'wm', 'size']),
    host.run('adb', ['-s', deviceId, 'shell', 'dumpsys', 'window']),
  ])

  let appearance: SimulatorAppearance | undefined
  if (nightRes.code === 0) {
    if (/Night mode:\s*yes/i.test(nightRes.stdout)) appearance = 'dark'
    else if (/Night mode:\s*no/i.test(nightRes.stdout)) appearance = 'light'
  }

  let textSize: SimulatorTextSize | undefined
  if (fontRes.code === 0) {
    const scale = Number.parseFloat(fontRes.stdout.trim())
    if (Number.isFinite(scale) && scale > 0) textSize = textSizeFromAndroid(scale)
  }

  const toggles: Partial<Record<SimulatorToggleSetting, boolean>> = {}
  if (animRes.code === 0) {
    const scale = Number.parseFloat(animRes.stdout.trim())
    if (Number.isFinite(scale)) toggles.reduceMotion = scale === 0
  }
  if (contrastRes.code === 0) {
    const raw = contrastRes.stdout.trim()
    if (/^[+-]?\d+$/.test(raw)) toggles.increaseContrast = Number(raw) !== 0
  }
  const wifiRaw = wifiRes.code === 0 ? wifiRes.stdout.trim() : ''
  const dataRaw = mobileDataRes.code === 0 ? mobileDataRes.stdout.trim() : ''
  const airplaneRaw = airplaneRes.code === 0 ? airplaneRes.stdout.trim() : ''
  if (airplaneRaw === '1') {
    toggles.networkEnabled = false
  } else if (wifiRaw === '0' || wifiRaw === '1' || dataRaw === '0' || dataRaw === '1') {
    toggles.networkEnabled = wifiRaw === '1' || dataRaw === '1'
  } else if (airplaneRaw === '0') {
    toggles.networkEnabled = true
  }

  let orientation: SimulatorOrientation | undefined
  const landscapeNative = isLandscapeNative(wmSizeRes.code === 0 ? wmSizeRes.stdout : undefined)
  if (focusRes.code === 0) {
    const displayRotMatch =
      /\bm(?:Current|Display)?Rotation=(?:ROTATION_)?(0|1|2|3|90|180|270)\b/.exec(focusRes.stdout)
    if (displayRotMatch?.[1] !== undefined) {
      const val = Number(displayRotMatch[1])
      orientation = parseAndroidOrientation(val > 3 ? val / 90 : val, landscapeNative)
    }
  }
  if (!orientation && rotationRes.code === 0) {
    const raw = rotationRes.stdout.trim()
    if (/^[0-3]$/.test(raw)) {
      orientation = parseAndroidOrientation(Number(raw), landscapeNative)
    }
  }

  let foregroundApp: SimulatorForegroundApp | undefined
  if (focusRes.code === 0) {
    const pkg = parseAndroidForegroundPackage(focusRes.stdout, ANDROID_WINDOW_DETECTORS)
    if (pkg) foregroundApp = { id: pkg }
  }
  if (!foregroundApp) {
    const actRes = await host.run('adb', [
      '-s',
      deviceId,
      'shell',
      'dumpsys',
      'activity',
      'activities',
    ])
    if (actRes.code === 0) {
      const pkg = parseAndroidForegroundPackage(actRes.stdout, ANDROID_ACTIVITY_DETECTORS)
      if (pkg) foregroundApp = { id: pkg }
    }
  }

  return {
    deviceId,
    platform,
    ...(foregroundApp ? { foregroundApp } : {}),
    ...(appearance ? { appearance } : {}),
    ...(textSize ? { textSize } : {}),
    ...(orientation ? { orientation } : {}),
    toggles,
    supportedActions: [...ANDROID_ACTIONS],
  }
}

export async function runSimulatorAction(
  host: ReadySimulatorHost,
  platform: SimulatorPlatform,
  input: SimulatorActionInput,
): Promise<SimulatorDetail> {
  const allowed = platform === 'ios' ? IOS_ACTIONS : ANDROID_ACTIONS
  if (!allowed.includes(input.type)) {
    throw new Error(`Action "${input.type}" is not supported on ${platform}.`)
  }
  if (input.type === 'setToggle') {
    const toggles = platform === 'ios' ? IOS_TOGGLES : ANDROID_TOGGLES
    if (!toggles.has(input.setting)) {
      throw new Error(`Setting "${input.setting}" is not supported on ${platform}.`)
    }
  }

  if (platform === 'ios') {
    await runIosAction(host, input)
  } else {
    await runAndroidAction(host, input)
  }

  return readSimulatorDetail(host, input.deviceId, platform)
}

async function runIosAction(host: ReadySimulatorHost, input: SimulatorActionInput): Promise<void> {
  const udid = input.deviceId
  switch (input.type) {
    case 'setAppearance':
      await simctl(host, udid, ['ui', 'appearance', input.value], 'appearance')
      return
    case 'setTextSize':
      await simctl(host, udid, ['ui', 'content_size', IOS_TEXT_SIZES[input.value]], 'text size')
      return
    case 'setToggle': {
      if (input.setting === 'increaseContrast') {
        await simctl(
          host,
          udid,
          ['ui', 'increase_contrast', input.value ? 'enabled' : 'disabled'],
          'increase contrast',
        )
        return
      }
      const option = IOS_TOGGLE_OPTIONS.get(input.setting)
      if (!option) throw new Error(`Unsupported iOS toggle: ${input.setting}`)
      await runAxSettings(host, udid, ['set', option, input.value ? 'on' : 'off'])
      return
    }
    case 'setLocation':
      await simctl(
        host,
        udid,
        ['location', 'set', `${input.latitude},${input.longitude}`],
        'location',
      )
      return
    case 'clearLocation':
      await simctl(host, udid, ['location', 'clear'], 'location')
      return
    case 'setPermission': {
      if (input.permission === 'notifications') {
        const cli = host.helpers.serveSimCli
        if (!cli) {
          throw new Error('Notification permissions helper is not available in this simulator hub.')
        }
        const result = await host.run(process.execPath, [
          cli,
          'permissions',
          udid,
          input.appId,
          'notifications',
          input.decision,
        ])
        assertOk('permission', result)
        return
      }
      const service = IOS_TCC_SERVICES.get(input.permission)
      if (!service) throw new Error(`Unsupported iOS permission: ${input.permission}`)
      await simctl(host, udid, ['privacy', input.decision, service, input.appId], 'permission')
      return
    }
    case 'openUrl':
      await simctl(host, udid, ['openurl', input.url], 'open url')
      return
    case 'launchApp':
      await simctl(host, udid, ['launch', input.appId], 'launch')
      return
    case 'terminateApp':
      await simctl(host, udid, ['terminate', input.appId], 'terminate')
      return
    case 'sendPush': {
      const payload =
        typeof input.payload === 'string' ? { aps: { alert: input.payload } } : input.payload
      const result = await host.run('xcrun', ['simctl', 'push', udid, input.appId, '-'], {
        stdin: JSON.stringify(payload),
      })
      assertOk('push', result)
      return
    }
    case 'setOrientation':
      throw new Error('iOS orientation is controlled via the simulator stream.')
  }
}

async function runAndroidAction(
  host: ReadySimulatorHost,
  input: SimulatorActionInput,
): Promise<void> {
  const serial = input.deviceId
  const adb = async (args: string[], operation: string) =>
    assertOk(operation, await host.run('adb', ['-s', serial, ...args]))

  switch (input.type) {
    case 'setAppearance':
      await adb(
        ['shell', 'cmd', 'uimode', 'night', input.value === 'dark' ? 'yes' : 'no'],
        'appearance',
      )
      return
    case 'setTextSize':
      await adb(
        ['shell', 'settings', 'put', 'system', 'font_scale', ANDROID_TEXT_SIZES[input.value]],
        'text size',
      )
      return
    case 'setToggle': {
      if (input.setting === 'reduceMotion') {
        const scale = input.value ? '0' : '1'
        for (const key of [
          'window_animation_scale',
          'transition_animation_scale',
          'animator_duration_scale',
        ]) {
          await adb(['shell', 'settings', 'put', 'global', key, scale], 'reduce motion')
        }
        return
      }
      if (input.setting === 'increaseContrast') {
        await adb(
          [
            'shell',
            'settings',
            'put',
            'secure',
            'high_text_contrast_enabled',
            input.value ? '1' : '0',
          ],
          'high contrast text',
        )
        return
      }
      if (input.setting === 'networkEnabled') {
        const mode = input.value ? 'enable' : 'disable'
        if (input.value) {
          await host
            .run('adb', ['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'])
            .catch(() => undefined)
        }
        await adb(['shell', 'svc', 'wifi', mode], 'network')
        await host.run('adb', ['-s', serial, 'shell', 'svc', 'data', mode]).catch(() => undefined)
        return
      }
      throw new Error(`Unsupported Android toggle: ${input.setting}`)
    }
    case 'setOrientation': {
      const wmSize = await host.run('adb', ['-s', serial, 'shell', 'wm', 'size'])
      const landscapeNative = isLandscapeNative(wmSize.code === 0 ? wmSize.stdout : undefined)
      const rotationIndex = rotationIndexForAndroidOrientation(input.value, landscapeNative)
      const locked = await host.run('adb', [
        '-s',
        serial,
        'shell',
        'cmd',
        'window',
        'user-rotation',
        'lock',
        String(rotationIndex),
      ])
      if (locked.code !== 0) {
        await adb(
          ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
          'orientation',
        )
        await adb(
          ['shell', 'settings', 'put', 'system', 'user_rotation', String(rotationIndex)],
          'orientation',
        )
      }
      await host
        .run('adb', [
          '-s',
          serial,
          'emu',
          'sensor',
          'set',
          'acceleration',
          ANDROID_GRAVITY[input.value],
        ])
        .catch(() => undefined)
      return
    }
    case 'setLocation':
      await adb(['emu', 'geo', 'fix', String(input.longitude), String(input.latitude)], 'location')
      return
    case 'clearLocation':
      await adb(['emu', 'geo', 'fix', '0', '0'], 'location')
      return
    case 'setPermission': {
      const permissions = ANDROID_PERMISSIONS.get(input.permission)
      if (!permissions) throw new Error(`Unsupported Android permission: ${input.permission}`)
      const op = input.decision === 'grant' ? 'grant' : 'revoke'
      let succeeded = 0
      let lastFailure: HostRunResult | undefined
      for (const perm of permissions) {
        const res = await host.run('adb', ['-s', serial, 'shell', 'pm', op, input.appId, perm])
        if (res.code === 0) {
          succeeded += 1
          if (input.decision === 'reset') {
            await host
              .run('adb', [
                '-s',
                serial,
                'shell',
                'pm',
                'clear-permission-flags',
                input.appId,
                perm,
                'user-set',
                'user-fixed',
              ])
              .catch(() => undefined)
          }
        } else {
          lastFailure = res
        }
      }
      if (succeeded === 0 && lastFailure) {
        assertOk('permission', lastFailure)
      }
      return
    }
    case 'openUrl':
      await adb(
        ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', input.url],
        'open url',
      )
      return
    case 'launchApp':
      await adb(
        ['shell', 'monkey', '-p', input.appId, '-c', 'android.intent.category.LAUNCHER', '1'],
        'launch',
      )
      return
    case 'terminateApp':
      await adb(['shell', 'am', 'force-stop', input.appId], 'terminate')
      return
    case 'sendPush':
      throw new Error('Sending test push notifications is only supported on iOS.')
  }
}
