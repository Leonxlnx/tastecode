import { useState } from 'react'
import type { Item } from '@harness/contracts'
import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleQuestionMark,
  FilePenLine,
  Images,
  ListChecks,
  LoaderCircle,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { Markdown } from './Markdown.js'

type WorkedBlock =
  { id: string; kind: 'narrative'; item: Item } | { id: string; kind: 'tools'; items: Item[] }

export function WorkedTranscript({ items }: { items: Item[] }) {
  return (
    <div className="activity__body">
      {workedBlocks(items).map((block) =>
        block.kind === 'narrative' ? (
          <div
            className={`activity__message${block.item.type === 'reasoning' ? ' activity__message--reasoning' : ''}`}
            key={block.id}
          >
            <Markdown text={block.item.text ?? ''} />
          </div>
        ) : (
          <WorkedToolGroup items={block.items} key={block.id} />
        ),
      )}
    </div>
  )
}

export function visibleWorkedItems(items: Item[]): Item[] {
  return items.filter((item) => !isNarrative(item) || Boolean(item.text?.trim()))
}

export function itemGlyph(item: Item) {
  switch (item.type) {
    case 'command':
      return <SquareTerminal size={13} />
    case 'reasoning':
      return <Brain size={13} />
    case 'file_change':
      return <FilePenLine size={13} />
    case 'tool_call':
      if (toolText(item).includes('image')) return <Images size={14} />
      if (toolText(item).match(/read|open|file/)) return <BookOpen size={14} />
      if (toolText(item).includes('search')) return <Search size={14} />
      return <Wrench size={13} />
    case 'plan':
      return <ListChecks size={13} />
    case 'error':
      return <CircleAlert size={13} />
    default:
      return <CircleQuestionMark size={13} />
  }
}

function workedBlocks(items: Item[]): WorkedBlock[] {
  const blocks: WorkedBlock[] = []
  let tools: Item[] = []
  const flushTools = () => {
    if (tools.length === 0) return
    blocks.push({
      id: `tools:${tools.map((item) => item.id).join(':')}`,
      kind: 'tools',
      items: tools,
    })
    tools = []
  }

  for (const item of items) {
    if (isNarrative(item)) {
      flushTools()
      blocks.push({ id: item.id, kind: 'narrative', item })
    } else {
      tools.push(item)
    }
  }
  flushTools()
  return blocks
}

function isNarrative(item: Item): boolean {
  return (item.type === 'message' && item.role === 'assistant') || item.type === 'reasoning'
}

function WorkedToolGroup({ items }: { items: Item[] }) {
  const [expanded, setExpanded] = useState(false)
  const lead = items.at(-1)
  if (!lead) return null

  const previous = items.slice(0, -1)
  return (
    <div className="activity__tool-group">
      {(expanded ? items : [lead]).map((item) => (
        <WorkedToolRow item={item} key={item.id} />
      ))}
      {previous.length > 0 ? (
        <button
          aria-expanded={expanded}
          className={`activity__previous-toggle${expanded ? ' is-expanded' : ''}`}
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown size={15} strokeWidth={1.8} aria-hidden />
          <span>
            {expanded
              ? 'Show fewer tool calls'
              : `+${previous.length} previous tool ${previous.length === 1 ? 'call' : 'calls'}`}
          </span>
        </button>
      ) : null}
    </div>
  )
}

function WorkedToolRow({ item }: { item: Item }) {
  const detail = workedToolDetail(item)
  const output = workedToolOutput(item)
  const row = (
    <>
      <span className="activity__tool-glyph" aria-hidden>
        {itemGlyph(item)}
      </span>
      <strong>{workedToolLabel(item)}</strong>
      {detail ? (
        <span className={`activity__tool-detail${item.type === 'command' ? ' is-command' : ''}`}>
          {detail}
        </span>
      ) : null}
      <span className="activity__tool-spacer" />
      {item.exitCode !== undefined && item.exitCode !== 0 ? (
        <span className="aux__code">exit {item.exitCode}</span>
      ) : null}
      {output ? <ChevronDown className="activity__tool-chevron" aria-hidden /> : null}
      {item.status === 'completed' ? (
        <Check className="activity__tool-status" aria-hidden />
      ) : item.status === 'failed' ? (
        <CircleAlert className="activity__tool-status is-failed" aria-hidden />
      ) : (
        <LoaderCircle className="activity__tool-status spinner" aria-hidden />
      )}
    </>
  )

  return output ? (
    <details className="activity__tool-row">
      <summary>{row}</summary>
      <pre>{output}</pre>
    </details>
  ) : (
    <div className="activity__tool-row">
      <div>{row}</div>
    </div>
  )
}

function workedToolLabel(item: Item): string {
  const ongoing = item.status === 'started'
  const text = toolText(item)
  switch (item.type) {
    case 'command':
      return ongoing ? 'Running command' : 'Ran command'
    case 'file_change':
      return 'File Change'
    case 'plan':
      return ongoing ? 'Updating plan' : 'Updated plan'
    case 'error':
      return 'Error'
    case 'tool_call':
      if (text.includes('image')) return ongoing ? 'Viewing image' : 'Viewed image'
      if (text.match(/read|open|file/)) return ongoing ? 'Reading files' : 'Read files'
      if (text.match(/search|find/)) return ongoing ? 'Searching' : 'Searched'
      return ongoing ? 'Using tool' : 'Used tool'
    default:
      return ongoing ? 'Using tool' : 'Used tool'
  }
}

function workedToolDetail(item: Item): string | undefined {
  switch (item.type) {
    case 'command':
      return item.command
    case 'file_change':
      return item.path ?? firstLine(item.text)
    default:
      return firstLine(item.text)
  }
}

function workedToolOutput(item: Item): string | undefined {
  if (item.type === 'command' || item.type === 'error' || item.type === 'unknown') {
    return cleanText(item.text)
  }
  if (item.type === 'file_change') {
    return cleanText(item.text) ?? cleanText(item.path)
  }
  if (item.type !== 'tool_call') return undefined
  const lines = item.text?.split('\n') ?? []
  return lines.length > 1 ? cleanText(lines.slice(1).join('\n')) : undefined
}

function toolText(item: Item): string {
  return `${item.text ?? ''} ${item.command ?? ''}`.toLowerCase()
}

function firstLine(value: string | undefined): string | undefined {
  return cleanText(value?.split('\n')[0])
}

function cleanText(value: string | undefined): string | undefined {
  const clean = value?.trim()
  return clean ? clean : undefined
}
