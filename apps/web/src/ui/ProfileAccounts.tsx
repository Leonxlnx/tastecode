import { useEffect, useId, useRef, useState } from 'react'
import type { Account, ProviderId, ProviderStatus } from '@harness/contracts'
import { providerMark } from '../provider-presentation.js'
import type { Transport } from '../transport.js'
import { ProviderIcon } from './ProviderIcon.js'
import { SettingsEmpty, SettingsRow } from './settings/SettingsLayout.js'
import { Skeleton, SkeletonRows, SkeletonStatus } from './Skeleton.js'

type AccountRead =
  { phase: 'loading' } | { phase: 'ready'; account: Account } | { phase: 'error'; message: string }

/** The last answer per provider and connection, kept across visits to Profile. */
const knownReads = new WeakMap<Transport, Partial<Record<ProviderId, AccountRead>>>()

/**
 * The last sign-in and plan each provider reported, kept on this device so
 * the first visit after a launch shows rows at once instead of waiting for
 * every provider's CLI. Only what a row shows is kept: never an email.
 */
const LAST_KNOWN_KEY = 'harness.profileAccounts'

type LastKnown = Map<string, Account>

function shownAccount(account: Account): Account {
  return account.plan === undefined
    ? { signedIn: account.signedIn }
    : { signedIn: account.signedIn, plan: account.plan }
}

function readLastKnown(): LastKnown {
  const known: LastKnown = new Map()
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LAST_KNOWN_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object') return known
    for (const [provider, value] of Object.entries(stored)) {
      if (!value || typeof value !== 'object') continue
      const { signedIn, plan } = value as { signedIn?: unknown; plan?: unknown }
      if (typeof signedIn !== 'boolean') continue
      if (plan !== undefined && typeof plan !== 'string') continue
      known.set(provider, plan === undefined ? { signedIn } : { signedIn, plan })
    }
  } catch {
    // Unreadable or blocked storage only means a first visit waits for its checks.
  }
  return known
}

function rememberAccount(provider: ProviderId, account: Account): void {
  try {
    const known = readLastKnown()
    const next = JSON.stringify(shownAccount(account))
    const previous = known.get(provider)
    if (previous && JSON.stringify(previous) === next) return
    known.set(provider, shownAccount(account))
    localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(Object.fromEntries(known)))
  } catch {
    // A display cache: the row still shows the answer when storage is full or blocked.
  }
}

/** The account the app already reads for the provider in use, so Profile does not ask twice. */
export type CurrentAccount = {
  provider: ProviderId
  account: Account | undefined
  loading: boolean
}

/**
 * Who each provider on this device is signed in as: one row per installed
 * provider that signs in with an account, with its plan. This is where a
 * provider's further accounts will be listed; email addresses stay in
 * Providers, behind their reveal.
 */
export function ProfileAccounts(props: {
  transport: Transport
  /** Undefined until the provider list has arrived. */
  providers: ProviderStatus[] | undefined
  current?: CurrentAccount | undefined
  onManage?: (() => void) | undefined
}) {
  const titleId = useId()
  // A provider signs in with an account when its adapter declares a sign-in setup.
  const signIns = (props.providers ?? []).filter(
    (status) => status.installed && status.setup !== undefined,
  )
  const current = props.current
  const fromApp = (provider: ProviderId) =>
    current?.provider === provider && (current.account !== undefined || current.loading)
  const unread = signIns
    .map((status) => status.id)
    .filter((provider) => !fromApp(provider))
    .join('|')

  // A visit starts from what the last one learned and refreshes it, instead
  // of a skeleton per provider until each sign-in check answers.
  const [reads, setReads] = useState<Partial<Record<ProviderId, AccountRead>>>(
    () => knownReads.get(props.transport) ?? {},
  )
  // The first visit of a connection starts from what an earlier launch read.
  const [lastKnown] = useState(readLastKnown)
  // Each provider is asked once per connection, however often the list changes.
  const asked = useRef<{ transport: Transport; providers: Set<string> } | undefined>(undefined)
  useEffect(() => {
    if (asked.current?.transport !== props.transport) {
      asked.current = { transport: props.transport, providers: new Set() }
    }
    const batch = asked.current
    for (const provider of unread.split('|') as ProviderId[]) {
      if (!provider || batch.providers.has(provider)) continue
      batch.providers.add(provider)
      const settle = (read: AccountRead) => {
        knownReads.set(batch.transport, { ...knownReads.get(batch.transport), [provider]: read })
        if (read.phase === 'ready') rememberAccount(provider, read.account)
        if (asked.current === batch) setReads((known) => ({ ...known, [provider]: read }))
      }
      props.transport.request('auth.status', { provider }).then(
        (account) => settle({ phase: 'ready', account }),
        (cause: unknown) =>
          settle({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      )
    }
  }, [props.transport, unread])

  // The app's own read of the provider in use is kept for the next launch too.
  const currentProvider = current?.provider
  const currentAccount = current?.account
  useEffect(() => {
    if (currentProvider && currentAccount) rememberAccount(currentProvider, currentAccount)
  }, [currentProvider, currentAccount])

  // While a check runs, a row shows what this connection or an earlier launch
  // last read; a skeleton only when nothing is known yet.
  const readOf = (provider: ProviderId): AccountRead => {
    if (current?.provider === provider && current.account) {
      return { phase: 'ready', account: current.account }
    }
    const known = reads[provider]
    if (known) return known
    const remembered = lastKnown.get(provider)
    return remembered ? { phase: 'ready', account: remembered } : { phase: 'loading' }
  }

  return (
    <section className="profile-section profile-accounts" aria-labelledby={titleId}>
      <div className="profile-section__head">
        <div className="profile-section__heading">
          <h2 className="profile-section__title" id={titleId}>
            Accounts
          </h2>
        </div>
        {props.onManage ? (
          <div className="profile-section__actions">
            <button className="set-button set-button--quiet" type="button" onClick={props.onManage}>
              Manage
            </button>
          </div>
        ) : null}
      </div>
      {!props.providers ? (
        <SkeletonStatus label="Loading accounts…" className="profile-accounts__loading">
          <SkeletonRows rows={2} icon="circle" />
        </SkeletonStatus>
      ) : signIns.length === 0 ? (
        <SettingsEmpty
          title="No provider is set up yet"
          detail="Providers lists the ones you can install and sign in to."
        />
      ) : (
        signIns.map((status) => {
          const read = readOf(status.id)
          return (
            <SettingsRow
              key={status.id}
              name={
                <span className="profile-accounts__provider">
                  <ProviderIcon mark={providerMark(status.id)} size={13} />
                  {status.displayName}
                </span>
              }
              tone={read.phase === 'ready' && read.account.signedIn ? undefined : 'muted'}
            >
              <AccountValue read={read} provider={status.displayName} />
            </SettingsRow>
          )
        })
      )}
    </section>
  )
}

function AccountValue(props: { read: AccountRead; provider: string }) {
  const { read } = props
  if (read.phase === 'loading') {
    return (
      <SkeletonStatus label={`Checking ${props.provider}…`} className="profile-accounts__checking">
        <Skeleton width={56} height={9} />
      </SkeletonStatus>
    )
  }
  if (read.phase === 'error') {
    return (
      <span className="profile-accounts__state" title={read.message}>
        Unavailable
      </span>
    )
  }
  if (!read.account.signedIn) return <span className="profile-accounts__state">Signed out</span>
  return <span>{read.account.plan ?? 'Signed in'}</span>
}
