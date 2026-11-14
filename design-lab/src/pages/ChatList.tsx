/**
 * The new design's chat list: Pinned, then every other chat grouped by
 * project, by date or not at all, sorted and filtered from the organize menu.
 * Each chat has a … menu (also on right-click): open in, pin, mark unread,
 * rename, fork, move to project, archive, delete.
 *
 * Motion:
 * - Opening a chat: its card fades in where it is, like the modules'.
 * - Regrouping, re-sorting and filtering morph the list: rows glide to their
 *   new places in a top-down wave, what's gone fades out where it was, and
 *   what's new fades in.
 * - Pinning and moving: the row lifts into a card, flies to its new place
 *   and settles, while the others make room.
 * - Archive and delete: the row slides out and the list closes up.
 * - Opening a project eases its height and draws its guide line down; a
 *   marker on that line follows the chat you're on.
 *
 * Styles: chat-list.css. Data: chat-examples.ts. Logic: chat-list.ts.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import '../styles/chat-list.css'
import { exampleChats, exampleProjects, type Chat, type ChatStatus } from './chat-examples'
import {
  ago,
  defaultOptions,
  inboxBucket,
  organizeChats,
  rowTime,
  type InboxBucket,
  type ListOptions,
  type SortKey,
} from './chat-list'
import { Dropdown, type MenuAnchor, type MenuEntry } from './Dropdown'
import { bezier } from './motion'
import { ChevronIcon, DotsIcon, FolderIcon, SpinnerIcon } from './NavIcons'
import { OrganizeMenu } from './OrganizeMenu'

/** Chats a project shows before "Show more". */
const PREVIEW = 5
const OPTIONS_KEY = 'lab.nd.chat-options'
const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)'

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const rowSelector = (id: string) => `[data-flip="c:${CSS.escape(id)}"]`

type OpenMenu = { id: string; anchor: MenuAnchor; token: number; fromKeys: boolean }

