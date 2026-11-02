import { requireNativeModule, requireNativeView } from 'expo'
import type { EventSubscription } from 'expo-modules-core'
import type { ViewProps } from 'react-native'

/** A request from the screens: `id` is empty unless they wait for `resolve`. */
export type ActionEvent = { id: string; action: string }

type TasteUIModule = {
  /** Replaces one piece of what the screens show, as JSON. */
  update(key: string, json: string): void
  /** Answers a request the screens made: a JSON result or an error sentence. */
  resolve(id: string, json: string | null, error: string | null): void
  addListener(event: 'onAction', listener: (event: ActionEvent) => void): EventSubscription
}

/** The native screens (UIKit on iOS). They render what `update` sends and ask through `onAction`. */
export const TasteUI = requireNativeModule<TasteUIModule>('TasteUI')

const TasteAppNative = requireNativeView<ViewProps>('TasteUI', 'TasteAppView')

/** The whole app's interface; give it the whole screen. */
export function TasteApp(props: ViewProps) {
  return <TasteAppNative {...props} />
}
