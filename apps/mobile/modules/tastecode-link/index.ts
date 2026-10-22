import { requireNativeModule, type EventSubscription } from 'expo-modules-core'

export type LinkStateEvent =
  | { attempt: number; state: 'open'; host: string; deviceId: string; serverName: string }
  | { attempt: number; state: 'failed' | 'closed'; host?: string; error: string; code: string }

export type LinkFramesEvent = { attempt: number; frames: string[] }

export type PathChangeEvent = { satisfied: boolean; wifi: boolean; expensive: boolean }

type LinkEvents = {
  onLinkState: (event: LinkStateEvent) => void
  onLinkFrames: (event: LinkFramesEvent) => void
  onPathChange: (event: PathChangeEvent) => void
}

type TasteLinkModule = {
  deviceKey(): string
  readPairing(): string | null
  writePairing(json: string): void
  forgetPairing(): void
  connect(options: { key: string; hosts: string[]; port: number; hello: string }): number
  send(frame: string): boolean
  close(): void
  readPreference(key: string): string | null
  writePreference(key: string, value: string | null): void
  addListener<E extends keyof LinkEvents>(event: E, listener: LinkEvents[E]): EventSubscription
}

/**
 * The encrypted link to the paired computer (Swift on iOS). An Android build
 * provides the same module in Kotlin; everything above it is shared.
 */
export const TasteLink = requireNativeModule<TasteLinkModule>('TasteLink')
