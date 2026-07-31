import type { ResultOf, Usage } from '@harness/contracts'
import { ChevronDown, Folder, GitBranch, History } from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import type { Project } from './Sidebar.js'
import { Menu, MenuItem } from './Menu.js'
import { ShortcutHint } from './ShortcutHint.js'

/**
 * Header above the thread: which project this session belongs to, and the
 * switcher for moving between them. It sits at the top because "where am I
 * working" must never require a glance elsewhere.
 */
export function StageHeader(props: {
  projects: Project[]
  activePath: string | undefined
  title: string | undefined
  usage: Usage | undefined
  usageSummary: ResultOf<'usage.summary'> | undefined
  checkpointCount: number
  worktreeBranch: string | undefined
  onSelectProject: (path: string) => void
  onOpenRollback: () => void
}) {
  const switchProjectShortcut = shortcutLabel(SHORTCUTS.switchProject, isMacOS())

  return (
    <header className="stagehead">
      <Menu
        label="Project"
        drop="down"
        disabled={props.projects.length === 0}
        shortcutAria={shortcutAria(SHORTCUTS.switchProject)}
        trigger={() => (
          <span className="picker">
            <span>{props.activePath ? basename(props.activePath) : 'No project'}</span>
            <ShortcutHint>{switchProjectShortcut}</ShortcutHint>
            <ChevronDown size={11} aria-hidden />
          </span>
        )}
      >
        {(close) => (
          <>
            {props.projects.map((project) => (
              <MenuItem
                key={project.path}
                icon={Folder}
                title={basename(project.path)}
                detail={project.path}
                active={project.path === props.activePath}
                onClick={() => {
                  props.onSelectProject(project.path)
                  close()
                }}
              />
            ))}
          </>
        )}
      </Menu>

      {props.title ? <span className="stagehead__title">{props.title}</span> : null}

      <div className="stagehead__tools">
        {props.worktreeBranch ? (
          <span className="worktree-branch" title="Isolated checkout">
            <GitBranch size={12} aria-hidden />
            {props.worktreeBranch}
          </span>
        ) : null}
        {props.checkpointCount > 0 ? (
          <button className="ghost rollback-trigger" onClick={props.onOpenRollback}>
            <History size={12} aria-hidden />
            {props.checkpointCount} checkpoint{props.checkpointCount === 1 ? '' : 's'}
          </button>
        ) : null}
        {props.usageSummary ? (
          <span className="usage" title={summaryTitle(props.usageSummary)}>
            {summaryText(props.usageSummary)}
          </span>
        ) : props.usage ? (
          <span
            className="usage"
            title={`${props.usage.inputTokens.toLocaleString()} in · ${props.usage.cachedInputTokens.toLocaleString()} cached · ${props.usage.outputTokens.toLocaleString()} out · ${props.usage.reasoningTokens.toLocaleString()} reasoning`}
          >
            {compact(props.usage.totalTokens)}
            {props.usage.contextWindow ? ` / ${compact(props.usage.contextWindow)}` : ' tokens'}
          </span>
        ) : null}
      </div>
    </header>
  )
}

/** Token counts get long fast; the exact numbers live in the tooltip. */
function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value / 100_000) / 10}M`
}

function summaryText(summary: ResultOf<'usage.summary'>): string {
  const cost = summary.session.costUsd
  const totals =
    cost === undefined
      ? `${compact(summary.session.totalTokens)} session · ${compact(summary.today.totalTokens)} today`
      : `${money(cost)} session · ${money(summary.today.costUsd ?? 0)} today`
  const limit = summary.limits[0]
  return limit
    ? `${totals} · ${Math.round(100 - limit.usedPercent)}% left (${limit.label})`
    : totals
}

function summaryTitle(summary: ResultOf<'usage.summary'>): string {
  const totals = `${summary.session.totalTokens.toLocaleString()} session tokens · ${summary.today.totalTokens.toLocaleString()} today`
  const limits = summary.limits.map(
    (limit) => `${limit.label}: ${Math.round(100 - limit.usedPercent)}% left`,
  )
  return [totals, ...limits].join(' · ')
}

function money(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