export function ChatList({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const [chats, setChats] = useState<Chat[]>(exampleChats)
  const [options, setOptions] = useState<ListOptions>(loadOptions)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  // The Inbox section the open chat was in when you opened it.
  const [stuck, setStuck] = useState<{ id: string; bucket: InboxBucket } | null>(null)
  const now = useNow(30_000)
  const scroller = useRef<HTMLDivElement>(null)
  const ghosts = useRef<HTMLDivElement>(null)
  const flip = useFlip(scroller)
  const morph = useMorph(scroller, ghosts)

  useEffect(() => saveOptions(options), [options])

  // The chat you're on stays listed even when a filter would hide it, and in
  // the Inbox the last chat you opened stays in its section until you open
  // another one (it then glides to where it now belongs).
  const view = useMemo(
    () => organizeChats(chats, exampleProjects, options, now, { keep: active, stick: stuck ?? undefined }),
    [chats, options, now, active, stuck],
  )

  const update = (id: string, change: (chat: Chat) => Chat) =>
    setChats((all) => all.map((chat) => (chat.id === id ? change(chat) : chat)))

  /** Regrouping, re-sorting and filtering morph the list (see useMorph). */
  const changeOptions = (next: Partial<ListOptions>) => {
    morph.capture()
    setOptions((current) => ({ ...current, ...next }))
  }

  /**
   * Opening a chat reads it (a finished or failed one is then done; one
   * waiting for approval or an answer still is).
   */
  const open = (id: string) => {
    if (id === active) return
    const chat = chats.find((c) => c.id === id)
    flip.snapshot()
    if (chat) setStuck({ id, bucket: inboxBucket(chat) })
    update(id, (c) => (c.status === 'unread' || c.status === 'failed' ? { ...c, status: 'idle' } : c))
    onSelect(id)
  }

  /** Acting on a chat (approve, retry, stop…) is activity: it moves sections and bumps its time. */
  const act = (id: string, status: ChatStatus) => {
    flip.snapshot(id)
    if (stuck?.id === id) setStuck(null)
    update(id, (chat) => ({ ...chat, status, updated: Date.now() }))
  }

  const togglePin = (id: string) => {
    flip.snapshot(id)
    update(id, (chat) => ({ ...chat, pinned: !chat.pinned }))
  }

  const toggleUnread = (id: string) => {
    flip.snapshot()
    update(id, (chat) => ({ ...chat, status: chat.status === 'unread' ? 'idle' : 'unread' }))
  }

  const fork = (chat: Chat) => {
    const copy: Chat = {
      ...chat,
      id: `${chat.id}~${Math.random().toString(36).slice(2, 7)}`,
      title: `${chat.title} (fork)`,
      created: Date.now(),
      updated: Date.now(),
      status: 'idle',
      pinned: false,
    }
    flip.snapshot()
    setChats((all) => {
      const at = all.findIndex((c) => c.id === chat.id)
      return [...all.slice(0, at + 1), copy, ...all.slice(at + 1)]
    })
    onSelect(copy.id)
  }

  /** Moves a chat to another project and opens that project so you see it land. */
  const move = (id: string, project: string) => {
    flip.snapshot(id)
    update(id, (chat) => ({ ...chat, project }))
    setClosed((c) => ({ ...c, [project]: false }))
  }

  /** Archive and delete: the row slides out first, then it's gone. */
  const remove = (id: string) => {
    if (id === active) onSelect('new-chat')
    if (reducedMotion()) setChats((all) => all.filter((chat) => chat.id !== id))
    else setLeaving((ids) => new Set(ids).add(id))
  }
  const removed = (id: string) => {
    setChats((all) => all.filter((chat) => chat.id !== id))
    setLeaving((ids) => {
      const next = new Set(ids)
      next.delete(id)
      return next
    })
  }

  const rename = (id: string, title: string | null, fromKeys: boolean) => {
    setRenaming(null)
    const clean = title?.trim()
    if (clean) update(id, (chat) => ({ ...chat, title: clean }))
    if (fromKeys)
      requestAnimationFrame(() =>
        scroller.current?.querySelector<HTMLElement>(`${rowSelector(id)} .nd-chat__btn`)?.focus(),
      )
  }

  /** What you can do about the chat's state, shown first when there's anything. */
  const actionsFor = (chat: Chat): MenuEntry[] => {
    const item = (label: string, shortcut: string, status: ChatStatus): MenuEntry => ({
      kind: 'item',
      label,
      shortcut,
      onSelect: () => act(chat.id, status),
    })
    switch (chat.status) {
      case 'approval':
        return [item('Approve', 'Y', 'running'), item('Deny', 'N', 'idle')]
      case 'input':
        return [item('Mark as answered', 'D', 'running')]
      case 'failed':
        return [item('Retry', 'T', 'running'), item('Dismiss', 'D', 'idle')]
      case 'running':
        return [item('Stop', 'S', 'idle')]
      default:
        return []
    }
  }

  const entriesFor = (chat: Chat): MenuEntry[] => [
    ...actionsFor(chat),
    ...(actionsFor(chat).length ? [{ kind: 'separator' as const }] : []),
    {
      kind: 'submenu',
      label: 'Open in',
      entries: [
        { kind: 'item', label: 'New window', onSelect: () => {} },
        { kind: 'item', label: 'Split view', onSelect: () => {} },
        { kind: 'separator' },
        { kind: 'item', label: 'Explorer', onSelect: () => {} },
        { kind: 'item', label: 'Terminal', onSelect: () => {} },
      ],
    },
    { kind: 'separator' },
    { kind: 'item', label: chat.pinned ? 'Unpin' : 'Pin', shortcut: 'P', onSelect: () => togglePin(chat.id) },
    {
      kind: 'item',
      label: chat.status === 'unread' ? 'Mark as read' : 'Mark as unread',
      shortcut: 'U',
      disabled: chat.status === 'running' || chat.status === 'approval' || chat.status === 'input',
      onSelect: () => toggleUnread(chat.id),
    },
    { kind: 'item', label: 'Rename', shortcut: 'R', onSelect: () => setRenaming(chat.id) },
    { kind: 'item', label: 'Fork', shortcut: 'F', onSelect: () => fork(chat) },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Move to project',
      entries: exampleProjects.map((project) => ({
        kind: 'item' as const,
        label: project,
        checked: project === chat.project,
        disabled: project === chat.project,
        onSelect: () => move(chat.id, project),
      })),
    },
    { kind: 'separator' },
    { kind: 'item', label: 'Archive', shortcut: 'A', onSelect: () => remove(chat.id) },
    { kind: 'item', label: 'Delete', danger: true, onSelect: () => remove(chat.id) },
  ]

  const tokens = useRef(0)
  const openMenu = (id: string, anchor: MenuAnchor, fromKeys = false) =>
    setMenu({ id, anchor, token: ++tokens.current, fromKeys })

  const row = (chat: Chat, nested = false) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      nested={nested}
      active={active === chat.id}
      time={ago(rowTime(chat, options.sort), now)}
      menuOpen={menu?.id === chat.id}
      renaming={renaming === chat.id}
      leaving={leaving.has(chat.id)}
      onOpen={open}
      onMenu={(anchor, fromKeys) => {
        if (menu?.id === chat.id && 'element' in anchor) setMenu(null)
        else openMenu(chat.id, anchor, fromKeys)
      }}
      onRename={(title, fromKeys) => rename(chat.id, title, fromKeys)}
      onRemoved={() => removed(chat.id)}
    />
  )

  const menuChat = menu ? chats.find((chat) => chat.id === menu.id) : undefined

  return (
    <div className="nd-chats-area">
    <div className="nd-chats" ref={scroller}>
      {view.pinned.length > 0 && (
        <section className="nd-sect" aria-label="Pinned">
          <div className="nd-sect__head" data-flip="s:pinned">
            <span>Pinned</span>
          </div>
          <ul className="nd-rows">{view.pinned.map((chat) => row(chat))}</ul>
        </section>
      )}

      <section className="nd-sect" aria-label="Chats">
        <div className="nd-sect__head" data-flip="s:chats">
          <span>{options.organize === 'project' ? 'Projects' : options.organize === 'inbox' ? 'Inbox' : 'Chats'}</span>
          <OrganizeMenu options={options} onChange={changeOptions} />
        </div>

        {view.groups.map((group) => {
          if (group.kind === 'project') {
            const isOpen = !closed[group.name]
            const isExpanded = Boolean(expanded[group.name])
            const first = group.chats.slice(0, PREVIEW)
            const more = group.chats.slice(PREVIEW)
            return (
              <div key={group.key} className="nd-proj">
                <button
                  type="button"
                  className="nd-proj__head"
                  data-flip={`p:${group.name}`}
                  aria-expanded={isOpen}
                  onClick={() => setClosed((c) => ({ ...c, [group.name]: isOpen }))}
                >
                  <span className="nd-proj__icon">
                    <FolderIcon className="nd-proj__folder" />
                    <ChevronIcon className="nd-proj__chevron" />
                  </span>
                  <span className="nd-proj__name">{group.name}</span>
                </button>
                <Collapse open={isOpen}>
                  {/* The guide line runs down from the folder beside its chats. */}
                  <div className="nd-proj__body">
                    <LineMark active={active} />
                    {group.chats.length === 0 ? (
                      <p className="nd-note">No chats yet</p>
                    ) : (
                      <ul className="nd-rows">{first.map((chat) => row(chat, true))}</ul>
                    )}
                    {more.length > 0 && (
                      <>
                        <Collapse open={isExpanded}>
                          <ul className="nd-rows nd-rows--more">{more.map((chat) => row(chat, true))}</ul>
                        </Collapse>
                        <button
                          type="button"
                          className="nd-more"
                          data-flip={`m:${group.name}`}
                          aria-expanded={isExpanded}
                          onClick={() => setExpanded((x) => ({ ...x, [group.name]: !isExpanded }))}
                        >
                          <span>{isExpanded ? 'Show less' : `Show ${more.length} more`}</span>
                          <ChevronIcon className="nd-more__chevron" size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </Collapse>
              </div>
            )
          }
          if (group.kind === 'inbox') {
            // Done can run long; it shows the first few, like a project.
            const fold = group.key === 'done' ? PREVIEW : group.chats.length
            const more = group.chats.slice(fold)
            const isExpanded = Boolean(expanded['inbox:done'])
            return (
              <div key={group.key} className="nd-datagroup" data-bucket={group.key}>
                <div className="nd-group" data-flip={`i:${group.key}`}>
                  {group.label}
                </div>
                <ul className="nd-rows">{group.chats.slice(0, fold).map((chat) => row(chat))}</ul>
                {more.length > 0 && (
                  <>
                    <Collapse open={isExpanded}>
                      <ul className="nd-rows nd-rows--more">{more.map((chat) => row(chat))}</ul>
                    </Collapse>
                    <button
                      type="button"
                      className="nd-more nd-more--flat"
                      data-flip="m:inbox-done"
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded((x) => ({ ...x, 'inbox:done': !isExpanded }))}
                    >
                      <span>{isExpanded ? 'Show less' : `Show ${more.length} more`}</span>
                      <ChevronIcon className="nd-more__chevron" size={12} />
                    </button>
                  </>
                )}
              </div>
            )
          }
          return (
            <div key={group.key} className="nd-datagroup">
              {group.kind === 'date' && (
                <div className="nd-group" data-flip={`d:${group.label}`}>
                  {group.label}
                </div>
              )}
              <ul className="nd-rows">{group.chats.map((chat) => row(chat))}</ul>
            </div>
          )
        })}

        {view.matches === 0 && (
          <p className="nd-note nd-note--empty" data-flip="e:empty">
            {options.show === 'unread' ? 'No unread chats' : options.show === 'running' ? 'Nothing running' : 'No chats yet'}
          </p>
        )}
      </section>

      {menu && menuChat && (
        <Dropdown
          key={menu.token}
          label={`Actions for ${menuChat.title}`}
          anchor={menu.anchor}
          entries={entriesFor(menuChat)}
          focusFirst={menu.fromKeys}
          onClose={() => setMenu((current) => (current?.token === menu.token ? null : current))}
        />
      )}
    </div>
    {/* Copies of what a reorganize removed, fading out where they were (useMorph). */}
    <div ref={ghosts} className="nd-ghosts" aria-hidden />
    </div>
  )
}

