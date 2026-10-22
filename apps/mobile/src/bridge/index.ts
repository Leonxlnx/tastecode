import { TasteLink } from '../../modules/tastecode-link'
import { TasteUI, type ActionEvent } from '../../modules/tastecode-ui'
import { catalog, connection, forgetComputer, pairing, pairWith, projects } from '../state/app'
import { message } from '../state/thread-session'
import { catalogView } from '../view/catalog'
import { chatsView } from '../view/chats'
import type { Action, LinkView } from '../view/types'
import { NewChat } from './new-chat'
import { OpenThread } from './open-thread'

/** Groups of four, so two people can read a key aloud and compare it. */
function fingerprint(key: string): string {
  return (key.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ')
}

function linkView(): LinkView {
  const status = connection.status.get()
  const current = pairing.get()
  return {
    paired: current !== undefined && current.secret === undefined,
    pairing: current?.secret !== undefined,
    computerName: current?.name ?? null,
    phase: status.phase,
    host: status.phase === 'open' ? status.host : null,
    error: status.phase === 'waiting' || status.phase === 'refused' ? status.error : null,
    computerKey: current ? fingerprint(current.key) : null,
    phoneKey: fingerprint(TasteLink.deviceKey()),
  }
}

const sent = new Map<string, string>()

/** Sends a piece of state unless the screens already have exactly that. */
function update(key: string, value: unknown): void {
  const json = JSON.stringify(value)
  if (sent.get(key) === json) return
  sent.set(key, json)
  TasteUI.update(key, json)
}

const threads = new Map<string, OpenThread>()

function openThread(threadId: string): OpenThread {
  const existing = threads.get(threadId)
  if (existing) return existing
  const thread = new OpenThread(threadId, (patch) =>
    TasteUI.update(`thread:${threadId}`, JSON.stringify(patch)),
  )
  threads.set(threadId, thread)
  return thread
}

function thread(threadId: string): OpenThread {
  const open = threads.get(threadId)
  if (!open) throw new Error('This chat is not open.')
  return open
}

let newChat: NewChat | undefined

async function perform(action: Action): Promise<unknown> {
  switch (action.type) {
    case 'pair':
      pairWith(action.link)
      return null
    case 'forget':
      forgetComputer()
      return null
    case 'reconnect':
      connection.reconnectNow()
      return null
    case 'refresh':
      await projects.refresh()
      return null
    case 'thread.open':
      openThread(action.threadId)
      return null
    case 'thread.close':
      threads.get(action.threadId)?.close()
      threads.delete(action.threadId)
      return null
    case 'thread.loadOlder':
      await thread(action.threadId).session.loadOlder()
      return null
    case 'thread.send':
      await thread(action.threadId).send(action.text, action.attachments)
      return null
    case 'thread.stop':
      await thread(action.threadId).session.interrupt()
      return null
    case 'thread.decide':
      await thread(action.threadId).decide(action.approvalId, action.decision)
      return null
    case 'thread.answer':
      await thread(action.threadId).session.respondToUserInput(action.requestId, action.answers)
      return null
    case 'thread.steer':
      await thread(action.threadId).session.steer(action.queuedId)
      return null
    case 'thread.unqueue':
      await thread(action.threadId).session.deleteQueued(action.queuedId)
      return null
    case 'thread.setAccess':
      await thread(action.threadId).setAccess(action.access)
      return null
    case 'thread.setModel':
      await thread(action.threadId).setModel(action.sourceKey, action.model)
      return null
    case 'thread.setEffort':
      thread(action.threadId).setEffort(action.effort)
      return null
    case 'thread.pin':
      await projects.pinChat(action.threadId, action.pinned)
      return null
    case 'thread.archive':
      await projects.archiveChat(action.threadId)
      return null
    case 'thread.restore':
      await projects.restoreChat(action.threadId)
      return null
    case 'thread.rename':
      await projects.renameChat(action.threadId, action.title)
      return null
    case 'thread.diff':
      return thread(action.threadId).diff()
    case 'newChat.open':
      newChat?.open(action.projectPath)
      return null
    case 'newChat.set': {
      const { type: _type, ...patch } = action
      newChat?.set(patch)
      return null
    }
    case 'newChat.start':
      if (!newChat) throw new Error('The app is still starting.')
      return newChat.start(action.text, action.attachments)
    case 'project.browse':
      return connection.request('projects.browse', action.path ? { path: action.path } : {})
    case 'project.add':
      await projects.add(action.path)
      return null
    case 'attach':
      return connection.request(
        'attachments.saveImage',
        { mimeType: action.mimeType, data: action.data },
        120_000,
      )
  }
}

function receive(event: ActionEvent): void {
  let action: Action
  try {
    action = JSON.parse(event.action) as Action
  } catch {
    if (event.id) TasteUI.resolve(event.id, null, 'The app sent something it could not read.')
    return
  }
  void perform(action).then(
    (result) => event.id && TasteUI.resolve(event.id, JSON.stringify(result ?? null), null),
    (error: unknown) => event.id && TasteUI.resolve(event.id, null, message(error)),
  )
}

// Fast Refresh re-runs this module in development; one bridge answers the screens.
const holder = globalThis as typeof globalThis & { __tastecodeBridge?: boolean }

/** Connects the screens to the phone's state: every change goes out, every request comes in. */
export function startBridge(): void {
  if (holder.__tastecodeBridge) return
  holder.__tastecodeBridge = true
  TasteUI.addListener('onAction', receive)
  const pushLink = () => update('link', linkView())
  connection.status.subscribe(pushLink)
  pairing.subscribe(pushLink)
  pushLink()
  const pushChats = () => update('chats', chatsView(projects.state.get()))
  projects.state.subscribe(pushChats)
  pushChats()
  const pushCatalog = () => update('catalog', catalogView(catalog.state.get()))
  catalog.state.subscribe(pushCatalog)
  pushCatalog()
  newChat = new NewChat((view) => update('newChat', view))
  newChat.flush()
}
