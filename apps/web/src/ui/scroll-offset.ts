import { debounce, type Virtualizer } from '@tanstack/react-virtual'

/**
 * The virtual list's scroll observer: virtual-core's observeElementOffset,
 * except that the position comes from `readTop`.
 *
 * The follow glide writes the scroll every frame while a reply streams. The
 * text that arrives before the next frame changes the transcript, so reading
 * scrollTop in the scroll event that write causes laid the whole transcript
 * out again, once per frame. The glide reads back where its write landed
 * while layout is still clean, and `readTop` hands that back for its own event.
 */
export function observeScrollOffset<TItem extends Element>(
  instance: Virtualizer<HTMLDivElement, TItem>,
  callback: (offset: number, isScrolling: boolean) => void,
  readTop: (element: HTMLDivElement, event: Event) => number,
): (() => void) | undefined {
  const element = instance.scrollElement
  const targetWindow = instance.targetWindow
  if (!element || !targetWindow) return undefined
  const scrollend = instance.options.useScrollendEvent && 'onscrollend' in targetWindow
  let offset = 0
  // Without scrollend, scrolling counts as over once no scroll event came for a while.
  const settle = scrollend
    ? undefined
    : debounce(targetWindow, () => callback(offset, false), instance.options.isScrollingResetDelay)
  const listen = (isScrolling: boolean) => (event: Event) => {
    offset = readTop(element, event)
    settle?.()
    callback(offset, isScrolling)
  }
  const onScroll = listen(true)
  const onScrollEnd = listen(false)
  element.addEventListener('scroll', onScroll, { passive: true })
  if (scrollend) element.addEventListener('scrollend', onScrollEnd, { passive: true })
  return () => {
    element.removeEventListener('scroll', onScroll)
    if (scrollend) element.removeEventListener('scrollend', onScrollEnd)
  }
}
