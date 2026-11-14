/**
 * The prompt bar. On a new chat it carries the project shelf (project,
 * workspace mode, branch) on top; inside a chat it docks to the bottom
 * without it. Every dropdown opens a real menu with the app's options, so
 * each one can be redesigned.
 * Real app: apps/web/src/ui/Composer.tsx, ModelSelector.tsx,
 * approval-modes.ts; styles in app.css (.composer*, .menu*),
 * composer-provider-shelf.css, model-selector-menu.css, context-usage.css.
 */
import {
  IconArrowUp,
  IconAsterisk,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconDeviceLaptop,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconHexagon,
  IconLockOpen,
  IconPalette,
  IconPlus,
  IconScanEye,
  IconSearch,
  IconShieldCheck,
  IconShieldQuestion,
  type Icon,
} from '@tabler/icons-react'
import { useState, type CSSProperties } from 'react'
import { Menu, MenuItem, MenuRule } from './Menu'

/* Options, as the app's design sandbox serves them. */

const PROJECTS = [
  { name: 'tastecode', path: 'C:\\Users\\demo\\code\\tastecode' },
  { name: 'design-system', path: 'C:\\Users\\demo\\code\\design-system' },
  { name: 'website', path: 'C:\\Users\\demo\\code\\website' },
]

const BRANCHES = ['main', 'dev', 'feat/prompt-bar-polish', 'fix/sidebar-spacing']

const PERMISSIONS: { id: string; title: string; short: string; detail: string; icon: Icon }[] = [
  { id: 'ask', title: 'Ask first', short: 'Ask first', detail: 'Approve each edit and command', icon: IconShieldQuestion },
  { id: 'auto', title: 'Auto-approve', short: 'Auto', detail: 'Edits and commands in this folder', icon: IconShieldCheck },
  { id: 'auto-review', title: 'Auto-review', short: 'Auto-review', detail: 'A reviewer checks elevated actions', icon: IconScanEye },
  { id: 'full', title: 'Full access', short: 'Full access', detail: 'No sandbox or prompts', icon: IconLockOpen },
]

/* The app shows each provider's brand mark; these are neutral stand-ins. */
const PROVIDERS: { name: string; mark: Icon; models: { id: string; name: string }[] }[] = [
  {
    name: 'Claude Code',
    mark: IconAsterisk,
    models: [
      { id: 'fable-5.1', name: 'Fable 5.1' },
      { id: 'opus-5.5', name: 'Opus 5.5' },
      { id: 'sonnet-5.5', name: 'Sonnet 5.5' },
      { id: 'haiku-5.5', name: 'Haiku 5.5' },
    ],
  },
  {
    name: 'Codex',
    mark: IconHexagon,
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    ],
  },
  { name: 'Grok', mark: IconBolt, models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] },
]

const EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max']

