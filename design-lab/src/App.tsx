/**
 * The design lab shell: title bar, rail, stage. The pill in the title bar is
 * lab-only (switch screen, theme, font) and is not part of the app's design.
 * Real app: apps/web/src/App.tsx (.shell, .stage), ui/TitleBar.tsx, ui/StageHeader.tsx.
 */
import {
  IconDots,
  IconLayoutBottombar,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconMoon,
  IconSun,
} from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { pinned, projects } from './data'
import { NewDesign } from './pages/NewDesign'

type Theme = 'dark' | 'light'
type Font = 'system' | 'geist' | 'inter'

function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private window: the lab still works, it just forgets */
  }
}

const allChats = [...pinned, ...projects.flatMap((p) => p.chats)]

type Page = 'current' | 'new'

export function App() {
  const [page, setPage] = useState<Page>(() =>
    new URLSearchParams(location.search).get('page') === 'new' ? 'new' : 'current',
  )
  const [chat, setChat] = useState<string | null>(() => new URLSearchParams(location.search).get('chat'))
  const [theme, setTheme] = useState<Theme>(() => stored('lab.theme', 'dark'))
  const [font, setFont] = useState<Font>(() => stored('lab.font', 'system'))
  const [railOpen, setRailOpen] = useState(true)

  // A layout effect so the stored theme is set before the first paint (no flash).
  useLayoutEffect(() => {
    document.documentElement.dataset['theme'] = theme
    store('lab.theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset['font'] = font
    store('lab.font', font)
  }, [font])

  useEffect(() => {
    const url = new URL(location.href)
    if (page === 'new') url.searchParams.set('page', 'new')
    else url.searchParams.delete('page')
    if (page === 'current' && chat) url.searchParams.set('chat', chat)
    else url.searchParams.delete('chat')
    history.replaceState(null, '', url)
  }, [page, chat])

  const title = chat ? (allChats.find((c) => c.id === chat)?.title ?? 'Chat') : 'New chat'

  const labBar = (
    <div className="lab-bar" role="toolbar" aria-label="Design lab">
      <span className="lab-bar__label">Design lab</span>
      <div className="lab-seg">
        <button
          aria-pressed={page === 'current' && chat === null}
          onClick={() => {
            setPage('current')
            setChat(null)
          }}
        >
          New chat
        </button>
        <button
          aria-pressed={page === 'current' && chat !== null}
          onClick={() => {
            setPage('current')
            setChat(chat ?? 'focus-ring')
          }}
        >
          Chat
        </button>
        <span className="lab-seg__divider" aria-hidden />
        <button aria-pressed={page === 'new'} onClick={() => setPage('new')}>
          New design
        </button>
      </div>
      <select className="lab-select" value={font} onChange={(e) => setFont(e.target.value as Font)} aria-label="Font">
        <option value="system">System</option>
        <option value="geist">Geist</option>
        <option value="inter">Inter</option>
      </select>
      <button
        className="lab-icon"
        aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? <IconSun size={14} stroke={1.75} /> : <IconMoon size={14} stroke={1.75} />}
      </button>
    </div>
  )

  if (page === 'new')
    return (
      <>
        <NewDesign />
        <div className="lab-float lab-float--bottom">{labBar}</div>
      </>
    )

  return (
    <div className={`shell${railOpen ? '' : ' is-rail-closed'}`}>
      <header className="titlebar">
        <button className="icon-btn" aria-label="Toggle sidebar" onClick={() => setRailOpen((o) => !o)}>
          <IconLayoutSidebar size={16} stroke={1.75} />
        </button>
        {labBar}
      </header>

      {railOpen && <Sidebar activeChat={chat} onOpenChat={setChat} />}

      <main className="stage">
        <header className="stagehead">
          <span className="stagehead__title">{title}</span>
          <button className="icon-btn icon-btn--sm" aria-label="Chat actions">
            <IconDots size={15} stroke={1.75} />
          </button>
          <div className="stagehead__actions">
            <button className="icon-btn icon-btn--sm" aria-label="Terminal">
              <IconLayoutBottombar size={16} stroke={1.75} />
            </button>
            <button className="icon-btn icon-btn--sm" aria-label="Workspace panel">
              <IconLayoutSidebarRight size={16} stroke={1.75} />
            </button>
          </div>
        </header>

        {chat === null ? (
          <div className="empty">
            <h1 className="empty__title">
              What should we build in <span className="empty__project">tastecode</span>?
            </h1>
            <Composer variant="new" />
          </div>
        ) : (
          <div className="chat">
            <Thread />
            <Composer variant="docked" />
          </div>
        )}
      </main>
    </div>
  )
}
