import { useEffect, useState } from 'react'
import type { Account, ProviderId } from '@harness/contracts'
import { LoaderCircle } from 'lucide-react'
import type { Transport } from '../transport.js'

/**
 * First run: welcome, pick an agent, sign in, done.
 *
 * The sign-in step is the real vendor OAuth flow — we hand the user a URL,
 * they authenticate on the vendor's own site, and we wait for the vendor to
 * tell us it worked. At no point do we see a password or a token, which is
 * both the compliant design and the honest thing to say on this screen.
 */

type Step = 'welcome' | 'provider' | 'agent' | 'signin' | 'done'

/** One row of `acp.agents`, as the server reports it. */
type AcpAgent = {
  id: string
  name: string
  installed: boolean
  verified: boolean
  install?: string | undefined
}

export type ProviderCard = {
  id: ProviderId
  name: string
  blurb: string
  plans: string[]
  ready: boolean
}

export const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: 'codex',
    name: 'Codex',
    blurb: 'OpenAI’s agent, signed in with your ChatGPT account',
    plans: ['Plus', 'Pro', 'Business', 'API key'],
    ready: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: 'Anthropic’s agent, signed in with your Claude account',
    plans: ['Pro', 'Max', 'API key'],
    ready: true,
  },
  {
    id: 'acp',
    name: 'Any ACP agent',
    blurb: 'Gemini, Kimi, Qwen — anything speaking the open protocol',
    plans: ['Your own account', 'API key'],
    ready: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'The Cursor agent, outside the editor',
    plans: ['Pro', 'Pro+', 'Ultra'],
    ready: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    blurb: 'Open source, any model you like',
    plans: ['Any provider', 'Local models'],
    ready: false,
  },
]

export function Onboarding(props: {
  transport: Transport
  onDone: (provider: ProviderId, agent?: { id: string; name: string }) => void
}) {
  const [step, setStep] = useState<Step>('welcome')
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [agent, setAgent] = useState<AcpAgent | undefined>()
  const [account, setAccount] = useState<Account | undefined>()

  const card = PROVIDER_CARDS.find((entry) => entry.id === provider)!
  // ACP agents sign themselves in on first run, so there is no sign-in step to
  // show — asking for one would be inventing a screen with nothing behind it.
  const afterProvider: Step = provider === 'acp' ? 'agent' : 'signin'

  // Someone who already ran `codex login` should not be asked to do it again.
  useEffect(() => {
    if (step !== 'signin') return
    void props.transport
      .request('auth.status', { provider })
      .then((status) => {
        setAccount(status)
        if (status.signedIn) setStep('done')
      })
      .catch(() => setAccount({ signedIn: false }))
  }, [props.transport, provider, step])

  return (
    <div className="onboard">
      <div className="onboard__inner" key={step}>
        {step === 'welcome' ? (
          <Welcome onNext={() => setStep('provider')} />
        ) : step === 'provider' ? (
          <PickProvider
            selected={provider}
            onSelect={setProvider}
            onBack={() => setStep('welcome')}
            onNext={() => setStep(afterProvider)}
          />
        ) : step === 'agent' ? (
          <PickAcpAgent
            transport={props.transport}
            selected={agent}
            onSelect={setAgent}
            onBack={() => setStep('provider')}
            onNext={() => setStep('done')}
          />
        ) : step === 'signin' ? (
          <SignIn
            transport={props.transport}
            card={card}
            account={account}
            onBack={() => setStep('provider')}
            onDone={(next) => {
              setAccount(next)
              setStep('done')
            }}
          />
        ) : (
          <Done
            card={card}
            agentName={agent?.name}
            account={account}
            onFinish={() =>
              props.onDone(provider, agent ? { id: agent.id, name: agent.name } : undefined)
            }
          />
        )}
      </div>

      <ol className="steps" aria-label="Progress">
        {(['welcome', 'provider', afterProvider, 'done'] as Step[]).map((entry) => (
          <li key={entry} className={`steps__dot ${entry === step ? 'is-on' : ''}`} />
        ))}
      </ol>
    </div>
  )
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="pane">
      <h1 className="pane__title">Personal Harness</h1>
      <p className="pane__lede">
        One window for every coding agent you use, and every plan you already pay for. Nothing you
        write, run, or open leaves this machine.
      </p>
      <ul className="facts">
        <li>
          <strong>Bring what you have.</strong> Your subscription stays with its vendor. We drive
          their tool; we never ask for a password.
        </li>
        <li>
          <strong>Local by default.</strong> No account with us, no telemetry, no cloud in the
          middle.
        </li>
        <li>
          <strong>Yours to change.</strong> Open source, and built to be forked.
        </li>
      </ul>
      <div className="pane__foot">
        <button className="btn" onClick={onNext}>
          Get started
        </button>
      </div>
    </div>
  )
}

