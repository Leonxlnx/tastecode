import { useRef, useState, type ReactNode } from 'react'
import type { SFSymbol } from 'sf-symbols-typescript'
import { Alert } from 'react-native'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Model,
  QueuedTurn,
  UserInputRequest,
} from '@harness/contracts'
import {
  Button,
  Divider,
  GlassEffectContainer,
  HStack,
  Image,
  Label,
  Menu,
  Picker,
  ProgressView,
  ScrollView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useNativeState,
} from '@expo/ui/swift-ui'
import {
  buttonStyle,
  clipShape,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  lineLimit,
  menuOrder,
  padding,
  pickerStyle,
  scrollClipDisabled,
  tag,
} from '@expo/ui/swift-ui/modifiers'
import { connection } from '../state/app'
import { accessLevels, effortLabel, visibleModels, type Source } from '../state/catalog'
import { firstLine } from './format'
import { ATTENTION } from './theme'

export type Attachment = { localUri: string; path: string }

/** One chip above the input: a native menu whose label is the current value. */
function Chip(props: { symbol: SFSymbol; text: string; children: ReactNode; disabled?: boolean }) {
  return (
    <Menu
      label={
        <HStack spacing={5}>
          <Image systemName={props.symbol} size={12} />
          <Text modifiers={[font({ textStyle: 'footnote', weight: 'medium' }), lineLimit(1)]}>
            {props.text}
          </Text>
          <Image
            systemName="chevron.up.chevron.down"
            size={9}
            modifiers={[foregroundStyle('secondary')]}
          />
        </HStack>
      }
      modifiers={[
        padding({ horizontal: 12, vertical: 8 }),
        glassEffect({ glass: { variant: 'regular', interactive: true }, shape: 'capsule' }),
        // Opening upward from the composer would otherwise reverse the list.
        menuOrder('fixed'),
        ...(props.disabled ? [disabled(true)] : []),
      ]}
    >
      {props.children}
    </Menu>
  )
}

export function ModelChip(props: {
  sources: readonly Source[]
  current: Source | undefined
  model: Model | undefined
  /** Other sources can be chosen only before a chat starts, or while it is idle. */
  switchable: boolean
  onSelect: (source: Source, model: Model) => void
}) {
  const { current } = props
  const label = props.model?.displayName ?? current?.name ?? 'Model'
  const others = props.sources.filter(
    (source) => source.key !== current?.key && source.models.length > 0,
  )
  return (
    <Chip symbol="cpu" text={label}>
      {current ? (
        <ModelSection source={current} selected={props.model?.id} onSelect={props.onSelect} />
      ) : null}
      {props.switchable && others.length > 0 ? (
        <Section title="Other providers">
          {others.map((source) => (
            <Menu key={source.key} label={source.name}>
              <ModelSection source={source} selected={undefined} onSelect={props.onSelect} />
            </Menu>
          ))}
        </Section>
      ) : null}
    </Chip>
  )
}

function ModelSection(props: {
  source: Source
  selected: string | undefined
  onSelect: (source: Source, model: Model) => void
}) {
  const { main, more } = visibleModels(props.source.models)
  const select = (id: string) => {
    const model = props.source.models.find((candidate) => candidate.id === id)
    if (model) props.onSelect(props.source, model)
  }
  return (
    <Section title={props.source.name}>
      {props.source.status === 'loading' && main.length === 0 ? <Text>Loading models…</Text> : null}
      <Picker
        selection={props.selected ?? null}
        onSelectionChange={(id: string | null) => id && select(id)}
        modifiers={[pickerStyle('inline')]}
      >
        {main.map((model) => (
          <Text key={model.id} modifiers={[tag(model.id)]}>
            {model.displayName}
          </Text>
        ))}
      </Picker>
      {more.length > 0 ? (
        <Menu label="More Models">
          <Picker
            selection={props.selected ?? null}
            onSelectionChange={(id: string | null) => id && select(id)}
            modifiers={[pickerStyle('inline')]}
          >
            {more.map((model) => (
              <Text key={model.id} modifiers={[tag(model.id)]}>
                {model.displayName}
              </Text>
            ))}
          </Picker>
        </Menu>
      ) : null}
    </Section>
  )
}