function ChatRow(props: {
  chat: Chat
  nested: boolean
  active: boolean
  time: string
  menuOpen: boolean
  renaming: boolean
  leaving: boolean
  onOpen: (id: string) => void
  onMenu: (anchor: MenuAnchor, fromKeys: boolean) => void
  onRename: (title: string | null, fromKeys: boolean) => void
  onRemoved: () => void
}) {
  const { chat } = props
  const reason = STATUS_LABEL[chat.status]
  const status = (
    <span className="nd-chat__status">
      {chat.status === 'running' ? <SpinnerIcon size={10} /> : <span className="nd-chat__dot" />}
      {reason && <span className="nd-sr">, {reason}</span>}
    </span>
  )
  return (
    <li
      className={`nd-chat${props.nested ? ' nd-chat--nested' : ''}${props.menuOpen ? ' is-menu-open' : ''}`}
      data-flip={`c:${chat.id}`}
      data-status={chat.status}
      data-leaving={props.leaving || undefined}
      onContextMenu={(e) => {
        if (props.renaming) return
        e.preventDefault()
        props.onMenu({ x: e.clientX, y: e.clientY }, false)
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === 'nd-row-out') props.onRemoved()
      }}
    >
      {props.renaming ? (
        <div className="nd-chat__btn is-renaming" aria-current={props.active ? 'page' : undefined}>
          {status}
          <RenameField title={chat.title} onDone={props.onRename} />
        </div>
      ) : (
        <>
          {/* Status hangs in the card's left padding, so titles never move;
              time on the right. */}
          <button
            type="button"
            className="nd-chat__btn"
            aria-current={props.active ? 'page' : undefined}
            title={`${chat.title} · ${chat.project}${reason ? ` · ${reason}` : ''}`}
            onClick={() => props.onOpen(chat.id)}
          >
            {status}
            <span className="nd-chat__title">{chat.title}</span>
            <span className="nd-chat__time">{props.time}</span>
          </button>
          <button
            type="button"
            className="nd-chat__more"
            aria-label={`More actions for ${chat.title}`}
            aria-haspopup="menu"
            aria-expanded={props.menuOpen}
            // detail is 0 when Enter or Space "clicked" it.
            onClick={(e) => props.onMenu({ element: e.currentTarget }, e.detail === 0)}
          >
            <DotsIcon />
          </button>
        </>
      )}
    </li>
  )
}

