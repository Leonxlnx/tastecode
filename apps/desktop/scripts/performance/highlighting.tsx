import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CompletedMarkdown } from '../../../web/src/ui/CompletedMarkdown.js'
import { highlightedTokens } from './highlighting-dom.js'

const code = Array.from(
  { length: 700 },
  (_, index) => `export const item${index} = { label: "entry ${index}", enabled: true };`,
).join('\n')
const markdown = `\`\`\`typescript\n${code}\n\`\`\``
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

/** Observe native workers without replacing their execution or returning fake tokens. */
export async function runHighlightingFixture() {
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask'))
    throw new Error('Chromium long-task observation is required')
  const host = document.createElement('section')
  host.className = 'highlighting-fixture'
  document.body.append(host)
  const root = createRoot(host)
  const originalPost = Worker.prototype.postMessage
  const theme = document.documentElement.dataset.theme
  const dark = document.documentElement.classList.contains('dark')
  let requests = 0
  Worker.prototype.postMessage = function (
    message: unknown,
    options?: Transferable[] | StructuredSerializeOptions,
  ) {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'highlight'
    )
      requests += 1
    return Reflect.apply(originalPost, this, [message, options])
  }
  const longTasks: number[] = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  })
  observer.observe({ type: 'longtask' })
  const frames: number[] = []
  let previous = await frame()
  let frameId = 0
  const sampleFrame = (now: number) => {
    frames.push(now - previous)
    previous = now
    frameId = requestAnimationFrame(sampleFrame)
  }
  frameId = requestAnimationFrame(sampleFrame)
  const colored = () => highlightedTokens(host).length
  const waitForColor = async () => {
    const deadline = performance.now() + 15_000
    const pending = () => host.querySelector('[data-highlight-pending="true"]') || colored() === 0
    while (pending() && performance.now() < deadline) await frame()
    if (pending()) throw new Error('Real worker did not paint all highlighted code')
    await frame()
    await frame()
  }
  try {
    performance.mark('highlight-cold-start')
    flushSync(() =>
      root.render(
        <>
          <CompletedMarkdown text={markdown} />
          <CompletedMarkdown text={markdown} />
        </>,
      ),
    )
    await waitForColor()
    const blocks = [...host.querySelectorAll<HTMLElement>('pre code')]
    if (blocks.length !== 2) throw new Error('Both full code fences must remain mounted')
    for (const block of blocks) {
      // Chromium can return empty innerText for inline code containing block lines.
      // Verify every source line and its layout instead of depending on that getter.
      const chunks = block.querySelectorAll<HTMLElement>('.md-code-line')
      const lines = [
        ...(chunks.length ? chunks : block.querySelectorAll<HTMLElement>(':scope > span')),
      ]
      if (
        lines.length !== 700 ||
        lines.map((line) => line.textContent).join('\n') !== code ||
        lines.some((line) => line.getBoundingClientRect().height === 0)
      )
        throw new Error('Highlighted code changed the full representative source or line layout')
    }
    const coldRequests = requests
    const coloredTokens = colored()
    performance.mark('highlight-cold-end')
    flushSync(() => root.render(null))
    await frame()
    performance.mark('highlight-remount-start')
    flushSync(() => root.render(<CompletedMarkdown text={markdown} />))
    await waitForColor()
    const remountRequests = requests - coldRequests
    const colors = []
    for (const nextTheme of ['light', 'dark']) {
      document.documentElement.dataset.theme = nextTheme
      document.documentElement.classList.toggle('dark', nextTheme === 'dark')
      await frame()
      await frame()
      const token = highlightedTokens(host)[0]
      if (!token) throw new Error(`Highlighted tokens disappeared in ${nextTheme} mode`)
      colors.push(getComputedStyle(token).color)
    }
    performance.mark('highlight-remount-end')
    return {
      codeCharacters: code.length,
      coldRequests,
      remountRequests,
      themeRequests: requests - coldRequests - remountRequests,
      coloredTokens,
      colors,
      frames,
      // Chromium reports tasks >=50ms here; frame samples enforce the stricter
      // 32ms budget, and the saved trace permits inspection of shorter tasks.
      longTasks,
    }
  } finally {
    cancelAnimationFrame(frameId)
    for (const entry of observer.takeRecords()) longTasks.push(entry.duration)
    observer.disconnect()
    Worker.prototype.postMessage = originalPost
    flushSync(() => root.unmount())
    host.remove()
    if (theme === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('dark', dark)
  }
}
