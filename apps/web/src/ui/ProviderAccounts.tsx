import { lazy, Suspense, useId, useState, type FormEvent } from 'react'
import {
  DEFAULT_ACCOUNT_ID,
  type ProviderAccount,
  type ProviderAccountHome,
  type ProviderId,
  type ProviderStatus,
} from '@harness/contracts'
import {
  IconChevronDown as ChevronDown,
  IconDots as Ellipsis,
  IconFolderOpen as FolderOpen,
  IconPencil as Pencil,
  IconTrash as Trash,
  IconUserMinus as UserMinus,
  IconUserPlus as UserPlus,
} from '@tabler/icons-react'
import { errorMessage } from '../boundary.js'
import { isDesktop, pickFolder, revealPath } from '../bridge.js'
import { providerMark } from '../model-catalog.js'
import { accountsOf, activeAccountOf, useProviderAccounts } from '../provider-accounts-state.js'
import type { Transport } from '../transport.js'
import { AccountEmail } from './AccountEmail.js'
import { Menu, MenuItem } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'
import { RowIssue } from './RowIssue.js'
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

/**
 * Further sign-ins for the providers that can run as more than one account.
 * A provider is listed once it has a second account; until then the section
 * is its note and the add button. Removing an account keeps its folder;
 * deleting a folder TasteCode created is its own, confirmed action.
 */
export function ProviderAccountsSection(props: {
  transport: Transport
  /** Installed providers that declare `multipleAccounts`. */
  providers: readonly ProviderStatus[]
}) {
  const { store, snapshot } = useProviderAccounts(props.transport, props.providers.length > 0)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<Confirm>()
  const [busy, setBusy] = useState<string>()
  const [issues, setIssues] = useState<Record<string, string | undefined>>({})
  if (props.providers.length === 0) return null

  const run = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key)
    setIssues((current) => ({ ...current, [key]: undefined }))
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

  const listed = props.providers
    .map((status) => ({ status, accounts: accountsOf(snapshot, status.id) }))
    .filter((group) => group.accounts.length > 1)
  const names = props.providers.map((status) => status.displayName).join(' or ')

  return (
    <SettingsSection
      title="Accounts"
      note={`Sign in to ${names} more than once. Each account keeps its own folder, and a chat stays on the account it started on.`}
    >
      {snapshot.phase === 'error' ? (
        <p className="set-form__error provider-accounts__error" role="alert">
          Could not load accounts. {snapshot.error}
        </p>
      ) : null}
      {listed.flatMap(({ status, accounts }) =>
        accounts.map((account) => {
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
            <AccountRow
              key={key}
              account={account}
              provider={status}
              active={activeAccountOf(snapshot, status.id) === account.id}
              busy={busy === key}
              issue={issues[key]}
              onSetActive={() => void run(key, () => store.setActive(account.provider, account.id))}
              onRename={() => {
                setIssues((current) => ({ ...current, [key]: undefined }))
                setRenaming(key)
              }}
              onRemove={(deleteHome) => setConfirm({ account, deleteHome })}
            />
          )
        }),
      )}
      {adding ? (
        <AddAccountForm
          providers={props.providers}
          busy={busy === 'add'}
          error={issues.add}
          onCancel={() => {
            setIssues((current) => ({ ...current, add: undefined }))
            setAdding(false)
          }}
          onSubmit={(provider, label, home) =>
            void run('add', () => store.create(provider, label, home)).then((done) => {
              if (done) setAdding(false)
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
    </SettingsSection>
  )
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
function AccountIdentityText(props: { account: ProviderAccount }) {
  const { email, plan } = props.account
  if (!email && !plan) return <>Not signed in</>
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
  onSetActive: () => void
  onRename: () => void
  onRemove: (deleteHome: boolean) => void
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
        <p className="set-entity__name" title={account.home}>
          {account.label}
        </p>
      </div>
      <span className="set-leader" aria-hidden />
      <div className="provider-row__status set-entity__status">
        {props.issue ? <RowIssue message={props.issue} announce label="Problem details" /> : null}
        <span className="provider-row__status-text">
          <AccountIdentityText account={account} />
        </span>
      </div>
      <div className="provider-account__active">
        {props.active ? (
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
      <div className="provider-account__more">
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
              {account.id !== DEFAULT_ACCOUNT_ID ? (
                <MenuItem
                  title="Remove account"
                  icon={<UserMinus size={14} aria-hidden />}
                  onClick={() => {
                    close()
                    props.onRemove(false)
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
                    props.onRemove(true)
                  }}
                />
              ) : null}
            </>
          )}
        </Menu>
      </div>
      <div className="provider-row__primary" />
    </div>
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
          ? `TasteCode makes a folder for this account and copies your ${chosen.displayName} settings into it, never your sign-in. Sign in once it is added.`
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
