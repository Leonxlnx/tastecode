export const PREVIEW_DOM_AUDIT_SCRIPT = `(() => {
  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const selectorFor = (element) => {
    if (element.id) return ('#' + CSS.escape(element.id)).slice(0, 512)
    const tag = element.localName || 'unknown'
    const siblings = element.parentElement
      ? Array.from(element.parentElement.children).filter(candidate => candidate.localName === tag)
      : [element]
    return (tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')').slice(0, 512)
  }

  const labelFor = (element) => {
    const label = element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.textContent
      || element.getAttribute('name')
      || ''
    return label.replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  const violations = []
  for (const element of document.querySelectorAll(interactiveSelector)) {
    if (violations.length === 200) break
    const style = getComputedStyle(element)
    if (
      element.matches(':disabled, [aria-disabled="true"], [aria-hidden="true"]')
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.pointerEvents === 'none'
    ) continue
    const rect = element.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue
    if (rect.right < 0 || rect.left > innerWidth) continue
    if (rect.width >= 44 && rect.height >= 44) continue
    violations.push({
      selector: selectorFor(element),
      label: labelFor(element),
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    })
  }

  return {
    h1Count: Math.min(document.querySelectorAll('h1').length, 10000),
    interactiveTargetViolations: violations,
  }
})()`
