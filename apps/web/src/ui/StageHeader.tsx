import { memo, useEffect, useRef, useState } from 'react'
import {
  IconArchive as Archive,
  IconCommand as Command,
  IconDots as Ellipsis,
  IconFolderOpen as FolderOpen,
  IconGitBranch as GitBranch,
  IconGitPullRequest as GitPullRequest,
  IconHistory as History,
  IconKeyboard as Keyboard,
  IconLayoutSidebar as PanelLeft,
  IconLayoutBottombar as PanelBottom,
  IconLayoutSidebarRightCollapse as PanelRightClose,
  IconLayoutSidebarRightExpand as PanelRightOpen,
  IconPencil as Pencil,
  IconPinned as Pin,
  IconPinnedOff as PinOff,
  IconSearch as Search,
  IconSettings as Settings,
  IconEdit as SquarePen,
  IconTerminal2 as SquareTerminal,
} from '@tabler/icons-react'
import { isDesktop, revealPath } from '../bridge.js'
import {
  DEFAULT_KEYBINDINGS,
  shortcutAria,
  type KeybindingId,
  type Keybindings,
} from '../shortcuts.js'
import { IconMorph } from './IconMorph.js'
import { Menu, MenuItem } from './Menu.js'

type StageHeaderMenuActions = Pick<
  Record<KeybindingId, () => void>,
  | 'commandPalette'
  | 'keybindings'
  | 'newChat'
  | 'openPullRequests'
  | 'searchSessions'
  | 'settings'
  | 'toggleSidebar'
  | 'toggleTerminal'
  | 'toggleWorkspace'
>

