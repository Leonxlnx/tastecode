import type { ProviderId } from '@harness/contracts'
import {
  IconArrowUp as ArrowUp,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconChevronUp as ChevronUp,
  IconDots as Dots,
  IconEdit as SquarePen,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconFolderPlus as FolderPlus,
  IconGitPullRequest as GitPullRequest,
  IconLayoutBottombar as PanelBottom,
  IconLayoutSidebarLeftCollapse as PanelLeftClose,
  IconLayoutSidebarRight as PanelRight,
  IconPalette as Palette,
  IconPencil as Pencil,
  IconPlus as Plus,
  IconSearch as Search,
} from '@tabler/icons-react'
import { type CSSProperties, Fragment } from 'react'
import { providerMark } from '../model-catalog.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { ProviderIcon } from './ProviderIcon.js'

export type PreviewHint = 'profile' | 'model'
export type PreviewAgent = { id: ProviderId; name: string; arriving?: boolean }

const ANSWER =
  'Done. The toggle sits in Settings › Appearance and follows the system until someone picks a side.'

const DIFF = [
  { kind: 'removed', code: "const theme = 'dark'" },
  { kind: 'added', code: 'const [theme, setTheme] = useThemePreference()' },
  { kind: 'added', code: '<Segmented value={theme} onChange={setTheme}>' },
  { kind: 'added', code: '  <Option value="system">System</Option>' },
] as const

/**
 * The app, drawn at a third of its size, in the middle of a real piece of
 * work. It is built from the live theme tokens (or one pinned scheme, for the
 * theme cards) and from what setup has learned so far: the name in the
 * profile row, the detected agents in the model picker. The first time it
 * appears the conversation plays out once, the way a turn actually streams.
 *
 * Parts the real app also has carry `data-morph`, naming their counterpart,
 * so setup can end by moving each one to where it really lives.
 */
