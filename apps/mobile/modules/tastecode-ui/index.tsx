import { requireNativeModule, requireNativeView } from 'expo'
import type { EventSubscription } from 'expo-modules-core'
import type { CommonViewModifierProps } from '@expo/ui/swift-ui'

/** A request from the screens: `id` is empty unless they wait for `resolve`. */
export type ActionEvent = { id: string; action: string }

type TasteUIModule = {
  /** Replaces one piece of what the screens show, as JSON. */
  update(key: string, json: string): void
  /** Answers a request the screens made: a JSON result or an error sentence. */
  resolve(id: string, json: string | null, error: string | null): void
  addListener(event: 'onAction', listener: (event: ActionEvent) => void): EventSubscription
}

/** The SwiftUI screens (Swift on iOS). They render what `update` sends and ask through `onAction`. */
export const TasteUI = requireNativeModule<TasteUIModule>('TasteUI')

const TasteAppNative = requireNativeView<CommonViewModifierProps>('TasteUI', 'TasteAppView')

/** The whole app's interface. Must sit inside a `Host` that fills the screen. */
export function TasteApp(props: CommonViewModifierProps) {
  return <TasteAppNative {...props} />
}