export const PanelToggles = memo(function PanelToggles(props: {
  projectPath: string | undefined
  terminalOpen: boolean
  workspacePanelOpen: boolean
  terminalShortcutActive?: boolean | undefined
  keybindings?: Keybindings | undefined
  onPrepareTerminal?: (() => void) | undefined
  onPrepareWorkspace?: (() => void) | undefined
  onToggleWorkspace: () => void
  onToggleTerminal: () => void
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS

  return (
    <div
      className={`panel-toggles${props.workspacePanelOpen ? ' is-workspace-open' : ''}`}
      aria-label="Panel controls"
    >
      {props.projectPath ? (
        <button
          type="button"
          className={`stagehead__action${props.terminalOpen ? ' is-open' : ''}`}
          aria-label={props.terminalOpen ? 'Hide bottom panel' : 'Show bottom panel'}
          aria-pressed={props.terminalOpen}
          aria-keyshortcuts={
            props.terminalShortcutActive === false
              ? undefined
              : shortcutAria(keybindings.toggleTerminal)
          }
          title={props.terminalOpen ? 'Hide bottom panel' : 'Show bottom panel'}
          onPointerEnter={props.onPrepareTerminal}
          onFocus={props.onPrepareTerminal}
          onClick={props.onToggleTerminal}
        >
          <PanelBottom size={16} aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        className={`stagehead__action panel-toggles__workspace${props.workspacePanelOpen ? ' is-open' : ''}`}
        aria-label={props.workspacePanelOpen ? 'Hide workspace tools' : 'Show workspace tools'}
        aria-pressed={props.workspacePanelOpen}
        aria-keyshortcuts={shortcutAria(keybindings.toggleWorkspace)}
        title={props.workspacePanelOpen ? 'Hide workspace tools' : 'Show workspace tools'}
        onPointerEnter={props.onPrepareWorkspace}
        onFocus={props.onPrepareWorkspace}
        onClick={props.onToggleWorkspace}
      >
        <IconMorph active={props.workspacePanelOpen ? 1 : 0}>
          <PanelRightOpen size={16} aria-hidden />
          <PanelRightClose size={16} aria-hidden />
        </IconMorph>
      </button>
    </div>
  )
})

function closeThenRun(close: () => void, action: () => void) {
  close()
  action()
}

/** Chat identity and direct workspace actions above the thread. */
function StageHeaderComponent(props: {
  sessionId: string | undefined
  title: string | undefined
  pinned: boolean
  projectPath: string | undefined
  checkpointCount: number
  worktreeBranch: string | undefined
  keybindings?: Keybindings | undefined
  menuActions: StageHeaderMenuActions
  onOpenRollback: () => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin: (id: string) => void
  onArchiveSession: (id: string) => void
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(props.title ?? '')
  const renameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!renaming) setDraft(props.title ?? '')
  }, [props.title, renaming])

  useEffect(() => {
    if (renaming) renameInput.current?.select()
  }, [renaming])

  const commitRename = () => {
    const title = draft.trim()
    if (title && props.sessionId) props.onRenameSession(props.sessionId, title)
    setRenaming(false)
  }

  return (
    <header className="stagehead">
      <span className="stagehead__drag-region" aria-hidden />
      <div className="stagehead__identity">
        {renaming ? (
          <input
            ref={renameInput}
            className="stagehead__rename rename--chat"
            value={draft}
            aria-label="Rename chat"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="stagehead__title" title={props.title ?? 'New chat'}>
            {props.title ?? 'New chat'}
          </span>
        )}

        <Menu
          drop="down"
          align="left"
          label={`Options for ${props.title ?? 'New chat'}`}
          triggerClassName="stagehead__menu-trigger"
          panelClassName="menu--compact stagehead__options-menu"
          trigger={() => <Ellipsis size={16} aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                title="Toggle sidebar"
                shortcutAria={shortcutAria(keybindings.toggleSidebar)}
                icon={<PanelLeft size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.toggleSidebar)}
              />
              <MenuItem
                title="Toggle terminal"
                detail={props.projectPath ? undefined : 'Select a project first'}
                shortcutAria={shortcutAria(keybindings.toggleTerminal)}
                icon={<SquareTerminal size={14} aria-hidden />}
                disabled={!props.projectPath}
                onClick={() => closeThenRun(close, props.menuActions.toggleTerminal)}
              />
              <MenuItem
                title="Toggle workspace tools"
                detail={props.projectPath ? undefined : 'Select a project first'}
                shortcutAria={shortcutAria(keybindings.toggleWorkspace)}
                icon={<PanelRightOpen size={14} aria-hidden />}
                disabled={!props.projectPath}
                onClick={() => closeThenRun(close, props.menuActions.toggleWorkspace)}
              />

              <div className="menu__rule" role="separator" />

              <MenuItem
                title="New chat"
                shortcutAria={shortcutAria(keybindings.newChat)}
                icon={<SquarePen size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.newChat)}
              />
              <MenuItem
                title="Search chats"
                shortcutAria={shortcutAria(keybindings.searchSessions)}
                icon={<Search size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.searchSessions)}
              />
              <MenuItem
                title="Command palette"
                shortcutAria={shortcutAria(keybindings.commandPalette)}
                icon={<Command size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.commandPalette)}
              />
              <MenuItem
                title="Pull requests"
                shortcutAria={shortcutAria(keybindings.openPullRequests)}
                icon={<GitPullRequest size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.openPullRequests)}
              />

              <div className="menu__rule" role="separator" />

              <MenuItem
                title="Settings"
                shortcutAria={shortcutAria(keybindings.settings)}
                icon={<Settings size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.settings)}
              />
              <MenuItem
                title="Keyboard shortcuts"
                shortcutAria={shortcutAria(keybindings.keybindings)}
                icon={<Keyboard size={14} aria-hidden />}
                onClick={() => closeThenRun(close, props.menuActions.keybindings)}
              />

              {props.sessionId ? (
                <>
                  <div className="menu__rule" role="separator" />

                  <MenuItem
                    title={props.pinned ? 'Unpin chat' : 'Pin chat'}
                    shortcutAria={shortcutAria(keybindings.toggleSessionPin)}
                    icon={
                      props.pinned ? (
                        <PinOff size={14} aria-hidden />
                      ) : (
                        <Pin size={14} aria-hidden />
                      )
                    }
                    onClick={() => {
                      props.onToggleSessionPin(props.sessionId!)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Rename chat"
                    icon={<Pencil size={14} aria-hidden />}
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Archive chat"
                    shortcutAria={shortcutAria(keybindings.archiveSession)}
                    icon={<Archive size={14} aria-hidden />}
                    onClick={() => {
                      props.onArchiveSession(props.sessionId!)
                      close()
                    }}
                  />
                  {isDesktop && props.projectPath ? (
                    <MenuItem
                      title="Open in Explorer"
                      icon={<FolderOpen size={14} aria-hidden />}
                      onClick={() => {
                        void revealPath(props.projectPath!)
                        close()
                      }}
                    />
                  ) : null}
                  {props.checkpointCount > 0 ? (
                    <MenuItem
                      title={`Checkpoint history (${props.checkpointCount})`}
                      shortcutAria={shortcutAria(keybindings.rollback)}
                      icon={<History size={14} aria-hidden />}
                      onClick={() => {
                        props.onOpenRollback()
                        close()
                      }}
                    />
                  ) : null}
                  {props.worktreeBranch ? (
                    <MenuItem
                      title="Isolated checkout"
                      detail={props.worktreeBranch}
                      icon={<GitBranch size={14} aria-hidden />}
                      disabled
                      onClick={() => {}}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </Menu>
      </div>
    </header>
  )
}

/** Kept out of the streamed-frame render path through stable owner callbacks. */
export const StageHeader = memo(StageHeaderComponent)
