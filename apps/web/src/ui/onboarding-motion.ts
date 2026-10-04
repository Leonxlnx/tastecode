/**
 * Motion for first-run setup: an answer travelling into the app preview, the
 * preview catching it, and the preview opening up into the app itself. Each
 * helper settles immediately — without animating — when motion is reduced or
 * either end is not on screen, so callers can hang their state change on the
 * promise and stay correct in every environment.
 */

// --ease-rail: a steady middle and a soft landing; a thrown object, not a snap.
const TRAVEL = 'cubic-bezier(0.32, 0.72, 0, 1)'
const ARC_SAMPLES = 18

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function onScreen(element: Element | null | undefined): element is HTMLElement | SVGElement {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false
  if (typeof element.animate !== 'function') return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

type Flight = {
  /** Which point of each box travels: its centre, or the middle of its leading edge (text). */
  anchor?: 'center' | 'start'
  /** Scale at the end; defaults to the ratio of the two heights. */
  scale?: number
  duration?: number
}

/**
 * Throws `ghost` from `from` to `target` along an arc and resolves when it has
 * landed. The ghost stays in place for one frame after landing so the caller's
 * state change can paint underneath it before it goes.
 */
function throwGhost(
  ghost: HTMLElement,
  from: DOMRect,
  target: HTMLElement,
  host: HTMLElement,
  flight: Flight,
): Promise<void> {
  const to = target.getBoundingClientRect()
  const anchor = flight.anchor ?? 'center'
  const scale = flight.scale ?? to.height / from.height
  const startX = anchor === 'center' ? from.left + from.width / 2 : from.left
  const endX = anchor === 'center' ? to.left + to.width / 2 : to.left
  const dx = endX - startX
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  // The control point sits above the midpoint, so the copy is lobbed across
  // rather than slid; longer throws arc higher, up to a ceiling.
  const lift = Math.min(140, Math.hypot(dx, dy) * 0.3)
  const controlX = dx / 2
  const controlY = dy / 2 - lift

  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    transformOrigin: anchor === 'center' ? '50% 50%' : '0 50%',
  })
  ghost.classList.add('onboarding__flyer')
  ghost.setAttribute('aria-hidden', 'true')
  host.append(ghost)

  const frames: Keyframe[] = []
  for (let step = 0; step <= ARC_SAMPLES; step += 1) {
    const t = step / ARC_SAMPLES
    const x = 2 * (1 - t) * t * controlX + t * t * dx
    const y = 2 * (1 - t) * t * controlY + t * t * dy
    // It grows a touch on the way up, as if lifted towards the viewer.
    const s = 1 + (scale - 1) * t + Math.sin(Math.PI * t) * 0.08
    frames.push({ offset: t, transform: `translate(${x}px, ${y}px) scale(${s})` })
  }
  const duration = flight.duration ?? 760
  const animation = ghost.animate(frames, { duration, easing: TRAVEL, fill: 'forwards' })
  return settled(animation, duration).then(() => {
    window.setTimeout(() => ghost.remove(), 34)
  })
}

/**
 * Settles when the animation ends, or shortly after it should have: a hidden
 * window stops the animation clock, and state must not wait on it.
 */
function settled(animation: Animation, duration: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, duration + 250)
    animation.finished.then(finish, finish)
  })
}

/** Sends a copy of `source` into `target`. */
export function fly(
  source: Element | null | undefined,
  target: Element | null | undefined,
  host: HTMLElement | null | undefined,
  flight: Flight = {},
): Promise<void> {
  if (!host || !onScreen(source) || !onScreen(target) || prefersReducedMotion()) {
    return Promise.resolve()
  }
  const ghost = document.createElement('div')
  ghost.append(source.cloneNode(true))
  return throwGhost(ghost, source.getBoundingClientRect(), target, host, flight)
}

/**
 * Sends the text of an input into `target`, starting where the characters
 * actually sit in the field and shrinking to the target's type size.
 */
