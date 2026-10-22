import { memo, useState } from 'react'
import type { Item, PlanStep } from '@harness/contracts'
import {
  DisclosureGroup,
  HStack,
  Image,
  ProgressView,
  Spacer,
  Text,
  VStack,
} from '@expo/ui/swift-ui'
import {
  background,
  controlSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  symbolEffect,
  textSelection,
} from '@expo/ui/swift-ui/modifiers'
import { MarkdownText } from '../../modules/tastecode-ui'
import type { ThreadView } from '../state/thread-model'
import { basename, duration, firstLine, providerName, stepTitle } from './format'
import { FAILURE } from './theme'

export type Row =
  | { key: string; kind: 'user'; item: Item }
  | { key: string; kind: 'assistant'; item: Item }
  | { key: string; kind: 'steps'; items: Item[]; live: boolean; turnId: string }
  | { key: string; kind: 'notice'; item: Item }
  | { key: string; kind: 'error'; item: Item }

const STEP_TYPES = new Set<Item['type']>([
  'command',
  'file_change',
  'tool_call',
  'reasoning',
  'plan',
  'unknown',
])

/** The transcript as rows: messages on their own, consecutive steps of work folded together. */
export function buildRows(view: ThreadView): Row[] {
  const rows: Row[] = []
  let steps: Item[] = []
  const flush = () => {
    const first = steps[0]
    if (first)
      rows.push({
        key: `steps:${first.id}`,
        kind: 'steps',
        items: steps,
        live: false,
        turnId: first.turnId,
      })
    steps = []
  }
  for (const item of view.items) {
    if (STEP_TYPES.has(item.type)) {
      steps.push(item)
      continue
    }
    flush()
    if (item.type === 'message') {
      rows.push({ key: item.id, kind: item.role === 'user' ? 'user' : 'assistant', item })
    } else if (item.type === 'notice') {
      rows.push({ key: item.id, kind: 'notice', item })
    } else {
      rows.push({ key: item.id, kind: 'error', item })
    }
  }
  flush()
  const last = rows.at(-1)
  if (view.running && last?.kind === 'steps') rows[rows.length - 1] = { ...last, live: true }
  return rows
}

export const TranscriptRow = memo(
  function TranscriptRow(props: { row: Row; turnTime?: number | undefined }) {
    const { row } = props
    switch (row.kind) {
      case 'user':
        return <UserMessage item={row.item} />
      case 'assistant':
        return (
          <MarkdownText
            markdown={row.item.text ?? ''}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'leading' })]}
          />
        )
      case 'steps':
        return <Steps items={row.items} live={row.live} turnTime={props.turnTime} />
      case 'notice':
        return <Notice item={row.item} />
      case 'error':
        return <ErrorLine text={row.item.text ?? 'Something went wrong.'} />
    }
  },
  (previous, next) => previous.turnTime === next.turnTime && sameRow(previous.row, next.row),
)

function sameRow(left: Row, right: Row): boolean {
  if (left.kind !== right.kind || left.key !== right.key) return false
  if (left.kind === 'steps' && right.kind === 'steps') {
    return (
      left.live === right.live &&
      left.items.length === right.items.length &&
      left.items.every((item, index) => item === right.items[index])
    )
  }
  return 'item' in left && 'item' in right && left.item === right.item
}

function UserMessage(props: { item: Item }) {
  const attachments = props.item.attachments ?? []
  return (
    <HStack>
      <Spacer minLength={48} />
      <VStack alignment="trailing" spacing={6}>
        {attachments.length > 0 ? (
          <HStack spacing={6}>
            <Image
              systemName="photo.on.rectangle"
              size={13}
              modifiers={[foregroundStyle('secondary')]}
            />
            <Text
              modifiers={[
                font({ textStyle: 'caption' }),
                foregroundStyle('secondary'),
                lineLimit(1),
              ]}
            >
              {attachments.length === 1
                ? basename(attachments[0] ?? '')
                : `${attachments.length} images`}
            </Text>
          </HStack>
        ) : null}
        {props.item.text ? (
          <Text
            modifiers={[
              font({ textStyle: 'body' }),
              textSelection(true),
              padding({ horizontal: 15, vertical: 10 }),
              background(
                { type: 'hierarchical', style: 'quinary' },
                { shape: 'roundedRectangle', cornerRadius: 20 },
              ),
            ]}
          >
            {props.item.text}
          </Text>
        ) : null}
      </VStack>
    </HStack>
  )
}

