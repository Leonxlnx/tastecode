import type { ReactNode } from 'react'
import { requireNativeView } from 'expo'
import type { CommonViewModifierProps } from '@expo/ui/swift-ui'
import {
  createModifier,
  createViewModifierEventListener,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers'

type NativeProps = CommonViewModifierProps & Record<string, unknown>

const MarkdownTextNative = requireNativeView<NativeProps>('TasteUI', 'MarkdownTextView')
const ChatScaffoldNative = requireNativeView<NativeProps>('TasteUI', 'ChatScaffoldView')
const ChatBarNative = requireNativeView<{ children?: ReactNode }>('TasteUI', 'ChatBarView')
const QRScannerNative = requireNativeView<NativeProps>('TasteUI', 'QRScannerView')

function withModifierEvents(modifiers: ModifierConfig[] | undefined) {
  return modifiers ? createViewModifierEventListener(modifiers) : undefined
}

/** An agent's reply, rendered natively from Markdown. Must sit inside a `Host`. */
export function MarkdownText(props: { markdown: string } & CommonViewModifierProps) {
  return <MarkdownTextNative {...props} {...withModifierEvents(props.modifiers)} />
}

/** A chat screen: its children fill it, and `ChatBar` floats over the bottom edge. */
export function ChatScaffold(props: { children: ReactNode } & CommonViewModifierProps) {
  return <ChatScaffoldNative {...props} {...withModifierEvents(props.modifiers)} />
}

export function ChatBar(props: { children: ReactNode }) {
  return <ChatBarNative>{props.children}</ChatBarNative>
}

export function QRScanner(
  props: {
    onCode: (value: string) => void
    onUnavailable?: (reason: 'denied' | 'no_camera') => void
  } & CommonViewModifierProps,
) {
  const { onCode, onUnavailable, ...rest } = props
  return (
    <QRScannerNative
      {...rest}
      {...withModifierEvents(rest.modifiers)}
      onCode={(event: { nativeEvent: { value: string } }) => onCode(event.nativeEvent.value)}
      onUnavailable={(event: { nativeEvent: { reason: 'denied' | 'no_camera' } }) =>
        onUnavailable?.(event.nativeEvent.reason)
      }
    />
  )
}

/** The line under a navigation title (iOS 26). */
export const navigationSubtitle = (text: string) => createModifier('navigationSubtitle', { text })

/** Hides the tab bar on a pushed screen, such as a chat. */
export const hideTabBar = () => createModifier('hideTabBar')