export function EffortChip(props: {
  model: Model | undefined
  effort: string | undefined
  onSelect: (effort: string) => void
}) {
  const efforts = props.model?.reasoningEfforts ?? []
  if (efforts.length === 0 || !props.effort) return null
  return (
    <Chip symbol="brain" text={effortLabel(props.effort)}>
      <Picker
        selection={props.effort}
        onSelectionChange={(effort: string) => props.onSelect(effort)}
        modifiers={[pickerStyle('inline')]}
      >
        {efforts.map((effort) => (
          <Text key={effort} modifiers={[tag(effort)]}>
            {effortLabel(effort)}
          </Text>
        ))}
      </Picker>
    </Chip>
  )
}

export function AccessChip(props: {
  source: Source | undefined
  approval: ApprovalMode
  onSelect: (mode: ApprovalMode) => void
}) {
  const levels = accessLevels(props.source?.capabilities)
  const current = levels.find((level) => level.mode === props.approval) ?? levels[0]
  return (
    <Chip symbol={current?.symbol ?? 'hand.raised'} text={current?.title ?? 'Ask first'}>
      <Section title="Access">
        <Picker
          selection={props.approval}
          onSelectionChange={(mode: ApprovalMode) => props.onSelect(mode)}
          modifiers={[pickerStyle('inline')]}
        >
          {levels.map((level) => (
            <Label
              key={level.mode}
              title={level.title}
              systemImage={level.symbol}
              modifiers={[tag(level.mode)]}
            />
          ))}
        </Picker>
      </Section>
    </Chip>
  )
}

export function ProjectChip(props: {
  projects: ReadonlyArray<{ path: string; name: string }>
  selected: string | undefined
  isolate: boolean
  onSelect: (path: string) => void
  onIsolate: (isolate: boolean) => void
  onAdd: () => void
}) {
  const current = props.projects.find((project) => project.path === props.selected)
  return (
    <Chip symbol="folder" text={current?.name ?? 'Choose a project'}>
      <Picker
        selection={props.selected ?? null}
        onSelectionChange={(path: string | null) => path && props.onSelect(path)}
        modifiers={[pickerStyle('inline')]}
      >
        {props.projects.map((project) => (
          <Text key={project.path} modifiers={[tag(project.path)]}>
            {project.name}
          </Text>
        ))}
      </Picker>
      <Divider />
      <Button
        label={props.isolate ? 'Work in the Project Folder' : 'Work in a Private Checkout'}
        systemImage={props.isolate ? 'folder' : 'arrow.triangle.branch'}
        onPress={() => props.onIsolate(!props.isolate)}
      />
      <Button label="Add Project…" systemImage="folder.badge.plus" onPress={props.onAdd} />
    </Chip>
  )
}

/** A permission the agent is waiting for. The highest-stakes moment in the app, answered here. */
export function ApprovalCard(props: {
  request: ApprovalRequest
  onDecide: (decision: ApprovalDecision) => Promise<void>
}) {
  const { request } = props
  const [busy, setBusy] = useState(false)
  const decide = (decision: ApprovalDecision) => {
    setBusy(true)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    props.onDecide(decision).catch((error: unknown) => {
      setBusy(false)
      Alert.alert('Could not answer', error instanceof Error ? error.message : String(error))
    })
  }
  const title =
    request.kind === 'command'
      ? 'Run this command?'
      : request.kind === 'file_change'
        ? 'Change this file?'
        : 'Allow this access?'
  const subject = request.command ?? request.path
  return (
    <VStack
      alignment="leading"
      spacing={10}
      modifiers={[
        padding({ all: 16 }),
        frame({ maxWidth: 10_000, alignment: 'leading' }),
        glassEffect({ glass: { variant: 'regular' }, shape: 'roundedRectangle', cornerRadius: 26 }),
      ]}
    >
      <HStack spacing={8}>
        <Image systemName="hand.raised.fill" size={15} modifiers={[foregroundStyle(ATTENTION)]} />
        <Text modifiers={[font({ textStyle: 'headline' })]}>{title}</Text>
      </HStack>
      {request.reason ? (
        <Text
          modifiers={[
            font({ textStyle: 'subheadline' }),
            foregroundStyle('secondary'),
            lineLimit(4),
          ]}
        >
          {request.reason}
        </Text>
      ) : null}
      {subject ? (
        <Text modifiers={[font({ textStyle: 'footnote', design: 'monospaced' }), lineLimit(6)]}>
          {subject}
        </Text>
      ) : null}
      <HStack spacing={8}>
        <Button
          label="Deny"
          onPress={() => decide('deny')}
          modifiers={[buttonStyle('glass'), disabled(busy)]}
        />
        <Spacer />
        <Menu label="Always" modifiers={[buttonStyle('glass'), disabled(busy)]}>
          <Button
            label="Allow for This Session"
            systemImage="checkmark.seal"
            onPress={() => decide('approve-session')}
          />
          <Button
            label="Stop the Turn"
            systemImage="stop.circle"
            role="destructive"
            onPress={() => decide('abort')}
          />
        </Menu>
        <Button
          label="Allow"
          onPress={() => decide('approve')}
          modifiers={[buttonStyle('glassProminent'), disabled(busy)]}
        />
      </HStack>
    </VStack>
  )
}

