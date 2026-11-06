import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  readAppBackground,
  subscribeAppBackground,
  windowMaterialSupport,
} from '../../app-background.js'
import { canNotifyChats, isDesktop } from '../../bridge.js'
import type { Transport } from '../../transport.js'
import { type Account, type ProviderStatus } from '@harness/contracts'
import { useProviderAccounts } from '../../provider-accounts-state.js'
import { rememberedAccountReads } from '../../provider-account-reads.js'
import { lastSignIn } from '../../remembered-sign-in.js'
import { executablePathEntries, providerTuningEntries } from './provider-tuning-search.js'
import { getFastServiceTier } from '../model-selector-utils.js'
import {
  searchSettings,
  SETTINGS_SEARCH_ENTRIES,
  type SettingsSearchEntry,
} from './settings-search.js'

export function SettingsSearch(props: {
  children: ReactNode
  transport: Transport
  providers: readonly ProviderStatus[]
  provider: string
  account: Account | undefined
  providerDefaults: boolean
  phone: boolean
  debug: boolean
  haptics: boolean
  fontSmoothing: boolean
  onChoose: (entry: SettingsSearchEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const [backgroundOptions, setBackgroundOptions] = useState({ effort: false, speed: false })
  const searching = query.trim().length > 0
  const { snapshot } = useProviderAccounts(
    props.transport,
    searching &&
      props.providerDefaults &&
      props.providers.some(
        (status) => status.installed && status.capabilities?.multipleAccounts === true,
      ),
  )
  const signedIn = new Map(rememberedAccountReads(props.transport))
  for (const status of props.providers) {
    if (!signedIn.has(status.id)) {
      const signed = status.installed ? lastSignIn(status.id) : undefined
      if (signed !== undefined || status.auth === 'authenticated') {
        signedIn.set(status.id, { signedIn: signed ?? true })
      }
    }
  }
  if (props.account) signedIn.set(props.provider, props.account)
  const providerEntries = [
    ...(props.providerDefaults
      ? providerTuningEntries(props.providers, snapshot.accounts, signedIn)
      : []),
    ...executablePathEntries(props.providers),
  ]
  useEffect(() => {
    if (!searching) return
    let current = true
    void props.transport
      .request('backgroundModel.settings', {})
      .then((state) => {
        if (!current) return
        const target = state.preference.mode === 'manual' ? state.preference.target : undefined
        const source = state.sources.find(
          (item) =>
            target &&
            item.provider === target.provider &&
            item.connectionId === target.connectionId &&
            item.agent === target.agent,
        )
        const model = source?.models.find((item) => item.id === target?.model)
        setBackgroundOptions({
          effort: (model?.reasoningEfforts.length ?? 0) > 0,
          speed: !!getFastServiceTier(model),
        })
      })
      .catch(() => {
        if (current) setBackgroundOptions({ effort: false, speed: false })
      })
    return () => {
      current = false
    }
  }, [searching, props.transport])
  const background = useSyncExternalStore(
    subscribeAppBackground,
    readAppBackground,
    readAppBackground,
  )
  const results = searchSettings(
    query,
    [...SETTINGS_SEARCH_ENTRIES, ...providerEntries].filter(
      (entry) =>
        entry.visible?.({
          phone: props.phone,
          debug: props.debug,
          desktop: isDesktop,
          notifications: canNotifyChats,
          haptics: props.haptics,
          fontSmoothing: props.fontSmoothing,
          backgroundMode: background.mode,
          backgroundImage: background.image !== undefined,
          material: windowMaterialSupport() === 'material',
          backgroundEffort: backgroundOptions.effort,
          backgroundSpeed: backgroundOptions.speed,
        }) !== false,
    ),
  )
  const selected = Math.min(active, Math.max(0, results.length - 1))
  const choose = (entry: SettingsSearchEntry) => {
    setQuery('')
    setActive(0)
    props.onChoose(entry)
  }
  return (
    <>
      <input
        className="set-input settings-search__input"
        aria-label="Search settings"
        placeholder="Search settings…"
        role="combobox"
        aria-expanded={query.trim().length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && query) {
            event.preventDefault()
            event.stopPropagation()
            setQuery('')
            setActive(0)
          } else if (event.key === 'ArrowDown' && results.length) {
            event.preventDefault()
            setActive((selected + 1) % results.length)
            document
              .getElementById(`${listId}-${(selected + 1) % results.length}`)
              ?.scrollIntoView?.({ block: 'nearest' })
          } else if (event.key === 'ArrowUp' && results.length) {
            event.preventDefault()
            setActive((selected - 1 + results.length) % results.length)
            document
              .getElementById(`${listId}-${(selected - 1 + results.length) % results.length}`)
              ?.scrollIntoView?.({ block: 'nearest' })
          } else if (event.key === 'Enter' && results[selected]) {
            event.preventDefault()
            choose(results[selected])
          }
        }}
      />
      {query.trim() ? (
        <>
          <div className="settings-search__count" role="status">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </div>
          <div
            className="settings__nav settings-search__results"
            role="listbox"
            id={listId}
            aria-label="Settings results"
          >
            {results.map((entry, index) => (
              <div
                key={entry.id}
                role="option"
                id={`${listId}-${index}`}
                aria-selected={index === selected}
                className={`settings__nav-item${index === selected ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                {entry.title}
              </div>
            ))}
            {!results.length ? (
              <p className="settings-search__empty">No matching settings</p>
            ) : null}
          </div>
        </>
      ) : (
        props.children
      )}
    </>
  )
}