export function flyText(
  text: string,
  field: HTMLInputElement | null | undefined,
  target: Element | null | undefined,
  host: HTMLElement | null | undefined,
): Promise<void> {
  if (!text || !host || !onScreen(field) || !onScreen(target) || prefersReducedMotion()) {
    return Promise.resolve()
  }
  const fieldStyle = getComputedStyle(field)
  const targetStyle = getComputedStyle(target)
  const box = field.getBoundingClientRect()
  const inset =
    Number.parseFloat(fieldStyle.paddingLeft) + Number.parseFloat(fieldStyle.borderLeftWidth)
  const fontSize = Number.parseFloat(fieldStyle.fontSize)
  const from = new DOMRect(box.left + inset, box.top, box.width - inset * 2, box.height)
  const ghost = document.createElement('div')
  ghost.textContent = text
  ghost.classList.add('onboarding__flyer--text')
  Object.assign(ghost.style, {
    font: fieldStyle.font,
    letterSpacing: fieldStyle.letterSpacing,
    lineHeight: `${box.height}px`,
    color: fieldStyle.color,
  })
  return throwGhost(ghost, from, target, host, {
    anchor: 'start',
    scale: Number.parseFloat(targetStyle.fontSize) / fontSize,
    duration: 700,
  })
}

/** The receiving end gives a little under the weight, and a ring spreads from it. */
export function catchIn(target: Element | null | undefined): void {
  if (!onScreen(target) || prefersReducedMotion()) return
  const ink = getComputedStyle(target).color
  target.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.07)', offset: 0.28 },
      { transform: 'scale(0.985)', offset: 0.62 },
      { transform: 'scale(1)' },
    ],
    { duration: 520, easing: 'ease-out' },
  )
  target.animate(
    [
      { boxShadow: `0 0 0 0 color-mix(in srgb, ${ink} 34%, transparent)` },
      { boxShadow: `0 0 0 0.7em color-mix(in srgb, ${ink} 0%, transparent)` },
    ],
    { duration: 700, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  )
}

// Where each part of the preview lives in the real app. A part whose
// counterpart is not on screen (a collapsed rail, no project yet) simply
// fades with the rest of setup.
const COUNTERPARTS = {
  window: '.shell',
  rail: '.rail',
  'new-chat': '.rail__new-chat',
  'new-project': '.rail__new-project',
  'pull-requests': '.rail__pull-requests',
  project: '.proj__head',
  profile: '.rail__foot .account',
  'account-menu': '.account__chevron',
  topbar: '.stagehead',
  'sidebar-toggle': '.titlebar__toggle',
  search: '.rail__search',
  'add-project': '.section__add',
  'bottom-panel': '.panel-toggles > :first-child',
  'side-panel': '.panel-toggles > :last-child',
  composer: '.composer__box',
  model: '.menutrigger--model-selector',
  send: '.composer__box .orb',
} as const
type Part = keyof typeof COUNTERPARTS

// What each pair lines up on while it travels, so the words that are the
// same in both land on each other: the first line of text for rows, the
// project list's heading for the rail, the tool row along the composer's
// bottom edge, the top-left corner for the window, and the centre for icons —
// the real ones sit in buttons with room around them, the preview's do not.
const ANCHORS = {
  window: 'corner',
  rail: 'heading',
  'new-chat': 'text',
  'new-project': 'text',
  'pull-requests': 'text',
  project: 'text',
  profile: 'text',
  'account-menu': 'center',
  topbar: 'text',
  'sidebar-toggle': 'center',
  search: 'center',
  'add-project': 'center',
  'bottom-panel': 'center',
  'side-panel': 'center',
  composer: 'bottom',
  model: 'text',
  send: 'center',
} as const satisfies Record<Part, 'corner' | 'bottom' | 'center' | 'text' | 'heading'>

// Parts only setup has. They leave on their own, early, instead of lingering
// in the page picture while the app arrives around them.
const LEAVING = {
  bar: '.onboarding__bar',
  question: '.onboarding__step',
  thread: '.onboarding__preview .preview__thread',
} as const

// Kept in step with ::view-transition-group in onboarding.css, so each
// picture scales on exactly the curve its box resizes on.
const MORPH_DURATION = 780

type Measure = { width: number; height: number; font: number; x: number; y: number }

/**
 * The start of the first line of text in `element` (or of `text`, when given),
 * with the size that text is set in.
 */
function textAnchor(
  element: Element,
  text: string | undefined,
): { x: number; y: number; font: number } | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim()
    if (!value || (text !== undefined && value !== text)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const line = range.getClientRects()[0]
    if (line && line.width > 0) {
      const font = Number.parseFloat(getComputedStyle(node.parentElement ?? element).fontSize)
      return { x: line.left, y: line.top + line.height / 2, font }
    }
  }
  return undefined
}

