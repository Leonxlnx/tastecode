import type { AccountIdentity } from '../provider-accounts-state.js'
import '../styles/account-badge.css'

/**
 * An account's colour. It only ever backs up a name: the account's label is
 * always on screen beside it or in the control's accessible name.
 */
export function AccountDot(props: { tone: number; className?: string | undefined }) {
  return (
    <span
      className={`account-dot${props.className ? ` ${props.className}` : ''}`}
      data-account-tone={props.tone}
      aria-hidden
    />
  )
}

/** Which account: its colour and its label, with the plan on hover. */
export function AccountBadge(props: { account: AccountIdentity; className?: string | undefined }) {
  const { account } = props
  return (
    <span
      className={`account-badge${props.className ? ` ${props.className}` : ''}`}
      data-account-tone={account.tone}
      title={account.plan ? `${account.label} · ${account.plan}` : account.label}
    >
      <span className="account-badge__dot" aria-hidden />
      <span className="account-badge__label">{account.label}</span>
    </span>
  )
}
