/** Copy into the site's existing script; CSS keeps every element visible by default. */
export function installReferenceReveals(root = document) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const animations = new Map()
  const elements = [...root.querySelectorAll('[data-reveal]')]
  const finish = (element) => {
    element.dataset.revealPlayed = 'true'
    animations.get(element)?.cancel()
    animations.delete(element)
  }
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              const element = entry.target
              observer.unobserve(element)
              element.dataset.revealPlayed = 'true'
              if (
                reduced.matches ||
                document.visibilityState === 'hidden' ||
                entry.boundingClientRect.bottom <= 0
              )
                finish(element)
              else animations.get(element)?.play()
            }
          },
          { threshold: 0, rootMargin: '0px 0px 96px 0px' },
        )
      : undefined
  const stop = () => {
    observer?.disconnect()
    elements.forEach(finish)
  }
  const onPreference = () => {
    if (reduced.matches) stop()
  }
  reduced.addEventListener('change', onPreference)
  for (const element of elements) {
    if (element.dataset.revealPlayed === 'true') continue
    const rect = element.getBoundingClientRect()
    // Never hide already visible content after first paint or a restored scroll position.
    if (
      reduced.matches ||
      !observer ||
      !element.animate ||
      rect.top < innerHeight ||
      document.visibilityState === 'hidden'
    ) {
      finish(element)
      continue
    }
    const transform =
      element.dataset.reveal === 'media'
        ? 'scale(1.025)'
        : element.dataset.reveal === 'slide'
          ? 'translateX(-12px)'
          : 'translateY(12px)'
    const animation = element.animate(
      [
        { opacity: 0, transform },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
    )
    animation.pause()
    animation.onfinish = () => finish(element)
    animations.set(element, animation)
    observer.observe(element)
  }
  return () => {
    stop()
    reduced.removeEventListener('change', onPreference)
  }
}
