import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  McpServer,
  McpServerConfig,
  McpTransport,
  ProviderId,
  ResultOf,
} from '@harness/contracts'
import { McpTransportSchema } from '@harness/contracts'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import type { Transport } from '../transport.js'
import { AppSelect } from './AppSelect.js'
import { propertiesWhen } from '../properties-when.js'

type Inventory = ResultOf<'mcp.list'>
type Editor = { mode: 'add' | 'edit'; id: string; displayName: string; transport: string }
type OAuthCompletion = {
  serverId: string
  loginId: string
  success: boolean
  error: string | null
}
type PendingOAuth = {
  serverId: string
  loginId: string | undefined
  completion?: OAuthCompletion
}
type Context = { transport: Transport; provider: ProviderId; projectPath: string | undefined }

export function McpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  providers?: Array<{ provider: ProviderId; providerName: string }>
  projectPath: string | undefined
  projectName: string | undefined
}) {
  const providers = props.providers?.length
    ? props.providers
    : [{ provider: props.provider, providerName: props.providerName }]
  const initialProvider =
    providers.find((option) => option.provider === props.provider) ?? providers[0]!
  const [provider, setProvider] = useState(initialProvider.provider)
  const availableProviders = providers.map((option) => option.provider).join('\0')

  useEffect(() => {
    if (availableProviders.split('\0').includes(provider)) return
    setProvider(initialProvider.provider)
  }, [availableProviders, initialProvider.provider, provider])

  const selected = providers.find((option) => option.provider === provider) ?? initialProvider
  return (
    <ProviderMcpSettings
      key={selected.provider}
      {...props}
      provider={selected.provider}
      providerName={selected.providerName}
      providerPicker={
        providers.length > 1 ? (
          <div className="mcp-settings__provider">
            <span>Provider</span>
            <AppSelect
              value={selected.provider}
              options={providers.map((option) => ({
                value: option.provider,
                label: option.providerName,
              }))}
              onChange={setProvider}
              ariaLabel="MCP provider"
              className="mcp-settings__provider-select"
              align="right"
            />
          </div>
        ) : null
      }
    />
  )
}

function ProviderMcpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
  providerPicker?: ReactNode
}) {
  const [inventory, setInventory] = useState<Inventory>()
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<Editor>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const inventoryContext = useRef<Context | undefined>(undefined)
  const errorContext = useRef<Context | undefined>(undefined)
  const pendingOAuth = useRef<PendingOAuth | undefined>(undefined)
  const activeContext = useRef({
    transport: props.transport,
    provider: props.provider,
    projectPath: props.projectPath,
  })
  activeContext.current = {
    transport: props.transport,
    provider: props.provider,
    projectPath: props.projectPath,
  }
  const isCurrentContext = () =>
    activeContext.current.transport === props.transport &&
    activeContext.current.provider === props.provider &&
    activeContext.current.projectPath === props.projectPath

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
    if (!props.projectPath || !isCurrentContext()) return
    const context = {
      transport: props.transport,
      provider: props.provider,
      projectPath: props.projectPath,
    }
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const inventory = await props.transport.request('mcp.list', {
        provider: props.provider,
        projectPath: props.projectPath,
      })
      if (refreshGeneration.current !== generation || !isCurrentContext()) return
      inventoryContext.current = context
      errorContext.current = undefined
      setInventory(inventory)
      setError(undefined)
    } catch (cause) {
      if (refreshGeneration.current !== generation || !isCurrentContext()) return
      errorContext.current = context
      setError(message(cause))
    } finally {
      if (refreshGeneration.current === generation && isCurrentContext()) setLoading(false)
    }
  }, [props.transport, props.provider, props.projectPath])

  const completeOAuth = useCallback(
    (result: OAuthCompletion) => {
      pendingOAuth.current = undefined
      setBusy((current) => (current === result.serverId ? undefined : current))
      if (result.success) {
        setNotice('MCP sign-in completed.')
        setError(undefined)
        void refresh()
      } else {
        setNotice(undefined)
        setError(result.error ?? 'MCP sign-in failed.')
      }
    },
    [refresh],
  )

  useEffect(() => {
    setInventory(undefined)
    inventoryContext.current = undefined
    errorContext.current = undefined
    setError(undefined)
    // "Server added." must not survive into an unrelated project's panel.
    setNotice(undefined)
    setEditor(undefined)
    pendingOAuth.current = undefined
    setBusy(undefined)
    if (!props.projectPath) {
      setLoading(false)
      return
    }
    void refresh()
    const offOAuth = props.transport.on('mcp.oauth', (result) => {
      if (result.provider !== props.provider || result.projectPath !== props.projectPath) return
      const pending = pendingOAuth.current
      if (pending) {
        if (pending.serverId !== result.serverId) {
          if (result.success) void refresh()
          return
        }
        if (pending.loginId === undefined) {
          pending.completion = result
          return
        }
        if (pending.loginId !== result.loginId) {
          if (result.success) void refresh()
          return
        }
      }
      completeOAuth(result)
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
  }, [props.transport, props.provider, props.projectPath, refresh, completeOAuth])

  async function applyChange<Result>(
    action: () => Promise<Result>,
    success: string,
  ): Promise<boolean> {
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      if (!isCurrentContext()) return false
      setNotice(success)
      if (inventory?.capabilities.reload && props.projectPath) {
        try {
          await props.transport.request('mcp.reload', {
            provider: props.provider,
            projectPath: props.projectPath,
          })
          if (!isCurrentContext()) return false
          setNotice(`${success} Active sessions reloaded.`)
        } catch (cause) {
          if (!isCurrentContext()) return false
          setNotice(`${success} ${message(cause)}`)
        }
      }
      await refresh()
      return true
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause))
      return false
    } finally {
      if (isCurrentContext()) setBusy(undefined)
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || !props.projectPath) return
    const projectPath = props.projectPath
    let server: McpServerConfig
    try {
      server = {
        id: editor.id.trim(),
        enabled: true,
        ...propertiesWhen(editor.displayName.trim(), () => ({
          displayName: editor.displayName.trim(),
        })),
        transport: McpTransportSchema.parse(JSON.parse(editor.transport)),
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
          projectPath,
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
    if (!props.projectPath || pendingOAuth.current) return
    pendingOAuth.current = { serverId: server.id, loginId: undefined }
    setBusy(server.id)
    setError(undefined)
    try {
      const result = await props.transport.request('mcp.startOAuth', {
        provider: props.provider,
        projectPath: props.projectPath,
        serverId: server.id,
      })
      if (!isCurrentContext()) return
      const pending = pendingOAuth.current
      if (!pending || pending.serverId !== server.id) return
      pending.loginId = result.loginId
      if (pending.completion?.loginId === result.loginId) {
        completeOAuth(pending.completion)
        return
      }
      delete pending.completion
      const opened = window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      if (!opened) {
        setNotice(`Your browser blocked the sign-in window. Open it yourself: ${result.authUrl}`)
      } else {
        setNotice('Finish signing in in your browser.')
      }
    } catch (cause) {
      if (isCurrentContext()) {
        pendingOAuth.current = undefined
        setBusy((current) => (current === server.id ? undefined : current))
        setError(message(cause))
      }
    }
  }

  const contextMatches = (context: Context | undefined) =>
    context?.transport === props.transport &&
    context.provider === props.provider &&
    context.projectPath === props.projectPath
  const currentInventory = contextMatches(inventoryContext.current) ? inventory : undefined
  const currentError = currentInventory || contextMatches(errorContext.current) ? error : undefined
  const projectServers =
    currentInventory?.servers.filter((server) => server.scope === 'project') ?? []
  const providerStatus = !props.projectPath
    ? 'Select a project to check MCP support.'
    : currentError && !currentInventory
      ? `${props.providerName} · MCP inventory status unavailable`
      : !currentInventory
        ? `Checking ${props.providerName} MCP support…`
        : `${props.providerName} · MCP inventory ${currentInventory.capabilities.inventory ? 'available' : 'unavailable'}`
  const status = !props.projectPath
    ? 'Select a project in the sidebar first.'
    : loading && !inventory
      ? 'Loading MCP servers…'
      : !currentInventory
        ? undefined
        : projectServers.length === 0
          ? !currentInventory.capabilities.inventory
            ? `No project MCP servers have been added for ${props.providerName}. Provider-global inventory is unavailable here.`
            : 'No MCP servers have been added to this project.'
          : undefined

  return (
    <section className="settings__panel mcp-settings" aria-labelledby="settings-mcp">
      <header className="mcp-settings__header">
        <div>
          <h1 className="settings__title" id="settings-mcp">
            MCP servers
          </h1>
          <p role="status" aria-live="polite" aria-atomic="true">
            {providerStatus}
          </p>
        </div>
        <div className="mcp-settings__actions">
          {props.providerPicker}
          {props.projectPath && currentInventory?.capabilities.add ? (
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
        </div>
      </header>

      {currentError ? (
        <p className="mcp-settings__message is-error" role="alert">
          {currentError}{' '}
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
      {currentInventory && projectServers.length > 0 ? (
        <div className="settings__group">
          {projectServers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              capabilities={currentInventory.capabilities}
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
  const auth = props.server.auth
  const startup = props.server.startup
  const needsOAuth =
    props.capabilities.startOAuth && auth?.status === 'sign_in_required' && auth.method === 'oauth'
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
          <span>
            {props.server.enabled ? (startup?.state ?? 'status unavailable') : 'disabled'}
          </span>
        </div>
        <p className="mcp-row__transport">{transportLabel(props.server.transport)}</p>
        {startup?.state === 'failed' ? (
          <p className="mcp-row__failure" role="alert">
            <AlertTriangle size={13} aria-hidden />
            {startup.message}
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
