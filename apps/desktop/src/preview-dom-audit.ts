export const PREVIEW_DOM_AUDIT_SCRIPT = `(() => {
  const MAX_ELEMENTS = 20000
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

  // Light DOM plus open shadow roots, in document order and bounded. Closed
  // roots cannot be inspected; a walk cut short reports partial coverage.
  const elements = []
  let coverage = 'complete'
  const stack = document.documentElement ? [document.documentElement] : []
  while (stack.length > 0) {
    if (elements.length === MAX_ELEMENTS) {
      coverage = 'partial'
      break
    }
    const element = stack.pop()
    elements.push(element)
    // An upgraded custom element without an open root may hide a closed one.
    if (!element.shadowRoot && element.localName.includes('-') && element.matches(':defined')) {
      coverage = 'partial'
    }
    const children = [
      ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : []),
      ...Array.from(element.children),
    ]
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
  }

  const composedParent = (element) => {
    if (element.parentElement) return element.parentElement
    const root = element.getRootNode()
    return root instanceof ShadowRoot ? root.host : null
  }

  const isInert = (element) => {
    for (let current = element; current; current = composedParent(current)) {
      if (current.inert || current.hasAttribute('inert')) return true
    }
    return false
  }

  const pathInRoot = (element) => {
    const root = element.getRootNode()
    const parts = []
    for (let current = element; current; current = current.parentElement) {
      if (current.id) {
        parts.unshift('#' + CSS.escape(current.id))
        break
      }
      const tag = current.localName || 'unknown'
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(candidate => candidate.localName === tag)
        : [current]
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : tag)
      const selector = parts.join(' > ')
      try {
        if (root.querySelectorAll(selector).length === 1) return selector
      } catch {
        return selector
      }
    }
    return parts.join(' > ')
  }

  // Shadow content is described through its host; ">>>" marks the boundary.
  const selectorFor = (element) => {
    const parts = []
    for (let current = element; current; ) {
      parts.unshift(pathInRoot(current))
      const root = current.getRootNode()
      current = root instanceof ShadowRoot ? root.host : null
    }
    const selector = parts.join(' >>> ')
    return selector.length <= 512 ? selector : '…' + selector.slice(-511)
  }

  const labelFor = (element) => {
    const root = element.getRootNode()
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .map(id => (id && root.getElementById ? root.getElementById(id) : null)?.textContent || '')
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

  const isRendered = (element) => {
    const style = getComputedStyle(element)
    return !(
      (typeof element.checkVisibility === 'function'
        && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.pointerEvents === 'none'
    )
  }

  // checkVisibility ignores overflow clips, so intersect with clipping ancestors.
  const visibleRect = (element, rect) => {
    let left = rect.left
    let top = rect.top
    let right = rect.right
    let bottom = rect.bottom
    if (getComputedStyle(element).position === 'fixed') return { left, top, right, bottom }
    for (let current = composedParent(element); current; current = composedParent(current)) {
      if (current === document.documentElement || current === document.body) continue
      const style = getComputedStyle(current)
      const clipsX = style.overflowX !== 'visible'
      const clipsY = style.overflowY !== 'visible'
      if (clipsX || clipsY) {
        const bounds = current.getBoundingClientRect()
        if (clipsX) {
          left = Math.max(left, bounds.left)
          right = Math.min(right, bounds.right)
        }
        if (clipsY) {
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.bottom)
        }
      }
      if (style.position === 'fixed') break
    }
    return { left, top, right, bottom }
  }

  const largeEnough = (rect) => rect.width >= 44 && rect.height >= 44

  // A native control is activated by any of its labels too.
  const hasLargeLabel = (element) =>
    Array.from(element.labels || []).some(label =>
      !isInert(label) && isRendered(label) && largeEnough(label.getBoundingClientRect()))

  const start = { x: scrollX, y: scrollY }
  // The screenshot starts at the document origin, so measure from there.
  scrollTo({ left: 0, top: 0, behavior: 'instant' })
  const violations = []
  try {
    for (const element of elements) {
      if (violations.length === 200) break
      if (!element.matches(interactiveSelector)) continue
      if (
        element.matches(':disabled, [aria-disabled="true"], [aria-hidden="true"]')
        || isInert(element)
        || !isRendered(element)
      ) continue
      const rect = element.getBoundingClientRect()
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0) continue
      if (largeEnough(rect) || hasLargeLabel(element)) continue
      const visible = visibleRect(element, rect)
      if (visible.right <= visible.left || visible.bottom <= visible.top) continue
      const partiallyClipped =
        visible.left > rect.left || visible.top > rect.top
        || visible.right < rect.right || visible.bottom < rect.bottom
      violations.push({
        selector: selectorFor(element),
        label: labelFor(element),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        ...(partiallyClipped ? { partiallyClipped: true } : {}),
      })
    }
  } finally {
    scrollTo({ left: start.x, top: start.y, behavior: 'instant' })
  }

  return {
    h1Count: Math.min(elements.filter(element => element.localName === 'h1').length, 10000),
    interactiveTargetViolations: violations,
    coverage,
  }
})()`
