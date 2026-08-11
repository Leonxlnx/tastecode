import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  McpServer,
  McpServerConfig,
  McpTransport,
  ProviderId,
  ResultOf,
} from '@harness/contracts'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import type { Transport } from '../transport.js'

type Inventory = ResultOf<'mcp.list'>
type Editor = { mode: 'add' | 'edit'; id: string; displayName: string; transport: string }

export function McpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
}) {
  const [inventory, setInventory] = useState<Inventory>()
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<Editor>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  // Generation counter: a slow reply from a previous project must not land
  // on top of the current one's list (or arrive after unmount).
  const refreshGeneration = useRef(0)
  useEffect(
    () => () => {
      refreshGeneration.current += 1
    },
    [],
  )

  const refresh = useCallback(async () => {
    if (!props.projectPath) return
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const inventory = await props.transport.request('mcp.list', {
        provider: props.provider,
        projectPath: props.projectPath,
      })
      if (refreshGeneration.current !== generation) return
      setInventory(inventory)
      setError(undefined)
    } catch (cause) {
      if (refreshGeneration.current !== generation) return
      setError(message(cause))
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    setInventory(undefined)
    setError(undefined)
    // "Server added." must not survive into an unrelated project's panel.
    setNotice(undefined)
    if (!props.projectPath) {
      setLoading(false)
      return
    }
    void refresh()
    const offOAuth = props.transport.on('mcp.oauth', (result) => {
      if (result.provider !== props.provider || result.projectPath !== props.projectPath) return
      setBusy(undefined)
      if (result.success) {
        setNotice('MCP sign-in completed.')
        setError(undefined)
        void refresh()
      } else {
        setError(result.error ?? 'MCP sign-in failed.')
      }
    })
    const offChanged = props.transport.on('mcp.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) void refresh()
    })
    let reconnecting = props.transport.state === 'reconnecting'
    const offState = props.transport.onState((state) => {
      if (state === 'reconnecting') reconnecting = true
      else if (state === 'open' && reconnecting) {
        reconnecting = false
        void refresh()
      }
    })
    return () => {
      offOAuth()
      offChanged()
      offState()
    }
  }, [props.transport, props.provider, props.projectPath, refresh])

  async function applyChange(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      setNotice(success)
      if (inventory?.capabilities.reload && props.projectPath) {
        try {
          await props.transport.request('mcp.reload', {
            provider: props.provider,
            projectPath: props.projectPath,
          })
          setNotice(`${success} Active sessions reloaded.`)
        } catch (cause) {
          setNotice(`${success} ${message(cause)}`)
        }
      }
      await refresh()
      return true
    } catch (cause) {
      setError(message(cause))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || !props.projectPath) return
    let server: McpServerConfig
    try {
      server = {
        id: editor.id.trim(),
        enabled: true,
        ...(editor.displayName.trim() ? { displayName: editor.displayName.trim() } : {}),
        transport: JSON.parse(editor.transport) as McpTransport,
      }
    } catch {
      setError('Transport must be valid JSON.')
      return
    }
    setBusy('editor')
    const saved = await applyChange(
      () =>
        props.transport.request(editor.mode === 'add' ? 'mcp.add' : 'mcp.update', {
          provider: props.provider,
          projectPath: props.projectPath!,
          server,
        }),
      editor.mode === 'add' ? 'Server added.' : 'Server updated.',
    )
    if (saved) setEditor(undefined)
  }

  function toggle(server: McpServer): void {
    if (!props.projectPath) return
    setBusy(server.id)
    void applyChange(
      () =>
        server.enabled
          ? props.transport.request('mcp.add', {
              provider: props.provider,
              projectPath: props.projectPath!,
              server: { id: server.id, enabled: false },
            })
          : props.transport.request('mcp.remove', {
              provider: props.provider,
              projectPath: props.projectPath!,
              serverId: server.id,
            }),
      server.enabled ? 'Server disabled for this project.' : 'Project override removed.',
    )
  }

  function remove(server: McpServer): void {
    if (!props.projectPath || !window.confirm(`Remove ${name(server)} from this project?`)) return
    setBusy(server.id)
    void applyChange(
      () =>
        props.transport.request('mcp.remove', {
          provider: props.provider,
          projectPath: props.projectPath!,
          serverId: server.id,
        }),
      'Server removed.',
    )
  }

  async function signIn(server: McpServer): Promise<void> {
    if (!props.projectPath) return
    setBusy(server.id)
    setError(undefined)
    try {
      const result = await props.transport.request('mcp.startOAuth', {
        provider: props.provider,
        projectPath: props.projectPath,
        serverId: server.id,
      })
      const opened = window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      if (!opened) {
        setNotice(`Your browser blocked the sign-in window. Open it yourself: ${result.authUrl}`)
      }
      setNotice('Finish signing in in your browser.')
      setBusy(undefined)
    } catch (cause) {
      setError(message(cause))
      setBusy(undefined)
    }
  }

  const project = props.projectName ?? props.projectPath
  const status = !props.projectPath
    ? 'Select a project in the sidebar first.'
    : loading
      ? 'Loading MCP servers…'
      : !inventory
        ? undefined
        : !inventory.capabilities.inventory
          ? `${props.providerName} does not expose MCP servers here yet.`
          : inventory.servers.length === 0
            ? 'No MCP servers are configured for this project.'
            : undefined

  return (
    <section className="settings__panel mcp-settings" aria-labelledby="settings-mcp">
      <header className="mcp-settings__header">
        <div>
          <h1 className="settings__title" id="settings-mcp">
            MCP servers
          </h1>
          <p>{project ? `Available in ${project}` : 'Choose a project to inspect its servers.'}</p>
        </div>
        {props.projectPath && inventory?.capabilities.add ? (
          <button
            className="settings__action"
            type="button"
            disabled={busy !== undefined}
            onClick={() =>
              setEditor({
                mode: 'add',
                id: '',
                displayName: '',
                transport: '{\n  "type": "http",\n  "url": "https://example.com/mcp"\n}',
              })
            }
          >
            <Plus size={14} aria-hidden />
            Add server
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="mcp-settings__message is-error" role="alert">
          {error}{' '}
          <button className="settings__action" type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {notice ? <p className="mcp-settings__message">{notice}</p> : null}
      {status ? <p className="mcp-settings__empty">{status}</p> : null}
      {editor ? (
        <ServerEditor
          editor={editor}
          busy={busy === 'editor'}
          onChange={setEditor}
          onCancel={() => setEditor(undefined)}
          onSubmit={(event) => void save(event)}
        />
      ) : null}
      {inventory?.capabilities.inventory && inventory.servers.length ? (
        <div className="settings__group">
          {inventory.servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              capabilities={inventory.capabilities}
              busy={busy === server.id}
              onSignIn={() => void signIn(server)}
              onToggle={() => toggle(server)}
              onEdit={() =>
                setEditor({
                  mode: 'edit',
                  id: server.id,
                  displayName: server.displayName ?? '',
                  transport: JSON.stringify(server.transport, null, 2),
                })
              }
              onRemove={() => remove(server)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ServerRow(props: {
  server: McpServer
  capabilities: Inventory['capabilities']
  busy: boolean
  onSignIn: () => void
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const needsOAuth =
    props.capabilities.startOAuth &&
    props.server.auth.status === 'sign_in_required' &&
    props.server.auth.method === 'oauth'
  const canToggle =
    props.capabilities.remove &&
    ((!props.server.enabled && props.server.scope === 'project') ||
      (props.capabilities.add && props.server.scope === 'global'))
  const canEdit =
    props.capabilities.update && props.server.scope === 'project' && props.server.transport
  const canRemove =
    props.capabilities.remove && props.server.scope === 'project' && props.server.enabled
  return (
    <article className={`settings__row mcp-row${props.server.enabled ? '' : ' is-disabled'}`}>
      <div className="settings__row-copy">
        <div className="mcp-row__heading">
          <h2>{props.server.displayName ?? props.server.id}</h2>
          <span>{props.server.scope}</span>
          <span>{props.server.enabled ? props.server.startup.state : 'disabled'}</span>
        </div>
        <p className="mcp-row__transport">{transportLabel(props.server.transport)}</p>
        {props.server.startup.state === 'failed' ? (
          <p className="mcp-row__failure" role="alert">
            <AlertTriangle size={13} aria-hidden />
            {props.server.startup.message}
          </p>
        ) : null}
        <details className="mcp-row__details">
          <summary>
            {props.server.tools.length} tools · {props.server.resources.length} resources ·{' '}
            {props.server.resourceTemplates.length} templates
          </summary>
          {props.server.tools.length ? (
            <ul>
              {props.server.tools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.title ?? tool.name}</strong>
                  {tool.description ? ` — ${tool.description}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>No tools reported.</p>
          )}
        </details>
      </div>
      <div className="mcp-row__actions">
        {needsOAuth ? (
          <button
            className="settings__action"
            type="button"
            disabled={props.busy}
            onClick={props.onSignIn}
          >
            Sign in
          </button>
        ) : null}
        {canToggle ? (
          <button
            className={`switch${props.server.enabled ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label={`${props.server.enabled ? 'Disable' : 'Enable'} ${name(props.server)} for this project`}
            aria-checked={props.server.enabled}
            disabled={props.busy}
            onClick={props.onToggle}
          >
            <span className="switch__thumb" />
          </button>
        ) : null}
        {canEdit ? (
          <button
            className="settings__action"
            type="button"
            disabled={props.busy}
            onClick={props.onEdit}
          >
            Edit
          </button>
        ) : null}
        {canRemove ? (
          <button
            className="settings__action is-danger"
            type="button"
            disabled={props.busy}
            onClick={props.onRemove}
          >
            <Trash2 size={13} aria-hidden />
            Remove
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ServerEditor(props: {
  editor: Editor
  busy: boolean
  onChange: (editor: Editor) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const update = (change: Partial<Editor>) => props.onChange({ ...props.editor, ...change })
  return (
    <form
      className="mcp-editor"
      aria-label={`${props.editor.mode === 'add' ? 'Add' : 'Edit'} MCP server`}
      onSubmit={props.onSubmit}
    >
      <label>
        Server ID
        <input
          required
          disabled={props.editor.mode === 'edit'}
          value={props.editor.id}
          onChange={(event) => update({ id: event.target.value })}
        />
      </label>
      <label>
        Display name
        <input
          value={props.editor.displayName}
          onChange={(event) => update({ displayName: event.target.value })}
        />
      </label>
      <label className="mcp-editor__wide">
        Transport JSON
        <textarea
          required
          spellCheck={false}
          value={props.editor.transport}
          onChange={(event) => update({ transport: event.target.value })}
        />
        <small>
          Use stdio or HTTP transport fields. Reference secrets as
          {' { "source": "credential", "credentialRef": "…" }'}.
        </small>
      </label>
      <footer>
        <button
          className="settings__action"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button className="settings__action" type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : 'Save server'}
        </button>
      </footer>
    </form>
  )
}

function name(server: McpServer): string {
  return server.displayName ?? server.id
}

function transportLabel(transport: McpTransport | undefined): string {
  if (!transport) return 'Configuration managed by provider'
  return transport.type === 'http'
    ? transport.url
    : [transport.command, ...(transport.args ?? [])].join(' ')
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
