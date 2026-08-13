import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keep a modal's keyboard input and focus inside its visible surface. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const panel = useRef<T>(null)
  const close = useRef(onClose)
  const previousFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  close.current = onClose

  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus()
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    // The app owns global shortcuts on window. A modal must not let those
    // commands mutate the surface hidden underneath it.
    event.stopPropagation()
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      close.current()
      return
    }
    if (event.key !== 'Tab' || event.defaultPrevented || !panel.current) return

    const focusable = Array.from(
      panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]'),
    )
    const first = focusable[0]
    const last = focusable.at(-1)
    const active = document.activeElement
    const atBoundary =
      !first ||
      !last ||
      active === panel.current ||
      !panel.current.contains(active) ||
      (event.shiftKey ? active === first : active === last)
    if (!atBoundary) return

    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }, [])

  return { panel, onKeyDown }
}
