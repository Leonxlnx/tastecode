import type { ProviderStatus, ResultOf } from '@harness/contracts'
import {
  IconArrowLeft as ArrowLeft,
  IconCheck as Check,
  IconCornerDownLeft as CornerDownLeft,
  IconFolderOpen as FolderOpen,
  IconLock as Lock,
} from '@tabler/icons-react'
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import '../styles/onboarding.css'
import { isDesktop, setDesktopTheme } from '../bridge.js'
import { providerDisplayName, providerMark, type ProviderMark } from '../model-catalog.js'
import { agentMark } from '../provider-presentation.js'
import { DIRECT_PROVIDERS, agentRosterKey, type ProviderRoster } from '../provider-roster.js'
import { DARK_THEME_QUERY, type ThemePreference } from '../theme.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { OnboardingPreview, type PreviewAgent, type PreviewHint } from './OnboardingPreview.js'
import { ProviderIcon } from './ProviderIcon.js'
import { useDialogFocus } from './dialog-focus.js'
import { catchIn, fly, flyText, morphInto, prefersReducedMotion } from './onboarding-motion.js'

const STEPS = [
  { id: 'welcome', label: 'Welcome', hint: undefined },
  { id: 'name', label: 'Your name', hint: 'profile' },
  { id: 'appearance', label: 'Appearance', hint: undefined },
  { id: 'providers', label: 'Coding agents', hint: 'model' },
  { id: 'project', label: 'First project', hint: undefined },
] as const satisfies ReadonlyArray<{ id: string; label: string; hint: PreviewHint | undefined }>
type StepId = (typeof STEPS)[number]['id']

/** One provider or ACP agent the agents page offers, keyed as the roster keys it. */
type PickEntry = {
  key: string
  name: string
  maker: string | undefined
  mark: ProviderMark
  state: string
  installed: boolean
}

const THEME_CHOICES = [
  { value: 'system', label: 'System', note: 'Matches your OS' },
  { value: 'light', label: 'Light', note: 'Bright, high contrast' },
  { value: 'dark', label: 'Dark', note: 'Dimmed, low glare' },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; note: string }>

const PREVIEW = '.onboarding__preview'

type Readiness = { label: string; tone: 'ready' | 'pending' | 'checking' }

/** One honest line per plan, derived from what the vendor binary told us. */
export function providerReadiness(status: ProviderStatus | undefined): Readiness {
  if (!status) return { label: 'Checking…', tone: 'checking' }
  if (!status.installed) return { label: 'Not installed', tone: 'pending' }
  if (status.problem) return { label: 'Needs attention', tone: 'pending' }
  if (status.auth === 'unauthenticated') return { label: 'Sign in needed', tone: 'pending' }
  return { label: status.auth === 'authenticated' ? 'Signed in' : 'Installed', tone: 'ready' }
}

const prefersDark = () => window.matchMedia?.(DARK_THEME_QUERY).matches ?? false

/** Settles on the next change of the OS colour-scheme query, or after `timeout`. */
function schemeChange(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const media = window.matchMedia?.(DARK_THEME_QUERY)
    const finish = () => {
      media?.removeEventListener('change', finish)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, timeout)
    media?.addEventListener('change', finish)
  })
}

/** Settles once the page's theme attribute leaves `before`, or after `timeout`. */
function themeChange(root: HTMLElement, before: string | undefined, timeout: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      observer.disconnect()
      window.clearTimeout(timer)
      resolve()
    }
    const observer = new MutationObserver(() => {
      if (root.dataset.theme !== before) finish()
    })
    const timer = window.setTimeout(finish, timeout)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  })
}

/**
 * First-run setup. Full-window and paged on purpose: each step asks one
 * question, applies its answer immediately (name, theme) and never blocks —
 * every page can be skipped and everything here is reachable again in Settings.
 * Beside the pages sits the app itself, drawn small; answers travel into it,
 * and when setup ends it opens up into the real thing.
 */
