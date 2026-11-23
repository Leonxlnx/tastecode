import { z } from 'zod'

/**
 * Local mobile simulators and emulators (iOS Simulator via Xcode and Android
 * Emulator via Android SDK). The server owns the device hub, stream proxy,
 * typed `simctl`/`adb` actions, and agent MCP/CLI toolchain; clients are thin
 * viewers over the protocol and authenticated loopback proxy.
 */

export const SIMULATOR_HUB_ROUTE_PREFIX = '/api/device-hub'

export const SimulatorPlatformSchema = z.enum(['ios', 'android'])
export type SimulatorPlatform = z.infer<typeof SimulatorPlatformSchema>

export const SimulatorHostStatusSchema = z.enum([
  'disabled',
  'idle',
  'installing',
  'starting',
  'ready',
  'failed',
])
export type SimulatorHostStatus = z.infer<typeof SimulatorHostStatusSchema>

export const SimulatorPlatformAvailabilitySchema = z.object({
  platform: SimulatorPlatformSchema,
  available: z.boolean(),
  reason: z.string().min(1).optional(),
})
export type SimulatorPlatformAvailability = z.infer<typeof SimulatorPlatformAvailabilitySchema>

export const SimulatorToolVersionSchema = z.object({
  requiredVersion: z.string().min(1),
  installedVersions: z.array(z.string().min(1)),
  runningVersion: z.string().min(1).nullable(),
})
export type SimulatorToolVersion = z.infer<typeof SimulatorToolVersionSchema>

export const SimulatorToolVersionsSchema = z.object({
  hub: SimulatorToolVersionSchema,
  agent: SimulatorToolVersionSchema,
})
export type SimulatorToolVersions = z.infer<typeof SimulatorToolVersionsSchema>

export const SimulatorDeviceIdSchema = z.string().trim().min(1).max(256)
export type SimulatorDeviceId = z.infer<typeof SimulatorDeviceIdSchema>

export const SimulatorDeviceSchema = z.object({
  id: SimulatorDeviceIdSchema,
  name: z.string().min(1).max(256),
  platform: SimulatorPlatformSchema,
  version: z.string().max(128),
  booted: z.boolean(),
  physical: z.boolean(),
})
export type SimulatorDevice = z.infer<typeof SimulatorDeviceSchema>

export const SimulatorSessionSchema = z.object({
  threadId: z.string().min(1),
  deviceId: SimulatorDeviceIdSchema,
  platform: SimulatorPlatformSchema,
  openedAt: z.number().int().nonnegative(),
  openedBy: z.enum(['user', 'agent']),
})
export type SimulatorSession = z.infer<typeof SimulatorSessionSchema>

export const SimulatorAndroidSetupStatusSchema = z.enum([
  'idle',
  'installing',
  'removing',
  'failed',
])
export type SimulatorAndroidSetupStatus = z.infer<typeof SimulatorAndroidSetupStatusSchema>

export const SimulatorAndroidSystemImageSchema = z.object({
  packageId: z.string().min(1),
  label: z.string().min(1),
  apiLevel: z.number().int().positive(),
  tag: z.string().min(1),
  abi: z.string().min(1),
  installed: z.boolean(),
})
export type SimulatorAndroidSystemImage = z.infer<typeof SimulatorAndroidSystemImageSchema>

export const SimulatorAndroidSdkSchema = z.object({
  root: z.string().min(1).nullable(),
  defaultRoot: z.string().min(1),
  adb: z.boolean(),
  emulator: z.boolean(),
  cmdlineTools: z.boolean(),
  javaAvailable: z.boolean(),
  javaPath: z.string().min(1).nullable(),
  javaReason: z.string().min(1).optional(),
  hostAbi: z.enum(['arm64-v8a', 'x86_64']),
  systemImages: z.array(SimulatorAndroidSystemImageSchema),
})
export type SimulatorAndroidSdk = z.infer<typeof SimulatorAndroidSdkSchema>

export const SimulatorDeviceModelOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  supported: z.boolean(),
})
export type SimulatorDeviceModelOption = z.infer<typeof SimulatorDeviceModelOptionSchema>

export const SimulatorRuntimeOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  models: z.array(SimulatorDeviceModelOptionSchema),
})
export type SimulatorRuntimeOption = z.infer<typeof SimulatorRuntimeOptionSchema>

export const SimulatorPlatformNewOptionsSchema = z.object({
  runtimes: z.array(SimulatorRuntimeOptionSchema),
})
export type SimulatorPlatformNewOptions = z.infer<typeof SimulatorPlatformNewOptionsSchema>

export const SimulatorNewOptionsSchema = z.object({
  ios: SimulatorPlatformNewOptionsSchema,
  android: SimulatorPlatformNewOptionsSchema,
  errors: z.array(z.string()),
})
export type SimulatorNewOptions = z.infer<typeof SimulatorNewOptionsSchema>