/** What a row's marker means, for its tooltip and screen readers. */
const STATUS_LABEL: Partial<Record<ChatStatus, string>> = {
  running: 'running',
  unread: 'ready to review',
  approval: 'waiting for approval',
  input: 'waiting for an answer',
  failed: 'failed',
}

/** The title, editable in place: Enter or clicking away saves, Escape cancels. */
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null, fromKeys: boolean) => void }) {
  const done = useRef(false)
  const finish = (value: string | null, fromKeys: boolean) => {
    if (done.current) return
    done.current = true
    onDone(value, fromKeys)
  }
  return (
    <input
      className="nd-chat__input"
      aria-label="Chat title"
      defaultValue={title}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value, true)
        else if (e.key === 'Escape') finish(null, true)
      }}
      onBlur={(e) => finish(e.currentTarget.value, false)}
    />
  )
}

/**
 * The open chat's marker on its project's guide line. Re-placed after every
 * render (one lookup per project), so it follows re-sorts, Show more and
 * selection alike: it slides when the chat it marks moves or another chat
 * in the project opens, and hides when the chat isn't here or is folded
 * away.
 */
function LineMark({ active }: { active: string }) {
  const mark = useRef<HTMLSpanElement>(null)
  const shown = useRef(false)

  useLayoutEffect(() => {
    const el = mark.current
    const body = el?.parentElement
    if (!el || !body) return
    const row = body.querySelector<HTMLElement>(rowSelector(active))
    const folded = row?.closest('[data-collapsed]')
    if (!row || (folded && body.contains(folded))) {
      el.dataset['on'] = 'false'
      shown.current = false
      return
    }
    // Measured before any move starts this render: this is where the row
    // lands, and the mark's own transition carries it there alongside.
    const move = `translateY(${row.offsetTop + row.offsetHeight / 2}px)`
    if (!shown.current) {
      // Appearing: start in place and grow in, rather than sliding from
      // wherever it last was.
      el.style.transition = 'none'
      el.style.transform = move
      void el.offsetWidth
      el.style.transition = ''
    }
    el.style.transform = move
    el.dataset['on'] = 'true'
    shown.current = true
  })

  return <span ref={mark} className="nd-proj__mark" data-on="false" aria-hidden />
}

