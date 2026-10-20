import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  DEFAULT_ACCOUNT_ID,
  type DetectedAccountHome,
  type ProviderAccount,
  type ProviderAccountHome,
  type ProviderId,
  type ProviderStatus,
} from '@harness/contracts'
import {
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconCircleMinus as CircleMinus,
  IconDots as Ellipsis,
  IconFolderOpen as FolderOpen,
  IconPencil as Pencil,
  IconTrash as Trash,
  IconUserPlus as UserPlus,
} from '@tabler/icons-react'
import { errorMessage } from '../boundary.js'
import { ignoreSignIn, unignoreSignIn } from '../ignored-sign-ins.js'
import { isDesktop, pickFolder, revealPath } from '../bridge.js'
import { providerMark } from '../model-catalog.js'
import { accountsOf, activeAccountOf, useProviderAccounts } from '../provider-accounts-state.js'
import {
  beginLogin,
  cancelInstall,
  clearInstall,
  installState,
  loginKey,
  subscribeInstalls,
  type ProviderLoginTerminalTarget,
} from '../provider-install.js'
import type { Transport } from '../transport.js'
import { AccountEmail } from './AccountEmail.js'
import { Menu, MenuItem } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'
import { ProviderRow } from './ProviderRow.js'
import { RowIssue } from './RowIssue.js'
import { indexedAgo } from './usage/usage-sheets.js'
import { SettingsSection } from './settings/SettingsLayout.js'
import { SettingsSegmented } from './settings/SettingsSegmented.js'
import '../styles/provider-accounts.css'

const ConfirmDialog = lazy(() =>
  import('./SidebarConfirmDialog.js').then((module) => ({
    default: module.SidebarConfirmDialog,
  })),
)

type Confirm = { account: ProviderAccount; deleteHome: boolean }

function accountKey(account: Pick<ProviderAccount, 'provider' | 'id'>): string {
  return `${account.provider}/${account.id}`
}

/** Runs one account action per key at a time and keeps what the server refused. */
function useAccountActions() {
  const [busy, setBusy] = useState<string>()
  const [issues, setIssues] = useState<Record<string, string | undefined>>({})
  const clear = (key: string) => setIssues((current) => ({ ...current, [key]: undefined }))
  const run = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key)
    clear(key)
    try {
      await action()
      return true
    } catch (error) {
      setIssues((current) => ({ ...current, [key]: errorMessage(error) }))
      return false
    } finally {
      setBusy((current) => (current === key ? undefined : current))
    }
  }
  return { busy, issues, run, clear }
}

/**
 * A provider's further sign-ins, under its own row in Settings › Providers,
 * which is its default account. Each has the roster's minus in the margin;
 * removing keeps its folder, and deleting a folder TasteCode created is its
 * own, confirmed action in the row's menu.
 */
