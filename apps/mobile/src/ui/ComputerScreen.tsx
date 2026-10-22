import { useState } from 'react'
import Constants from 'expo-constants'
import type { SFSymbol } from 'sf-symbols-typescript'
import {
  Button,
  ConfirmationDialog,
  Form,
  HStack,
  Image,
  LabeledContent,
  NavigationStack,
  Section,
  Text,
  VStack,
} from '@expo/ui/swift-ui'
import {
  font,
  foregroundStyle,
  lineLimit,
  navigationTitle,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import { TasteLink } from '../../modules/tastecode-link'
import { connection, forgetComputer, pairing } from '../state/app'
import { useStore } from '../store'

/** Groups of four, so two people can read a key aloud and compare it. */
function fingerprint(key: string): string {
  return (key.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ')
}

export function ComputerTab() {
  const status = useStore(connection.status)
  const current = useStore(pairing)
  const [forgetting, setForgetting] = useState(false)
  const name = current?.name ?? 'Computer'
  const state: { text: string; color: string; symbol: SFSymbol } =
    status.phase === 'open'
      ? { text: 'Connected', color: 'green', symbol: 'checkmark.circle.fill' }
      : status.phase === 'connecting'
        ? { text: 'Connecting…', color: 'secondary', symbol: 'arrow.triangle.2.circlepath' }
        : status.phase === 'refused'
          ? { text: 'Needs pairing again', color: 'red', symbol: 'xmark.circle.fill' }
          : { text: 'Not reachable', color: 'orange', symbol: 'wifi.exclamationmark' }

  return (
    <NavigationStack>
      <Form modifiers={[navigationTitle('Computer')]}>
        <Section>
          <HStack spacing={14} modifiers={[padding({ vertical: 6 })]}>
            <Image
              systemName="laptopcomputer"
              size={34}
              modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}
            />
            <VStack alignment="leading" spacing={3}>
              <Text modifiers={[font({ textStyle: 'title3', weight: 'semibold' }), lineLimit(1)]}>
                {name}
              </Text>
              <HStack spacing={5}>
                <Image
                  systemName={state.symbol}
                  size={12}
                  modifiers={[foregroundStyle(state.color)]}
                />
                <Text
                  modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('secondary')]}
                >
                  {state.text}
                </Text>
              </HStack>
            </VStack>
          </HStack>
          {status.phase === 'open' ? (
            <LabeledContent label="Address">
              <Text>{status.host}</Text>
            </LabeledContent>
          ) : null}
          {status.phase === 'waiting' || status.phase === 'refused' ? (
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>
              {status.error}
            </Text>
          ) : null}
          {status.phase !== 'open' ? (
            <Button label="Reconnect" onPress={() => connection.reconnectNow()} />
          ) : null}
        </Section>
        <Section
          title="Security"
          footer={
            <Text>
              Every link is end-to-end encrypted and only this computer's key can answer it, on
              Wi-Fi or over Tailscale. Nothing passes through a server.
            </Text>
          }
        >
          {current ? (
            <LabeledContent label="Computer key">
              <Text modifiers={[font({ textStyle: 'footnote', design: 'monospaced' })]}>
                {fingerprint(current.key)}
              </Text>
            </LabeledContent>
          ) : null}
          <LabeledContent label="This phone's key">
            <Text modifiers={[font({ textStyle: 'footnote', design: 'monospaced' })]}>
              {fingerprint(TasteLink.deviceKey())}
            </Text>
          </LabeledContent>
        </Section>
        <Section>
          <ConfirmationDialog
            title={`Forget ${name}?`}
            isPresented={forgetting}
            onIsPresentedChange={setForgetting}
            titleVisibility="visible"
          >
            <ConfirmationDialog.Trigger>
              <Button
                label="Forget This Computer"
                role="destructive"
                onPress={() => setForgetting(true)}
              />
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button label="Forget" role="destructive" onPress={forgetComputer} />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <Text>This phone stops connecting and has to be paired again from the computer.</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Section>
        <Section footer={<Text>{`TasteCode ${Constants.expoConfig?.version ?? ''}`}</Text>}>
          {null}
        </Section>
      </Form>
    </NavigationStack>
  )
}