export function QuestionCard(props: { request: UserInputRequest; onAnswer: () => void }) {
  const first = props.request.questions[0]
  return (
    <HStack
      spacing={12}
      modifiers={[
        padding({ horizontal: 16, vertical: 12 }),
        glassEffect({ glass: { variant: 'regular' }, shape: 'roundedRectangle', cornerRadius: 22 }),
      ]}
    >
      <Image
        systemName="questionmark.bubble.fill"
        size={18}
        modifiers={[foregroundStyle(ATTENTION)]}
      />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' })]}>
          {props.request.questions.length > 1
            ? `${props.request.questions.length} questions for you`
            : 'A question for you'}
        </Text>
        <Text
          modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary'), lineLimit(2)]}
        >
          {first?.question ?? ''}
        </Text>
      </VStack>
      <Spacer />
      <Button
        label="Answer"
        onPress={props.onAnswer}
        modifiers={[buttonStyle('glassProminent'), controlSize('small')]}
      />
    </HStack>
  )
}

export function QueueList(props: {
  items: readonly QueuedTurn[]
  canSteer: boolean
  onSteer: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <VStack alignment="leading" spacing={6} modifiers={[padding({ horizontal: 6 })]}>
      {props.items.map((item) => (
        <HStack key={item.id} spacing={8}>
          <Image systemName="clock" size={12} modifiers={[foregroundStyle('secondary')]} />
          <Text
            modifiers={[
              font({ textStyle: 'footnote' }),
              foregroundStyle('secondary'),
              lineLimit(1),
            ]}
          >
            {firstLine(item.text) || 'Image'}
          </Text>
          <Spacer />
          {props.canSteer ? (
            <Button
              label="Send Now"
              onPress={() => props.onSteer(item.id)}
              modifiers={[controlSize('mini'), buttonStyle('glass')]}
            />
          ) : null}
          <Button
            onPress={() => props.onDelete(item.id)}
            modifiers={[controlSize('mini'), buttonStyle('borderless')]}
          >
            <Image systemName="xmark" size={11} modifiers={[foregroundStyle('secondary')]} />
          </Button>
        </HStack>
      ))}
    </VStack>
  )
}

/**
 * The input row: attachments, the growing text field, and one round button
 * that sends, or stops the running turn when there is nothing to send.
 */
