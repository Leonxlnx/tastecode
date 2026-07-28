# Landing page plan

Ships **before** open-sourcing. It is the artifact that decides whether the launch lands.

---

## The meta-point

The landing page for a product whose differentiator is a design agent **must be built by
that design agent.** It is the proof and the demo in one artifact. If TasteSkill cannot
produce our marketing site, we have not finished M4.

That means the page is not a side quest — it is the acceptance test for the most important
feature in the product. Plan it as part of M4/M5, not as launch-week scramble.

## Positioning

The one-sentence version, to be sharpened:

> **Every coding agent you pay for, in one window that was actually designed.**

Three supporting claims, in priority order:

1. **Bring everything.** Claude, Codex, Cursor, Kimi, GLM, Grok, OpenRouter, local models —
   your subscriptions and your keys, together for the first time.
2. **Built for Windows first.** The honest gap in the market. Say it plainly; the audience
   that needs to hear it has been ignored by every competitor.
3. **A design agent with taste.** Show the output, do not describe it.

Plus the trust line, which is a genuine differentiator and reads as confidence:

> **Your credentials never touch us.** We ask your tools to work; we never ask for your
> passwords. Nothing leaves your machine.

## Structure

1. **Hero** — one sentence, one action, and *the app itself* — a real screenshot or a short
   loop of a real session, taken on Windows. Not an abstract illustration. The product is
   visual; lead with it.
2. **The problem** — brief and concrete. Six terminals, five logins, one unreadable
   scrollback.
3. **The provider wall** — every logo, with what each one gives you. This section does more
   sales work than any copy on the page, because the reaction we want is "wait, it does *my*
   provider?"
4. **The thread** — an interactive or recorded demo of a 500-message thread scrolling at
   60fps. Speed has to be *felt*; a bullet point claiming it is worthless.
5. **The design agent** — before/after. Generic AI landing page on the left, TasteSkill
   output on the right. This is the most persuasive thing we can possibly show, and it needs
   no words.
6. **Trust** — credentials, local-first, open source. Short.
7. **Download** — Windows first in the list, macOS beside it. Signed. Version and size shown.
8. **Footer** — GitHub, docs, changelog.

Deliberately absent: fake testimonials, invented logos, a pricing table for a free product,
a newsletter modal, "trusted by 10,000 developers."

## Technical

- Static site, prerendered. Astro or Next static export. Zero client JS above the fold.
- Self-hosted fonts, no third-party requests, no cookie banner (because no cookies).
- Lighthouse 100 on performance and accessibility. A slow landing page for a product that
  sells speed is self-refuting.
- Lives in the monorepo as `apps/marketing` (T3 Code does the same, and it keeps screenshots
  and copy in sync with the product).
- Deploy: Vercel or Cloudflare Pages, previews on every PR so design review is a link.
- Analytics: privacy-preserving and self-hostable (Plausible/Umami), or none. Given the
  "nothing leaves your machine" promise, ad-tech on the marketing site would be a bad look.

## Assets needed

- Product screenshots on Windows, both themes, at 2x — the single highest-leverage asset
- A 20–30s screen recording of a real session, no narration
- The design-agent before/after pair
- Logo, wordmark, favicon, OG image
- Signed installers for both platforms, published, before the page goes live

## Sequence

1. Name and domain decided (blocks everything — see roadmap open questions)
2. Brand and identity via the design agent, direction chosen by the humans
3. Page built by the design agent, reviewed by the humans
4. Assets captured from the real M5 build
5. Live, with a waitlist or direct download, before the repo goes public
6. Repo public and announcement — never announce into an empty repo

## Launch channels

Order matters; each one primes the next.

- GitHub release with signed installers, first
- Hacker News ("Show HN") — the Windows gap is the angle, not the AI
- r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding — the provider-aggregation angle
- X/Twitter with the design-agent before/after as the lead image
- Ask Theo/T3 for a look — T3 Code is adjacent, not identical, and the category benefits
  from more than one good client. Do this genuinely, not as a growth hack.
