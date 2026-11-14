/**
 * The left rail: actions, pinned chats, projects with their chats, account card.
 * Real app: apps/web/src/ui/Sidebar.tsx + styles/inbox-sidebar.css, account-card.css.
 */
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconFolder,
  IconFolderPlus,
  IconGitPullRequest,
  IconLoader2,
  IconPlus,
  IconSearch,
  IconSettings,
} from '@tabler/icons-react'
import { useState } from 'react'
import { pinned, projects, type Chat } from '../data'
import { AccountMenu } from './AccountMenu'
import { Menu } from './Menu'

type Props = { activeChat: string | null; onOpenChat: (id: string | null) => void }

export function Sidebar({ activeChat, onOpenChat }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(projects.map((p) => [p.name, Boolean(p.open)])),
  )

  return (
    <nav className="rail" aria-label="Chats">
      <div className="rail__top">
        <div className="rail__row">
          <button className="navitem" onClick={() => onOpenChat(null)}>
            <IconEdit size={16} stroke={1.75} />
            <span>New chat</span>
          </button>
          <button className="icon-btn icon-btn--sm" aria-label="Search chats">
            <IconSearch size={15} stroke={1.75} />
          </button>
        </div>
        <button className="navitem">
          <IconFolderPlus size={16} stroke={1.75} />
          <span>New project</span>
        </button>
        <button className="navitem">
          <IconGitPullRequest size={16} stroke={1.75} />
          <span>Pull requests</span>
        </button>
      </div>

      <div className="rail__scroll">
        <div className="section">Pinned</div>
        <ul className="sesslist">
          {pinned.map((chat) => (
            <SessionRow key={chat.id} chat={chat} active={activeChat === chat.id} onOpen={onOpenChat} />
          ))}
        </ul>

        <div className="section section--row">
          <span>Projects</span>
          <button className="icon-btn icon-btn--xs" aria-label="New project">
            <IconPlus size={14} stroke={1.75} />
          </button>
        </div>
        {projects.map((project) => (
          <div key={project.name} className="project">
            <button
              className="project__head"
              aria-expanded={open[project.name]}
              onClick={() => setOpen((o) => ({ ...o, [project.name]: !o[project.name] }))}
            >
              <span className="project__icon">
                <IconFolder className="project__folder" size={16} stroke={1.75} />
                {open[project.name] ? (
                  <IconChevronDown className="project__chevron" size={14} stroke={2} />
                ) : (
                  <IconChevronRight className="project__chevron" size={14} stroke={2} />
                )}
              </span>
              <span className="project__name">{project.name}</span>
            </button>
            {open[project.name] && (
              <ul className="sesslist sesslist--nested">
                {project.chats.map((chat) => (
                  <SessionRow key={chat.id} chat={chat} active={activeChat === chat.id} onOpen={onOpenChat} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="account-card">
        <Menu
          label="Profile"
          drop="up"
          triggerClassName="account-card__trigger"
          panelClassName="menu--compact menu--settings menu--account"
          trigger={() => (
            <>
              <span className="account__avatar" aria-hidden />
              <span className="account__identity">
                <span className="account__name">Local profile</span>
                <span className="account__limit">
                  <span className="limit-bar">
                    <span className="limit-bar__fill" style={{ width: '61%' }} />
                  </span>
                  <span>39% left</span>
                </span>
              </span>
            </>
          )}
        >
          {(close) => <AccountMenu close={close} />}
        </Menu>
        <button className="icon-btn account-card__settings" aria-label="Settings">
          <IconSettings size={16} stroke={1.75} />
        </button>
      </div>
    </nav>
  )
}

function SessionRow({ chat, active, onOpen }: { chat: Chat; active: boolean; onOpen: (id: string) => void }) {
  return (
    <li className={`sessrow${active ? ' is-active' : ''}`}>
      <button className="sessrow__button" onClick={() => onOpen(chat.id)}>
        {chat.status === 'running' ? (
          <IconLoader2 className="sessrow__spinner" size={14} stroke={2} />
        ) : (
          <span className="sessrow__dot" aria-hidden />
        )}
        <span className="sessrow__title">{chat.title}</span>
        <span className="sessrow__time">{chat.time}</span>
      </button>
    </li>
  )
}
