import { useState } from 'react'
import type { ProviderId } from '@harness/contracts'

/**
 * First run. One screen, no wizard.
 *
 * The honest framing is the point: we are not collecting credentials, we are
 * asking which tools are already on the machine. Sign-in happens in the
 * vendor's own CLI, which is the only compliant way to use a subscription —
 * see rules/security.md.
 */

type Plan = { label: string; note?: string }

export type ProviderCard = {
  id: ProviderId
  name: string
  plans: Plan[]
  /** The command that authenticates this provider, run by the user, not by us. */
  signInCommand: string
  ready: boolean
}

export const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: 'codex',
    name: 'Codex',
    plans: [
      { label: 'ChatGPT Plus' },
      { label: 'Pro' },
      { label: 'Business' },
      { label: 'API key' },
    ],
    signInCommand: 'codex login',
    ready: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    plans: [{ label: 'Claude Pro' }, { label: 'Max' }, { label: 'API key' }],
    signInCommand: 'claude auth login',
    ready: false,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    plans: [{ label: 'Pro' }, { label: 'Pro+' }, { label: 'Ultra' }],
    signInCommand: 'cursor-agent login',
    ready: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    plans: [{ label: 'Any provider' }, { label: 'Local models' }],
    signInCommand: 'opencode auth login',
    ready: false,
  },
]

export function Onboarding({ onDone }: { onDone: (id: ProviderId) => void }) {
  const [selected, setSelected] = useState<ProviderId | undefined>()

  return (
    <div className="onboard">
      <div className="onboard__inner">
        <h1 className="onboard__title">Connect a coding agent</h1>
        <p className="onboard__lede">
          Personal Harness drives the tools already installed on this machine. You sign in with the
          vendor&rsquo;s own command — we never see a password, a token, or your code.
        </p>

        <ul className="cards">
          {PROVIDER_CARDS.map((card) => (
            <li key={card.id}>
              <button
                className={`card ${selected === card.id ? 'is-selected' : ''}`}
                onClick={() => card.ready && setSelected(card.id)}
                disabled={!card.ready}
              >
                <span className="card__head">
                  <span className="card__name">{card.name}</span>
                  <span className={`card__state ${card.ready ? '' : 'is-muted'}`}>
                    {card.ready ? (selected === card.id ? 'Selected' : 'Available') : 'Coming soon'}
                  </span>
                </span>
                <span className="card__plans">
                  {card.plans.map((plan) => (
                    <span className="chip" key={plan.label}>
                      {plan.label}
                    </span>
                  ))}
                </span>
                {selected === card.id ? (
                  <span className="card__cmd">
                    Not signed in yet? Run <code>{card.signInCommand}</code> once in a terminal.
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        <div className="onboard__foot">
          <button className="btn" disabled={!selected} onClick={() => selected && onDone(selected)}>
            Continue
          </button>
          <span className="onboard__note">You can add the others later.</span>
        </div>
      </div>
    </div>
  )
}
