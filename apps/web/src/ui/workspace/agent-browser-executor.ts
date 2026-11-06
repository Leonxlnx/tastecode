import {
  BROWSER_CONSOLE_MAX,
  BROWSER_PNG_MAX,
  BROWSER_TEXT_MAX,
  type BrowserCommand,
  type BrowserConsoleEntry,
  type BrowserResult,
} from '@harness/contracts'
import { browserAddress } from './browser-url.js'

/** The parts of an Electron <webview> the agent's commands use. */
export type AgentBrowserGuest = {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  /** Runs in the page's own world: what it returns is the page's word, which may lie. */
  executeJavaScript(code: string): Promise<unknown>
  /**
   * Runs in a JavaScript world of TasteCode's own on the same page, where the page cannot replace
   * querySelector, property descriptors or labels. The field check and typing run here.
   */
  executeIsolated(code: string): Promise<unknown>
  /** The visible page as a PNG data URL. */
  capturePng(): Promise<string>
}

/** The tab's console, newest last, as the tab recorded it. */
export type AgentBrowserConsole = () => readonly BrowserConsoleEntry[]

/** A screenshot is scaled down to this width before it is sent. */
export const AGENT_SCREENSHOT_WIDTH = 1600

/** Scales a PNG data URL to at most AGENT_SCREENSHOT_WIDTH and returns its base64. */
export type ScaleScreenshot = (dataUrl: string, width: number) => Promise<string>

/**
 * A field an agent never types into: passwords and payment details. Checked in the page itself,
 * on the element the selector names, by type, autocomplete hint and the words that label it.
 */
const SENSITIVE_FIELD_CHECK = `(element) => {
  if (!element) return 'missing'
  const words = [element.type, element.name, element.id, element.placeholder,
    element.getAttribute('autocomplete'), element.getAttribute('aria-label'),
    element.labels ? [...element.labels].map((label) => label.textContent).join(' ') : '']
    .filter(Boolean).join(' ').toLowerCase()
  if (element.type === 'password') return 'password'
  if (/\\bcc-|card|cvc|cvv|csc|security code|expir|iban|routing number|account number/.test(words)) return 'payment'
  if (/password|passcode|passwort|\\bpin\\b|one-time-code/.test(words)) return 'password'
  return 'ok'
}`

const REFUSED_FIELD = {
  password: 'TasteCode does not let an agent type into password or sign-in code fields.',
  payment: 'TasteCode does not let an agent type into payment fields.',
  missing: 'No element matches that selector.',
} as const

/**
 * Runs one agent command on the chat's own browser tab and answers it. Every refusal is an
 * `ok: false` answer with a reason the agent reads; nothing here trusts the server's checks
 * alone.
 */
export async function runAgentBrowserCommand(
  command: BrowserCommand,
  guest: AgentBrowserGuest,
  consoleEntries: AgentBrowserConsole,
  scale: ScaleScreenshot,
): Promise<BrowserResult> {
  const refuse = (error: string): BrowserResult => ({
    commandId: command.commandId,
    ok: false,
    error,
  })
  const page = () => ({
    url: guest.getURL().slice(0, 2_048),
    title: guest.getTitle().slice(0, 512),
  })
  try {
    switch (command.action) {
      case 'open':
      case 'navigate': {
        // The address bar's own rule: http(s), and plain http on this machine only.
        const address = browserAddress(command.url)
        if (!address.url) return refuse(address.error ?? 'That is not an http or https page.')
        await guest.loadURL(address.url)
        return { commandId: command.commandId, ok: true, ...page() }
      }
      case 'screenshot': {
        const png = await scale(await guest.capturePng(), AGENT_SCREENSHOT_WIDTH)
        if (png.length > BROWSER_PNG_MAX) return refuse('The screenshot is too large to send.')
        return { commandId: command.commandId, ok: true, ...page(), png }
      }
      case 'click': {
        // A DOM click from TasteCode's own world: native input events do not reach a guest
        // whose window is in the background, which is where an agent often works.
        const target =
          command.selector === undefined
            ? `document.elementFromPoint(${command.x ?? 0}, ${command.y ?? 0})`
            : `document.querySelector(${JSON.stringify(command.selector)})`
        const outcome = await guest.executeIsolated(
          `(() => {
            const element = ${target}
            if (!element) return 'missing'
            element.scrollIntoView({ block: 'center', inline: 'center' })
            element.click()
            return 'ok'
          })()`,
        )
        if (outcome !== 'ok') return refuse(REFUSED_FIELD.missing)
        return { commandId: command.commandId, ok: true, ...page() }
      }
      case 'type': {
        const outcome = await guest.executeIsolated(
          `(() => {
            const element = document.querySelector(${JSON.stringify(command.selector)})
            const verdict = (${SENSITIVE_FIELD_CHECK})(element)
            if (verdict !== 'ok') return verdict
            element.focus()
            const prototype = element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
            if (element.isContentEditable) element.textContent = ${JSON.stringify(command.text)}
            else if (setter) setter.call(element, ${JSON.stringify(command.text)})
            else return 'missing'
            element.dispatchEvent(new Event('input', { bubbles: true }))
            element.dispatchEvent(new Event('change', { bubbles: true }))
            return 'ok'
          })()`,
        )
        if (outcome !== 'ok')
          return refuse(
            REFUSED_FIELD[outcome as keyof typeof REFUSED_FIELD] ?? REFUSED_FIELD.missing,
          )
        return { commandId: command.commandId, ok: true, ...page() }
      }
      case 'scroll':
        await guest.executeJavaScript(`window.scrollBy(${command.dx}, ${command.dy})`)
        return { commandId: command.commandId, ok: true, ...page() }
      case 'read_text': {
        const text = await guest.executeJavaScript(
          command.selector === undefined
            ? `document.body ? document.body.innerText : ''`
            : `(document.querySelector(${JSON.stringify(command.selector)}) || {}).innerText ?? null`,
        )
        if (typeof text !== 'string') return refuse(REFUSED_FIELD.missing)
        return {
          commandId: command.commandId,
          ok: true,
          ...page(),
          text: text.slice(0, BROWSER_TEXT_MAX),
        }
      }
      case 'console': {
        const since = command.since ?? 0
        const entries = consoleEntries()
          .filter((entry) => entry.at >= since)
          .slice(-BROWSER_CONSOLE_MAX)
          .map((entry) => ({ ...entry, text: entry.text.slice(0, 2_000) }))
        return { commandId: command.commandId, ok: true, ...page(), console: entries }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return refuse((message || 'The browser could not run that command.').slice(0, 2_000))
  }
}