function PickProvider(props: {
  selected: ProviderId
  onSelect: (id: ProviderId) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="pane">
      <h1 className="pane__title">Which agent do you want first?</h1>
      <p className="pane__lede">You can add the others whenever you like.</p>

      <ul className="cards">
        {PROVIDER_CARDS.map((card) => (
          <li key={card.id}>
            <button
              className={`card ${props.selected === card.id ? 'is-selected' : ''}`}
              onClick={() => card.ready && props.onSelect(card.id)}
              disabled={!card.ready}
            >
              <span className="card__head">
                <span className="card__name">{card.name}</span>
                {card.ready ? null : <span className="card__state">Coming soon</span>}
              </span>
              <span className="card__blurb">{card.blurb}</span>
              <span className="card__plans">
                {card.plans.map((plan) => (
                  <span className="chiplet" key={plan}>
                    {plan}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="pane__foot">
        <button className="ghost" onClick={props.onBack}>
          Back
        </button>
        <button className="btn" onClick={props.onNext}>
          Continue
        </button>
      </div>
    </div>
  )
}

/**
 * Which ACP agent to drive.
 *
 * The list comes from the server because only it can look at this machine.
 * Agents that are not installed stay visible with the command that installs
 * them — hiding them would leave the user wondering why the app claims to
 * support something they cannot see.
 */
function PickAcpAgent(props: {
  transport: Transport
  selected: AcpAgent | undefined
  onSelect: (agent: AcpAgent) => void
  onBack: () => void
  onNext: () => void
}) {
  const [agents, setAgents] = useState<AcpAgent[] | undefined>()

  useEffect(() => {
    let cancelled = false
    void props.transport
      .request('acp.agents', {})
      .then((result) => {
        if (cancelled) return
        setAgents(result.agents)
        // Preselect the first one actually present, so the common case is one
        // click rather than two.
        const first = result.agents.find((entry) => entry.installed)
        if (first) props.onSelect(first)
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
    // Runs once: re-running would fight the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.transport])

  return (
    <div className="pane">
      <h1 className="pane__title">Which ACP agent?</h1>
      <p className="pane__lede">
        These all speak the same open protocol, so Personal Harness drives them through one
        integration. Each signs in with its own account, on its own.
      </p>

      {agents === undefined ? (
        <p className="pane__lede">Looking for agents on this machine…</p>
      ) : (
        <ul className="cards">
          {agents.map((entry) => (
            <li key={entry.id}>
              <button
                className={`card ${props.selected?.id === entry.id ? 'is-selected' : ''}`}
                onClick={() => entry.installed && props.onSelect(entry)}
                disabled={!entry.installed}
              >
                <span className="card__head">
                  <span className="card__name">{entry.name}</span>
                  {entry.installed ? null : <span className="card__state">Not installed</span>}
                </span>
                <span className="card__blurb">
                  {entry.installed
                    ? entry.verified
                      ? 'Tested against this build'
                      : 'Supported, but not tested by us yet'
                    : (entry.install ?? 'Install it, then come back')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {agents?.some((entry) => entry.installed) === false ? (
        <p className="pane__error">
          None of these are installed yet. Install one and reopen this step.
        </p>
      ) : null}

      <div className="pane__foot">
        <button className="ghost" onClick={props.onBack}>
          Back
        </button>
        <button className="btn" disabled={!props.selected} onClick={props.onNext}>
          Continue
        </button>
      </div>
    </div>
  )
}

function SignIn(props: {
  transport: Transport
  card: ProviderCard
  account: Account | undefined
  onBack: () => void
  onDone: (account: Account) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'failed'>('idle')
  const [loginId, setLoginId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)

  // The vendor tells us when the browser half finished. Polling would be both
  // slower and wrong — the user may take a minute in a password manager.
  useEffect(() => {
    return props.transport.on('auth.event', (event) => {
      if (loginId && event.loginId !== loginId) return
      if (event.success) {
        void props.transport.request('auth.status', { provider: props.card.id }).then(props.onDone)
      } else {
        setPhase('failed')
        setError(event.error ?? 'Sign-in was cancelled.')
      }
    })
  }, [props.transport, props.card.id, loginId, props.onDone])

  const startBrowserLogin = async () => {
    setError(undefined)
    setPhase('waiting')
    try {
      const { loginId: id, authUrl } = await props.transport.request('auth.startLogin', {
        provider: props.card.id,
      })
      setLoginId(id)
      window.open(authUrl, '_blank', 'noopener')
    } catch (e) {
      setPhase('failed')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const useKey = async () => {
    setError(undefined)
    try {
      const account = await props.transport.request('auth.useApiKey', {
        provider: props.card.id,
        apiKey: apiKey.trim(),
      })
      props.onDone(account)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="pane">
      <h1 className="pane__title">Sign in to {props.card.name}</h1>
      <p className="pane__lede">
        This opens {props.card.name}’s own sign-in page in your browser. Your password and token
        never pass through Personal Harness.
      </p>

      {phase === 'waiting' ? (
        <div className="waiting">
          <LoaderCircle className="spinner" aria-hidden />
          <div>
            <p className="waiting__title">Waiting for your browser…</p>
            <p className="waiting__note">
              Finish signing in there and this window will continue on its own.
            </p>
          </div>
        </div>
      ) : (
        <button className="btn btn--wide" onClick={() => void startBrowserLogin()}>
          Sign in with {props.card.name}
        </button>
      )}

      {error ? <p className="pane__error">{error}</p> : null}

      <details className="alt">
        <summary>Use an API key instead</summary>
        <p className="alt__note">
          Billed per token by the vendor. Stored in your operating system’s credential store, never
          in a file we write.
        </p>
        <div className="alt__row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="ghost" onClick={() => setShowKey(!showKey)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button className="btn" disabled={apiKey.trim() === ''} onClick={() => void useKey()}>
            Use key
          </button>
        </div>
      </details>

      <div className="pane__foot">
        <button className="ghost" onClick={props.onBack}>
          Back
        </button>
        {phase === 'waiting' && loginId ? (
          <button
            className="ghost"
            onClick={() => {
              void props.transport.request('auth.cancelLogin', {
                provider: props.card.id,
                loginId,
              })
              setPhase('idle')
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Done(props: {
  card: ProviderCard
  agentName?: string | undefined
  account: Account | undefined
  onFinish: () => void
}) {
  return (
    <div className="pane">
      <h1 className="pane__title">You’re set</h1>
      <div className="signed">
        <span className="signed__name">{props.agentName ?? props.card.name}</span>
        {props.account?.plan ? <span className="chiplet">{props.account.plan}</span> : null}
        {props.account?.email ? <span className="signed__email">{props.account.email}</span> : null}
      </div>
      <p className="pane__lede">
        Add a project folder and start a session. Everything else — more agents, models, permissions
        — is a click away and changeable later.
      </p>
      <div className="pane__foot">
        <button className="btn" onClick={props.onFinish}>
          Open Personal Harness
        </button>
      </div>
    </div>
  )
}