function summarize(items: readonly Item[]): string {
  let commands = 0
  let files = new Set<string>()
  let tools = 0
  let thoughts = 0
  for (const item of items) {
    if (item.type === 'command') commands += 1
    else if (item.type === 'file_change') files = new Set([...files, item.path ?? item.id])
    else if (item.type === 'tool_call') tools += 1
    else if (item.type === 'reasoning') thoughts += 1
  }
  const parts = [
    files.size ? `Edited ${files.size} ${files.size === 1 ? 'file' : 'files'}` : '',
    commands ? `ran ${commands} ${commands === 1 ? 'command' : 'commands'}` : '',
    tools ? `used ${tools} ${tools === 1 ? 'tool' : 'tools'}` : '',
  ].filter(Boolean)
  if (parts.length === 0) return thoughts ? 'Thought it through' : `${items.length} steps`
  const sentence = parts.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

function Steps(props: { items: Item[]; live: boolean; turnTime: number | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const latest = props.items.at(-1)
  const label = props.live && latest ? stepTitle(latest).text : summarize(props.items)
  const failed = props.items.some(
    (item) =>
      item.status === 'failed' ||
      (item.type === 'command' && item.exitCode !== undefined && item.exitCode !== 0),
  )
  return (
    <DisclosureGroup isExpanded={expanded} onIsExpandedChange={setExpanded}>
      <DisclosureGroup.Label>
        <HStack spacing={9}>
          {props.live ? (
            <ProgressView modifiers={[controlSize('small')]} />
          ) : (
            <Image
              systemName={failed ? 'exclamationmark.circle' : 'checklist'}
              size={14}
              modifiers={[foregroundStyle(failed ? FAILURE : 'secondary')]}
            />
          )}
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle('secondary'),
              lineLimit(1),
            ]}
          >
            {label}
          </Text>
          {!props.live && props.turnTime ? (
            <Text
              modifiers={[
                font({ textStyle: 'subheadline' }),
                foregroundStyle({ type: 'hierarchical', style: 'tertiary' }),
              ]}
            >
              {duration(props.turnTime)}
            </Text>
          ) : null}
        </HStack>
      </DisclosureGroup.Label>
      <VStack alignment="leading" spacing={10} modifiers={[padding({ top: 8 })]}>
        {props.items.map((item) => (
          <Step key={item.id} item={item} />
        ))}
      </VStack>
    </DisclosureGroup>
  )
}

function Step(props: { item: Item }) {
  const { item } = props
  const { symbol, text } = stepTitle(item)
  const running = item.status === 'started'
  const failed =
    item.status === 'failed' ||
    (item.type === 'command' && item.exitCode !== undefined && item.exitCode !== 0)
  const detail =
    item.type === 'reasoning'
      ? item.text
      : item.type === 'command' && item.durationMs !== undefined
        ? `${item.exitCode === undefined ? 'Ran' : `Exit ${item.exitCode}`} · ${duration(item.durationMs)}`
        : item.type === 'tool_call' && item.subagent?.summary
          ? item.subagent.summary
          : undefined
  return (
    <HStack spacing={10} alignment="top">
      <Image
        systemName={symbol}
        size={13}
        modifiers={[foregroundStyle('secondary'), frame({ width: 18 })]}
      />
      <VStack alignment="leading" spacing={3}>
        <Text
          modifiers={[
            font({
              textStyle: 'footnote',
              design: item.type === 'command' ? 'monospaced' : 'default',
            }),
            lineLimit(item.type === 'command' ? 3 : 2),
          ]}
        >
          {text}
        </Text>
        {detail ? (
          <Text
            modifiers={[
              font({ textStyle: 'caption' }),
              foregroundStyle('secondary'),
              lineLimit(item.type === 'reasoning' ? 12 : 3),
            ]}
          >
            {detail}
          </Text>
        ) : null}
      </VStack>
      <Spacer />
      {running ? <ProgressView modifiers={[controlSize('mini')]} /> : null}
      {failed ? (
        <Image systemName="xmark.circle.fill" size={13} modifiers={[foregroundStyle(FAILURE)]} />
      ) : null}
    </HStack>
  )
}

function Notice(props: { item: Item }) {
  const notice = props.item.notice
  const text = notice
    ? `Continued on ${providerName(notice.provider)}${notice.model ? ` · ${notice.model}` : ''}`
    : firstLine(props.item.text ?? '')
  return (
    <HStack>
      <Spacer />
      <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle('secondary')]}>{text}</Text>
      <Spacer />
    </HStack>
  )
}

function ErrorLine(props: { text: string }) {
  return (
    <HStack spacing={10} alignment="top">
      <Image
        systemName="exclamationmark.triangle.fill"
        size={14}
        modifiers={[foregroundStyle(FAILURE)]}
      />
      <Text modifiers={[font({ textStyle: 'subheadline' }), textSelection(true)]}>
        {props.text}
      </Text>
    </HStack>
  )
}

/** The agent at work with nothing streaming yet: before its first step or reply. */
export function WorkingLine(props: { label: string }) {
  return (
    <HStack spacing={8}>
      <Image
        systemName="ellipsis"
        size={16}
        modifiers={[
          foregroundStyle('secondary'),
          symbolEffect(
            { effect: 'variableColor', fillStyle: 'iterative' },
            { options: { repeat: 'continuous' } },
          ),
        ]}
      />
      <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('secondary')]}>
        {props.label}
      </Text>
    </HStack>
  )
}

export function PlanCard(props: { steps: readonly PlanStep[] }) {
  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[
        padding({ all: 14 }),
        frame({ maxWidth: 10_000, alignment: 'leading' }),
        background(
          { type: 'hierarchical', style: 'quinary' },
          { shape: 'roundedRectangle', cornerRadius: 18 },
        ),
      ]}
    >
      <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' })]}>Plan</Text>
      {props.steps.map((step, index) => (
        <HStack key={`${index}:${step.text}`} spacing={10} alignment="top">
          <Image
            systemName={
              step.status === 'done'
                ? 'checkmark.circle.fill'
                : step.status === 'running'
                  ? 'circle.dotted'
                  : 'circle'
            }
            size={14}
            modifiers={[foregroundStyle(step.status === 'pending' ? 'secondary' : 'primary')]}
          />
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle(step.status === 'done' ? 'secondary' : 'primary'),
            ]}
          >
            {step.text}
          </Text>
        </HStack>
      ))}
    </VStack>
  )
}
