import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '@harness/contracts'
import { Transport, type ConnectionState } from './transport.js'
import { appendUserMessage, emptyThread, reduce, type ThreadState } from './thread-store.js'

const SERVER_URL = 'ws://127.0.0.1:4311'

export function App() {
  const transport = useMemo(() => new Transport(SERVER_URL), [])
  const [connection, setConnection] = useState<ConnectionState>('closed')
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [threadId, setThreadId] = useState<string | undefined>()
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    const offState = transport.onState(setConnection)
    const offEvent = transport.on('thread.event', ({ event }) => {
      setThread((current) => reduce(current, event))
    })
    transport.connect()
    return () => {
      offState()
      offEvent()
      transport.close()
    }
  }, [transport])

  const start = useCallback(async () => {
    setError(undefined)
    setBusy(true)
    try {
      const { threadId: id } = await transport.request('thread.start', {
        provider: 'codex',
        workspacePath: workspace,
      })
      setThreadId(id)
      setThread(emptyThread)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [transport, workspace])

  const send = useCallback(
    async (text: string) => {
      if (!threadId) return
      setThread((current) => appendUserMessage(current, text))
      try {
        await transport.request('thread.sendTurn', { threadId, text })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [transport, threadId],
  )

  const interrupt = useCallback(() => {
    if (threadId) void transport.request('thread.interrupt', { threadId })
  }, [transport, threadId])

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">Personal Harness</span>
        <span className={`status status--${connection}`}>{connection}</span>
        {threadId ? <span className="thread-id">codex · {threadId.slice(0, 8)}</span> : null}
      </header>

      {threadId ? (
        <Thread items={thread.items} running={thread.running} />
      ) : (
        <Start
          workspace={workspace}
          onChange={setWorkspace}
          onStart={start}
          busy={busy}
          disabled={connection !== 'open'}
        />
      )}

      {error ? <div className="error">{error}</div> : null}

      {threadId ? (
        <Composer onSend={send} onInterrupt={interrupt} running={thread.running} />
      ) : null}
    </div>
  )
}

function Start(props: {
  workspace: string
  onChange: (value: string) => void
  onStart: () => void
  busy: boolean
  disabled: boolean
}) {
  return (
    <div className="start">
      <h1>Start a session</h1>
      <p className="muted">
        Point Codex at a folder. Nothing is sent anywhere but the agent running on this machine.
      </p>
      <div className="row">
        <input
          value={props.workspace}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="D:\path\to\your\project"
          spellCheck={false}
        />
        <button
          onClick={props.onStart}
          disabled={props.busy || props.disabled || props.workspace.trim() === ''}
        >
          {props.busy ? 'starting…' : 'Start'}
        </button>
      </div>
      {props.disabled ? <p className="muted small">Waiting for the local server…</p> : null}
    </div>
  )
}

function Thread(props: { items: Item[]; running: boolean }) {
  const bottom = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the newest output, but only while the user is already at the bottom.
  // Yanking someone back mid-read is the cardinal sin of chat UIs. Proper
  // end-anchored virtualisation replaces this in M1.
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [props.items])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {props.items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
      {props.running ? <div className="working">working…</div> : null}
      <div ref={bottom} />
    </div>
  )
}

function ItemView({ item }: { item: Item }) {
  if (item.type === 'message') {
    return (
      <article className={`msg msg--${item.role ?? 'assistant'}`}>
        <div className="msg__body">{item.text}</div>
      </article>
    )
  }

  // Everything that is not a message collapses to a one-line summary. The
  // default view should read as a summary of what happened, not a transcript.
  return (
    <details className={`aux aux--${item.type}`}>
      <summary>
        <span className="aux__kind">{label(item)}</span>
        {item.status === 'started' ? <span className="aux__spin">·</span> : null}
      </summary>
      {item.text ? <pre className="aux__body">{item.text}</pre> : null}
    </details>
  )
}

function label(item: Item): string {
  switch (item.type) {
    case 'command':
      return `ran ${item.command ?? 'a command'}`
    case 'reasoning':
      return 'thinking'
    case 'file_change':
      return item.path ? `edited ${item.path}` : 'edited files'
    case 'tool_call':
      return `tool ${item.text ?? ''}`
    case 'plan':
      return 'plan'
    case 'error':
      return 'error'
    default:
      return item.type
  }
}

function Composer(props: {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
}) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    props.onSend(trimmed)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Ask Codex to do something…   Ctrl+Enter to send"
        rows={3}
      />
      <div className="composer__actions">
        {props.running ? (
          <button className="ghost" onClick={props.onInterrupt}>
            Stop
          </button>
        ) : null}
        <button onClick={submit} disabled={text.trim() === ''}>
          Send
        </button>
      </div>
    </div>
  )
}
