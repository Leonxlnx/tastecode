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
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
  type HexColor,
  type HsvColor,
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
 * the font menu beside it: the named presets as menu rows, then a
 * saturation/brightness square with the hue bar under it, then the hex row.
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

/** The thumb's centre travels a radius inside the control, read from its CSS. */
function thumbSize(element: HTMLElement, name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function usePointerDrag(apply: (event: ReactPointerEvent<HTMLDivElement>) => void) {
  const dragging = useRef(false)
  return {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (event.button !== 0) return
      dragging.current = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      apply(event)
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      if (!dragging.current) return
      // A release the element never heard about (outside the window) ends the drag.
      if ((event.buttons & 1) === 0) {
        dragging.current = false
        return
      }
      apply(event)
    },
    onPointerUp() {
      dragging.current = false
    },
    onPointerCancel() {
      dragging.current = false
    },
  }
}

function ColorPickerContent<Value extends string>(
  props: PickerProps<Value> & { sampling: { current: boolean } },
) {
  const [hsv, setHsv] = useState(() => hexToHsv(props.color))
  const [draft, setDraft] = useState<string>(props.color)
  const [invalid, setInvalid] = useState(false)
  const hexId = useId()
  const errorId = useId()
  const dropper = screenColorDropper()

  useEffect(() => {
    // Keep the local channels while they still name this colour: a grey or
    // black has no hue of its own, and the hue row must not jump back to red.
    setHsv((current) => (hsvToHex(current) === props.color ? current : hexToHsv(props.color)))
    setDraft(props.color)
    setInvalid(false)
  }, [props.color])

  const change = (next: HsvColor) => {
    setHsv(next)
    const color = hsvToHex(next)
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

  const color = hsvToHex(hsv)
  const fieldDrag = usePointerDrag((event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const thumb = thumbSize(event.currentTarget, '--field-thumb', 18)
    change({
      ...hsv,
      s: clamp((event.clientX - bounds.left - thumb / 2) / Math.max(1, bounds.width - thumb)),
      v: 1 - clamp((event.clientY - bounds.top - thumb / 2) / Math.max(1, bounds.height - thumb)),
    })
  })
  const hueDrag = usePointerDrag((event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const thumb = thumbSize(event.currentTarget, '--hue-thumb', 26)
    change({
      ...hsv,
      h: clamp((event.clientX - bounds.left - thumb / 2) / Math.max(1, bounds.width - thumb)) * 360,
    })
  })
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01
    const next =
      event.key === 'ArrowLeft'
        ? { ...hsv, s: clamp(hsv.s - step) }
        : event.key === 'ArrowRight'
          ? { ...hsv, s: clamp(hsv.s + step) }
          : event.key === 'ArrowDown'
            ? { ...hsv, v: clamp(hsv.v - step) }
            : event.key === 'ArrowUp'
              ? { ...hsv, v: clamp(hsv.v + step) }
              : event.key === 'Home'
                ? { ...hsv, s: 0 }
                : event.key === 'End'
                  ? { ...hsv, s: 1 }
                  : undefined
    if (!next) return
    event.preventDefault()
    change(next)
  }
  const onHueKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? hsv.h - step
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? hsv.h + step
          : event.key === 'PageDown'
            ? hsv.h - 10
            : event.key === 'PageUp'
              ? hsv.h + 10
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 360
                  : undefined
    if (next === undefined) return
    event.preventDefault()
    change({ ...hsv, h: clamp(next, 0, 360) })
  }

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
      <div className="color-picker__picker">
        <div
          className="color-picker__field"
          style={
            {
              backgroundColor: `hsl(${hsv.h} 100% 50%)`,
              '--s': hsv.s,
              '--v': hsv.v,
            } as CSSProperties
          }
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-description="Use left and right arrows for saturation, up and down for brightness."
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          {...fieldDrag}
          onKeyDown={onFieldKeyDown}
        >
          <span
            className="color-picker__field-thumb"
            style={{ backgroundColor: color }}
            aria-hidden
          />
        </div>
        <div
          className="color-picker__hue"
          style={{ '--h': hsv.h / 360 } as CSSProperties}
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuetext={`${Math.round(hsv.h)} degrees`}
          {...hueDrag}
          onKeyDown={onHueKeyDown}
        >
          <span
            className="color-picker__hue-thumb"
            style={{ backgroundColor: color }}
            aria-hidden
          />
        </div>
      </div>
      <div className="color-picker__hex">
        <label className="color-picker__name" htmlFor={hexId}>
          Hex
        </label>
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
            const color = /^\s*#?[\da-f]{6}\s*$/i.test(next) ? normalizeHexColor(next) : undefined
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
      {invalid ? (
        <p className="color-picker__error" id={errorId}>
          Use a hex color, like #5E6AD2.
        </p>
      ) : null}
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
