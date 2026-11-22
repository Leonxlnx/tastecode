// @vitest-environment happy-dom
import type { BrowserCommand } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runAgentBrowserCommand,
  type AgentBrowserGuest,
  type ScaleScreenshot,
} from './agent-browser-executor.js'
import { scalePng } from './white-ground.js'

const ID = '00000000-0000-4000-8000-000000000001'

/** A guest whose page is this test document: scripts run against it as they would in the tab. */
function guest(overrides: Partial<AgentBrowserGuest> = {}) {
  const page: AgentBrowserGuest = {
    loadURL: vi.fn(async () => undefined),
    getURL: () => 'http://127.0.0.1:5173/checkout',
    getTitle: () => 'Checkout',
    // eslint-disable-next-line no-eval -- the page's own scripts, against the test document
    executeJavaScript: async (code) => (0, eval)(code),
    // eslint-disable-next-line no-eval -- the test document stands in for the isolated world too
    executeIsolated: async (code) => (0, eval)(code),
    capturePng: async () => 'data:image/png;base64,AAAA',
    ...overrides,
  }
  return { page }
}

const run = (
  command: object,
  page: AgentBrowserGuest,
  scale: ScaleScreenshot = async () => 'iVBORw0K',
) =>
  runAgentBrowserCommand(
    { threadId: 'chat-1', commandId: ID, ...command } as BrowserCommand,
    page,
    () => [
      { level: 'log', text: 'old', at: 1 },
      { level: 'error', text: 'new', at: 5 },
    ],
    scale,
  )

afterEach(() => {
  document.body.innerHTML = ''
})