/**
 * Eases its content open and closed (grid rows 0fr <-> 1fr) and fades it.
 * Clips only while moving or closed, so rows gliding in from elsewhere in
 * the list aren't cut off at its edge.
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [moving, setMoving] = useState(false)
  const last = useRef(open)

  useLayoutEffect(() => {
    if (last.current === open) return
    last.current = open
    setMoving(true)
    // transitionend doesn't fire with reduced motion; don't stay clipped.
    const done = setTimeout(() => setMoving(false), 600)
    return () => clearTimeout(done)
  }, [open])

  return (
    <div
      className={`nd-collapse${moving ? ' is-moving' : ''}`}
      data-open={open}
      data-collapsed={open ? undefined : 'true'}
      inert={!open}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows') setMoving(false)
      }}
    >
      <div className="nd-collapse__inner">{children}</div>
    </div>
  )
}

/**
 * FLIP: call snapshot() just before a change that reorders the list. After
 * the change renders (before paint), every [data-flip] element that moved is
 * animated from its old place to its new one; new ones fade in. Snapshots
 * are taken from what's on screen, so a change mid-animation carries on
 * smoothly from where things are. snapshot(id) also "carries" that chat:
 * it lifts into a card above the others for the trip and settles on landing.
 */
function useFlip(root: RefObject<HTMLElement | null>) {
  const before = useRef<{ rects: Map<string, DOMRect>; carry: string | undefined } | null>(null)

  const visible = (el: HTMLElement) => !el.closest('[data-collapsed]')

  const snapshot = useCallback(
    (carry?: string) => {
      const container = root.current
      if (!container) return
      const rects = new Map<string, DOMRect>()
      for (const el of container.querySelectorAll<HTMLElement>('[data-flip]')) {
        if (visible(el)) rects.set(el.dataset['flip']!, el.getBoundingClientRect())
      }
      before.current = { rects, carry: carry === undefined ? undefined : `c:${carry}` }
    },
    [root],
  )

  useLayoutEffect(() => {
    const snap = before.current
    const container = root.current
    if (!snap || !container) return
    before.current = null
    if (reducedMotion()) return

    for (const el of container.querySelectorAll<HTMLElement>('[data-flip]')) {
      if (!visible(el)) continue
      const key = el.dataset['flip']!
      glides.get(el)?.cancel()
      const now = el.getBoundingClientRect()
      const was = snap.rects.get(key)
      if (!was) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: 140, easing: EASE, fill: 'backwards' })
        glide(el, 0, -4, 280, easeOut, 140)
        continue
      }
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      if (key === snap.carry) {
        // Lifted: flies above the other rows as a card with a shadow, and
        // settles as it lands.
        const button = el.querySelector<HTMLElement>('.nd-chat__btn')
        button?.classList.add('is-carried')
        el.style.zIndex = '3'
        const settle = () => {
          button?.classList.remove('is-carried')
          el.style.zIndex = ''
        }
        void glide(el, dx, dy, 640, easeCarry).finished.then(settle)
      } else {
        glide(el, dx, dy, 480, easeOut)
      }
    }
  })

  return { snapshot }
}