export function Onboarding(props: {
  displayName?: string | undefined
  onDisplayNameChange?: ((name: string) => void) | undefined
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  providerStatuses: ProviderStatus[]
  acpAgents: ResultOf<'acp.agents'>['agents']
  /** What is added so far; the agents page adds to it and takes away from it. */
  providerRoster: ProviderRoster
  onProviderRosterChange: (roster: ProviderRoster) => void
  onAddProject: () => void
  onDismiss: () => void
  /** Kept mounted but hidden while Settings sits on top, so the page survives the round trip. */
  hidden?: boolean | undefined
  /** Setup is no longer needed — a project arrived — so the page plays its way out. */
  finished?: boolean | undefined
}) {
  const [index, setIndex] = useState(0)
  // The furthest page visited: the progress dots let the user jump back to
  // any page already seen.
  const [reached, setReached] = useState(0)
  // The page the user asked for while the current one is still animating out.
  // The swap happens when that animation ends, so the old page leaves before
  // the new one arrives instead of both fighting over the same frame.
  const [pending, setPending] = useState<number>()
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [closing, setClosing] = useState(false)
  // How the page leaves: the preview morphing into the app, or a plain fade
  // where that cannot play (preview hidden, reduced motion).
  const [exit, setExit] = useState<'morph' | 'fade'>()
  const [enterHeld, setEnterHeld] = useState(false)
  // What the preview has been handed so far: the name as of the last time the
  // name page was left, and the agents that have flown into its model picker.
  const [shownName, setShownName] = useState(props.displayName ?? '')
  const [receivingName, setReceivingName] = useState(false)
  const [landed, setLanded] = useState<readonly string[]>(props.providerRoster)
  const [arriving, setArriving] = useState<readonly string[]>([])
  // The theme card just chosen, shown selected while the desktop shell is
  // still letting go of its pinned scheme.
  const [themeChoice, setThemeChoice] = useState<ThemePreference>()
  // The pointer or focus is on Choose a folder: the preview's waiting project
  // row reacts before anything is chosen.
  const [pointingFolder, setPointingFolder] = useState(false)
  const step: StepId = STEPS[index]?.id ?? 'welcome'
  const leaving = pending !== undefined
  const titleId = useId()
  const nameId = useId()
  const stepRef = useRef<HTMLElement>(null)
  const revealFrom = useRef<{ x: number; y: number }>(undefined)
  const themeRequest = useRef(0)
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

  // Every provider the server reports, or all of them while it has not yet.
  const direct: PickEntry[] = DIRECT_PROVIDERS.filter(
    (entry) =>
      props.providerStatuses.length === 0 ||
      props.providerStatuses.some((status) => status.id === entry.id),
  ).map((entry) => {
    const status = props.providerStatuses.find((candidate) => candidate.id === entry.id)
    const readiness = providerReadiness(status)
    return {
      key: entry.id,
      name: providerDisplayName(entry.id),
      maker: entry.maker,
      mark: providerMark(entry.id),
      state: readiness.label,
      installed: status?.installed ?? true,
    }
  })
  const agents: PickEntry[] = props.acpAgents.map((agent) => ({
    key: agentRosterKey(agent.id),
    name: agent.name,
    maker: agent.maker,
    mark: agentMark(agent.id),
    state: agent.installed ? 'Installed' : 'Not installed',
    installed: agent.installed,
  }))
  const offered = [...direct, ...agents]
  const checking = props.providerStatuses.length === 0
  const addedCount = props.providerRoster.length
  const profileName = props.displayName?.trim() || 'Local profile'
  const selectedTheme = themeChoice ?? props.themePreference

  useEffect(() => {
    focusTarget.current?.focus({ preventScroll: true })
  }, [step])

  useEffect(() => {
    if (props.finished) setClosing(true)
  }, [props.finished])

  const settle = (next: number) => {
    setIndex(next)
    setReached((furthest) => Math.max(furthest, next))
    setPending(undefined)
  }

  // Without a running exit animation (reduced motion that removed it, a
  // hidden page, a test DOM) the swap must not wait for an event that never
  // comes; with one, a timer still guards against a lost animationend.
  useEffect(() => {
    if (pending === undefined) return
    if (!stepRef.current?.getAnimations?.().length) {
      settle(pending)
      return
    }
    const timer = window.setTimeout(() => settle(pending), 400)
    return () => window.clearTimeout(timer)
  }, [pending])

  // Chosen before paint, so the page never starts one exit and switches to
  // the other.
  useLayoutEffect(() => {
    if (!closing) return
    const morph = morphInto(dialog.panel.current, () => flushSync(() => onDismiss.current()))
    setExit(morph ? 'morph' : 'fade')
  }, [closing, dialog.panel])

  useEffect(() => {
    if (exit !== 'fade') return
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
  }, [exit, dialog.panel])

  useEffect(() => {
    if (!enterHeld) return
    const timer = window.setTimeout(() => setEnterHeld(false), 180)
    return () => window.clearTimeout(timer)
  }, [enterHeld])

  // An agent added on its page leaves its row for the preview's model
  // picker; one taken away again simply goes.
  const sendAgent = (key: string) => {
    const root = dialog.panel.current
    // The picker makes room first, so the flight has a place to aim for.
    flushSync(() => setArriving((list) => [...list, key]))
    void fly(
      root?.querySelector(`.onboarding__pick-row[data-plan="${key}"] .onboarding__pick-mark svg`),
      root?.querySelector(`${PREVIEW} [data-land="agent-${key}"] svg`),
      root,
      { duration: 820 },
    ).then(() => {
      setArriving((list) => list.filter((entry) => entry !== key))
      setLanded((list) => (list.includes(key) ? list : [...list, key]))
      catchIn(root?.querySelector(`${PREVIEW} [data-land="model"]`))
    })
  }
  const toggleAgent = (key: string) => {
    if (props.providerRoster.includes(key)) {
      props.onProviderRosterChange(props.providerRoster.filter((entry) => entry !== key))
      setLanded((list) => list.filter((entry) => entry !== key))
      setArriving((list) => list.filter((entry) => entry !== key))
      return
    }
    props.onProviderRosterChange([...props.providerRoster, key])
    sendAgent(key)
  }

  // Leaving the name page forward hands the answer over: the picture and the
  // typed name travel into the preview's profile row, which lets go of the
  // old ones as they come.
  const handOverName = (forward: boolean) => {
    const value = props.displayName ?? ''
    const root = dialog.panel.current
    const preview = root?.querySelector(PREVIEW)
    if (!forward || !root || !preview) {
      setShownName(value)
      return
    }
    setReceivingName(true)
    void Promise.all([
      fly(
        root.querySelector('.onboarding__avatar'),
        preview.querySelector('[data-land="avatar"]'),
        root,
        {
          duration: 820,
        },
      ),
      flyText(
        value.trim(),
        root.querySelector<HTMLInputElement>('.onboarding__field input'),
        preview.querySelector('[data-land="name"]'),
        root,
      ),
    ]).then(() => {
      setShownName(value)
      setReceivingName(false)
      catchIn(preview.querySelector('[data-land="profile"]'))
    })
  }

  const go = (next: number) => {
    const clamped = Math.min(STEPS.length - 1, Math.max(0, next))
    if (clamped === index || leaving || closing) return
    if (step === 'name') handOverName(clamped > index)
    setPointingFolder(false)
    setDirection(clamped > index ? 'forward' : 'back')
    setPending(clamped)
  }
  const advance = () => {
    if (leaving || closing) return
    if (step === 'project') props.onAddProject()
    else go(index + 1)
  }

  // The new theme spreads out from the card that chose it, as a circle over
  // a snapshot of the old one. Skipped where it would show nothing: no View
  // Transitions, reduced motion, or a choice that lands on the same scheme.
  const chooseTheme = async (value: ThemePreference, anchor: HTMLElement) => {
    const origin = revealFrom.current
    revealFrom.current = undefined
    if (value === selectedTheme) return
    const request = ++themeRequest.current
    const root = document.documentElement
    const animate = typeof document.startViewTransition === 'function' && !prefersReducedMotion()
    const apply = () => {
      props.onThemePreferenceChange(value)
      setThemeChoice(undefined)
      // Only a pending System choice gets past the guard above with the theme
      // already in force. It let the shell go, and an unchanged preference
      // gives the app no reason to pin it again.
      if (isDesktop && value === props.themePreference) {
        void setDesktopTheme(value).catch(() => undefined)
      }
    }
    // In the desktop shell a pinned Light or Dark also pins what the page is
    // told the OS prefers, so where System lands is unknown until the shell
    // lets go. Let go first; the reveal then shows whatever the OS shows.
    if (value === 'system' && isDesktop && animate) {
      setThemeChoice(value)
      const settled = schemeChange(180)
      await setDesktopTheme('system').catch(() => undefined)
      await settled
      if (request !== themeRequest.current) return
    }
    const before = root.dataset.theme
    const resolved = value === 'system' ? (prefersDark() ? 'dark' : 'light') : value
    if (!animate || before === resolved) {
      apply()
      return
    }
    const rect = anchor.getBoundingClientRect()
    const width = window.innerWidth
    const height = window.innerHeight
    const x = origin?.x ?? rect.left + rect.width / 2
    const y = origin?.y ?? rect.top + rect.height / 2
    const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y))
    // Percentages of the snapshot, not pixels: on a high-density display
    // Chromium can lay the snapshot out in device pixels and scale it down,
    // which halves a pixel origin. A circle's percentage radius resolves
    // against the box diagonal divided by √2.
    root.style.setProperty('--theme-reveal-x', `${(x / width) * 100}%`)
    root.style.setProperty('--theme-reveal-y', `${(y / height) * 100}%`)
    root.style.setProperty(
      '--theme-reveal-r',
      `${(radius / (Math.hypot(width, height) / Math.SQRT2)) * 100}%`,
    )
    root.dataset.themeReveal = ''
    const transition = document.startViewTransition(() => {
      flushSync(apply)
      // The attribute is written in a layout effect; should the app take a
      // beat longer, hold the snapshot until it has.
      return root.dataset.theme === before ? themeChange(root, before, 200) : undefined
    })
    void transition.finished.finally(() => {
      delete root.dataset.themeReveal
      root.style.removeProperty('--theme-reveal-x')
      root.style.removeProperty('--theme-reveal-y')
      root.style.removeProperty('--theme-reveal-r')
    })
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

  const previewAgent = (key: string, arriving?: boolean): PreviewAgent[] => {
    const entry = offered.find((candidate) => candidate.key === key)
    return entry ? [{ id: key, name: entry.name, mark: entry.mark, arriving }] : []
  }
  const previewAgents: PreviewAgent[] = [
    ...landed
      .filter((key) => props.providerRoster.includes(key))
      .flatMap((key) => previewAgent(key)),
    ...arriving.filter((key) => !landed.includes(key)).flatMap((key) => previewAgent(key, true)),
  ]
  const preview = { name: shownName, agents: previewAgents }

  return (
    <div
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-step={step}
      data-closing={closing || undefined}
      data-exit={exit}
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
          {STEPS.map((entry, position) => {
            const current = position === index
            const label = <span className="visually-hidden">{entry.label}</span>
            return (
              <li
                key={entry.id}
                className={position <= index ? 'is-done' : undefined}
                aria-current={current ? 'step' : undefined}
              >
                {!current && position <= reached ? (
                  <button type="button" data-label={entry.label} onClick={() => go(position)}>
                    {label}
                  </button>
                ) : (
                  label
                )}
              </li>
            )
          })}
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
        <div className="onboarding__layout">
          <section
            className="onboarding__step"
            key={step}
            ref={stepRef}
            data-direction={direction}
            data-phase={leaving ? 'leaving' : 'entering'}
            onAnimationEnd={(event) => {
              if (event.target !== event.currentTarget || pending === undefined) return
              settle(pending)
            }}
          >
            {step === 'welcome' ? (
              <>
                <TasteCodeMark className="onboarding__mark" size={40} />
                <h1
                  className="onboarding__title onboarding__title--display"
                  id={titleId}
                  ref={setFocusTarget}
                  tabIndex={-1}
                >
                  <Words text="Welcome to TasteCode" />
                </h1>
                <p className="onboarding__lead">
                  One window for the coding agents already on this machine. A few quick choices and
                  you&rsquo;re in.
                </p>
                <footer className="onboarding__actions">
                  <PrimaryButton onClick={advance} pressed={enterHeld}>
                    Get started
                  </PrimaryButton>
                </footer>
              </>
            ) : null}

            {step === 'name' ? (
              <>
                <AvatarMorph name={profileName} />
                <h1 className="onboarding__title" id={titleId}>
                  What should we call you?
                </h1>
                <p className="onboarding__lead">
                  Shown on your profile, with every provider. You can leave it empty.
                </p>
                <div className="onboarding__field">
                  <label className="visually-hidden" htmlFor={nameId}>
                    Your name
                  </label>
                  <input
                    id={nameId}
                    ref={setFocusTarget}
                    autoComplete="nickname"
                    spellCheck={false}
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
                  Choose your look
                </h1>
                <p className="onboarding__lead">
                  Applied as you choose. Fonts, accents and backdrops wait in Settings › Appearance.
                </p>
                <fieldset className="onboarding__themes">
                  <legend className="visually-hidden">Theme</legend>
                  {THEME_CHOICES.map((choice) => {
                    const selected = selectedTheme === choice.value
                    return (
                      <label
                        className={`onboarding__theme${selected ? ' is-selected' : ''}`}
                        key={choice.value}
                        onPointerDown={(event) => {
                          revealFrom.current = { x: event.clientX, y: event.clientY }
                        }}
                      >
                        <input
                          type="radio"
                          name="onboarding-theme"
                          value={choice.value}
                          checked={selected}
                          onChange={(event) =>
                            void chooseTheme(
                              choice.value,
                              event.currentTarget.closest('label') ?? event.currentTarget,
                            )
                          }
                        />
                        <span className="onboarding__theme-frame">
                          {choice.value === 'system' ? (
                            <>
                              <OnboardingPreview {...preview} scheme="light" still />
                              <span className="onboarding__theme-half">
                                <OnboardingPreview {...preview} scheme="dark" still />
                              </span>
                            </>
                          ) : (
                            <OnboardingPreview {...preview} scheme={choice.value} still />
                          )}
                          <span className="onboarding__theme-check">
                            <Check size={11} stroke={3} />
                          </span>
                        </span>
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
                  Choose your coding agents
                </h1>
                <p className="onboarding__lead" role="status">
                  {checking
                    ? 'Looking for the coding agents installed on this machine…'
                    : addedCount === 0
                      ? 'Pick the ones you use. Nothing is added until you do.'
                      : `${addedCount} added. Change this any time in Settings › Providers.`}
                </p>
                <div className="onboarding__pick">
                  <PickGroup
                    title="Providers"
                    entries={direct}
                    roster={props.providerRoster}
                    onToggle={toggleAgent}
                  />
                  <PickGroup
                    title="ACP agents"
                    entries={agents}
                    roster={props.providerRoster}
                    onToggle={toggleAgent}
                  />
                </div>
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
                  directory.
                </p>
                <p className="onboarding__note">
                  <Lock size={15} aria-hidden />
                  <span>
                    Projects and chats stay on this machine. Sign-in stays with each provider.
                  </span>
                </p>
                <footer className="onboarding__actions onboarding__actions--split">
                  <BackButton onClick={() => go(index - 1)} />
                  <div className="onboarding__actions-end">
                    <button className="ghost onboarding__ghost" type="button" onClick={dismiss}>
                      Skip for now
                    </button>
                    <PrimaryButton
                      onClick={props.onAddProject}
                      onPoint={setPointingFolder}
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

          <div className="onboarding__preview" data-receiving={receivingName || undefined}>
            <OnboardingPreview
              {...preview}
              hint={STEPS[index]?.hint}
              newProject={step === 'project' ? (pointingFolder ? 'ready' : 'open') : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Words arrive one by one, each sharpening out of a blur as it settles. */
function Words(props: { text: string }) {
  return props.text.split(' ').map((word, position) => (
    <Fragment key={position}>
      {position > 0 ? ' ' : null}
      <span className="onboarding__word" style={{ '--word': position } as CSSProperties}>
        {word}
      </span>
    </Fragment>
  ))
}

/**
 * The identicon redraws as the name is typed. The new picture resolves over
 * the previous one instead of replacing it, so fast typing reads as one image
 * shifting rather than a string of flashes.
 */
function AvatarMorph(props: { name: string }) {
  const [layers, setLayers] = useState(() => [{ id: 0, name: props.name }])
  const top = layers[layers.length - 1]!
  if (top.name !== props.name) setLayers([top, { id: top.id + 1, name: props.name }])
  return (
    <div className="onboarding__avatar" aria-hidden>
      {layers.map((layer) => (
        <span className="onboarding__avatar-art" key={layer.id}>
          <GeneratedAvatar name={layer.name} />
        </span>
      ))}
    </div>
  )
}

/**
 * One group of the agents page, each agent a line in the same language as the
 * provider roster: its name, a dotted leader and an empty socket like the one
 * in the preview's model picker. Picking it runs the wire solid into the
 * socket, which fills, while the agent itself flies into the preview.
 */
function PickGroup(props: {
  title: string
  entries: readonly PickEntry[]
  roster: ProviderRoster
  onToggle: (key: string) => void
}) {
  const titleId = useId()
  if (props.entries.length === 0) return null
  return (
    <section className="onboarding__pick-group" aria-labelledby={titleId}>
      <h2 className="onboarding__pick-title" id={titleId}>
        {props.title}
      </h2>
      <ul className="onboarding__picks">
        {props.entries.map((entry) => {
          const added = props.roster.includes(entry.key)
          return (
            <li
              className="onboarding__pick-row"
              data-plan={entry.key}
              data-added={added || undefined}
              data-missing={entry.installed ? undefined : true}
              key={entry.key}
            >
              <label title={entry.maker}>
                <input
                  className="visually-hidden"
                  type="checkbox"
                  checked={added}
                  onChange={() => props.onToggle(entry.key)}
                />
                <span className="onboarding__pick-mark">
                  <ProviderIcon mark={entry.mark} size={16} />
                </span>
                <span className="onboarding__pick-name">{entry.name}</span>
                <span className="onboarding__pick-wire" aria-hidden />
                <span className="onboarding__pick-state">{entry.state}</span>
                <span className="onboarding__pick-socket" aria-hidden />
              </label>
            </li>
          )
        })}
      </ul>
    </section>
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
  /** Told when the pointer or keyboard focus arrives on the button and leaves it. */
  onPoint?: ((pointing: boolean) => void) | undefined
  icon?: ReactNode
  pressed?: boolean | undefined
  children: string
}) {
  return (
    <button
      className="btn onboarding__primary"
      type="button"
      onClick={props.onClick}
      onPointerEnter={() => props.onPoint?.(true)}
      onPointerLeave={() => props.onPoint?.(false)}
      onFocus={() => props.onPoint?.(true)}
      onBlur={() => props.onPoint?.(false)}
    >
      {props.icon}
      {props.children}
      <kbd aria-hidden data-pressed={props.pressed || undefined}>
        <CornerDownLeft size={12} />
      </kbd>
    </button>
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