describe('agent browser commands', () => {
  it('opens only what the address bar would: https, and plain http on this machine', async () => {
    const { page } = guest()
    expect(await run({ action: 'open', url: 'http://127.0.0.1:5173/' }, page)).toMatchObject({
      ok: true,
      url: 'http://127.0.0.1:5173/checkout',
      title: 'Checkout',
    })
    for (const url of ['http://example.com/', 'file:///C:/secret.txt']) {
      const answer = await run({ action: 'navigate', url }, page)
      expect(answer, url).toMatchObject({ ok: false })
    }
    expect(page.loadURL).toHaveBeenCalledTimes(1)
  })

  it('never types into a password or payment field, and says why', async () => {
    document.body.innerHTML = `
      <input id="pw" type="password">
      <input id="card" autocomplete="cc-number">
      <label for="cvc">Security code</label><input id="cvc">
      <input id="otp" name="one-time-code">
      <input id="email" type="email">`
    const { page } = guest()
    expect(await run({ action: 'type', selector: '#pw', text: 'x' }, page)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/password/),
    })
    for (const selector of ['#card', '#cvc'])
      expect(await run({ action: 'type', selector, text: '4242' }, page), selector).toMatchObject({
        ok: false,
        error: expect.stringMatching(/payment/),
      })
    expect(await run({ action: 'type', selector: '#otp', text: '123456' }, page)).toMatchObject({
      ok: false,
    })
    for (const selector of ['#pw', '#card', '#cvc', '#otp'])
      expect(document.querySelector<HTMLInputElement>(selector)!.value).toBe('')

    const input = vi.fn()
    document.querySelector('#email')!.addEventListener('input', input)
    expect(
      await run({ action: 'type', selector: '#email', text: 'me@example.com' }, page),
    ).toMatchObject({ ok: true })
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe('me@example.com')
    expect(input).toHaveBeenCalledOnce()
  })

  // A page can replace its own querySelector or value setter; the check must not run there.
  it('reads "card" as a word of its own, so a search for postcards is typed into', async () => {
    document.body.innerHTML = `
      <input id="search" placeholder="Search postcards">
      <input id="snake" name="card_number">
      <input id="camel" name="cardNumber">
      <input id="billing" name="billing_card">
      <label for="holder">Card holder</label><input id="holder">
      <input id="credit" aria-label="creditcard">`
    const { page } = guest()
    for (const selector of ['#snake', '#camel', '#billing', '#holder', '#credit'])
      expect(await run({ action: 'type', selector, text: '4242' }, page), selector).toMatchObject({
        ok: false,
        error: expect.stringMatching(/payment/),
      })
    expect(await run({ action: 'type', selector: '#search', text: 'Paris' }, page)).toMatchObject({
      ok: true,
    })
    expect(document.querySelector<HTMLInputElement>('#search')!.value).toBe('Paris')
  })

  const PAYMENT_NAMES = [
    'paymentCardNumber',
    'cardNumberInput',
    'cardHolderName',
    'card_number',
    'billing_card',
    'payment-card-number',
    'cardNumber',
    'cardnumber',
    'card number',
    'cc-number',
    'creditcard',
    'Kartennummer',
    'paymentcardnumber',
    'cardholdername',
  ]
  const ORDINARY_NAMES = [
    'discard',
    'cardigan',
    'Search postcards',
    'scorecard',
    'dashboard',
    'giftcardigan',
  ]
  const ALONE_AS = {
    id: (value: string) => `<input data-field id="${value}">`,
    name: (value: string) => `<input data-field name="${value}">`,
    autocomplete: (value: string) => `<input data-field autocomplete="${value}">`,
    placeholder: (value: string) => `<input data-field placeholder="${value}">`,
    'aria-label': (value: string) => `<input data-field aria-label="${value}">`,
    label: (value: string) => `<label for="field">${value}</label><input data-field id="field">`,
  }

  it.each(Object.entries(ALONE_AS))(
    'refuses a payment field whose only clue is its %s',
    async (attribute, html) => {
      const { page } = guest()
      for (const value of PAYMENT_NAMES) {
        document.body.innerHTML = html(value)
        const answer = await run({ action: 'type', selector: '[data-field]', text: '4242' }, page)
        expect(answer, `${attribute}=${value}`).toMatchObject({
          ok: false,
          error: expect.stringMatching(/payment/),
        })
        expect(document.querySelector<HTMLInputElement>('[data-field]')!.value).toBe('')
      }
    },
  )

  it.each(Object.entries(ALONE_AS))(
    'types into a field whose %s only contains "card" inside another word',
    async (attribute, html) => {
      const { page } = guest()
      for (const value of ORDINARY_NAMES) {
        document.body.innerHTML = html(value)
        const answer = await run({ action: 'type', selector: '[data-field]', text: 'Paris' }, page)
        expect(answer, `${attribute}=${value}`).toMatchObject({ ok: true })
        expect(document.querySelector<HTMLInputElement>('[data-field]')!.value).toBe('Paris')
      }
    },
  )

  it('checks and types in its own world, never in the page’s', async () => {
    document.body.innerHTML = '<input id="pw" type="password">'
    const pageWorld = vi.fn(async () => 'ok')
    const { page } = guest({ executeJavaScript: pageWorld })
    expect(await run({ action: 'type', selector: '#pw', text: 'x' }, page)).toMatchObject({
      ok: false,
    })
    expect(pageWorld).not.toHaveBeenCalled()
  })

  it('clicks an element by selector or a point, and refuses a missing element', async () => {
    document.body.innerHTML = '<button id="buy">Buy</button>'
    const button = document.querySelector('#buy')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    // happy-dom has no layout; the page's own hit test stands in for the point.
    const atPoint = vi.spyOn(document, 'elementFromPoint').mockReturnValue(button)
    const { page } = guest()
    expect(await run({ action: 'click', selector: '#buy' }, page)).toMatchObject({ ok: true })
    expect(await run({ action: 'click', x: 40, y: 60 }, page)).toMatchObject({ ok: true })
    expect(atPoint).toHaveBeenCalledWith(40, 60)
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(await run({ action: 'click', selector: '#gone' }, page)).toMatchObject({
      ok: false,
      error: 'No element matches that selector.',
    })
  })

  it("clicks an icon's SVG, and the button around it hears the click", async () => {
    document.body.innerHTML =
      '<button id="close"><svg viewBox="0 0 10 10"><path id="glyph" d="M0 0L10 10"/></svg></button>'
    const glyph = document.querySelector('#glyph')!
    const clicked = vi.fn()
    document.querySelector('#close')!.addEventListener('click', clicked)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(glyph)
    const { page } = guest()
    expect(await run({ action: 'click', selector: '#glyph' }, page)).toMatchObject({ ok: true })
    expect(await run({ action: 'click', x: 5, y: 5 }, page)).toMatchObject({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(2)
  })

  it('clicks a chart point at the position the agent named', async () => {
    document.body.innerHTML = '<svg id="chart"><circle id="dot" r="4"/></svg>'
    const at = vi.fn()
    document.querySelector('#chart')!.addEventListener('click', (event) => {
      const { clientX, clientY } = event as MouseEvent
      at(clientX, clientY)
    })
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.querySelector('#dot'))
    const { page } = guest()
    expect(await run({ action: 'click', x: 100, y: 50 }, page)).toMatchObject({ ok: true })
    expect(at).toHaveBeenCalledExactlyOnceWith(100, 50)
  })

  it('reads text, bounded, and treats a selector as data, not code', async () => {
    document.body.innerHTML = `<main id="main">${'word '.repeat(30_000)}</main>`
    const { page } = guest({
      // happy-dom has no layout, so innerText is its textContent here.
      executeJavaScript: async (code) => (0, eval)(code.replaceAll('innerText', 'textContent')),
    })
    const answer = await run({ action: 'read_text' }, page)
    expect(answer.ok && answer.text?.length).toBe(100_000)
    const hostile = await run({ action: 'read_text', selector: `x'); alert(1); ('` }, page)
    expect(hostile.ok).toBe(false)
  })

  it('sends a screenshot at the page’s CSS width, bounded, and the console since a time', async () => {
    const scale = vi.fn(async () => 'iVBORw0K')
    let cssWidth: number | undefined = 800
    const { page } = guest({
      // eslint-disable-next-line no-eval -- the test document stands in for the isolated world
      executeIsolated: async (code) => (code === 'window.innerWidth' ? cssWidth : (0, eval)(code)),
    })
    expect(await run({ action: 'screenshot' }, page, scale)).toMatchObject({
      ok: true,
      png: 'iVBORw0K',
    })
    // An 800 px wide page on a Retina screen captures 1600 px wide; the agent gets 800.
    expect(scale).toHaveBeenLastCalledWith('data:image/png;base64,AAAA', 800, true)
    cssWidth = 2400
    await run({ action: 'screenshot' }, page, scale)
    expect(scale).toHaveBeenLastCalledWith('data:image/png;base64,AAAA', 1600, true)
    cssWidth = undefined
    await run({ action: 'screenshot' }, page, scale)
    expect(scale).toHaveBeenLastCalledWith('data:image/png;base64,AAAA', 1600, false)
    expect(await run({ action: 'console', since: 2 }, page)).toMatchObject({
      ok: true,
      console: [{ level: 'error', text: 'new', at: 5 }],
    })
  })

  it('still sends a screenshot when the page width cannot be read', async () => {
    const scale = vi.fn<ScaleScreenshot>(async () => 'iVBORw0K')
    const { page } = guest({
      executeIsolated: async () => {
        throw new Error('Not an agent browser tab')
      },
    })
    expect(await run({ action: 'screenshot' }, page, scale)).toMatchObject({
      ok: true,
      png: 'iVBORw0K',
    })
    expect(scale.mock.lastCall?.[1]).toBe(1600)
  })

  it('draws a capture narrower than the page at the page’s CSS width', async () => {
    vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    vi.spyOn(Image.prototype, 'naturalWidth', 'get').mockReturnValue(800)
    vi.spyOn(Image.prototype, 'naturalHeight', 'get').mockReturnValue(600)
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,iVBORw0K',
    )
    try {
      const { page } = guest({ executeIsolated: async () => 1000 })
      expect(await run({ action: 'screenshot' }, page, scalePng)).toMatchObject({ ok: true })
      const drawn = getContext.mock.contexts[0] as HTMLCanvasElement
      expect([drawn.width, drawn.height]).toEqual([1000, 750])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('answers a failed page action with its reason instead of throwing', async () => {
    const { page } = guest({
      loadURL: async () => {
        throw new Error('ERR_CONNECTION_REFUSED (-102)')
      },
    })
    expect(await run({ action: 'open', url: 'http://127.0.0.1:9/' }, page)).toEqual({
      commandId: ID,
      ok: false,
      error: 'ERR_CONNECTION_REFUSED (-102)',
    })
  })
})
