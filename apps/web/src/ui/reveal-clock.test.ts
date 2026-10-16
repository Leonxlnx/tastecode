// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { REVEAL_FRESH, REVEAL_PENDING_ATTRIBUTE, createRevealClock } from './reveal-clock.js'
import { fakeRevealEnvironment as fakeEnvironment, visibleText } from './reveal-clock.fixture.js'

function liveRoot() {
  const root = document.createElement('div')
  const paragraph = document.createElement('p')
  const text = document.createTextNode('')
  paragraph.append(text)
  root.append(paragraph)
  document.body.append(root)
  return { root, paragraph, text }
}

/** Characters of text before (node, offset). */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  if (node === root) return 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let count = 0
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) return count + offset
    count += (text as Text).length
  }
  return count
}

const prose = (length: number) =>
  'The handler records the event before it charges the card again. '
    .repeat(Math.ceil(length / 64))
    .slice(0, length)

describe('reveal clock', () => {
  it('reveals bursts on every frame instead of in jumps', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    const source = prose(300)
    const shown: number[] = []
    let sent = 0
    for (let frame = 0; frame < 160; frame += 1) {
      // Six bursts of 50 characters, about 120 ms apart.
      if (sent < 300 && frame % 8 === 0) {
        text.appendData(source.slice(sent, sent + 50))
        cursor.appended(50)
        sent += 50
      }
      fake.frame(15)
      shown.push(visibleText(root, fake.ranges()).length)
    }

    expect(shown.at(-1)).toBe(300)
    const end = shown.indexOf(300)
    const steps = shown.slice(1, end + 1).map((value, index) => value - shown[index]!)
    // Past the first frames of the ease-in, the edge moves on every frame.
    expect(steps.slice(3).every((step) => step >= 1)).toBe(true)
    // An even pace: about 6 characters a frame, never a jump.
    expect(Math.max(...steps)).toBeLessThanOrEqual(9)
    // The last step is whatever was left.
    const even = steps.slice(0, -1)
    const changes = even.slice(1).map((step, index) => Math.abs(step - even[index]!))
    expect(Math.max(...changes)).toBeLessThanOrEqual(3)
    expect(visibleText(root, fake.ranges())).toBe(source)
  })

  it('trails a steady provider by 70-180 ms', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    const arrivedAt: number[] = []
    const lags: number[] = []
    for (let frame = 0; frame < 240; frame += 1) {
      if (frame < 200) {
        text.appendData('words ')
        cursor.appended(6)
        for (let k = 0; k < 6; k += 1) arrivedAt.push(fake.time)
      }
      fake.frame(16)
      const visible = visibleText(root, fake.ranges()).length
      while (lags.length < visible) lags.push(fake.time - arrivedAt[lags.length]!)
    }

    lags.sort((a, b) => a - b)
    const median = lags[Math.floor(lags.length / 2)]!
    expect(median).toBeGreaterThanOrEqual(50)
    expect(median).toBeLessThanOrEqual(130)
    expect(lags.at(-1)).toBeLessThanOrEqual(200)
  })

  it('never shows text much later than 180 ms after it arrived', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    const arrivedAt: number[] = []
    const lags: number[] = []
    for (let frame = 0; frame < 300; frame += 1) {
      // A provider that sends 120 characters every 400 ms.
      if (frame % 25 === 0 && frame < 250) {
        text.appendData(prose(120))
        cursor.appended(120)
        for (let k = 0; k < 120; k += 1) arrivedAt.push(fake.time)
      }
      fake.frame(16)
      const visible = visibleText(root, fake.ranges()).length
      while (lags.length < visible) lags.push(fake.time - arrivedAt[lags.length]!)
    }

    expect(lags).toHaveLength(1200)
    expect(Math.max(...lags)).toBeLessThanOrEqual(200)
  })

  it('drains a finished reply within 250 ms and reports it once', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    for (let frame = 0; frame < 40; frame += 1) {
      text.appendData('steady ')
      cursor.appended(7)
      fake.frame(16)
    }
    expect(visibleText(root, fake.ranges()).length).toBeLessThan(280)

    cursor.finish()
    const finishedAt = fake.time
    while (fake.pendingFrames() > 0 && fake.time - finishedAt < 1000) fake.frame(16)

    expect(onDrained).toHaveBeenCalledOnce()
    expect(fake.time - finishedAt).toBeLessThanOrEqual(250)
    expect(fake.ranges()).toHaveLength(0)
    expect(visibleText(root, fake.ranges())).toBe(root.textContent)
    cursor.finish()
    expect(onDrained).toHaveBeenCalledOnce()
  })

  it('reports a finished reply with nothing left at once', () => {
    const fake = fakeEnvironment()
    const { root } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    cursor.finish()
    expect(onDrained).toHaveBeenCalledOnce()
    expect(fake.pendingFrames()).toBe(0)
  })

  it('drains on a timer when no frames come', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    text.appendData(prose(200))
    cursor.appended(200)
    cursor.finish()
    fake.wait(999)
    expect(onDrained).not.toHaveBeenCalled()
    fake.wait(1)
    expect(onDrained).toHaveBeenCalledOnce()
    expect(fake.ranges()).toHaveLength(0)
  })

  it('jumps close to the end of a huge burst instead of crawling through it', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    for (let frame = 0; frame < 30; frame += 1) {
      text.appendData('steady ')
      cursor.appended(7)
      fake.frame(16)
    }
    text.appendData('x'.repeat(20_000))
    cursor.appended(20_000)
    fake.frame(16)

    expect(visibleText(root, fake.ranges()).length).toBeGreaterThan(20_000 + 210 - 120)
  })

  it('covers text appended past the veil before the next frame', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData(prose(100))
    cursor.appended(100)
    fake.frame(16)

    const next = document.createElement('p')
    const added = 'A new paragraph.'
    next.textContent = added
    root.append(next)
    cursor.appended(added.length)

    const [veil] = fake.ranges()
    expect(veil?.endContainer).toBe(root)
    expect(veil?.endOffset).toBe(root.childNodes.length)
    expect(visibleText(root, fake.ranges())).not.toContain('A new')
  })

  it('walks into nodes appended after it and skips code block labels', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    text.appendData('Run this:')
    cursor.appended(9)
    const block = document.createElement('div')
    const header = document.createElement('div')
    const code = document.createElement('code')
    block.dataset.streamdown = 'code-block'
    header.dataset.streamdown = 'code-block-header'
    header.textContent = 'ts'
    block.append(header, code)
    root.append(block)
    code.append('const ready = true')
    cursor.appended(18)
    cursor.finish()
    for (let frame = 0; frame < 60 && !onDrained.mock.calls.length; frame += 1) fake.frame(16)

    expect(onDrained).toHaveBeenCalledOnce()
    expect(fake.ranges()).toHaveLength(0)
    expect(visibleText(root, fake.ranges())).toBe('Run this:tsconst ready = true')
  })

  it('never splits a surrogate pair', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData('😀'.repeat(40))
    cursor.appended(80)
    for (let frame = 0; frame < 40; frame += 1) {
      fake.frame(7)
      const [veil] = fake.ranges()
      if (veil?.startContainer === text) expect(veil.startOffset % 2).toBe(0)
    }
  })

  it('shows everything at once on reset', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData(prose(200))
    cursor.appended(200)
    fake.frame(16)
    expect(fake.ranges()).toHaveLength(1)

    cursor.reset()
    expect(fake.ranges()).toHaveLength(0)
    text.appendData(' more')
    cursor.appended(5)
    expect(visibleText(root, fake.ranges())).toBe(prose(200))
  })

  it('stops veiling when motion is no longer allowed', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    text.appendData(prose(200))
    cursor.appended(200)
    cursor.finish()
    fake.setMotion(false)

    expect(fake.ranges()).toHaveLength(0)
    expect(onDrained).toHaveBeenCalledOnce()
    text.appendData(' later')
    cursor.appended(6)
    expect(fake.ranges()).toHaveLength(0)
  })

  it('shows text as it lands under reduced motion or without the API', () => {
    const reduced = fakeEnvironment()
    reduced.setMotion(false)
    const { root, text } = liveRoot()
    const clock = createRevealClock(reduced.env)
    expect(clock.enabled()).toBe(false)
    const cursor = clock.attach(root)
    text.appendData('Hello')
    cursor.appended(5)
    expect(reduced.ranges()).toHaveLength(0)
    expect(reduced.pendingFrames()).toBe(0)

    const missing = fakeEnvironment()
    missing.removeApi()
    const inert = createRevealClock(missing.env)
    const onDrained = vi.fn()
    const none = inert.attach(root, { onDrained })
    expect(inert.enabled()).toBe(false)
    expect(none.tracking).toBe(false)
    none.appended(5)
    none.finish()
    expect(onDrained).toHaveBeenCalledOnce()
    expect(missing.pendingFrames()).toBe(0)
  })

  it('removes its veil when disposed', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData(prose(100))
    cursor.appended(100)
    expect(fake.ranges()).toHaveLength(1)
    cursor.dispose()
    expect(fake.ranges()).toHaveLength(0)
    fake.frame(16)
    expect(fake.pendingFrames()).toBe(0)
  })
})

