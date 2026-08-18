import { memo, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Ellipsis,
  FolderOpen,
  GitBranch,
  History,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  SquareTerminal,
} from 'lucide-react'
import { isDesktop, revealPath } from '../bridge.js'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'

/** Chat identity and direct workspace actions above the thread. */
function StageHeaderComponent(props: {
  sessionId: string | undefined
  title: string | undefined
  pinned: boolean
  projectPath: string | undefined
  checkpointCount: number
  worktreeBranch: string | undefined
  terminalOpen: boolean
  workspacePanelOpen: boolean
  keybindings?: Keybindings | undefined
  onOpenRollback: () => void
  onToggleWorkspace: () => void
  onToggleTerminal: () => void
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
      <div className="stagehead__identity">
        {renaming ? (
          <input
            ref={renameInput}
            className="stagehead__rename"
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

        {props.sessionId ? (
          <Menu
            drop="down"
            align="left"
            label={`Options for ${props.title ?? 'chat'}`}
            triggerClassName="stagehead__menu-trigger"
            panelClassName="menu--sidebar"
            trigger={() => <Ellipsis size={16} aria-hidden />}
          >
            {(close) => (
              <>
                <MenuItem
                  title={props.pinned ? 'Unpin chat' : 'Pin chat'}
                  shortcutAria={shortcutAria(keybindings.toggleSessionPin)}
                  icon={
                    props.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />
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
            )}
          </Menu>
        ) : null}
      </div>

      <div className="stagehead__tools">
        <button
          type="button"
          className="stagehead__action stagehead__action--workspace"
          aria-label={props.workspacePanelOpen ? 'Hide workspace tools' : 'Show workspace tools'}
          aria-pressed={props.workspacePanelOpen}
          aria-keyshortcuts={shortcutAria(keybindings.toggleWorkspace)}
          title="Workspace tools"
          onClick={props.onToggleWorkspace}
        >
          {props.workspacePanelOpen ? (
            <PanelRightClose size={16} aria-hidden />
          ) : (
            <PanelRightOpen size={16} aria-hidden />
          )}
        </button>
        {props.sessionId ? (
          <button
            type="button"
            className={`stagehead__action${props.terminalOpen ? ' is-open' : ''}`}
            aria-label={props.terminalOpen ? 'Close terminal' : 'Open terminal'}
            aria-pressed={props.terminalOpen}
            aria-keyshortcuts={shortcutAria(keybindings.toggleTerminal)}
            title="Terminal"
            onClick={props.onToggleTerminal}
          >
            <SquareTerminal size={16} aria-hidden />
          </button>
        ) : null}
      </div>
    </header>
  )
}

/** Kept out of the streamed-frame render path through stable owner callbacks. */
export const StageHeader = memo(StageHeaderComponent)