function measure(element: HTMLElement | SVGElement, part: Part): Measure {
  const box = element.getBoundingClientRect()
  const anchor = ANCHORS[part]
  const font = Number.parseFloat(getComputedStyle(element).fontSize)
  const at = (x: number, y: number) => ({ width: box.width, height: box.height, font, x, y })
  if (anchor === 'corner') return at(0, 0)
  if (anchor === 'bottom') return at(0, box.height)
  if (anchor === 'center') return at(box.width / 2, box.height / 2)
  const point = textAnchor(element, anchor === 'heading' ? 'Projects' : undefined)
  if (!point) return at(0, 0)
  // A row scales by the size of its own words, so they meet exactly. The
  // rail keeps the size its rows are set in, not its small section heading.
  return {
    ...at(point.x - box.left, point.y - box.top),
    font: anchor === 'heading' ? font : point.font,
  }
}

/**
 * Setup gives way to the app by morphing into it. The preview's frame grows
 * into the app window; every part the app also has — the rail and its rows,
 * the profile, the top bar, the composer — travels to where it really lives
 * while its box resizes to the real one; what only setup has steps aside
 * first. `leave` must take setup off the page synchronously. Undefined when
 * it cannot play, and the caller fades instead.
 *
 * Left to itself a view transition stretches both pictures to the box, so a
 * preview row a sixth smaller than the real one balloons while the real one
 * shrinks to meet it. Instead each picture keeps its proportions, scales only
 * by the ratio of the two type sizes, and is held on its anchor while the box
 * clips it: the words stay the same size on the same line all the way, and
 * one simply becomes the other.
 */
export function morphInto(
  layer: Element | null | undefined,
  leave: () => void,
): Promise<void> | undefined {
  const preview = layer?.querySelector('.onboarding__preview')
  if (
    !layer ||
    !preview ||
    !onScreen(preview.querySelector('.preview__window')) ||
    prefersReducedMotion() ||
    typeof document.startViewTransition !== 'function'
  ) {
    return undefined
  }
  const root = document.documentElement
  const named: Array<HTMLElement | SVGElement> = []
  const name = (element: HTMLElement | SVGElement, part: string) => {
    element.style.viewTransitionName = `onboarding-${part}`
    named.push(element)
  }
  for (const [part, selector] of Object.entries(LEAVING)) {
    const element = layer.querySelector(selector)
    if (onScreen(element)) name(element, part)
  }
  const from = new Map<Part, Measure>()
  const to = new Map<Part, Measure>()
  for (const part of Object.keys(COUNTERPARTS) as Part[]) {
    const element = preview.querySelector(`[data-morph="${part}"]`)
    if (!onScreen(element)) continue
    name(element, part)
    from.set(part, measure(element, part))
  }
  root.dataset.onboardingMorph = ''
  const transition = document.startViewTransition(() => {
    leave()
    for (const part of from.keys()) {
      const element = document.querySelector(COUNTERPARTS[part])
      if (!onScreen(element)) continue
      name(element, part)
      to.set(part, measure(element, part))
    }
  })
  void transition.ready.then(
    () => {
      const timing = { duration: MORPH_DURATION, easing: TRAVEL, fill: 'both' } as const
      const move = (pseudo: string, transforms: [string, string]) =>
        root.animate({ transform: transforms }, { ...timing, pseudoElement: pseudo })
      for (const [part, a] of from) {
        const b = to.get(part)
        if (!b) continue
        const k = b.font / a.font
        // Holding an anchor is linear in the eased progress the box itself
        // follows, so interpolating on the same curve keeps the pair locked
        // together on every frame, not just at the two ends.
        const pseudo = (side: 'old' | 'new') => `::view-transition-${side}(onboarding-${part})`
        if (part === 'window') {
          // The old frame is only chrome — its content travels on its own —
          // so it simply stretches to the window, rounding off as it goes.
          root.animate(
            {
              borderRadius: [
                getComputedStyle(preview.querySelector('.preview__window')!).borderRadius,
                '0px',
              ],
            },
            { ...timing, pseudoElement: `::view-transition-group(onboarding-${part})` },
          )
        } else {
          move(pseudo('old'), [
            'translate(0, 0) scale(1)',
            `translate(${b.x - a.x * k}px, ${b.y - a.y * k}px) scale(${k})`,
          ])
        }
        move(pseudo('new'), [
          `translate(${a.x - b.x / k}px, ${a.y - b.y / k}px) scale(${1 / k})`,
          'translate(0, 0) scale(1)',
        ])
      }
    },
    () => undefined,
  )
  const clear = () => {
    for (const element of named) element.style.removeProperty('view-transition-name')
    delete root.dataset.onboardingMorph
  }
  return transition.finished.then(clear, clear)
}
