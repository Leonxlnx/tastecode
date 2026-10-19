import { DEFAULT_ACCOUNT_ID, type ProviderId } from '@harness/contracts'
import { IconUserCircle as UserCircle } from '@tabler/icons-react'
import { accountsOf, activeAccountOf, useProviderAccounts } from '../provider-accounts-state.js'
import type { Transport } from '../transport.js'
import { Menu, MenuItem } from './Menu.js'
import '../styles/composer-account.css'

/**
 * Which of the provider's accounts a new chat starts on, beside the other
 * composer tools. Shown only once the provider has a second account. Picking
 * one makes it the provider's active account, which is what the server pins a
 * new chat to when the chat names none.
 */
export function ComposerAccountChip(props: { transport: Transport; provider: ProviderId }) {
  const { store, snapshot } = useProviderAccounts(props.transport, true)
  const accounts = accountsOf(snapshot, props.provider)
  if (accounts.length < 2) return null
  const activeId = activeAccountOf(snapshot, props.provider)
  const active = accounts.find((account) => account.id === activeId) ?? accounts[0]!

  return (
    // Named apart from the sidebar's Account menu, which shows who is signed in.
    <Menu
      label="New chat account"
      triggerTitle={`New chat account: ${active.label}`}
      triggerClassName="composer__account"
      panelLabel="Account"
      panelClassName="menu--compact"
      trigger={() => (
        <span className="tool">
          <UserCircle size={13} aria-hidden />
          <span>{active.label}</span>
        </span>
      )}
    >
      {(close) =>
        accounts.map((account) => (
          <MenuItem
            key={account.id}
            title={account.label}
            // A further account that never signed in cannot run a chat yet; the
            // default account's sign-in shows on its provider.
            detail={
              account.id !== DEFAULT_ACCOUNT_ID &&
              account.email === undefined &&
              account.plan === undefined
                ? 'Not signed in'
                : undefined
            }
            icon={<UserCircle size={14} aria-hidden />}
            active={account.id === active.id}
            onClick={() => {
              close()
              void store.setActive(props.provider, account.id).catch(() => undefined)
            }}
          />
        ))
      }
    </Menu>
  )
}