export function Composer({ variant }: { variant: 'new' | 'docked' }) {
  const [text, setText] = useState('')
  const [project, setProject] = useState('tastecode')
  const [isolated, setIsolated] = useState(false)
  const [branch, setBranch] = useState('feat/prompt-bar-polish')
  const [permission, setPermission] = useState(variant === 'new' ? 'auto-review' : 'auto')
  const [design, setDesign] = useState(false)
  const [model, setModel] = useState('opus-5.5')
  const [effort, setEffort] = useState(2)

  const perm = PERMISSIONS.find((p) => p.id === permission)!
  const provider = PROVIDERS.find((p) => p.models.some((m) => m.id === model))!
  const modelName = provider.models.find((m) => m.id === model)!.name

  return (
    <div className={`composer composer--${variant}`}>
      <div className="composer__box">
        {variant === 'new' && (
          <div className="composer__shelf">
            <Menu
              label="Choose project"
              drop="down"
              triggerClassName="shelf-control"
              panelClassName="menu--compact menu--project-picker"
              trigger={() => (
                <>
                  <IconFolder size={14} stroke={1.75} />
                  {project}
                </>
              )}
            >
              {(close) => (
                <>
                  {PROJECTS.map((p) => (
                    <MenuItem
                      key={p.name}
                      icon={<IconFolder size={14} stroke={1.75} aria-hidden />}
                      title={p.name}
                      detail={p.path}
                      checked={p.name === project}
                      onClick={() => {
                        setProject(p.name)
                        close()
                      }}
                    />
                  ))}
                  <MenuItem icon={<IconFolderPlus size={14} stroke={1.75} aria-hidden />} title="New project" onClick={close} />
                </>
              )}
            </Menu>

            <Menu
              label="Workspace mode"
              drop="down"
              triggerClassName="shelf-control"
              panelClassName="menu--compact menu--mode"
              trigger={() => (
                <>
                  {isolated ? <IconGitBranch size={14} stroke={1.75} /> : <IconDeviceLaptop size={14} stroke={1.75} />}
                  {isolated ? 'Isolated' : 'Local'}
                </>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<IconDeviceLaptop size={14} stroke={1.75} aria-hidden />}
                    title="Local"
                    checked={!isolated}
                    onClick={() => {
                      setIsolated(false)
                      close()
                    }}
                  />
                  <MenuItem
                    icon={<IconGitBranch size={14} stroke={1.75} aria-hidden />}
                    title="Isolated"
                    checked={isolated}
                    onClick={() => {
                      setIsolated(true)
                      close()
                    }}
                  />
                </>
              )}
            </Menu>

            <Menu
              label="Choose branch"
              drop="down"
              triggerClassName="shelf-control"
              panelClassName="branch-menu"
              trigger={() => (
                <>
                  <IconGitBranch size={14} stroke={1.75} />
                  {branch}
                </>
              )}
            >
              {(close) => (
                <BranchMenu
                  active={branch}
                  onSelect={(b) => {
                    setBranch(b)
                    close()
                  }}
                />
              )}
            </Menu>
          </div>
        )}
        <div className="composer__prompt">
          <textarea
            className="composer__field"
            placeholder="Do anything"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="composer__bar">
            <div className="composer__left">
              {/* In the app this opens the system file picker; it has no menu. */}
              <button className="chip chip--icon" aria-label="Attach files">
                <IconPlus size={16} stroke={1.75} />
              </button>

              <Menu
                label="Permissions"
                drop="up"
                triggerClassName={`chip${permission === 'auto-review' ? ' chip--review' : ''}${permission === 'full' ? ' chip--danger' : ''}`}
                panelClassName="menu--compact menu--permissions"
                trigger={() => (
                  <>
                    <perm.icon size={14} stroke={1.75} />
                    {perm.short}
                  </>
                )}
              >
                {(close) =>
                  PERMISSIONS.map((p) => (
                    <MenuItem
                      key={p.id}
                      className={`composer__permission-option--${p.id}`}
                      icon={<p.icon size={14} stroke={1.75} aria-hidden />}
                      title={p.title}
                      detail={p.detail}
                      checked={p.id === permission}
                      onClick={() => {
                        setPermission(p.id)
                        close()
                      }}
                    />
                  ))
                }
              </Menu>

              <button className={`chip${design ? ' is-on' : ''}`} aria-pressed={design} onClick={() => setDesign((d) => !d)}>
                <IconPalette size={14} stroke={1.75} />
                Design
              </button>
            </div>
            <div className="composer__right">
              {variant === 'docked' && <ContextRing percent={23} />}
              <Menu
                label="Model and reasoning"
                drop="up"
                align="end"
                triggerClassName="chip chip--model"
                panelClassName="model-selector__menu"
                trigger={(open) => (
                  <>
                    <provider.mark size={13} stroke={2} />
                    <span className="chip__model">{modelName}</span>
                    <span className="chip__effort">{EFFORTS[effort]}</span>
                    <IconChevronDown size={13} stroke={2} className={open ? 'is-flipped' : undefined} />
                  </>
                )}
              >
                {() => (
                  <ModelPicker model={model} onModel={setModel} effort={effort} onEffort={setEffort} />
                )}
              </Menu>
              <button className={`orb${text.trim() ? ' is-ready' : ''}`} aria-label="Send">
                <IconArrowUp size={16} stroke={2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The branch menu: a search field, then the branches (main first). */
function BranchMenu({ active, onSelect }: { active: string; onSelect: (branch: string) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? BRANCHES.filter((b) => b.toLowerCase().includes(q)) : BRANCHES
  return (
    <>
      <label className="model-search branch-menu__search">
        <IconSearch size={15} stroke={1.75} />
        <input autoFocus placeholder="Search branches" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="branch-menu__results">
        {shown.length > 0 ? (
          shown.map((b) => (
            <MenuItem
              key={b}
              icon={<IconGitBranch size={14} stroke={1.75} aria-hidden />}
              title={b}
              checked={b === active}
              onClick={() => onSelect(b)}
            />
          ))
        ) : (
          <p className="branch-menu__empty" role="status">
            No matching branches.
          </p>
        )}
      </div>
    </>
  )
}

/** The model picker panel: search, models grouped by provider, then effort. */
function ModelPicker(props: {
  model: string
  onModel: (id: string) => void
  effort: number
  onEffort: (index: number) => void
}) {
  const [query, setQuery] = useState('')
  const groups = PROVIDERS.map((p) => ({
    ...p,
    models: p.models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())),
  })).filter((p) => p.models.length > 0)

  return (
    <div className="model-selector">
      <div className="model-selector__models">
        <div className="model-selector__flat-head">
          <label className="model-search model-selector__search">
            <IconSearch size={13} stroke={1.75} />
            <input autoFocus placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        {groups.map((g) => (
          <div key={g.name} className="model-selector__group">
            <div className="model-selector__group-title">
              <g.mark size={12} stroke={2} />
              {g.name}
            </div>
            {g.models.map((m) => (
              <button
                key={m.id}
                className={`model-selector__model${m.id === props.model ? ' is-selected' : ''}`}
                role="menuitemradio"
                aria-checked={m.id === props.model}
                onClick={() => props.onModel(m.id)}
              >
                <span className="model-selector__model-name">{m.name}</span>
                {m.id === props.model && <IconCheck size={13} stroke={2} />}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="model-selector__empty">No models match</p>}
      </div>
      <div className="model-selector__controls">
        <div className="model-selector__controls-head">
          <span className="model-selector__effort-title">
            Effort: <span className="model-selector__effort-value">{EFFORTS[props.effort]}</span>
          </span>
        </div>
        <div
          className="model-selector__slider"
          role="slider"
          aria-label="Effort"
          aria-valuemin={0}
          aria-valuemax={EFFORTS.length - 1}
          aria-valuenow={props.effort}
          aria-valuetext={EFFORTS[props.effort]}
          style={{ '--effort-p': props.effort / (EFFORTS.length - 1) } as CSSProperties}
        >
          <div className="model-selector__slider-rail">
            <div className="model-selector__slider-clip">
              <div className="model-selector__slider-fill" />
            </div>
            {EFFORTS.map((e, i) => (
              <button
                key={e}
                className={`model-selector__slider-dot${i <= props.effort ? ' is-lit' : ''}`}
                style={{ '--effort-stop': i / (EFFORTS.length - 1) } as CSSProperties}
                aria-label={e}
                onClick={() => props.onEffort(i)}
              />
            ))}
            <div className="model-selector__slider-thumb" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ContextRing({ percent }: { percent: number }) {
  const r = 6.5
  const c = 2 * Math.PI * r
  return (
    <span className="context-usage" title={`${percent}% context used`}>
      <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
        <circle className="context-usage__track" cx="7.5" cy="7.5" r={r} />
        <circle
          className="context-usage__fill"
          cx="7.5"
          cy="7.5"
          r={r}
          strokeDasharray={`${(c * percent) / 100} ${c}`}
          transform="rotate(-90 7.5 7.5)"
        />
      </svg>
      {percent}%
    </span>
  )
}
