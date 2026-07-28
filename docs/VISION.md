# Vision

## The problem

**It is not that the existing clients are bad.** They are good, and getting better fast.
Claude Code shipped a redesigned desktop app in April 2026 with parallel tasks, visual
diffs and server previews. Codex has a first-party app plus IDE extensions. Cursor is an
entire IDE built around an agent. Anyone claiming this field is a wasteland of ugly
terminal programs has not looked at it recently.

The problem is a different one, and it does not go away as those apps improve:

- **Every good client is locked to one vendor.** The Claude app runs Claude. The Codex app
  runs Codex. Cursor runs Cursor. None of them will ever run the others — it is not in
  their interest to. So the moment you use more than one engine, you are back to switching
  between three apps with three session models, three histories, and nothing shared.
- **Your subscriptions are stranded.** You may already pay for Claude Max, ChatGPT Plus,
  Cursor, Kimi Code, a GLM coding plan, and SuperGrok. Each one is usable only inside its
  own client. Nothing lets you point all of them at the same task in the same window.
- **Nothing adapts to you.** Every one of these apps is opinionated about how _they_ think
  you should work. None of them lets you assemble your own setup — your providers, your
  budget, your keybindings, your skills, your layout.
- **Design output is generic, everywhere.** Ask any of them for a landing page and you get
  the same gradient hero, the same three feature cards, the same violet-to-indigo blur.
  Everyone can see it. It is the single most obvious tell that software was made by an AI,
  and no first-party client is trying to fix it — because the fix is taste, not tokens.

There is a second tier of tools that _does_ aggregate — T3 Code, Conductor, Nimbalyst. That
is the shelf we are competing on, not the first-party apps. None of them has solved
personalization, and none of them is competing on design quality at all.

## The product

**Personal Harness** is a desktop control panel that sits above the agents.

One window. Every agent you have. Every subscription you pay for, plus your own keys.
Threads that stay instant at 500 messages. Real diff review. Parallel agents in isolated
worktrees. And a design agent that produces work you would actually ship.

We do not need to beat the Claude app at running Claude. We need to be the only place where
Claude, Codex, Cursor, GLM and a local model sit side by side, configured the way _you_
want, with an agent that has actual taste.

"Personal" is the point: the harness adapts to _your_ providers, _your_ budget, _your_
keybindings, _your_ taste. Nobody's setup is the same and the app should not pretend
otherwise.

## Three bets

### 1. Aggregation — bring everything you have

We do not resell tokens. We never proxy your credentials through our servers. The harness
drives the _official_ CLI or protocol server for each vendor, so your subscription is used
exactly the way the vendor intends, and BYOK keys go straight from your machine to the
provider.

Target set at v1: Claude (subscription + API), OpenAI Codex (ChatGPT subscription + API),
Cursor, OpenCode, Kimi, GLM/Z.ai, OpenRouter, and any OpenAI-compatible or
Anthropic-compatible endpoint including local models. Grok and Gemini follow.

The rule that makes this legal is in [rules/security.md](../rules/security.md).

### 2. Craft — the UI is the product

The bar here is high, not empty — the first-party apps are well made. Being merely decent
is not a position. Concretely what we hold ourselves to:

- A 500-message thread scrolls at 60fps and opens in under 150ms.
- Streaming output never causes layout jank or scroll jumps.
- Every destructive action is reversible and every agent action is inspectable.
- Motion is physical and short. Typography is deliberate. Density is adjustable.
- Windows is not a port. It ships first and it feels native.

See [FEATURES.md](./FEATURES.md).

### 3. Taste — a design agent that is actually good

The harness ships a design agent built on the **TasteSkill** system (authored separately,
integrated here). It is not a prompt. It is a skill system with:

- explicit design direction selection instead of one default look,
- a token-first pipeline (type scale, spacing, color, motion) generated before any markup,
- a hard ban list of AI-slop tells,
- a visual self-critique loop: render → screenshot → critique → revise,
- and reference-grounded output rather than mean-of-the-internet output.

Nobody else in the agent-GUI category is competing on design quality. It is the most
defensible thing we can build.

See [DESIGN-AGENT.md](./DESIGN-AGENT.md).

## What success looks like

**v0 (internal):** Both of us stop using bare terminals for agent work.

**v1 (Windows public):** A Windows developer with a Claude subscription installs it, logs
in once, and never opens a terminal for agent work again.

**v2 (open source):** The default answer to "what GUI should I use for coding agents on
Windows?" — because on Windows there currently is no good answer. Conductor is macOS-only,
Crystal is deprecated, Vibe Kanban's company wound down. The gap is real and it is ours to
take.

**v3 (mobile):** Start a task from your desk, approve the diff from your phone.

## Non-goals

- We are not building a model. We are not fine-tuning anything.
- We are not building an IDE. Editing happens in your editor; we own the agent loop,
  review, and orchestration.
- We are not reselling inference or taking a margin on tokens.
- We are not shipping a cloud that runs your code. Local-first, always. Cloud is optional
  and later.
- We are not chasing feature parity with every agent's every flag. We wrap what matters
  and expose an escape hatch for the rest.

## Naming

`personalharness` is the working repo name. The product name is undecided. Renaming a
GitHub repo is a one-click operation that preserves redirects, so this does not block
anything. Candidate criteria: pronounceable, one word, `.dev` or `.app` domain available,
no trademark collision in developer tools.