describe('reveal clock leading edge', () => {
  it('fades the last characters in through three contiguous bands', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    const widths: number[] = []
    for (let frame = 0; frame < 120; frame += 1) {
      text.appendData('words ')
      cursor.appended(6)
      fake.frame(16)
      if (frame < 40) continue
      const [veil] = fake.ranges()
      const bands = REVEAL_FRESH.map((name) => fake.ranges(name)[0])
      expect(veil).toBeDefined()
      expect(bands.every(Boolean)).toBe(true)
      const [nearest, middle, farthest] = bands as [AbstractRange, AbstractRange, AbstractRange]
      // Each band ends where the next one nearer the edge starts.
      expect([nearest.endContainer, nearest.endOffset]).toEqual([
        veil!.startContainer,
        veil!.startOffset,
      ])
      expect([middle.endContainer, middle.endOffset]).toEqual([
        nearest.startContainer,
        nearest.startOffset,
      ])
      expect([farthest.endContainer, farthest.endOffset]).toEqual([
        middle.startContainer,
        middle.startOffset,
      ])
      widths.push(
        offsetOf(root, veil!.startContainer, veil!.startOffset) -
          offsetOf(root, farthest.startContainer, farthest.startOffset),
      )
    }
    widths.sort((a, b) => a - b)
    const median = widths[Math.floor(widths.length / 2)]!
    // About 12 characters at this speed (375 per second).
    expect(median).toBeGreaterThanOrEqual(8)
    expect(median).toBeLessThanOrEqual(16)
  })

  it('lets the bands close once the edge stops, and drains only then', () => {
    const fake = fakeEnvironment()
    const { root, text } = liveRoot()
    const onDrained = vi.fn()
    const cursor = createRevealClock(fake.env).attach(root, { onDrained })
    for (let frame = 0; frame < 30; frame += 1) {
      text.appendData('words ')
      cursor.appended(6)
      fake.frame(16)
    }
    cursor.finish()
    let shownAt: number | undefined
    while (fake.pendingFrames() > 0 && fake.time < 5000) {
      fake.frame(16)
      if (shownAt === undefined && fake.ranges().length === 0) shownAt = fake.time
      if (fake.pendingFrames() > 0) expect(onDrained).not.toHaveBeenCalled()
    }

    expect(onDrained).toHaveBeenCalledOnce()
    for (const name of REVEAL_FRESH) expect(fake.ranges(name)).toHaveLength(0)
    // The last characters finish fading within the longest ramp.
    expect(fake.time - shownAt!).toBeLessThanOrEqual(110 + 16)
  })

  it('draws no bands where nothing is veiled', () => {
    const fake = fakeEnvironment()
    fake.setMotion(false)
    const { root, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData(prose(100))
    cursor.appended(100)
    fake.frame(16)
    for (const name of REVEAL_FRESH) expect(fake.ranges(name)).toHaveLength(0)
  })
})

