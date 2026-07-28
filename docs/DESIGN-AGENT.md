# The design agent (TasteSkill runtime)

This is the differentiator. Everything else in the harness is orchestration that a
determined competitor could replicate in a quarter. This is the part that is hard to copy
because it is not a feature — it is accumulated judgment, encoded.

---

## Why this exists

Ask any coding agent for a landing page today and you get the same artifact. Everyone in
the industry can recognize it on sight:

- a hero with a violet-to-indigo gradient and a radial blur behind it
- three feature cards, identical, with a lucide icon in a rounded square
- `Inter` at 16px everywhere, one weight, generous letter-spacing on nothing
- a testimonial section with invented people
- emoji as section markers
- glassmorphism applied to things that are not glass
- pill-shaped buttons with a gradient and a shadow that has no light source
- a dark section, then a light section, then a dark section
- perfectly even spacing everywhere, so nothing has hierarchy

This is what "the mean of the internet" looks like. It happens because the model is
optimizing for the most likely token, and the most likely design is the most common design.
Good design is, almost definitionally, not the average.

**No competitor in the agent-GUI category is working on this.** They are all competing on
worktrees and kanban boards. This is open ground.

---

## Division of responsibility

**TasteSkill v2** is authored separately by the team, outside this repo, and delivered here
as a skill package. It carries the judgment: directions, rules, ban lists, reference
material, critique rubrics.

**This repo builds the runtime around it** — the loop, the tools, the UI, the feedback
mechanism. The runtime is what turns a good prompt into a good outcome, and it is where
almost all of the engineering is.

The integration contract is deliberately thin, so TasteSkill can evolve independently:

```
design-agent/
  skills/
    tasteskill/
      SKILL.md              name, description, entry instructions
      directions/*.md       named design directions, loaded on demand
      references/*.md       principles, type scales, motion specs, color theory
      banlist.md            the slop tells, explicit and exhaustive
      critique-rubric.md    how to score a rendered screen
      assets/               fonts, textures, grids
```

We build on the **Agent Skills open standard** (`SKILL.md` + YAML frontmatter,
three-stage progressive disclosure: discovery → activation → execution). Anthropic opened
the spec in December 2025 and by March 2026 OpenAI, Microsoft, JetBrains, Cursor, Gemini CLI
and 25+ others had shipped compatible implementations.

**This is a strategic choice, not a convenience.** Building on the open format means
TasteSkill runs inside our harness *and* inside Claude Code, Codex and Cursor. The skill
becomes a distribution channel for the harness rather than a hostage to it — people
encounter the skill, then discover the app that runs it best.

---

## The pipeline

The core insight: **most of the quality comes from the process, not the prompt.** A
one-shot request produces average work no matter how good the instructions. A staged
pipeline with commitment points produces distinctive work.

### Stage 1 — Brief

Extract or ask for what actually determines the design, and refuse to proceed on vibes:

- What is this, for whom, and what is the one action?
- Emotional register: authoritative / playful / precise / warm / severe / editorial
- Constraints: brand, existing tokens, framework, accessibility, performance
- **Anti-references** — "not like X" is more informative than "like Y" and users find it
  much easier to answer.

Output: a written brief the user confirms. Nothing renders before this is agreed.

### Stage 2 — Direction

Generate **three genuinely divergent directions**, described in words plus a small visual
signature (type pairing, palette, spatial idea, motion character). Not three variations —
three different opinions. Editorial/Swiss vs. brutalist/industrial vs. warm/organic, say.

The user picks one, or picks parts of two. **This is the moment taste actually enters**,
and it is a human decision. The agent's job is to make the options real and different enough
that choosing is meaningful.

Why this stage matters most: a design agent that skips straight to code has already
defaulted to the mean before writing a line.

### Stage 3 — Tokens before markup

Commit the system before any component exists:

- **Type scale** — a real ratio, real weights, real optical sizing. A named pairing, not
  `Inter` for everything.
- **Spacing scale** — geometric, with deliberate asymmetry between vertical rhythm and
  horizontal gutters.
- **Color** — built from a defined light source and surface model, in a perceptual space
  (OKLCH), with contrast verified rather than assumed. Not a hue picked and tinted.
- **Motion** — durations and easing curves as a physical system: what accelerates, what
  settles, what never moves.
