/**
 * Full-screen layouts often scroll inside an element instead of the document
 * (`html, body { height: 100% } main { height: 100%; overflow-y: auto }`). The
 * document then measures one viewport and the screenshot shows only the first
 * screen of that element. `pageScrollerOverflow(element)` returns how far such
 * a page-sized scroller, starting on the first screen, extends below its box,
 * and 0 for any other element. Smaller scroll boxes, such as a code block, are
 * content on the page rather than the page itself.
 */
export const PAGE_SCROLLER_SOURCE = `const pageScrollerOverflow = element => {
  const hidden = element.scrollHeight - element.clientHeight
  // Negated so that a missing measurement (NaN) never counts as a scroller.
  if (!(hidden > 1 && element.clientWidth * 2 >= innerWidth && element.clientHeight * 2 >= innerHeight)) return 0
  const overflowY = getComputedStyle(element).overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return 0
  return element.getBoundingClientRect().top + scrollY < innerHeight ? hidden : 0
}`