describe('reveal clock held boxes', () => {
  it('shows a held box only once the edge reaches its text', () => {
    const fake = fakeEnvironment()
    const { root, paragraph, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData('Run the tests with ')
    const code = document.createElement('code')
    paragraph.append(code)
    cursor.holdBox(code)
    code.append('pnpm test')
    cursor.appended(19 + 9)
    expect(code.hasAttribute(REVEAL_PENDING_ATTRIBUTE)).toBe(true)

    while (fake.pendingFrames() > 0) {
      fake.frame(16)
      const shown = visibleText(root, fake.ranges()).length
      // Held while the edge is in the prose before it, shown from its first character.
      if (shown <= 19) expect(code.hasAttribute(REVEAL_PENDING_ATTRIBUTE)).toBe(true)
      if (shown > 19) expect(code.hasAttribute(REVEAL_PENDING_ATTRIBUTE)).toBe(false)
    }
    expect(visibleText(root, fake.ranges())).toBe('Run the tests with pnpm test')
  })

  it('lets every held box go when everything shows, and holds none without motion', () => {
    const fake = fakeEnvironment()
    const { root, paragraph, text } = liveRoot()
    const cursor = createRevealClock(fake.env).attach(root)
    text.appendData(prose(100))
    const code = document.createElement('code')
    code.append('later')
    paragraph.append(code)
    cursor.holdBox(code)
    cursor.appended(105)
    cursor.reset()
    expect(code.hasAttribute(REVEAL_PENDING_ATTRIBUTE)).toBe(false)

    fake.setMotion(false)
    const another = document.createElement('code')
    paragraph.append(another)
    cursor.holdBox(another)
    expect(another.hasAttribute(REVEAL_PENDING_ATTRIBUTE)).toBe(false)
  })
})