export function InputRow(props: {
  draftKey: string
  running: boolean
  canSend: boolean
  allowImages: boolean
  placeholder: string
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>
  onStop: () => void
}) {
  const text = useNativeState(drafts.get(props.draftKey) ?? '')
  const current = useRef(drafts.get(props.draftKey) ?? '')
  const [hasText, setHasText] = useState(current.current.trim().length > 0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)

  const ready = (hasText || attachments.length > 0) && props.canSend && !uploading && !sending
  const showStop = props.running && !hasText && attachments.length === 0

  const send = async () => {
    if (!ready) return
    const value = current.current.trim()
    const files = attachments
    setSending(true)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    text.value = ''
    current.current = ''
    drafts.delete(props.draftKey)
    setHasText(false)
    setAttachments([])
    const sent = await props.onSend(value, files).catch(() => false)
    setSending(false)
    if (!sent) {
      // Nothing is lost: the prompt goes back into the field.
      text.value = value
      current.current = value
      drafts.set(props.draftKey, value)
      setHasText(value.length > 0)
      setAttachments(files)
    }
  }

  const pick = async (camera: boolean) => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
      allowsMultipleSelection: !camera,
      selectionLimit: 4,
    }
    const result = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options)
    if (result.canceled) return
    setUploading(true)
    try {
      const saved = await Promise.all(
        result.assets
          .filter((asset) => asset.base64)
          .map(async (asset) => {
            const { path } = await connection.request(
              'attachments.saveImage',
              { mimeType: asset.mimeType ?? 'image/jpeg', data: asset.base64 ?? '' },
              120_000,
            )
            return { localUri: asset.uri, path }
          }),
      )
      setAttachments((existing) => [...existing, ...saved])
    } catch (error) {
      Alert.alert('Could not attach', error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  return (
    <VStack alignment="leading" spacing={8}>
      {attachments.length > 0 || uploading ? (
        <HStack spacing={8} modifiers={[padding({ horizontal: 4 })]}>
          {attachments.map((attachment) => (
            <Button
              key={attachment.path}
              onPress={() =>
                setAttachments((existing) => existing.filter((entry) => entry !== attachment))
              }
              modifiers={[buttonStyle('plain')]}
            >
              <Image
                uiImage={attachment.localUri}
                modifiers={[frame({ width: 52, height: 52 }), clipShape('roundedRectangle', 12)]}
              />
            </Button>
          ))}
          {uploading ? <ProgressView /> : null}
        </HStack>
      ) : null}
      <HStack spacing={8} alignment="bottom">
        {props.allowImages ? (
          <Menu
            label={
              <Image systemName="plus" size={18} modifiers={[frame({ width: 44, height: 44 })]} />
            }
            modifiers={[
              glassEffect({ glass: { variant: 'regular', interactive: true }, shape: 'circle' }),
            ]}
          >
            <Button
              label="Photo Library"
              systemImage="photo.on.rectangle"
              onPress={() => void pick(false)}
            />
            <Button label="Take Photo" systemImage="camera" onPress={() => void pick(true)} />
          </Menu>
        ) : null}
        <TextField
          text={text}
          axis="vertical"
          placeholder={props.placeholder}
          onTextChange={(value) => {
            current.current = value
            drafts.set(props.draftKey, value)
            setHasText(value.trim().length > 0)
          }}
          modifiers={[
            lineLimit({ min: 1, max: 6 }),
            font({ textStyle: 'body' }),
            padding({ horizontal: 16, vertical: 11 }),
            frame({ minHeight: 44 }),
            glassEffect({
              glass: { variant: 'regular', interactive: true },
              shape: 'roundedRectangle',
              cornerRadius: 22,
            }),
          ]}
        />
        <Button
          onPress={() => (showStop ? props.onStop() : void send())}
          modifiers={[
            buttonStyle('glassProminent'),
            clipShape('circle'),
            disabled(!showStop && !ready),
          ]}
        >
          <Image
            systemName={showStop ? 'stop.fill' : 'arrow.up'}
            size={showStop ? 14 : 17}
            modifiers={[frame({ width: 28, height: 32 }), font({ weight: 'semibold' })]}
          />
        </Button>
      </HStack>
    </VStack>
  )
}

/** What was typed but not sent, per chat, while the app runs. */
const drafts = new Map<string, string>()

/** The chips above the input; they scroll sideways when they do not fit. */
export function ChipRow(props: { children: ReactNode }) {
  return (
    <ScrollView axes="horizontal" showsIndicators={false} modifiers={[scrollClipDisabled()]}>
      <HStack spacing={8} modifiers={[padding({ horizontal: 2, vertical: 2 })]}>
        {props.children}
      </HStack>
    </ScrollView>
  )
}

export function ComposerStack(props: { children: ReactNode }) {
  return (
    <GlassEffectContainer spacing={12}>
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[padding({ horizontal: 12, top: 6, bottom: 8 })]}
      >
        {props.children}
      </VStack>
    </GlassEffectContainer>
  )
}
