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
    '[role="gridcell"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="treeitem"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(',')

  const selectorFor = (element) => {
    const idSelector = element.id ? '#' + CSS.escape(element.id) : ''
    if (idSelector.length > 0 && idSelector.length <= 512) return idSelector
    const tag = element.localName || 'unknown'
    const siblings = element.parentElement
      ? Array.from(element.parentElement.children).filter(candidate => candidate.localName === tag)
      : [element]
    return (tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')').slice(0, 512)
  }

  const labelFor = (element) => {
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .map(id => document.getElementById(id)?.textContent || '')
      .join(' ')
    const associatedLabels = Array.from(element.labels || [])
      .map(label => label.textContent || '')
      .join(' ')
    const label = labelledBy
      || element.getAttribute('aria-label')
      || associatedLabels
      || element.textContent
      || element.getAttribute('title')
      || element.getAttribute('name')
      || ''
    return label.replace(/\\s+/g, ' ').trim().slice(0, 200)
  }

  const violations = []
  for (const element of document.querySelectorAll(interactiveSelector)) {
    if (violations.length === 200) break
    const style = getComputedStyle(element)
    if (
      element.matches(':disabled, [aria-disabled="true"], [aria-hidden="true"]')
      || (typeof element.checkVisibility === 'function'
        && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.pointerEvents === 'none'
    ) continue
    const rect = element.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0) continue
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
