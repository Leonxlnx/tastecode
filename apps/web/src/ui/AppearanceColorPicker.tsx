import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { flushSync } from 'react-dom'
import { IconCheck as Check, IconColorPicker as PickColor } from '@tabler/icons-react'
import {
  hexToHsl,
  hslToHex,
  normalizeHexColor,
  type HexColor,
  type HslColor,
} from '../theme-colors.js'
import '../styles/appearance-color-picker.css'

const PANEL_GAP = 6
const VIEWPORT_GUTTER = 8

type ScreenColorDropper = new () => {
  open: () => Promise<{ sRGBHex: string }>
}

function screenColorDropper(): ScreenColorDropper | undefined {
  const candidate = (window as Window & { EyeDropper?: ScreenColorDropper }).EyeDropper
  return typeof candidate === 'function' ? candidate : undefined
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

function showing(popup: HTMLElement): boolean {
  try {
    return popup.matches(':popover-open')
  } catch {
    return false
  }
}

type PickerProps<Value extends string> = {
  label: string
  value: Value | HexColor
  color: HexColor
  options: readonly { value: Value; label: string; color: HexColor }[]
  onChange: (value: Value | HexColor) => void
}

/**
 * A colour value on an Appearance row, opened into the same kind of panel as
 * the font menu beside it: the named presets as menu rows, then the colour
 * itself as rows of the page, each a name, a leader and a value. On the
 * channel rows the leader is painted in the channel's colours and the thumb
 * rides on it.
 */
export function AppearanceColorPicker<Value extends string>(props: PickerProps<Value>) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const sampling = useRef(false)
  const [open, setOpen] = useState(false)
  // Each opening starts from the current colour, with no half-typed hex left over.
  const [session, setSession] = useState(0)
  const [modality, setModality] = useState<'pointer' | 'keyboard'>('pointer')

  const place = () => {
    const bounds = trigger.current?.getBoundingClientRect()
    const popup = panel.current
    if (!bounds || !popup) return
    // Offset sizes ignore the entry transform, which would otherwise shrink the measure.
    const width = popup.offsetWidth
    const height = popup.offsetHeight
    const below = window.innerHeight - bounds.bottom - PANEL_GAP - VIEWPORT_GUTTER
    const above = bounds.top - PANEL_GAP - VIEWPORT_GUTTER
    const up = height > below && above > below
    const top = up ? bounds.top - PANEL_GAP - height : bounds.bottom + PANEL_GAP
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER)
    const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - height - VIEWPORT_GUTTER)
    popup.style.left = `${clamp(bounds.right - width, VIEWPORT_GUTTER, maxLeft)}px`
    popup.style.top = `${clamp(top, VIEWPORT_GUTTER, maxTop)}px`
    popup.style.transformOrigin = `right ${up ? 'bottom' : 'top'}`
    popup.dataset.drop = up ? 'up' : 'down'
  }

  const show = (input: 'pointer' | 'keyboard') => {
    const popup = panel.current
    if (!popup) return
    // Render, show and place in one task, so the first painted frame is the
    // finished panel where it belongs rather than an empty strip in a corner.
    flushSync(() => {
      setModality(input)
      setSession((current) => current + 1)
      setOpen(true)
    })
    if (!showing(popup)) popup.showPopover?.()
    place()
    const first =
      popup.querySelector<HTMLElement>("[aria-pressed='true']") ??
      popup.querySelector<HTMLElement>('[tabindex="0"]')
    first?.focus({ preventScroll: true })
  }

  const hide = (restoreFocus: boolean) => {
    const popup = panel.current
    if (!popup) return
    // Leaving the hex field commits whatever was typed into it.
    const active = document.activeElement
    if (active instanceof HTMLElement && popup.contains(active)) active.blur()
    flushSync(() => setOpen(false))
    if (showing(popup)) popup.hidePopover?.()
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }
  const hideRef = useRef(hide)
  hideRef.current = hide
  const placeRef = useRef(place)
  placeRef.current = place

  useEffect(() => {
    if (!open) return
    // The panel is a manual popover so nothing outside this component can
    // dismiss it, the screen sampler included.
    const onPointerDown = (event: PointerEvent) => {
      if (sampling.current) return
      const target = event.target
      if (
        target instanceof Node &&
        (panel.current?.contains(target) || trigger.current?.contains(target))
      ) {
        return
      }
      hideRef.current(false)
    }
    const reposition = () => placeRef.current()
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null
    if (panel.current) resize?.observe(panel.current)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => {
      resize?.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  const presetLabel = props.options.find((option) => option.value === props.value)?.label

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="appearance-color"
        style={{ '--appearance-color': props.color } as CSSProperties}
        aria-label={`${props.label}: ${props.color}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          if (open) hide(false)
          else show(event.detail > 0 ? 'pointer' : 'keyboard')
        }}
      >
        <span className="appearance-color__swatch" aria-hidden />
        <span>{presetLabel ?? props.color}</span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={`${props.label} color picker`}
        aria-hidden={!open || undefined}
        inert={!open}
        className="color-picker popup"
        data-popup-state={open ? 'open' : 'closed'}
        data-input-modality={modality}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          hide(true)
        }}
        onBlur={(event) => {
          if (sampling.current || !open) return
          const next = event.relatedTarget
          if (
            next instanceof Node &&
            !event.currentTarget.contains(next) &&
            !trigger.current?.contains(next)
          ) {
            hide(false)
          }
        }}
      >
        <ColorPickerContent key={session} {...props} sampling={sampling} />
      </div>
    </>
  )
}

function ColorPickerContent<Value extends string>(
  props: PickerProps<Value> & { sampling: { current: boolean } },
) {
  const [hsl, setHsl] = useState(() => hexToHsl(props.color))
  const [draft, setDraft] = useState<string>(props.color)
  const [invalid, setInvalid] = useState(false)
  const hexId = useId()
  const errorId = useId()
  const dropper = screenColorDropper()

  useEffect(() => {
    // Keep the local channels while they still name this colour: a grey or
    // black has no hue of its own, and the hue row must not jump back to red.
    setHsl((current) => (hslToHex(current) === props.color ? current : hexToHsl(props.color)))
    setDraft(props.color)
    setInvalid(false)
  }, [props.color])

  const change = (next: HslColor) => {
    setHsl(next)
    const color = hslToHex(next)
    setDraft(color)
    setInvalid(false)
    if (color !== props.color) props.onChange(color)
  }
  const commitHex = () => {
    if (draft === props.color) return
    const color = normalizeHexColor(draft)
    setInvalid(!color)
    if (!color) return
    setDraft(color)
    if (color !== props.color) props.onChange(color)
  }
  const sampleScreen = () => {
    if (!dropper) return
    const Dropper = dropper
    props.sampling.current = true
    void (async () => {
      try {
        const result = await new Dropper().open()
        const color = normalizeHexColor(result.sRGBHex)
        if (color) props.onChange(color)
      } catch {
        // The sampler rejects when the gesture is cancelled.
      } finally {
        props.sampling.current = false
      }
    })()
  }

  const pressedIndex = props.options.findIndex((option) => option.value === props.value)
  const rovingIndex = pressedIndex >= 0 ? pressedIndex : 0
  const movePresetFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = props.options.length - 1
    const next =
      event.key === 'ArrowDown'
        ? Math.min(last, index + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const group = event.currentTarget.parentElement
    group?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }

  // The tracks paint each channel in a colour light and strong enough to read
  // on the menu; the thumb always carries the exact colour.
  const hueTrack = `linear-gradient(to right, ${Array.from(
    { length: 13 },
    (_, step) =>
      `hsl(${step * 30} ${Math.round(Math.max(hsl.s, 0.5) * 100)}% ${Math.round(clamp(hsl.l, 0.4, 0.7) * 100)}%)`,
  ).join(', ')})`
  const saturationTrack = `linear-gradient(to right, hsl(${hsl.h} 0% ${Math.round(clamp(hsl.l, 0.3, 0.7) * 100)}%), hsl(${hsl.h} 100% ${Math.round(clamp(hsl.l, 0.3, 0.7) * 100)}%))`
  const lightnessTrack = `linear-gradient(to right, #000, hsl(${hsl.h} ${Math.round(hsl.s * 100)}% 50%), #fff)`
  const color = hslToHex(hsl)

  return (
    <>
      {props.options.length > 0 ? (
        <>
          <div className="color-picker__presets" role="group" aria-label={`${props.label} presets`}>
            {props.options.map((option, index) => {
              const pressed = props.value === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className="color-picker__preset"
                  aria-pressed={pressed}
                  tabIndex={index === rovingIndex ? 0 : -1}
                  onClick={() => props.onChange(option.value)}
                  onKeyDown={(event) => movePresetFocus(event, index)}
                >
                  <span
                    className="color-picker__swatch"
                    style={{ backgroundColor: option.color }}
                    aria-hidden
                  />
                  <span className="color-picker__preset-name">{option.label}</span>
                  {pressed ? <Check className="color-picker__check" size={13} aria-hidden /> : null}
                </button>
              )
            })}
          </div>
          <div className="color-picker__rule" aria-hidden />
        </>
      ) : null}
      <div className="color-picker__mix">
        <ChannelRow
          name="Hue"
          position={hsl.h / 360}
          max={360}
          unit="°"
          spoken="degrees"
          track={hueTrack}
          color={color}
          onChange={(position) => change({ ...hsl, h: position * 360 })}
        />
        <ChannelRow
          name="Saturation"
          position={hsl.s}
          max={100}
          unit="%"
          spoken="percent"
          track={saturationTrack}
          color={color}
          onChange={(position) => change({ ...hsl, s: position })}
        />
        <ChannelRow
          name="Lightness"
          position={hsl.l}
          max={100}
          unit="%"
          spoken="percent"
          track={lightnessTrack}
          color={color}
          onChange={(position) => change({ ...hsl, l: position })}
        />
        <div className="color-picker__row color-picker__hex">
          <label className="color-picker__name" htmlFor={hexId}>
            Hex
          </label>
          <div className="color-picker__line">
            <span className="color-picker__leader" aria-hidden />
            <input
              id={hexId}
              type="text"
              aria-label={`${props.label} hex color`}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              autoComplete="off"
              spellCheck={false}
              maxLength={16}
              value={draft}
              onChange={(event) => {
                const next = event.currentTarget.value
                setDraft(next)
                setInvalid(false)
                // A full six-digit value shows at once; a short one waits for Enter.
                const color = /^\s*#?[\da-f]{6}\s*$/i.test(next)
                  ? normalizeHexColor(next)
                  : undefined
                if (color && color !== props.color) props.onChange(color)
              }}
              onBlur={commitHex}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitHex()
                }
              }}
            />
          </div>
        </div>
        {invalid ? (
          <p className="color-picker__error" id={errorId}>
            Use a hex color, like #5E6AD2.
          </p>
        ) : null}
      </div>
      {dropper ? (
        <>
          <div className="color-picker__rule" aria-hidden />
          <button className="color-picker__preset" type="button" onClick={sampleScreen}>
            <PickColor
              className="color-picker__sample-icon"
              size={14}
              strokeWidth={1.8}
              aria-hidden
            />
            <span className="color-picker__preset-name">Pick from screen</span>
          </button>
        </>
      ) : null}
    </>
  )
}