export function ProviderAccountRows(props: {
  transport: Transport
  /** An installed provider that declares `multipleAccounts`. */
  provider: ProviderStatus
  /** Says so when the account list could not be read; one provider's rows carry it. */
  reportsErrors?: boolean | undefined
  /** Shows a running sign-in in the expanded workspace terminal, as the provider rows do. */
  onOpenTerminal?: ((target: ProviderLoginTerminalTarget) => void) | undefined
}) {
  const { store, snapshot } = useProviderAccounts(props.transport, true)
  const { busy, issues, run, clear } = useAccountActions()
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<Confirm>()
  // Stable, because it ends up in AccountSignIn's effect dependencies.
  const refresh = useCallback(() => store.refresh(), [store])
  const accounts = accountsOf(snapshot, props.provider.id).filter(
    (account) => account.id !== DEFAULT_ACCOUNT_ID,
  )
  const error =
    props.reportsErrors && snapshot.phase === 'error' ? (
      <p className="set-form__error provider-accounts__error" role="alert">
        Could not load accounts. {snapshot.error}
      </p>
    ) : null
  if (accounts.length === 0) return error

  return (
    <div className="provider-accounts">
      {error}
      {accounts.map((account) => {
        const key = accountKey(account)
        if (renaming === key) {
          return (
            <RenameAccountForm
              key={key}
              account={account}
              busy={busy === key}
              error={issues[key]}
              onCancel={() => setRenaming(undefined)}
              onSubmit={(label) =>
                void run(key, () => store.rename(account.provider, account.id, label)).then(
                  (done) => {
                    if (done) setRenaming(undefined)
                  },
                )
              }
            />
          )
        }
        return (
          <div className="provider-account-entry" key={key}>
            <button
              className="provider-roster__remove"
              type="button"
              aria-label={`Remove ${accountName(props.provider, account)}`}
              title={`Remove ${accountName(props.provider, account)}`}
              disabled={busy === key}
              onClick={() => setConfirm({ account, deleteHome: false })}
            >
              <CircleMinus size={17} stroke={1.6} aria-hidden />
            </button>
            <AccountRow
              account={account}
              provider={props.provider}
              active={activeAccountOf(snapshot, props.provider.id) === account.id}
              busy={busy === key}
              issue={issues[key]}
              signIn={
                <AccountSignIn
                  account={account}
                  provider={props.provider}
                  transport={props.transport}
                  onSignedIn={refresh}
                  onOpenTerminal={props.onOpenTerminal}
                />
              }
              onSetActive={() => void run(key, () => store.setActive(account.provider, account.id))}
              onRename={() => {
                clear(key)
                setRenaming(key)
              }}
              onDeleteFolder={() => setConfirm({ account, deleteHome: true })}
            />
          </div>
        )
      })}
      {confirm ? (
        <Suspense fallback={null}>
          <ConfirmDialog
            {...confirmCopy(confirm)}
            path={confirm.account.home ?? ''}
            onClose={() => setConfirm(undefined)}
            onConfirm={() => {
              const { account, deleteHome } = confirm
              setConfirm(undefined)
              void run(accountKey(account), () =>
                store.remove(account.provider, account.id, deleteHome),
              )
            }}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

/** The last part of a folder path, on Windows or POSIX. */
function folderName(home: string): string {
  return home.split(/[\\/]/).filter(Boolean).at(-1) ?? home
}

/**
 * Sign-ins already on this computer in folders of their own, set up by hand
 * or by another tool, for the given providers (`accounts.detect`). Asked
 * once, and again whenever `again` changes; a server from before detection,
 * or one that could not look, finds nothing.
 */
export function useDetectedAccounts(
  transport: Transport,
  providers: readonly ProviderStatus[],
  options: { enabled?: boolean; again?: unknown } = {},
): readonly DetectedAccountHome[] {
  const [found, setFound] = useState<readonly DetectedAccountHome[]>([])
  const enabled = options.enabled ?? true
  const ids = providers.map((status) => status.id).join(' ')
  useEffect(() => {
    if (!enabled || !ids) return
    let live = true
    void transport
      .request('accounts.detect', {})
      .then((result) => {
        // An answer without the list, as from a server that only half knows the method, finds nothing.
        if (live) setFound(Array.isArray(result?.found) ? result.found : [])
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [transport, enabled, ids, options.again])
  const wanted = ids.split(' ')
  return found.filter((entry) => wanted.includes(entry.provider))
}

/** "Found in .claude_personal · used 2 days ago", with the whole path on hover. */
function foundWhere(entry: DetectedAccountHome, now: number): ReactNode {
  return (
    <span title={entry.home}>
      Found in {folderName(entry.home)}
      {entry.lastUsed === undefined ? null : ` · used ${indexedAgo(entry.lastUsed, now)}`}
    </span>
  )
}

/**
 * The found sign-ins nobody ignored, offered first on Add providers. Adding
 * one makes it an account that uses the folder as it is, and adds its
 * provider when it was not added yet; Ignore moves it under Ignored.
 */
export function FoundAccountsSection(props: {
  transport: Transport
  /** Installed providers that declare `multipleAccounts`. */
  providers: readonly ProviderStatus[]
  found: readonly DetectedAccountHome[]
  onAdded: (provider: ProviderId) => void
}) {
  const { store } = useProviderAccounts(props.transport, props.providers.length > 0)
  const { busy, issues, run } = useAccountActions()
  const [added, setAdded] = useState<readonly string[]>([])
  const offered = props.found.flatMap((entry) => {
    const provider = props.providers.find((status) => status.id === entry.provider)
    return provider ? [{ entry, provider }] : []
  })
  if (offered.length === 0) return null
  const now = Date.now()

  return (
    <SettingsSection
      title="Found on this computer"
      note="Sign-ins kept in folders of their own, by you or another tool. Add one to use it here as a separate account."
    >
      {offered.map(({ entry, provider }) => {
        const name = `${provider.displayName} · ${entry.label}`
        const done = added.includes(entry.home)
        const issue = issues[entry.home]
        return (
          <ProviderRow
            key={entry.home}
            provider={{ ...provider, displayName: name }}
            status={foundWhere(entry, now)}
            link={done ? 'connected' : 'open'}
            live={busy === entry.home}
            issue={issue ? { message: issue, announce: true } : undefined}
            secondary={
              done || busy === entry.home
                ? undefined
                : {
                    label: 'Ignore',
                    ariaLabel: `Ignore ${name}`,
                    onClick: () => ignoreSignIn(entry),
                  }
            }
            primary={
              done
                ? { label: 'Added', done: true }
                : {
                    label: busy === entry.home ? 'Adding…' : 'Add',
                    ariaLabel: `Add ${name}`,
                    disabled: busy !== undefined,
                    onClick: () =>
                      void run(entry.home, () =>
                        store.create(entry.provider, entry.label, {
                          kind: 'existing',
                          path: entry.home,
                        }),
                      ).then((ok) => {
                        if (!ok) return
                        setAdded((current) => [...current, entry.home])
                        props.onAdded(entry.provider)
                      }),
                  }
            }
          />
        )
      })}
    </SettingsSection>
  )
}

/**
 * Found sign-ins the user ignored, folded away at the foot of Add providers
 * until asked for. Unignore offers one again under Found on this computer.
 */
export function IgnoredSignInsSection(props: {
  providers: readonly ProviderStatus[]
  ignored: readonly DetectedAccountHome[]
}) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const listId = useId()
  const offered = props.ignored.flatMap((entry) => {
    const provider = props.providers.find((status) => status.id === entry.provider)
    return provider ? [{ entry, provider }] : []
  })
  if (offered.length === 0) return null
  const now = Date.now()

  return (
    <section className="set-section provider-ignored" aria-labelledby={titleId}>
      <h2 className="set-section__title provider-ignored__title" id={titleId}>
        <button
          className="provider-ignored__toggle"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight className={open ? 'is-open' : undefined} size={14} aria-hidden />
          Ignored
          <span className="provider-ignored__count">{offered.length}</span>
        </button>
      </h2>
      <div id={listId} hidden={!open}>
        {open
          ? offered.map(({ entry, provider }) => {
              const name = `${provider.displayName} · ${entry.label}`
              return (
                <ProviderRow
                  key={entry.home}
                  provider={{ ...provider, displayName: name }}
                  status={foundWhere(entry, now)}
                  link="none"
                  primary={{
                    label: 'Unignore',
                    ariaLabel: `Unignore ${name}`,
                    onClick: () => unignoreSignIn(entry),
                  }}
                />
              )
            })
          : null}
      </div>
    </section>
  )
}

/**
 * Another sign-in for a provider that can run as more than one account, in a
 * new folder or one the user has, from Add providers. Adding one adds its
 * provider when it was not added yet.
 */
export function AddAccountSection(props: {
  transport: Transport
  /** Installed providers that declare `multipleAccounts`. */
  providers: readonly ProviderStatus[]
  onAdded: (provider: ProviderId) => void
}) {
  const { store } = useProviderAccounts(props.transport, props.providers.length > 0)
  const { busy, issues, run, clear } = useAccountActions()
  const [adding, setAdding] = useState(false)
  if (props.providers.length === 0) return null
  const names = props.providers.map((status) => status.displayName).join(' or ')

  return (
    <SettingsSection
      title="Accounts"
      note={`Sign in to ${names} more than once. Each account keeps its own folder, and a chat stays on the account it started on.`}
    >
      {adding ? (
        <AddAccountForm
          providers={props.providers}
          busy={busy === 'add'}
          error={issues.add}
          onCancel={() => {
            clear('add')
            setAdding(false)
          }}
          onSubmit={(provider, label, home) =>
            void run('add', () => store.create(provider, label, home)).then((done) => {
              if (!done) return
              setAdding(false)
              props.onAdded(provider)
            })
          }
        />
      ) : (
        <button
          className="set-button provider-connections__add"
          type="button"
          onClick={() => setAdding(true)}
        >
          <UserPlus size={15} aria-hidden />
          Add account
        </button>
      )}
    </SettingsSection>
  )
}

/** "Codex · Work", as Profile and the account popup name it. */
function accountName(provider: ProviderStatus, account: ProviderAccount): string {
  return `${provider.displayName} · ${account.label}`
}

function confirmCopy(confirm: Confirm) {
  const label = confirm.account.label
  return confirm.deleteHome
    ? {
        title: `Delete ${label} and its folder?`,
        body: 'This removes the account and deletes its folder, which signs it out and erases its local sessions. Its chats cannot continue. This cannot be undone.',
        action: 'Delete folder',
        destructive: true,
      }
    : {
        title: `Remove ${label}?`,
        body: 'TasteCode stops using this account. The folder stays as it is, with its sign-in and sessions. Its chats cannot continue.',
        action: 'Remove account',
        destructive: false,
      }
}

/** Who an account last signed in as, with the email behind the usual reveal. */
function AccountIdentityText(props: { account: ProviderAccount; active?: boolean }) {
  const { email, plan } = props.account
  if (!email && !plan) return <>{props.active ? 'Active · Not signed in' : 'Not signed in'}</>
  return (
    <span className="settings__account">
      {email ? <AccountEmail email={email} /> : 'Signed in'}
      {plan ? <span className="settings__account-plan"> · {plan}</span> : null}
    </span>
  )
}

function AccountRow(props: {
  account: ProviderAccount
  provider: ProviderStatus
  active: boolean
  busy: boolean
  issue?: string | undefined
  signIn: ReactNode
  onSetActive: () => void
  onRename: () => void
  /** Deletes a folder TasteCode created; removing is the roster's minus. */
  onDeleteFolder: () => void
}) {
  const { account } = props
  const signedIn = account.email !== undefined || account.plan !== undefined
  return (
    <div
      className="provider-row provider-account"
      data-link={signedIn ? 'connected' : 'open'}
      data-fault={props.issue ? '' : undefined}
    >
      <div className="provider-row__mark" title={props.provider.displayName}>
        <ProviderIcon mark={providerMark(account.provider)} size={18} />
      </div>
      <div className="provider-row__identity">
        {/* The provider is named too: every provider has an account called Default. */}
        <p className="set-entity__name" title={account.home}>
          {accountName(props.provider, account)}
        </p>
      </div>
      <span className="set-leader" aria-hidden />
      <div className="provider-row__status set-entity__status">
        {props.issue ? <RowIssue message={props.issue} announce label="Problem details" /> : null}
        <span className="provider-row__status-text">
          {/* Sign in takes the action slot, so an account still waiting for
              one says here that new chats start on it. */}
          <AccountIdentityText account={account} active={props.active && !signedIn} />
        </span>
      </div>
      <div className="provider-row__secondary provider-account__more">
        <Menu
          align="right"
          drop="down"
          label={`${account.label} account actions`}
          disabled={props.busy}
          triggerClassName="set-button set-button--quiet set-button--icon"
          panelClassName="menu--compact"
          trigger={() => <Ellipsis size={16} aria-hidden />}
        >
          {(close) => (
            <>
              {!signedIn && !props.active ? (
                <MenuItem
                  title="Set active"
                  icon={<Check size={14} aria-hidden />}
                  onClick={() => {
                    close()
                    props.onSetActive()
                  }}
                />
              ) : null}
              <MenuItem
                title="Rename"
                icon={<Pencil size={14} aria-hidden />}
                onClick={() => {
                  close()
                  props.onRename()
                }}
              />
              {isDesktop && account.home ? (
                <MenuItem
                  title="Open in Explorer"
                  icon={<FolderOpen size={14} aria-hidden />}
                  onClick={() => {
                    close()
                    void revealPath(account.home!)
                  }}
                />
              ) : null}
              {account.managed ? (
                <MenuItem
                  title="Delete folder"
                  icon={<Trash size={14} aria-hidden />}
                  className="menu__item--danger"
                  onClick={() => {
                    close()
                    props.onDeleteFolder()
                  }}
                />
              ) : null}
            </>
          )}
        </Menu>
      </div>
      {/* One action per row, in the roster's action slot: Sign in until the
          account names who it is, then Set active or the word Active. */}
      <div className="provider-row__primary provider-account__action">
        {props.signIn}
        {!signedIn ? null : props.active ? (
          <span className="provider-account__current">Active</span>
        ) : (
          <button
            className="set-button set-button--quiet"
            type="button"
            disabled={props.busy}
            aria-label={`Use ${account.label} for new ${props.provider.displayName} chats`}
            onClick={props.onSetActive}
          >
            Set active
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Signs one account in through the same sign-in terminal the provider rows
 * use, run in that account's folder. Shown until the account names who it is,
 * and while a sign-in runs. A clean exit asks the account who it is now, which
 * the server keeps as its identity; a failed one offers a retry.
 */
function AccountSignIn(props: {
  account: ProviderAccount
  provider: ProviderStatus
  transport: Transport
  onSignedIn: () => void
  onOpenTerminal?: ((target: ProviderLoginTerminalTarget) => void) | undefined
}) {
  const { account, provider, transport, onSignedIn, onOpenTerminal } = props
  const target = { provider: account.provider, accountId: account.id }
  const key = loginKey(target)
  const login = useSyncExternalStore(subscribeInstalls, () => installState(key))
  const [starting, setStarting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [startError, setStartError] = useState<string>()
  // Latched: a parent render must not ask twice for one finished sign-in.
  const confirmed = useRef(false)
  const succeeded = login?.phase === 'succeeded'
  useEffect(() => {
    if (!succeeded) {
      confirmed.current = false
      return
    }
    if (confirmed.current) return
    confirmed.current = true
    if (!onOpenTerminal) clearInstall(key)
    void transport
      .request('auth.status', { provider: account.provider, accountId: account.id })
      .catch(() => undefined)
      .finally(onSignedIn)
  }, [succeeded, key, transport, account.provider, account.id, onSignedIn, onOpenTerminal])

  const signedIn = account.email !== undefined || account.plan !== undefined
  const running = login?.phase === 'running'
  const busy = running || starting
  if (signedIn && !busy) return null

  const title = accountName(provider, account)
  const openTerminal = () =>
    onOpenTerminal?.({
      provider: account.provider,
      accountId: account.id,
      displayName: title,
      installKey: key,
    })
  const start = () => {
    setStarting(true)
    setStartError(undefined)
    void beginLogin(
      transport,
      target,
      // The expanded CLI opens its own browser; do not open the URL it prints as well.
      onOpenTerminal && provider.setup?.loginOpensBrowser !== false ? () => undefined : undefined,
    )
      .then(() => {
        if (installState(key)?.phase !== 'running' || installState(key)?.canceling) return
        openTerminal()
      })
      .catch((cause: unknown) => setStartError(errorMessage(cause)))
      .finally(() => setStarting(false))
  }
  const cancel = () => {
    setCanceling(true)
    void cancelInstall(transport, key)
      .catch((cause: unknown) => setStartError(errorMessage(cause)))
      .finally(() => setCanceling(false))
  }
  const stopping = canceling || login?.canceling === true
  const failed = login?.phase === 'failed' || startError !== undefined
  return (
    <>
      {startError ? <RowIssue message={startError} announce label="Sign-in problem" /> : null}
      {running && onOpenTerminal ? (
        <button className="set-button set-button--quiet" type="button" onClick={openTerminal}>
          Show terminal
        </button>
      ) : null}
      <button
        className="set-button"
        type="button"
        disabled={stopping}
        aria-label={busy ? `Cancel signing in to ${account.label}` : `Sign in to ${account.label}`}
        onClick={busy ? cancel : start}
      >
        {stopping ? 'Canceling…' : busy ? 'Cancel sign-in' : failed ? 'Retry sign-in' : 'Sign in'}
      </button>
    </>
  )
}

function RenameAccountForm(props: {
  account: ProviderAccount
  busy: boolean
  error?: string | undefined
  onCancel: () => void
  onSubmit: (label: string) => void
}) {
  const [label, setLabel] = useState(props.account.label)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (label.trim()) props.onSubmit(label.trim())
  }
  return (
    <form
      className="set-form provider-accounts__form"
      aria-label={`Rename ${props.account.label}`}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || props.busy) return
        event.stopPropagation()
        props.onCancel()
      }}
    >
      <label className="set-form__wide">
        <span>Name</span>
        <input
          className="set-input"
          value={label}
          maxLength={80}
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      {props.error ? (
        <p className="set-form__error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="set-form__actions">
        <button
          className="set-button set-button--quiet"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          className="set-button set-button--primary"
          type="submit"
          disabled={props.busy || !label.trim()}
        >
          {props.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

const HOME_OPTIONS = [
  { value: 'managed', label: 'New folder' },
  { value: 'existing', label: 'Existing folder' },
] as const

function AddAccountForm(props: {
  providers: readonly ProviderStatus[]
  busy: boolean
  error?: string | undefined
  onCancel: () => void
  onSubmit: (provider: ProviderId, label: string, home: ProviderAccountHome) => void
}) {
  const pathId = useId()
  const [provider, setProvider] = useState<ProviderId>(props.providers[0]!.id)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<ProviderAccountHome['kind']>('managed')
  const [folder, setFolder] = useState('')
  const chosen = props.providers.find((status) => status.id === provider) ?? props.providers[0]!
  const ready = label.trim() !== '' && (kind === 'managed' || folder.trim() !== '')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || props.busy) return
    props.onSubmit(
      chosen.id,
      label.trim(),
      kind === 'managed' ? { kind } : { kind, path: folder.trim() },
    )
  }
  const browse = async () => {
    const picked = await pickFolder().catch(() => undefined)
    if (picked) setFolder(picked)
  }

  return (
    <form
      className="set-form provider-accounts__form"
      aria-label="Add account"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || props.busy) return
        event.stopPropagation()
        props.onCancel()
      }}
    >
      {props.providers.length > 1 ? (
        <div className="set-form__field">
          <span>Provider</span>
          <Menu
            align="left"
            drop="down"
            label={`Provider, ${chosen.displayName}`}
            panelLabel="Provider"
            panelClassName="provider-form__menu"
            triggerClassName="provider-form__select set-select"
            trigger={(open) => (
              <>
                <span className="provider-form__select-value">
                  <ProviderIcon mark={providerMark(chosen.id)} size={16} />
                  {chosen.displayName}
                </span>
                <ChevronDown className={open ? 'is-open' : undefined} size={14} aria-hidden />
              </>
            )}
          >
            {(close) =>
              props.providers.map((status) => (
                <MenuItem
                  key={status.id}
                  title={status.displayName}
                  icon={<ProviderIcon mark={providerMark(status.id)} size={16} />}
                  active={status.id === chosen.id}
                  onClick={() => {
                    setProvider(status.id)
                    close()
                  }}
                />
              ))
            }
          </Menu>
        </div>
      ) : null}
      <label className={props.providers.length > 1 ? undefined : 'set-form__wide'}>
        <span>Name</span>
        <input
          className="set-input"
          value={label}
          maxLength={80}
          placeholder="Work"
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="set-form__field set-form__wide">
        <span>Folder</span>
        <SettingsSegmented
          ariaLabel="Account folder"
          value={kind}
          options={HOME_OPTIONS}
          onChange={(value) => setKind(value === 'existing' ? 'existing' : 'managed')}
        />
      </div>
      {kind === 'existing' ? (
        <div className="set-form__field set-form__wide">
          <label htmlFor={pathId}>Folder path</label>
          <div className="provider-accounts__path">
            <input
              id={pathId}
              className="set-input"
              value={folder}
              spellCheck={false}
              onChange={(event) => setFolder(event.target.value)}
            />
            {isDesktop ? (
              <button className="set-button" type="button" onClick={() => void browse()}>
                Choose…
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="set-form__note">
        {kind === 'managed'
          ? `TasteCode makes a new, empty folder for this account, so ${chosen.displayName} starts there with its default settings. Sign in once it is added.`
          : `A folder that already holds a ${chosen.displayName} sign-in. TasteCode uses it as it is and never deletes it.`}
      </p>
      {props.error ? (
        <p className="set-form__error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="set-form__actions">
        <button
          className="set-button set-button--quiet"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          className="set-button set-button--primary"
          type="submit"
          disabled={props.busy || !ready}
        >
          {props.busy ? 'Adding…' : 'Add account'}
        </button>
      </div>
    </form>
  )
}