const easeOut = bezier(0.25, 1, 0.5, 1)
const easeMorph = bezier(0.32, 0.72, 0, 1)
const easeCarry = bezier(0.3, 0.85, 0.3, 1)

type Glide = { cancel: () => void; finished: Promise<void> }
const glides = new WeakMap<HTMLElement, Glide>()

/**
 * Moves an element from an offset back to its place, in whole-pixel steps.
 * Text is always drawn on whole pixels; if the row moved by fractions, its
 * card and dot would glide while its text stepped, and the text shudders
 * inside the row. Stepping everything by whole pixels keeps them together
 * and crisp. Driven per frame; cancel() (or a new glide on the same
 * element) puts it straight back in place.
 */
function glide(el: HTMLElement, dx: number, dy: number, duration: number, ease: (t: number) => number, delay = 0): Glide {
  glides.get(el)?.cancel()
  const place = (x: number, y: number) => {
    const rx = Math.round(x)
    const ry = Math.round(y)
    el.style.translate = rx || ry ? `${rx}px ${ry}px` : ''
  }
  let frame = 0
  let resolve = () => {}
  const finished = new Promise<void>((r) => (resolve = r))
  const g: Glide = {
    finished,
    cancel: () => {
      cancelAnimationFrame(frame)
      place(0, 0)
      if (glides.get(el) === g) glides.delete(el)
      resolve()
    },
  }
  const start = performance.now() + delay
  const step = (now: number) => {
    const p = Math.min(1, Math.max(0, (now - start) / duration))
    if (p >= 1) return g.cancel()
    const left = 1 - ease(p)
    place(dx * left, dy * left)
    frame = requestAnimationFrame(step)
  }
  place(dx, dy)
  glides.set(el, g)
  frame = requestAnimationFrame(step)
  return g
}

/**
 * The organize transition: a layout morph. Call capture() just before the
 * change. Once the new arrangement renders (before paint):
 * - Everything that's still there and moves up to three rows glides from
 *   its old place to its new one on a long, soft ease, top rows a beat
 *   before lower ones, so the list moves as a wave. Anything moving further
 *   fades out where it was and in where it lands instead of flying across
 *   the list through the other rows.
 * - What's gone (old group labels, project heads, filtered-out rows)
 *   doesn't just vanish: a copy fades out where it was (140ms), on a layer
 *   over the list.
 * - What's new fades in and settles once that's cleared, while the gliding
 *   rows are still on their way, so old and new never overlap.
 * Off-screen at both ends means no animation. A change during a morph
 * carries on from where things are on screen.
 */
