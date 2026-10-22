import { useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import {
  BottomSheet,
  Button,
  HStack,
  Image,
  NavigationStack,
  ProgressView,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui'
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  padding,
  presentationDetents,
  presentationDragIndicator,
  strokeBorder,
} from '@expo/ui/swift-ui/modifiers'
import { QRScanner } from '../../modules/tastecode-ui'
import { connection, forgetComputer, pairing, pairWith } from '../state/app'
import { useStore } from '../store'

const STEPS = [
  'On your computer, open TasteCode and go to Settings › Phone.',
  'Turn on phone access, then choose Show pairing code.',
  'Scan the code with this phone.',
]

/** First run, and whenever the computer no longer knows this phone. */
export function PairingScreen() {
  const status = useStore(connection.status)
  const current = useStore(pairing)
  const [scanning, setScanning] = useState(false)
  const [problem, setProblem] = useState<string>()

  const pair = (link: string) => {
    setScanning(false)
    try {
      setProblem(undefined)
      pairWith(link)
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    if (text.trim()) pair(text)
    else setProblem('The clipboard has no pairing link. Copy it on the computer first.')
  }

  const pairingName = current?.name
  const refused = status.phase === 'refused'
  const waiting = current !== undefined && !refused
  const failure = problem ?? (refused || status.phase === 'waiting' ? status.error : undefined)

  return (
    <NavigationStack>
      <VStack spacing={0} modifiers={[padding({ horizontal: 28 })]}>
        <Spacer />
        <Image
          systemName="laptopcomputer.and.iphone"
          size={58}
          modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}
        />
        <Text modifiers={[font({ size: 34, weight: 'bold' }), padding({ top: 22 })]}>
          TasteCode
        </Text>
        <Text
          modifiers={[
            font({ textStyle: 'body' }),
            foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
            multilineTextAlignment('center'),
            padding({ top: 8 }),
          ]}
        >
          Your agents keep working on your computer. Follow them, answer them and start new work
          from here.
        </Text>
        <VStack alignment="leading" spacing={16} modifiers={[padding({ top: 40 })]}>
          {STEPS.map((step, index) => (
            <HStack key={step} spacing={14} alignment="top">
              <Text
                modifiers={[
                  font({ textStyle: 'subheadline', weight: 'semibold' }),
                  foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                  frame({ width: 18, alignment: 'trailing' }),
                ]}
              >
                {String(index + 1)}
              </Text>
              <Text modifiers={[font({ textStyle: 'subheadline' })]}>{step}</Text>
            </HStack>
          ))}
        </VStack>
        <Spacer />
        {waiting ? (
          <VStack spacing={14} modifiers={[padding({ bottom: 24 })]}>
            {status.phase === 'connecting' || status.phase === 'idle' ? (
              <HStack spacing={10}>
                <ProgressView />
                <Text modifiers={[font({ textStyle: 'subheadline' })]}>
                  {`Pairing with ${pairingName ?? 'your computer'}…`}
                </Text>
              </HStack>
            ) : null}
            {failure ? <Failure text={failure} /> : null}
            <Button
              label="Cancel"
              onPress={() => {
                setProblem(undefined)
                forgetComputer()
              }}
              modifiers={[buttonStyle('glass'), controlSize('large')]}
            />
          </VStack>
        ) : (
          <VStack spacing={12} modifiers={[padding({ bottom: 24 })]}>
            {failure ? <Failure text={failure} /> : null}
            <Button
              onPress={() => setScanning(true)}
              modifiers={[buttonStyle('glassProminent'), controlSize('extraLarge')]}
            >
              <Text modifiers={[font({ weight: 'semibold' }), frame({ maxWidth: 10_000 })]}>
                Scan Pairing Code
              </Text>
            </Button>
            <Button
              onPress={() => void paste()}
              modifiers={[buttonStyle('glass'), controlSize('extraLarge')]}
            >
              <Text modifiers={[frame({ maxWidth: 10_000 })]}>Paste Pairing Link</Text>
            </Button>
          </VStack>
        )}
      </VStack>
      <BottomSheet isPresented={scanning} onIsPresentedChange={setScanning}>
        <ScannerSheet onCode={pair} onClose={() => setScanning(false)} />
      </BottomSheet>
    </NavigationStack>
  )
}

function Failure(props: { text: string }) {
  return (
    <Text
      modifiers={[
        font({ textStyle: 'footnote' }),
        foregroundStyle('red'),
        multilineTextAlignment('center'),
      ]}
    >
      {props.text}
    </Text>
  )
}

function ScannerSheet(props: { onCode: (value: string) => void; onClose: () => void }) {
  const [unavailable, setUnavailable] = useState<'denied' | 'no_camera'>()
  return (
    <ZStack modifiers={[presentationDetents(['large']), presentationDragIndicator('visible')]}>
      {unavailable ? (
        <VStack spacing={10} modifiers={[padding({ horizontal: 32 })]}>
          <Image systemName="camera" size={36} modifiers={[foregroundStyle('secondary')]} />
          <Text modifiers={[font({ textStyle: 'headline' })]}>
            {unavailable === 'denied' ? 'Camera access is off' : 'No camera available'}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle('secondary'),
              multilineTextAlignment('center'),
            ]}
          >
            {unavailable === 'denied'
              ? 'Allow TasteCode to use the camera in Settings, or copy the pairing link on the computer and paste it here.'
              : 'Copy the pairing link on the computer and paste it here instead.'}
          </Text>
        </VStack>
      ) : (
        <ZStack>
          <QRScanner onCode={props.onCode} onUnavailable={setUnavailable} />
          <RoundedRectangle
            cornerRadius={36}
            modifiers={[
              foregroundStyle('clear'),
              frame({ width: 248, height: 248 }),
              strokeBorder({
                color: 'white',
                style: { lineWidth: 3 },
                shape: 'roundedRectangle',
                cornerRadius: 36,
              }),
            ]}
          />
          <VStack>
            <Spacer />
            <Text
              modifiers={[
                font({ textStyle: 'callout', weight: 'medium' }),
                foregroundStyle('white'),
                padding({ horizontal: 18, vertical: 10 }),
                padding({ bottom: 48 }),
              ]}
            >
              Point at the code on your computer
            </Text>
          </VStack>
        </ZStack>
      )}
      <VStack>
        <HStack>
          <Spacer />
          <Button
            role="close"
            onPress={props.onClose}
            modifiers={[buttonStyle('glass'), padding({ top: 20, trailing: 20 })]}
          />
        </HStack>
        <Spacer />
      </VStack>
    </ZStack>
  )
}
