import type { ProviderId, ProviderStatus } from '@harness/contracts'
import {
  IconArrowLeft as ArrowLeft,
  IconCornerDownLeft as CornerDownLeft,
  IconFolderOpen as FolderOpen,
} from '@tabler/icons-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import '../styles/onboarding.css'
import { providerMark } from '../model-catalog.js'
import type { ThemePreference } from '../theme.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { ProviderIcon } from './ProviderIcon.js'
import { useDialogFocus } from './dialog-focus.js'

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'name', label: 'Your name' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'providers', label: 'Coding agents' },
  { id: 'project', label: 'First project' },
] as const
type StepId = (typeof STEPS)[number]['id']

const BETA_PLANS = [
  { id: 'codex', name: 'Codex', vendor: 'OpenAI' },
  { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic' },
  { id: 'grok', name: 'Grok', vendor: 'xAI' },
] as const satisfies ReadonlyArray<{ id: ProviderId; name: string; vendor: string }>

const THEME_CHOICES = [
  { value: 'system', label: 'System', note: 'Follows the OS setting' },
  { value: 'light', label: 'Light', note: 'Bright, high contrast' },
  { value: 'dark', label: 'Dark', note: 'Dimmed, low glare' },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; note: string }>

type Readiness = { label: string; tone: 'ready' | 'pending' | 'checking' }

/** One honest line per plan, derived from what the vendor binary told us. */
export function providerReadiness(status: ProviderStatus | undefined): Readiness {
  if (!status) return { label: 'Checking…', tone: 'checking' }
  if (!status.installed) return { label: 'Not installed', tone: 'pending' }
  if (status.problem) return { label: 'Needs attention', tone: 'pending' }
  if (status.auth === 'unauthenticated') return { label: 'Sign in needed', tone: 'pending' }
  return { label: status.auth === 'authenticated' ? 'Ready' : 'Installed', tone: 'ready' }
}

/**
 * First-run setup. Full-window and paged on purpose: each step asks one
 * question, applies its answer immediately (name, theme) and never blocks —
 * every page can be skipped and everything here is reachable again in Settings.
 */
export function Onboarding(props: {
  displayName?: string | undefined
  onDisplayNameChange?: ((name: string) => void) | undefined
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  providerStatuses: ProviderStatus[]
  onAddProject: () => void
  onOpenProviders: () => void
  onDismiss: () => void
  /** Kept mounted but hidden while Settings sits on top, so the page survives the round trip. */
  hidden?: boolean | undefined
}) {
  const [index, setIndex] = useState(0)
  // The page the user asked for while the current one is still animating out.
  // The swap happens when that animation ends, so the old page leaves before
  // the new one arrives instead of both fighting over the same frame.
  const [pending, setPending] = useState<number>()
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [closing, setClosing] = useState(false)
  const [enterHeld, setEnterHeld] = useState(false)
  const step: StepId = STEPS[index]?.id ?? 'welcome'
  const leaving = pending !== undefined
  const titleId = useId()
  const nameId = useId()
  const stepRef = useRef<HTMLElement>(null)
  const onDismiss = useRef(props.onDismiss)
  onDismiss.current = props.onDismiss
  const dismiss = () => setClosing(true)
  const dialog = useDialogFocus<HTMLDivElement>(dismiss)
  // Each page names one element to land focus on: its input when it has one,
  // otherwise the heading, so screen readers hear where the page went.
  const focusTarget = useRef<HTMLElement | null>(null)
  const setFocusTarget = (node: HTMLElement | null) => {
    focusTarget.current = node
  }

  useEffect(() => {
    focusTarget.current?.focus({ preventScroll: true })
  }, [step])

  // Without a running exit animation (reduced motion that removed it, a
  // hidden page, a test DOM) the swap must not wait for an event that never
  // comes; with one, a timer still guards against a lost animationend.
  useEffect(() => {
    if (pending === undefined) return
    const settle = () => {
      setIndex(pending)
      setPending(undefined)
    }
    if (!stepRef.current?.getAnimations?.().length) {
      settle()
      return
    }
    const timer = window.setTimeout(settle, 400)
    return () => window.clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    if (!closing) return
    const node = dialog.panel.current
    if (!node?.getAnimations?.().length) {
      onDismiss.current()
      return
    }
    const finish = (event?: AnimationEvent) => {
      if (event && event.target !== node) return
      window.clearTimeout(timer)
      node.removeEventListener('animationend', finish)
      onDismiss.current()
    }
    const timer = window.setTimeout(finish, 400)
    node.addEventListener('animationend', finish)
    return () => {
      window.clearTimeout(timer)
      node.removeEventListener('animationend', finish)
    }
  }, [closing, dialog.panel])

  useEffect(() => {
    if (!enterHeld) return
    const timer = window.setTimeout(() => setEnterHeld(false), 180)
    return () => window.clearTimeout(timer)
  }, [enterHeld])

  const go = (next: number) => {
    const clamped = Math.min(STEPS.length - 1, Math.max(0, next))
    if (clamped === index || leaving || closing) return
    setDirection(clamped > index ? 'forward' : 'back')
    setPending(clamped)
  }
  const advance = () => {
    if (leaving || closing) return
    if (step === 'project') props.onAddProject()
    else go(index + 1)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    dialog.onKeyDown(event)
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return
    const target = event.target instanceof HTMLElement ? event.target : null
    // The on-screen key presses along with the physical one; the button
    // itself already fires on Enter when it has focus.
    if (target?.closest('.onboarding__primary')) {
      setEnterHeld(true)
      return
    }
    // Other buttons and links already act on Enter; only bare surfaces and inputs advance.
    if (target?.closest('button, a, textarea')) return
    event.preventDefault()
    setEnterHeld(true)
    advance()
  }

  const readiness = BETA_PLANS.map((plan) => ({
    plan,
    ...providerReadiness(props.providerStatuses.find((entry) => entry.id === plan.id)),
  }))
  const readyCount = readiness.filter((entry) => entry.tone === 'ready').length
  const checking = readiness.some((entry) => entry.tone === 'checking')
  const profileName = props.displayName?.trim() || 'Local profile'

  return (
    <div
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-step={step}
      data-closing={closing || undefined}
      hidden={props.hidden}
      ref={dialog.panel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="onboarding__titlebar" aria-hidden />

      <header className="onboarding__bar">
        <div className="onboarding__brand">
          <TasteCodeMark size={15} />
          <span>TasteCode</span>
        </div>
        <ol className="onboarding__progress" aria-label="Setup progress">
          {STEPS.map((entry, position) => (
            <li
              key={entry.id}
              className={position <= index ? 'is-done' : undefined}
              aria-current={position === index ? 'step' : undefined}
            >
              <span className="visually-hidden">{entry.label}</span>
            </li>
          ))}
        </ol>
        <div className="onboarding__bar-end">
          {step !== 'project' ? (
            <button className="ghost onboarding__skip" type="button" onClick={dismiss}>
              Skip setup
            </button>
          ) : null}
        </div>
      </header>

      <div className="onboarding__body">
        <section
          className="onboarding__step"
          key={step}
          ref={stepRef}
          data-direction={direction}
          data-phase={leaving ? 'leaving' : 'entering'}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || pending === undefined) return
            setIndex(pending)
            setPending(undefined)
          }}
        >
          {step === 'welcome' ? (
            <div className="onboarding__cover">
              <div className="onboarding__cover-copy">
                <TasteCodeMark className="onboarding__mark" size={36} />
                <h1
                  className="onboarding__title onboarding__title--display"
                  id={titleId}
                  ref={setFocusTarget}
                  tabIndex={-1}
                >
                  Welcome to TasteCode
                </h1>
                <p className="onboarding__lead">
                  One window for the coding agents already on this machine. Four quick choices and
                  you&rsquo;re in.
                </p>
                <footer className="onboarding__actions">
                  <PrimaryButton onClick={advance} pressed={enterHeld}>
                    Begin setup
                  </PrimaryButton>
                </footer>
              </div>
              <AppMiniature className="onboarding__hero" animate />
            </div>
          ) : null}

          {step === 'name' ? (
            <>
              <div className="onboarding__avatar" aria-hidden>
                <span className="onboarding__avatar-art" key={profileName}>
                  <GeneratedAvatar name={profileName} />
                </span>
              </div>
              <h1 className="onboarding__title" id={titleId}>
                What should we call you?
              </h1>
              <p className="onboarding__lead">
                Shown in your profile and used with every provider. You can leave it empty.
              </p>
              <div className="onboarding__field">
                <label htmlFor={nameId}>Your name</label>
                <input
                  id={nameId}
                  ref={setFocusTarget}
                  autoComplete="nickname"
                  maxLength={64}
                  value={props.displayName ?? ''}
                  onChange={(event) => props.onDisplayNameChange?.(event.target.value)}
                  placeholder="Ada Lovelace"
                />
              </div>
              <StepActions onBack={() => go(index - 1)} onNext={advance} pressed={enterHeld} />
            </>
          ) : null}

          {step === 'appearance' ? (
            <>
              <h1 className="onboarding__title" id={titleId} ref={setFocusTarget} tabIndex={-1}>
                Pick your look
              </h1>
              <p className="onboarding__lead">
                Applied as you choose. Fonts, accents and backdrops wait in Settings › Appearance.
              </p>
              <fieldset className="onboarding__themes">
                <legend className="visually-hidden">Theme</legend>
                {THEME_CHOICES.map((choice) => {
                  const selected = props.themePreference === choice.value
                  return (
                    <label
                      className={`onboarding__theme${selected ? ' is-selected' : ''}`}
                      key={choice.value}
                    >
                      <input
                        type="radio"
                        name="onboarding-theme"
                        value={choice.value}
                        checked={selected}
                        onChange={() => props.onThemePreferenceChange(choice.value)}
                      />
                      <AppMiniature scheme={choice.value} className="onboarding__theme-preview" />
                      <span className="onboarding__theme-label">{choice.label}</span>
                      <span className="onboarding__theme-note">{choice.note}</span>
                    </label>
                  )
                })}
              </fieldset>
              <StepActions onBack={() => go(index - 1)} onNext={advance} pressed={enterHeld} />
            </>
          ) : null}

          {step === 'providers' ? (
            <>
              <h1 className="onboarding__title" id={titleId} ref={setFocusTarget} tabIndex={-1}>
                Your coding agents
              </h1>
              <p className="onboarding__lead" role="status">
                {checking
                  ? 'Looking for the coding agents installed on this machine…'
                  : readyCount === BETA_PLANS.length
                    ? 'All three beta plans are ready. Nothing else to do here.'
                    : `${readyCount} of ${BETA_PLANS.length} beta plans ready. Set up the rest now, or later in Settings.`}
              </p>
              <ul className="onboarding__providers" aria-label="Supported beta plans">
                {readiness.map(({ plan, label, tone }) => (
                  <li className="onboarding__provider" data-tone={tone} key={plan.id}>
                    <span className="onboarding__provider-mark">
                      <ProviderIcon mark={providerMark(plan.id)} size={18} />
                    </span>
                    <span className="onboarding__provider-name">
                      {plan.name}
                      <small>{plan.vendor}</small>
                    </span>
                    <span className="onboarding__provider-status">{label}</span>
                    {tone === 'pending' ? (
                      <button
                        className="onboarding__provider-action"
                        type="button"
                        aria-label={`Set up ${plan.name}`}
                        onClick={props.onOpenProviders}
                      >
                        Set up
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <StepActions onBack={() => go(index - 1)} onNext={advance} pressed={enterHeld} />
            </>
          ) : null}

          {step === 'project' ? (
            <>
              <h1 className="onboarding__title" id={titleId} ref={setFocusTarget} tabIndex={-1}>
                Open your first project
              </h1>
              <p className="onboarding__lead">
                Pick the folder you&rsquo;re working in &mdash; a git repository or any plain
                directory. Projects and chats stay on this machine; sign-in stays with each
                provider.
              </p>
              <footer className="onboarding__actions onboarding__actions--split">
                <BackButton onClick={() => go(index - 1)} />
                <div className="onboarding__actions-end">
                  <button className="ghost onboarding__ghost" type="button" onClick={dismiss}>
                    Skip for now
                  </button>
                  <PrimaryButton
                    onClick={props.onAddProject}
                    icon={<FolderOpen size={15} aria-hidden />}
                    pressed={enterHeld}
                  >
                    Choose a folder
                  </PrimaryButton>
                </div>
              </footer>
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function StepActions(props: { onBack: () => void; onNext: () => void; pressed: boolean }) {
  return (
    <footer className="onboarding__actions onboarding__actions--split">
      <BackButton onClick={props.onBack} />
      <PrimaryButton onClick={props.onNext} pressed={props.pressed}>
        Continue
      </PrimaryButton>
    </footer>
  )
}

function BackButton(props: { onClick: () => void }) {
  return (
    <button className="ghost onboarding__ghost" type="button" onClick={props.onClick}>
      <ArrowLeft size={14} aria-hidden />
      Back
    </button>
  )
}

function PrimaryButton(props: {
  onClick: () => void
  icon?: ReactNode
  pressed?: boolean | undefined
  children: string
}) {
  return (
    <button className="btn onboarding__primary" type="button" onClick={props.onClick}>
      {props.icon}
      {props.children}
      <kbd aria-hidden data-pressed={props.pressed || undefined}>
        <CornerDownLeft size={12} />
      </kbd>
    </button>
  )
}

/**
 * The app drawn at thumbnail scale: rail, a short exchange, the composer.
 * Without a scheme it inherits the live theme tokens, so the cover always
 * previews what the user will actually get; the theme cards pin one scheme.
 */
function AppMiniature(props: {
  scheme?: 'light' | 'dark' | 'system' | undefined
  className?: string | undefined
  animate?: boolean | undefined
}) {
  const className = props.className ? ` ${props.className}` : ''
  if (props.scheme === 'system') {
    return (
      <span className={`mini-split${className}`} aria-hidden>
        <AppMiniature scheme="light" />
        <AppMiniature scheme="dark" className="mini--half" />
      </span>
    )
  }
  return (
    <span
      className={`mini${className}`}
      data-scheme={props.scheme}
      data-animate={props.animate || undefined}
      aria-hidden
    >
      <span className="mini__rail">
        <span className="mini__rail-head" />
        <span className="mini__nav is-active" />
        <span className="mini__nav" />
        <span className="mini__nav" />
        <span className="mini__nav" />
        <span className="mini__nav" />
      </span>
      <span className="mini__stage">
        <span className="mini__turn mini__turn--user" />
        <span className="mini__turn mini__turn--agent">
          <span />
          <span />
          <span />
        </span>
        <span className="mini__turn mini__turn--user mini__turn--short" />
        <span className="mini__composer">
          <span className="mini__caret" />
          <span className="mini__orb" />
        </span>
      </span>
    </span>
  )
}

/** The desktop icon reduced to its silhouette, in the current text colour. */
function TasteCodeMark(props: { size?: number | undefined; className?: string | undefined }) {
  const size = props.size ?? 16
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 150 149.6"
      fill="currentColor"
      aria-hidden
    >
      <path d="m75 144.6c-11.2 0-21.4-9.2-21.4-20.4 0-13.5 10-22.6 21.4-22.6 9.1 0 20.8 7.5 21.4 20.3 0.7 12.8-9.8 22.7-21.4 22.7z" />
      <path d="m68.7 42.9c-9.4 5.8-17.7 12.1-34.5 16.3-3.6 1-10.9 2.6-19.1 3.1-2.2 0.1-3.1 1.5-3.1 3.3l0.1 10.8c0 1.9 1.3 2.9 3.8 2.8 8.1-0.5 16.5-1.6 29.8-6.2 1.2-0.6 2.3-0.9 3.4-0.9 2.9 0 4.6 1 4.8 4.2v24.4c0 1.7 1.1 2.3 2.4 1.2 2.7-2.2 7-5.2 13.7-7 1.1-0.3 1.7-1 1.7-2.2v-47.7c0-1.6-1.7-2.7-3-2.1z" />
      <path d="m134.7 39.1c-22.8-1.5-40.1-11.4-54.8-30.1-1.3-1.7-2.3-5.1-4.9-5.1-2.1 0-3.1 2.8-4.4 4.4-7.7 9.6-21.7 23.1-43 28.6l-12 2c-2.5 0.1-4.2 1.4-4.2 3.5v10.6c0 2.3 1.3 3.4 3.7 3.1 16.8-1 27.8-4.5 35.8-8.2 6.8-3 13-6.3 20.7-14.2 0.5-0.7 2-1.8 3.5-2.1 1.3 0 2.2 0.5 3.3 1.7 9.3 8.6 19 13.1 27.5 16.7 10.7 3.7 20.7 5.4 29.1 5.9 2.3 0.2 3.4-0.3 3.4-2.3v-11.2c0-1.8-0.8-3.1-3.7-3.3z" />
      <path d="m134.4 62.7c-18.8-0.8-27.4-4.1-32.5-6.3-8.3-3.1-15.3-7.5-20.8-12.8-1.5-1.3-3.2-0.9-3.2 1.4l0.4 48c0 1 0.7 1.6 1.6 1.7 3.1 0.6 8.7 2.4 13.4 6.3 1.3 1.4 3.3 2 3.3 0v-25c-0.2-2 2.1-4.4 4.5-4.3l1.6 0.3c7.9 3.3 17.3 5.9 31.4 7.3 2.2 0.3 3.8-0.3 3.8-2.7v-10.7c0.1-2.3-1.3-3-3.5-3.2z" />
    </svg>
  )
}