function useMorph(root: RefObject<HTMLElement | null>, ghosts: RefObject<HTMLElement | null>) {
  const before = useRef<Map<string, { rect: DOMRect; node: HTMLElement }> | null>(null)

  const shown = (el: HTMLElement) => !el.closest('[data-collapsed]')

  const capture = useCallback(() => {
    const container = root.current
    if (!container) return
    const map = new Map<string, { rect: DOMRect; node: HTMLElement }>()
    for (const el of container.querySelectorAll<HTMLElement>('[data-flip]')) {
      if (shown(el)) map.set(el.dataset['flip']!, { rect: el.getBoundingClientRect(), node: el })
    }
    before.current = map
  }, [root])

  useLayoutEffect(() => {
    const snap = before.current
    const container = root.current
    const layer = ghosts.current
    if (!snap || !container || !layer) return
    before.current = null
    if (reducedMotion()) return

    for (const animation of container.getAnimations({ subtree: true })) {
      if (animation.id === 'nd-morph') animation.cancel()
    }
    for (const el of container.querySelectorAll<HTMLElement>('[data-flip]')) glides.get(el)?.cancel()
    layer.replaceChildren()

    const view = layer.getBoundingClientRect()
    const onScreen = (r: DOMRect) => r.bottom > view.top && r.top < view.bottom
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)'

    const now = [...container.querySelectorAll<HTMLElement>('[data-flip]')]
      .filter(shown)
      .map((el) => ({ el, key: el.dataset['flip']!, rect: el.getBoundingClientRect() }))
      .sort((a, b) => a.rect.top - b.rect.top)

    // A row moving more than three rows doesn't travel there (that's what
    // turns a regroup into rows flying through each other): it fades out
    // where it was and fades in where it lands, like a leave plus an arrive.
    const FAR = 3 * 29
    const leaving: { rect: DOMRect; node: HTMLElement }[] = []

    let order = 0
    for (const { el, key, rect } of now) {
      const was = snap.get(key)
      snap.delete(key)
      if (was && !onScreen(was.rect) && !onScreen(rect)) continue
      const delay = Math.min(order * 12, 150)
      order += 1
      const dx = was ? was.rect.left - rect.left : 0
      const dy = was ? was.rect.top - rect.top : 0
      if (was && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      if (!was || Math.abs(dy) > FAR) {
        if (was) leaving.push(was)
        // Arrivals wait for what's leaving to clear (140ms), so the old and
        // new never sit on top of each other half-faded. They're invisible
        // while they wait, so the stagger never shows as a hold.
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          id: 'nd-morph',
          duration: 400,
          delay: 140 + delay,
          easing: ease,
          fill: 'backwards',
        })
        glide(el, 0, 6, 400, easeMorph, 140 + delay)
        continue
      }
      // Moving rows all start together: a staggered start made each one hold
      // still and then lurch.
      glide(el, dx, dy, 460, easeMorph)
    }

    // Whatever's left in the snapshot is gone, plus the far movers' old
    // places: fade a copy out where each was.
    for (const { rect, node } of [...snap.values(), ...leaving]) {
      if (!onScreen(rect)) continue
      const copy = node.cloneNode(true) as HTMLElement
      copy.removeAttribute('data-flip')
      Object.assign(copy.style, {
        position: 'absolute',
        left: `${rect.left - view.left}px`,
        top: `${rect.top - view.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        listStyle: 'none',
      })
      layer.append(copy)
      const fade = copy.animate(
        [
          { opacity: 1 },
          { opacity: 0 },
        ],
        { duration: 140, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      )
      void fade.finished.then(
        () => copy.remove(),
        () => copy.remove(),
      )
    }
  })

  return { capture }
}

/** Re-renders every `ms` so relative times stay fresh. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

const ORGANIZE = ['project', 'inbox', 'date', 'list'] as const
const SORTS: SortKey[] = ['updated', 'created', 'name']
const SHOWS = ['all', 'unread', 'running'] as const

function loadOptions(): ListOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<ListOptions>
    return {
      organize: ORGANIZE.includes(saved.organize!) ? saved.organize! : defaultOptions.organize,
      sort: SORTS.includes(saved.sort!) ? saved.sort! : defaultOptions.sort,
      reversed: typeof saved.reversed === 'boolean' ? saved.reversed : defaultOptions.reversed,
      show: SHOWS.includes(saved.show!) ? saved.show! : defaultOptions.show,
    }
  } catch {
    return defaultOptions
  }
}

function saveOptions(options: ListOptions) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    /* private window: the lab still works, it just forgets */
  }
}
