import type { SFSymbol } from 'sf-symbols-typescript'
import type { Item, ProviderId } from '@harness/contracts'
import type { Session } from '../state/projects'

/** "now", "4m", "2h", "Tue", "12 Oct": short enough for a list row's trailing edge. */
export function shortTime(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const date = new Date(at)
  if (hours < 24 * 6) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const PROVIDER_NAMES = new Map<ProviderId, string>([
  ['codex', 'Codex'],
  ['claude-code', 'Claude Code'],
  ['grok', 'Grok'],
  ['cursor', 'Cursor'],
  ['opencode', 'OpenCode'],
  ['antigravity', 'Antigravity'],
  ['pi', 'Pi'],
  ['acp', 'Agent'],
  ['api', 'API'],
])

export function providerName(provider: ProviderId): string {
  return PROVIDER_NAMES.get(provider) ?? provider
}

/** What a chat row says under its title while something is going on. */
export function sessionState(
  session: Session,
): { text: string; tone: 'attention' | 'working' | 'failed' } | undefined {
  switch (session.status) {
    case 'approval':
      return { text: 'Needs your approval', tone: 'attention' }
    case 'input':
      return { text: 'Has a question for you', tone: 'attention' }
    case 'failed':
      return { text: 'Stopped with an error', tone: 'failed' }
    case 'starting':
      return { text: 'Starting…', tone: 'working' }
    case 'working':
      return { text: 'Working…', tone: 'working' }
    case 'queued':
      return { text: 'Working, more queued', tone: 'working' }
    default:
      return session.running ? { text: 'Working…', tone: 'working' } : undefined
  }
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export type StepTitle = { symbol: SFSymbol; text: string }

/** One line for a step the agent took: the command it ran, the file it changed, the tool it used. */
export function stepTitle(item: Item): StepTitle {
  switch (item.type) {
    case 'command':
      return { symbol: 'terminal', text: firstLine(item.command ?? item.text ?? 'Command') }
    case 'file_change': {
      const added = item.linesAdded ? ` +${item.linesAdded}` : ''
      const removed = item.linesRemoved ? ` −${item.linesRemoved}` : ''
      return {
        symbol: 'pencil.line',
        text: `${item.path ? basename(item.path) : 'File'}${added}${removed}`,
      }
    }
    case 'tool_call':
      if (item.subagent) {
        return {
          symbol: 'person.2',
          text: item.subagent.name ?? item.subagent.description ?? 'Subagent',
        }
      }
      return { symbol: 'wrench.and.screwdriver', text: firstLine(item.text ?? 'Tool') }
    case 'reasoning':
      return { symbol: 'brain', text: 'Thinking' }
    case 'plan':
      return { symbol: 'list.bullet', text: 'Plan' }
    default:
      return { symbol: 'questionmark.circle', text: firstLine(item.text ?? item.type) }
  }
}

export function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