export const SimulatorStateSchema = z.object({
  enabled: z.boolean(),
  agentAccessEnabled: z.boolean(),
  onboardingCompleted: z.boolean(),
  hostStatus: SimulatorHostStatusSchema,
  hostStatusDetail: z.string().min(1).optional(),
  platforms: z.array(SimulatorPlatformAvailabilitySchema),
  hubInstalled: z.boolean(),
  agentDeviceInstalled: z.boolean(),
  tools: SimulatorToolVersionsSchema.optional(),
  androidSdk: SimulatorAndroidSdkSchema.optional(),
  androidSetupStatus: SimulatorAndroidSetupStatusSchema.optional(),
  androidSetupDetail: z.string().min(1).optional(),
  devices: z.array(SimulatorDeviceSchema),
  sessions: z.array(SimulatorSessionSchema),
  hubBasePath: z.string().min(1),
  incompletePlatforms: z.array(SimulatorPlatformSchema).optional(),
  revision: z.number().int().nonnegative(),
})
export type SimulatorState = z.infer<typeof SimulatorStateSchema>

export const SimulatorHubAccessSchema = z.object({
  httpBase: z.string().min(1),
  wsBase: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
})
export type SimulatorHubAccess = z.infer<typeof SimulatorHubAccessSchema>

export const SimulatorOpenedEventSchema = z.object({
  threadId: z.string().min(1),
  deviceId: SimulatorDeviceIdSchema,
  platform: SimulatorPlatformSchema,
  name: z.string().min(1).max(256),
  openedBy: z.enum(['user', 'agent']),
})
export type SimulatorOpenedEvent = z.infer<typeof SimulatorOpenedEventSchema>

export const SimulatorAppearanceSchema = z.enum(['light', 'dark'])
export type SimulatorAppearance = z.infer<typeof SimulatorAppearanceSchema>

export const SimulatorTextSizeSchema = z.enum(['small', 'default', 'large', 'extra-large'])
export type SimulatorTextSize = z.infer<typeof SimulatorTextSizeSchema>

export const SimulatorOrientationSchema = z.enum([
  'portrait',
  'portrait_upside_down',
  'landscape_left',
  'landscape_right',
])
export type SimulatorOrientation = z.infer<typeof SimulatorOrientationSchema>

export const SimulatorToggleSettingSchema = z.enum([
  'reduceMotion',
  'increaseContrast',
  'reduceTransparency',
  'showBorders',
  'voiceOver',
  'networkEnabled',
])
export type SimulatorToggleSetting = z.infer<typeof SimulatorToggleSettingSchema>

export const SimulatorPermissionSchema = z.enum([
  'camera',
  'microphone',
  'photos',
  'contacts',
  'calendar',
  'reminders',
  'location',
  'notifications',
  'motion',
  'media-library',
  'faceid',
])
export type SimulatorPermission = z.infer<typeof SimulatorPermissionSchema>

export const SimulatorPermissionDecisionSchema = z.enum(['grant', 'revoke', 'reset'])
export type SimulatorPermissionDecision = z.infer<typeof SimulatorPermissionDecisionSchema>

export const SimulatorActionTypeSchema = z.enum([
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
  'sendPush',
])
export type SimulatorActionType = z.infer<typeof SimulatorActionTypeSchema>

export const SimulatorForegroundAppSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  pid: z.number().int().nonnegative().optional(),
})
export type SimulatorForegroundApp = z.infer<typeof SimulatorForegroundAppSchema>

export const SimulatorDetailSchema = z.object({
  deviceId: SimulatorDeviceIdSchema,
  platform: SimulatorPlatformSchema,
  foregroundApp: SimulatorForegroundAppSchema.optional(),
  appearance: SimulatorAppearanceSchema.optional(),
  textSize: SimulatorTextSizeSchema.optional(),
  orientation: SimulatorOrientationSchema.optional(),
  toggles: z.partialRecord(SimulatorToggleSettingSchema, z.boolean()),
  supportedActions: z.array(SimulatorActionTypeSchema),
})
export type SimulatorDetail = z.infer<typeof SimulatorDetailSchema>

const NonEmptyIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'), 'cannot contain a null byte')

const OpenUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) => !value.includes('\0') && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value),
    'expected a URL with a scheme',
  )

export const SimulatorActionInputSchema = z.discriminatedUnion('type', [
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setAppearance'),
    value: SimulatorAppearanceSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setTextSize'),
    value: SimulatorTextSizeSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setToggle'),
    setting: SimulatorToggleSettingSchema,
    value: z.boolean(),
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setOrientation'),
    value: SimulatorOrientationSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setLocation'),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('clearLocation'),
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('setPermission'),
    appId: NonEmptyIdSchema,
    permission: SimulatorPermissionSchema,
    decision: SimulatorPermissionDecisionSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('openUrl'),
    url: OpenUrlSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('launchApp'),
    appId: NonEmptyIdSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('terminateApp'),
    appId: NonEmptyIdSchema,
  }),
  z.object({
    deviceId: SimulatorDeviceIdSchema,
    type: z.literal('sendPush'),
    appId: NonEmptyIdSchema,
    payload: z.union([z.string().min(1).max(4096), z.record(z.string(), z.unknown())]),
  }),
])
export type SimulatorActionInput = z.infer<typeof SimulatorActionInputSchema>