/**
 * One channel as a row of the page: its name, a leader painted from the
 * channel's lowest to highest colour that the thumb rides on, and the number.
 */
function ChannelRow(props: {
  name: string
  position: number
  max: number
  unit: string
  spoken: string
  track: string
  color: HexColor
  onChange: (position: number) => void
}) {
  const nameId = useId()
  const dragging = useRef(false)
  const value = Math.round(props.position * props.max)

  const fromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = event.currentTarget
    const bounds = track.getBoundingClientRect()
    // The thumb's centre travels a radius inside the track (--thumb in the CSS).
    const thumb = Number.parseFloat(getComputedStyle(track).getPropertyValue('--thumb')) || 12
    const travel = Math.max(1, bounds.width - thumb)
    props.onChange(clamp((event.clientX - bounds.left - thumb / 2) / travel))
  }

  return (
    <div className="color-picker__row">
      <span className="color-picker__name" id={nameId}>
        {props.name}
      </span>
      <div className="color-picker__line">
        <div
          className="color-picker__track"
          style={{ '--track': props.track, '--position': props.position } as CSSProperties}
          role="slider"
          tabIndex={0}
          aria-labelledby={nameId}
          aria-valuemin={0}
          aria-valuemax={props.max}
          aria-valuenow={value}
          aria-valuetext={`${value} ${props.spoken}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            dragging.current = true
            event.currentTarget.setPointerCapture?.(event.pointerId)
            fromPointer(event)
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return
            // A release the element never heard about (outside the window) ends the drag.
            if ((event.buttons & 1) === 0) {
              dragging.current = false
              return
            }
            fromPointer(event)
          }}
          onPointerUp={() => {
            dragging.current = false
          }}
          onPointerCancel={() => {
            dragging.current = false
          }}
          onKeyDown={(event) => {
            const step = (event.shiftKey ? 10 : 1) / props.max
            const big = 10 / props.max
            const next =
              event.key === 'ArrowRight' || event.key === 'ArrowUp'
                ? props.position + step
                : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                  ? props.position - step
                  : event.key === 'PageUp'
                    ? props.position + big
                    : event.key === 'PageDown'
                      ? props.position - big
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 1
                          : undefined
            if (next === undefined) return
            event.preventDefault()
            props.onChange(clamp(next))
          }}
        >
          <span
            className="color-picker__thumb"
            style={{ backgroundColor: props.color }}
            aria-hidden
          />
        </div>
        <span className="color-picker__value" aria-hidden>
          {value}
          {props.unit}
        </span>
      </div>
    </div>
  )
}
