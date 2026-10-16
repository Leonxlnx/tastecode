import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const tokensCss = read('./tokens.css')
const threadCss = read('./thread.css')
const skeletonCss = read('./skeleton.css')
const appCss = read('./app.css')
const voiceCss = read('./composer-voice-control.css')

/** The body of the first top-level rule whose whole selector is `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
}

/** Every block that opens with `prelude {`, braces balanced, joined. */
function blocks(css: string, prelude: string): string {
  const found: string[] = []
  let from = 0
  for (;;) {
    const start = css.indexOf(`${prelude} {`, from)
    if (start < 0) return found.join('\n')
    let depth = 0
    let end = css.indexOf('{', start)
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}' && (depth -= 1) === 0) break
    }
    found.push(css.slice(start, end + 1))
    from = end + 1
  }
}

const COLUMN_WIDTH =
  'width: min(\n    calc(var(--chat-w) - 2 * var(--chat-text-inset)),\n    calc(100cqi - 2 * (var(--chat-gutter) + var(--chat-text-inset)))\n  );'

describe('chat column', () => {
  it('defines one gutter and one text inset next to the chat width', () => {
    expect(tokensCss).toContain('--chat-w: 808px;')
    expect(tokensCss).toContain('--chat-gutter: 24px;')
    // 1px prompt border + the textarea's 16px padding.
    expect(tokensCss).toContain('--chat-text-inset: 17px;')
  })

  it('sizes the transcript and its skeleton as the prompt bar text box', () => {
    for (const body of [
      rule(threadCss, '.thread__col'),
      rule(skeletonCss, '.thread-skeleton__col'),
    ]) {
      expect(body).toContain(COLUMN_WIDTH)
      expect(body).toContain('margin: 0 auto;')
      // Padding or a max-width would put the content back on its own formula.
      expect(body).not.toMatch(/padding|max-width/)
    }
  })

  it('measures the column against the pane the prompt bar sits in', () => {
    // 100cqi falls back to the viewport outside a size container.
    expect(rule(appCss, '.stage')).toContain('container: chat-stage / inline-size;')
  })

  it('places the prompt bar and its text from the same variables', () => {
    expect(rule(appCss, '.composer')).toContain('padding: 4px var(--chat-gutter) 8px;')
    expect(rule(appCss, '.composer__box')).toContain('max-width: var(--chat-w);')
    expect(rule(appCss, '.composer textarea')).toContain(
      'padding: 12px calc(var(--chat-text-inset) - 1px) 6px;',
    )
    expect(rule(appCss, '.composer__prompt')).toContain('border: 1px solid var(--line);')
    expect(rule(voiceCss, '.composer__voice-error')).toContain('padding: 0 var(--chat-text-inset);')
  })

  it('narrows only the gutter in a narrow pane or window', () => {
    const narrowPane = blocks(appCss, '@container chat-stage (max-width: 480px)')
    const narrowWindow = blocks(appCss, '@media (max-width: 700px)')

    expect(narrowPane).toMatch(/\.stage__body \{\s*--chat-gutter: 10px;\s*\}/)
    expect(narrowWindow).toMatch(/\.stage__body \{\s*--chat-gutter: 10px;\s*\}/)
    for (const css of [narrowPane, narrowWindow]) {
      expect(css).not.toMatch(/\.thread__col/)
      expect(css).not.toMatch(/\.composer \{[^}]*padding(-inline)?: [^;]*\d+px [^;]*\d+px/)
    }
  })
})
