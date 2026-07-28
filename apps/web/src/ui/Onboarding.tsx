import type { ProviderId } from '@harness/contracts'

/**
 * One step, once. Everything else the app can infer or ask for later.
 *
 * The honest framing matters here: we are not asking for credentials, we are
 * asking which tool the user already has. Saying so up front is the strongest
 * thing we can say on this screen — see rules/security.md for why we can.
 */

export type ProviderChoice = {
  id: ProviderId
  name: string
  detail: string
  available: boolean
}

export const PROVIDERS: ProviderChoice[] = [
  {
    id: 'codex',
    name: 'Codex',
    detail: 'ChatGPT Plus, Pro or an API key',
    available: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    detail: 'Claude Pro or Max',
    available: false,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detail: 'Cursor Pro',
    available: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detail: 'Bring any model',
    available: false,
  },
]

export function Onboarding({ onPick }: { onPick: (id: ProviderId) => void }) {
  return (
    <div className="onboard">
      <div className="onboard__inner">
        <p className="label">Step 1 of 1</p>
        <h1 className="onboard__title">Which agent do you run?</h1>
        <p className="onboard__lede">
          Personal Harness drives the tool you already installed. Your subscription stays where it
          is — we never ask for a password, and nothing leaves this machine.
        </p>

        <ul className="onboard__list">
          {PROVIDERS.map((provider) => (
            <li key={provider.id}>
              <button
                className="pick"
                onClick={() => onPick(provider.id)}
                disabled={!provider.available}
              >
                <span className="pick__name">{provider.name}</span>
                <span className="pick__detail">{provider.detail}</span>
                <span className={`pick__state ${provider.available ? 'is-ready' : ''}`}>
                  {provider.available ? 'Ready' : 'Soon'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="onboard__foot label">Changeable later in settings</p>
      </div>
    </div>
  )
}