export function OnboardingPreview(props: {
  name: string
  agents: ReadonlyArray<PreviewAgent>
  hint?: PreviewHint | undefined
  /** Pins one scheme's greys instead of following the live theme. */
  scheme?: 'light' | 'dark' | undefined
  /** A thumbnail: everything in place from the first frame, nothing plays. */
  still?: boolean | undefined
  /**
   * A row opening at the top of the project list for the folder about to be
   * chosen; `ready` while the pointer is on the button that chooses it.
   */
  newProject?: 'open' | 'ready' | undefined
}) {
  const name = props.name.trim() || 'Local profile'
  const lead = props.agents.find((agent) => !agent.arriving)
  const hint = (part: PreviewHint) => (props.hint === part ? '' : undefined)

  return (
    <span
      className="preview"
      data-scheme={props.scheme}
      data-still={props.still || undefined}
      aria-hidden
    >
      <span className="preview__window" data-morph="window">
        <span className="preview__rail" data-morph="rail">
          <span className="preview__rail-top">
            <span className="preview__icon" data-morph="sidebar-toggle">
              <PanelLeftClose />
            </span>
            <span className="preview__icon" data-morph="search">
              <Search />
            </span>
          </span>
          <span className="preview__nav" data-morph="new-chat">
            <SquarePen />
            New chat
          </span>
          <span className="preview__nav" data-morph="new-project">
            <FolderPlus />
            New project
          </span>
          <span className="preview__nav" data-morph="pull-requests">
            <GitPullRequest />
            Pull requests
          </span>
          <span className="preview__group">
            Projects
            <span className="preview__icon" data-morph="add-project">
              <Plus />
            </span>
          </span>
          <span className="preview__incoming" data-state={props.newProject}>
            <span className="preview__incoming-row">
              <span
                className="preview__project preview__project--new"
                data-morph={props.newProject ? 'project' : undefined}
              >
                {props.newProject === 'ready' ? <FolderOpen /> : <Folder />}
                Your project
              </span>
            </span>
          </span>
          <span className="preview__project">
            <Folder />
            my-app
          </span>
          <span className="preview__chat is-active">
            <span>Add a theme toggle</span>
          </span>
          <span className="preview__chat">
            <span>Fix the flaky upload test</span>
            <time>2h</time>
          </span>
          <span className="preview__chat">
            <span>Bump dependencies</span>
            <time>1d</time>
          </span>
          <span className="preview__project">
            <Folder />
            api-server
          </span>
          <span
            className="preview__profile"
            data-hint={hint('profile')}
            data-land="profile"
            data-morph="profile"
          >
            <span className="preview__avatar" data-land="avatar">
              <GeneratedAvatar name={name} />
            </span>
            <span className="preview__profile-name" data-land="name">
              {name}
            </span>
            <span className="preview__icon" data-morph="account-menu">
              <ChevronUp />
            </span>
          </span>
        </span>

        <span className="preview__main">
          <span className="preview__topbar" data-morph="topbar">
            <span className="preview__title">Add a theme toggle</span>
            <Dots />
            <span className="preview__spacer" />
            <span className="preview__icon" data-morph="bottom-panel">
              <PanelBottom />
            </span>
            <span className="preview__icon" data-morph="side-panel">
              <PanelRight />
            </span>
          </span>

          <span className="preview__thread">
            <span className="preview__answer preview__answer--earlier">
              All 214 tests pass. The upload retry now waits for the socket to close before it opens
              a new one.
            </span>
            <span className="preview__said">
              Add a light and dark toggle to Settings. It should follow the system until someone
              picks one.
            </span>
            <span className="preview__activity preview__activity--first">
              <span className="preview__activity-icon">
                <span className="preview__spinner" />
                <Search />
              </span>
              Explored 3 files
              <ChevronRight />
            </span>
            <span className="preview__activity preview__activity--second">
              <span className="preview__activity-icon">
                <span className="preview__spinner" />
                <Pencil />
              </span>
              Edited Appearance.tsx
              <span className="preview__stat">
                <ins>+18</ins>
                <del>−2</del>
              </span>
            </span>
            <span className="preview__diff">
              {DIFF.map((line, index) => (
                <span
                  className={`preview__diff-line is-${line.kind}`}
                  key={index}
                  style={{ '--line': index } as CSSProperties}
                >
                  <b>{line.kind === 'added' ? '+' : '−'}</b>
                  <code>{line.code}</code>
                </span>
              ))}
            </span>
            <span className="preview__answer">
              {ANSWER.split(' ').map((word, index) => (
                <Fragment key={index}>
                  {index > 0 ? ' ' : null}
                  <span style={{ '--word': index } as CSSProperties}>{word}</span>
                </Fragment>
              ))}
            </span>
          </span>

          <span className="preview__composer" data-morph="composer">
            <span className="preview__prompt">
              <span className="preview__caret" />
              Ask for follow-up changes
            </span>
            <span className="preview__tools">
              <span className="preview__tool">
                <Plus />
              </span>
              <span className="preview__tool preview__tool--text">
                <Palette />
                Design
              </span>
              <span className="preview__spacer" />
              <span
                className="preview__model"
                data-hint={hint('model')}
                data-land="model"
                data-morph="model"
              >
                <span className="preview__marks">
                  {props.agents.length > 0 ? (
                    props.agents.map((agent) => (
                      <span
                        className="preview__mark"
                        data-arriving={agent.arriving || undefined}
                        data-land={`agent-${agent.id}`}
                        key={agent.id}
                      >
                        <ProviderIcon mark={providerMark(agent.id)} />
                      </span>
                    ))
                  ) : (
                    <span className="preview__socket" />
                  )}
                </span>
                <span className={lead ? undefined : 'preview__muted'}>
                  {lead?.name ?? 'Choose model'}
                </span>
                <ChevronDown />
              </span>
              <span className="preview__orb" data-morph="send">
                <ArrowUp />
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}
