/**
 * Full-screen layouts often scroll inside an element instead of the document
 * (`html, body { height: 100% } main { height: 100%; overflow-y: auto }`). The
 * document then measures one viewport and the screenshot shows only the first
 * screen of that element. `pageScrollerOverflow(element)` returns how far such
 * a page-sized scroller, visible on the first screen, extends below its box,
 * and 0 for any other element. Smaller scroll boxes, such as a code block, are
 * content on the page rather than the page itself, and a closed drawer or modal
 * is not the page either.
 *
 * The overflow is measured against offsetHeight so that a horizontal scrollbar
 * does not count as hidden content: Windows draws it inside the box (about
 * 17px) while macOS overlays it, so clientHeight would flag a full-height
 * gallery as cut short on Windows only.
 */
export const PAGE_SCROLLER_SOURCE = `const pageScrollerOverflow = element => {
  const hidden = element.scrollHeight - element.offsetHeight
  // Negated so that a missing measurement (NaN) never counts as a scroller.
  if (!(hidden > 1 && element.clientWidth * 2 >= innerWidth && element.clientHeight * 2 >= innerHeight)) return 0
  const overflowY = getComputedStyle(element).overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return 0
  if (typeof element.checkVisibility === 'function'
    && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 0
  const rect = element.getBoundingClientRect()
  return rect.right > 0 && rect.left < innerWidth
    && rect.bottom + scrollY > 0 && rect.top + scrollY < innerHeight ? hidden : 0
}`
