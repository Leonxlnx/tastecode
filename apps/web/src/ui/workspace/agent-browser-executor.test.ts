// @vitest-environment happy-dom
import type { BrowserCommand } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentBrowserCommand, type AgentBrowserGuest } from './agent-browser-executor.js'

const ID = '00000000-0000-4000-8000-000000000001'

/** A guest whose page is this test document: scripts run against it as they would in the tab. */
function guest(overrides: Partial<AgentBrowserGuest> = {}) {
  const events: Array<{ type: string; x: number; y: number }> = []
  const page: AgentBrowserGuest = {
    loadURL: vi.fn(async () => undefined),
    getURL: () => 'http://127.0.0.1:5173/checkout',
    getTitle: () => 'Checkout',
    // eslint-disable-next-line no-eval -- the page's own scripts, against the test document
    executeJavaScript: async (code) => (0, eval)(code),
    // eslint-disable-next-line no-eval -- the test document stands in for the isolated world too
    executeIsolated: async (code) => (0, eval)(code),
    capturePng: async () => 'data:image/png;base64,AAAA',
    sendInputEvent: (event) => events.push(event),
    ...overrides,
  }
  return { page, events }
}

const run = (command: object, page: AgentBrowserGuest, scale = async () => 'iVBORw0K') =>
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
    const { page, events } = guest()
    expect(await run({ action: 'click', selector: '#buy' }, page)).toMatchObject({ ok: true })
    expect(await run({ action: 'click', x: 40, y: 60 }, page)).toMatchObject({ ok: true })
    expect(events.map(({ type }) => type)).toEqual(['mouseDown', 'mouseUp', 'mouseDown', 'mouseUp'])
    expect(events.at(-1)).toMatchObject({ x: 40, y: 60 })
    expect(await run({ action: 'click', selector: '#gone' }, page)).toMatchObject({
      ok: false,
      error: 'No element matches that selector.',
    })
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

  it('sends a scaled screenshot and the console since a time', async () => {
    const scale = vi.fn(async () => 'iVBORw0K')
    const { page } = guest()
    expect(await run({ action: 'screenshot' }, page, scale)).toMatchObject({
      ok: true,
      png: 'iVBORw0K',
    })
    expect(scale).toHaveBeenCalledWith('data:image/png;base64,AAAA', 1600)
    expect(await run({ action: 'console', since: 2 }, page)).toMatchObject({
      ok: true,
      console: [{ level: 'error', text: 'new', at: 5 }],
    })
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
