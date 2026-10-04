import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import { IconCheck, IconX } from '@tabler/icons-react'
import {
  colorForeground,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
  type HexColor,
  type HsvColor,
} from '../theme-colors.js'
import '../styles/appearance-color-picker.css'

export function AppearanceColorPicker<Value extends string>(props: {
  label: string
  value: Value | HexColor
  color: HexColor
  options: readonly { value: Value; label: string; color: HexColor }[]
  onChange: (value: Value | HexColor) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect()
      const popup = panel.current
      if (!bounds || !popup) return
      const { width, height } = popup.getBoundingClientRect()
      const below = bounds.bottom + 8
      const top = below + height <= window.innerHeight - 8 ? below : bounds.top - height - 8
      popup.style.left = `${Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8))}px`
      popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="appearance-color"
        style={
          {
            '--appearance-color': props.color,
            '--appearance-color-foreground': colorForeground(props.color),
            '--control-pressed': props.color,
          } as CSSProperties
        }
        popoverTarget={id}
        aria-label={`${props.label}: ${props.color}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="appearance-color__swatch" aria-hidden />
        <span>{props.color}</span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`${props.label} color picker`}
        className="color-picker"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          panel.current?.hidePopover()
          trigger.current?.focus()
        }}
        onBlur={(event) => {
          const next = event.relatedTarget
          if (
            next instanceof Node &&
            !event.currentTarget.contains(next) &&
            next !== trigger.current
          ) {
            panel.current?.hidePopover()
          }
        }}
      >
        {open ? (
          <ColorPickerContent
            {...props}
            close={() => {
              panel.current?.hidePopover()
              trigger.current?.focus()
            }}
          />
        ) : null}
      </div>
    </>
  )
}

function ColorPickerContent<Value extends string>(props: {
  label: string
  value: Value | HexColor
  color: HexColor
  options: readonly { value: Value; label: string; color: HexColor }[]
  onChange: (value: Value | HexColor) => void
  close: () => void
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(props.color))
  const [draft, setDraft] = useState<string>(props.color)
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()
  const dragging = useRef(false)

  useEffect(() => {
    const endDrag = () => {
      dragging.current = false
    }
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('blur', endDrag)
    return () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('blur', endDrag)
    }
  }, [])

  useEffect(() => {
    setHsv((current) => (hsvToHex(current) === props.color ? current : hexToHsv(props.color)))
    setDraft(props.color)
    setInvalid(false)
  }, [props.color])

  const change = (next: HsvColor) => {
    setHsv(next)
    const color = hsvToHex(next)
    setDraft(color)
    setInvalid(false)
    props.onChange(color)
  }
  const commitHex = () => {
    const color = normalizeHexColor(draft)
    setInvalid(!color)
    if (!color) return
    setDraft(color)
    props.onChange(color)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    change({
      h: hsv.h,
      s: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      v: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height)),
    })
  }

  return (
    <>
      <header className="color-picker__header">
        <span>{props.label}</span>
        <button type="button" aria-label="Close color picker" onClick={props.close}>
          <IconX size={14} aria-hidden />
        </button>
      </header>
      <div
        className="color-picker__field"
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-description="Use left and right arrows for saturation, up and down for brightness."
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          event.currentTarget.focus({ preventScroll: true })
          move(event)
        }}
        onPointerMove={(event) => {
          if (dragging.current) move(event)
        }}
        onPointerUp={(event) => {
          if (dragging.current) move(event)
          dragging.current = false
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.01
          let { s, v } = hsv
          if (event.key === 'ArrowLeft') s -= step
          else if (event.key === 'ArrowRight') s += step
          else if (event.key === 'ArrowUp') v += step
          else if (event.key === 'ArrowDown') v -= step
          else if (event.key === 'Home') s = 0
          else if (event.key === 'End') s = 1
          else return
          event.preventDefault()
          change({ h: hsv.h, s: Math.max(0, Math.min(1, s)), v: Math.max(0, Math.min(1, v)) })
        }}
      >
        <span
          className="color-picker__handle"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: props.color,
          }}
        />
      </div>
      <input
        className="color-picker__hue"
        type="range"
        aria-label="Hue"
        min={0}
        max={360}
        value={hsv.h}
        onChange={(event) => change({ ...hsv, h: Number(event.currentTarget.value) })}
      />
      <label className="color-picker__hex">
        <span>Hex</span>
        <input
          type="text"
          aria-label={`${props.label} hex color`}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value)
            setInvalid(false)
          }}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitHex()
            }
          }}
        />
      </label>
      {invalid ? (
        <p className="color-picker__error" id={errorId}>
          Use a hex color, like #5E6AD2.
        </p>
      ) : null}
      <div className="color-picker__presets" role="group" aria-label={`${props.label} presets`}>
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={props.value === option.value}
            title={option.label}
            style={{ backgroundColor: option.color, color: colorForeground(option.color) }}
            onClick={() => props.onChange(option.value)}
          >
            {props.value === option.value ? <IconCheck size={13} aria-hidden /> : null}
          </button>
        ))}
      </div>
    </>
  )
}