- **Elevation** — shadows derived from the declared light source, so they agree with each
  other.

Emitted as CSS custom properties / Tailwind theme, versioned in the project. Every
subsequent component is authored *against the tokens*, which is what makes the output feel
designed rather than assembled.

### Stage 4 — Build

Compose the page from the system. Framework-agnostic output (React, Vue, Svelte, plain HTML
— the harness knows the project's stack and matches it).

Hard rules enforced during generation, from the ban list:
- No element exists without a reason traceable to the brief
- Hierarchy is created by scale and weight contrast, not by boxes
- Whitespace is asymmetric and intentional; even spacing everywhere means no hierarchy
- Real content and real copy — never `lorem ipsum`, never invented testimonials
- Every interactive element has hover, focus-visible, active, and disabled states
- Reduced-motion is honored, always

### Stage 5 — See it, critique it, fix it

**This is the stage that separates us from a prompt.**

The harness renders the result in a real browser, screenshots it at multiple viewports, and
feeds the images back to the agent with the critique rubric. The agent scores its own work
against explicit criteria and revises. Two to three passes.

The rubric checks the things models are bad at judging without seeing:
- Does the visual hierarchy match the intended reading order?
- Is optical alignment right, or only mathematical alignment?
- Are there orphans, widows, awkward line-breaks, or a hero headline that wraps badly?
- Does it hold up at 1440, 768, and 375?
- Does anything on the ban list appear?
- Is contrast sufficient in both themes?
- Would a designer look at this and know it was AI-made? If yes — what specifically gives it
  away?

That last question, asked explicitly with the image in context, is remarkably effective.

### Stage 6 — Handoff

Working code, the token file, a short written rationale for the direction, and a list of
deliberate decisions so a human can argue with them.

---

## What the harness must provide

The runtime work, all of it ours:

| Capability | Why |
| --- | --- |
| **Headless browser render + screenshot** at multiple viewports | Stage 5 is impossible without it. Playwright, bundled. |
| **Multimodal feedback loop** | Screenshot → back into the model's context. Requires an adapter path that supports image input (Codex `turn/start` accepts images natively). |
| **Live preview pane** | Side-by-side page and conversation, hot-reloading. |
| **Visual diff between iterations** | "What changed between v2 and v3" as images, not code. |
| **Design token editor** | Tweak the scale by hand and watch the page update. Human taste stays in the loop. |
| **Reference board** | Drop in screenshots as anti-references or targets; they enter the brief. |
| **Direction gallery** | Stage 2 rendered as three real thumbnails, not three paragraphs. |
| **Font management** | Real typography needs real fonts, licensed and available locally. |

The design agent is therefore also the **most demanding consumer of the harness's own
architecture** — it needs image input, browser control, file watching, and preview. Building
it forces the rest of the platform to be good.

---

## Honest limits

Write these down so we do not oversell:

- This does not replace a designer. It reliably clears "generic AI output" and often reaches
  "a competent developer with good taste." It does not reach "a great designer with a point
  of view."
- It is strongest on landing pages, portfolios, marketing sites, and documentation — bounded
  surfaces with conventional structure and high aesthetic ceiling. It is weaker on dense
  product UI where domain logic dominates.
- It depends on the underlying model's visual judgment, which is improving but is not the
  bottleneck we control. The pipeline is what we control.
- **Direction selection is human.** We should not pretend otherwise; the product is better
  for making that explicit.

## How we know it works

Not vibes. A held-out evaluation set of ~20 briefs, generated by the pipeline and by a
baseline one-shot prompt, shuffled and rated blind by both of us plus outside designers on:
distinctiveness, craft, appropriateness to brief, and "does this look AI-made."

Run it on every meaningful change to TasteSkill or the pipeline. If a change does not move
the numbers, it did not help.

---

## Sources

- [Agent Skills Overview](https://agentskills.io/home) — the open spec
- [Agent Skills Open Standard Explained](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
- [How Do You Build Your First Agent Skill? SKILL.md Anatomy](https://agentman.ai/blog/build-your-first-agent-skill-skillmd-anatomy)
- [Trending AI Design Skills to Watch in 2026](https://awesomeskill.ai/blog/trending-ai-design-skills-2026)
