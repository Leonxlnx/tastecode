# TasteCode handoff

Updated: 2026-08-16  
Repository: `D:\personalharness`  
Source snapshot before this document: `main` at `3715e64f`

This is a concise continuation guide, not a replacement for GitHub or the durable project docs.
Read `AGENTS.md`, `rules/`, `docs/dashboard.html`, `docs/feature-inventory.html`, open issues, and
open pull requests before changing code.

## Current verified state

- Public-beta work targets `main` by branch and pull request. Never push directly to `main`.
- `nightly` carries the complete provider roster. Do not unpark providers on `main` without Leon.
- The shipped beta providers are Codex, Claude Code, and Grok.
- At this snapshot the open `main` pull requests are:
  - #895, automatic updates, Ready.
  - #897, first-project onboarding, Draft.
- Both open pull requests have active owner worktrees. Inspect and coordinate before touching their
  files or merging them.
- The user's running desktop app was deliberately not restarted during the performance work.

## Completed performance work

PR #923 merged as `54edfedb`: `perf(server): compact fresh thread replay`.  
PR #924 merged as `eeccaf81`: documentation closeout.

Root cause: opening a persisted thread asked SQLite for every durable event and sent the complete
event log to the renderer. The live streaming and rendering paths were already bounded and fast;
fresh history transfer was the real long-thread bottleneck.

The landed behavior is intentionally small:

- `apps/server/src/history-replay.ts` removes superseded item deltas and old diff, plan, and usage
  snapshots from a fresh replay.
- `Orchestrator.history(threadId, 0)` returns that state-equivalent compact replay.
- `Orchestrator.history(threadId, afterSeq)` returns the exact durable tail unchanged. Reconnects do
  not lose or combine events.
- `apps/server/src/side-chat.ts` supplies the existing provider-neutral item projection instead of
  introducing a second replay implementation.
- SQLite history, schemas, contracts, renderer behavior, CSS, design, and animation are unchanged.

## Measured result

The largest measured real thread contained 6,495 events. Loopback `thread.history` results:

| Metric             |    Before |     After | Change |
| ------------------ | --------: | --------: | -----: |
| Response events    |     6,495 |       603 | -90.7% |
| Response size      |  18.81 MB |   1.85 MB | -90.2% |
| Median RPC latency | 466.17 ms | 109.18 ms | -76.6% |
| p95 RPC latency    | 537.58 ms | 128.04 ms | -76.2% |

Final-head validation replayed all 70 current durable user threads through both paths:

- 0 reconstructed-state differences.
- 104.60 MB of full history became 19.91 MB, an 81.0% reduction.
- The benchmark server used `127.0.0.1:45701`; it was stopped and the copied database was deleted.

## Verification already completed

- Focused history, Side chat, and orchestrator tests: 149/149.
- Full lint: green.
- Full typecheck: all 15 participating workspace projects green.
- Full test rerun: web 784, server 372, desktop 60, and every package/adapter green.
- Full build: all 15 participating workspace projects green.
- One unrelated Pull Requests routing test timed out in the first contended run. It then passed
  three isolated runs and the complete clean rerun.

## Codex Desktop comparison

- TasteCode's measured active-tail and streamed-delta work was already effectively constant-time.
- Before #923, Codex had the better long-history architecture because its app-server API can omit
  turns on resume and page them separately.
- TasteCode now avoids the measured full-log waste while preserving its durable event model.
- Codex still has a pagination advantage for histories far beyond today's data. Add pagination only
  when real measurements show compact snapshots no longer meet the latency budget.
- Do not claim a global memory winner from the existing process sample. The observed Codex session
  was a busy, very long session and was not an apples-to-apples packaged-app benchmark.

## Safe continuation

1. Fetch `origin/main`; do not assume the root worktree is current or clean.
2. Inspect open PRs, issues, worktrees, and owned ports before choosing files.
3. Use a dedicated worktree and a small branch. Push each logical commit.
4. Merge `main` into an active branch if the target advances. Never rebase or force-push it.
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before Ready.
6. Exercise server or UI behavior locally without replacing another owner's running app stack.
7. Merge through a PR and update the dashboard and feature inventory immediately when status moves.

There is no remaining action in the compact-history performance slice.

## Design agent addendum

This section records the Design Mode state after the 2026-08-16 quality, browser-review, gradient,
and reference-library work. The performance facts above are unchanged.

### Product goal and architecture

Design Mode turns an incomplete website request into a briefed, planned, implemented, locally
previewed, and visually reviewed result inside the existing TasteCode thread. It is not a second
agent framework. The server owns sessions, persistence, phase order, approvals, preview lifecycle,
recovery, and completion. `packages/design-agent` owns the artifact contracts, creative rules,
phase prompts, deterministic helpers, and validation gates.

The selected provider remains the implementation agent. Shared behavior reads capabilities and
does not branch on provider names. Codex, Claude Code, and Grok can currently receive Review images;
ACP can when negotiated. Text-only providers complete through Preview and report that visual Review
was skipped. Direct API providers have bounded workspace tools but no image attachments yet.

### Current end-to-end flow

1. The composer Design action adds the internal Design sentinel to a normal turn.
2. Qualification disables Design Mode for a non-website request.
3. Briefing infers supported facts and asks only material questions. The provider may return any
   necessary number of questions; the UI shows one at a time, preserves answers, supports custom
   text, Back/Next, and wheel navigation, and prevents advancing without an answer.
4. After any question round, TasteCode always asks the final optional-note question before locking
   a complete brief. Unclear answers can cause another bounded question round.
5. The validated artifact chain is written under `.taste`: `brief.json`, `brand.json`, `page.json`,
   `assets.json`, and the latest `review.json`.
6. Brand, Page, Asset, and Build run as hidden machine-readable turns in the same provider session.
   Invalid phase JSON gets one correction attempt; a second failure ends visibly.
7. Build reuses the opened project's framework, dependencies, scripts, and user files. It must not
   scaffold a parallel app.
8. TasteCode starts an allowlisted `127.0.0.1` preview, opens or reuses one sidebar Browser tab,
   captures desktop/mobile evidence in a separate hardened Electron renderer, and performs visual
   Review with at most two repair attempts.
9. The final thread message surfaces the preview URL and any representative data that the user
   should verify. Internal notes and disclaimers must never appear on the website itself.

The durable implementation guide is `docs/DESIGN-AGENT.md`; treat it as normative before editing
the workflow.

### Artifact ownership

- `brief.json` owns user intent and evidence: subject, page type, scope, goal, audience, offer,
  primary action, required content, constraints, supplied brand inputs, explicit answers,
  assumptions, unresolved details, and creative-control level.
- `brand.json` owns derived decisions: existing-asset locks, creative direction, semantic palette,
  at most two type families, interface language, imagery, motion, and voice. Supplied identity is
  evidence to protect, not a suggestion to overwrite.
- `page.json` owns final page story and composition: navigation, ordered sections, final copy,
  layout family and exact case IDs, responsive transformations, component and asset needs,
  interactions, acceptance criteria, and one purposeful motion decision per section.
- `assets.json` owns real acquisition and provenance: existing/needed/ready state, purpose,
  requirements, source kind, source reference, license where required, and project-relative
  destination.
- `review.json` owns only the latest screenshot-supported pass/repair verdict and bounded findings.
  It does not claim factual accuracy, conversion, provenance, performance, or comprehension.

### Judgment and quality rules now enforced

- Headings should normally fit one or two lines; three is rare and the hard maximum. Display sizes
  are bounded by viewport rather than using giant type as a substitute for composition.
- Eyebrows, decorative uppercase monospace labels, page-wide `01 / 02 / 03` numbering, IBM Plex
  Mono, Archivo, em/en dashes, internal placeholders, launch disclaimers, and redundant Hero
  support blocks are rejected or explicitly reviewed.
- One primary type family is the default. A second family needs a clear role; repeated serif/sans
  toggling inside the same page is not a design system.
- Cards must group coherent features, people, plans, proof, actions, or media. Empty equal-column
  cards, colored vertical rails, divider-grid templates, unexplained SVG diagrams, and arbitrary
  hairline systems are blocked.
- Use meaningful imagery more often than ornamental SVG. Never stretch or casually crop generated
  images; generate or source the required aspect ratio. Simple dashboards, forms, controls, and
  calendars should be implemented as real UI instead of raster images.
- Keep one coherent light or dark palette through adjacent sections. Use brand color on meaningful
  actions and states, not only tiny labels. Controls, dropdowns, calendars, disclosure panels,
  focus, hover, and error states must be visibly designed and accessible.
- Layout follows the human-authored Hero, About, Feature, How It Works, Social Proof, Stats, FAQ,
  CTA, Pricing, Contact, and Footer cases. Sections carry exact case IDs; unknown, cross-family,
  missing, and immediately repeated compositions fail before Build.
- Motion is purposeful per section and records purpose, trigger, behavior, duration, easing, and a
  reduced-motion equivalent. Generic reveal effects are not a substitute for motion direction.
- Representative content is permitted when needed for a complete one-shot page, but the final
  Harness response must tell the user what to verify. Never print that warning inside the site.

### Deterministic helpers and reference evidence

- `palette.ts` derives semantic light/dark roles from compact accent and neutral seeds, maps to
  opaque sRGB, preserves locks, and audits required WCAG 2.2 pairs. `60/30/10` remains loose usage
  guidance, not a generation formula or pixel quota.
- `gradients.ts` derives dependency-free CSS recipes for card, section, and page purposes from the
  validated brand palette. Build may use at most one matching purpose per view and must keep
  readable content on the supplied opaque surface.
- `copywriting.ts` performs the page-copy and anti-slop checks described above.
- `layout-guidance.ts` holds the human-authored section cases and selection constraints.
- `reference-directions.ts` holds metadata for 132 generated-only WebP direction references across
  all 11 layout families. A deterministic brief-and-brand seed selects one compact geometry cue per
  family. Providers receive only those textual cues, never 132 paths or binary images. Cues never
  override the brief, brand, accessibility, copy, responsive, factual, or layout-case rules and
  never copy the source identity.
- The private source screenshots in `D:\personalharness\design directions` were read-only and were
  never committed. Only newly generated sibling references are in the repository.

Reference counts at this snapshot: About 18, Contact 1, CTA 8, FAQ 9, Feature 40, Footer 11, Hero
17, How It Works 5, Pricing 5, Social Proof 14, and Stats 4. Total optimized size is 7,241,560 bytes;
maximum width is 1600 pixels.

### Browser Review state

- The visible sidebar Browser is for user inspection. A separate hidden BrowserWindow remains the
  authority for exact screenshot evidence.
- Capture requests are serialized. Same-URL repair passes reload the dedicated Browser tab.
- The hidden renderer denies permissions and new windows, confines navigation and redirects to the
  preview origin, verifies the final URL, scrolls through lazy content, waits within fixed
  deadlines for animations/fonts/images, audits the whole document, and captures whole-page
  desktop/mobile PNGs bounded to 12,000 CSS pixels.
- Review cannot erase objective DOM findings. Current checks cover one H1, interaction targets,
  overflow/clipping, internal placeholder copy, and the persisted composition/quality rules.

### Design PRs completed in this slice

- #926, merged as `dfdac4c0`: stronger brand/page/build/review rules, per-section motion, and
  bounded whole-page desktop capture.
- #929, merged as `55cbad98`: deterministic brand-gradient recipes. #927 was closed as superseded
  because its required merge-from-main commit could not use the repository's server-side rebase
  merge; #929 contains the same verified feature tree on current `main`.
- #930, merged as `3715e64f`: 132 generated direction references plus deterministic bounded cue
  selection. #928 was closed as superseded for the same clean-history reason.

No hosted CI was started. Final local validation on the combined implementation recorded:

- `pnpm lint`: passed;
- `pnpm typecheck`: all 15 participating workspace projects passed;
- `pnpm test`: Design Agent 88, Web 784, Server 372, Desktop 61, and every adapter/package passed;
- `pnpm build`: all 15 participating workspace projects passed with only the existing Vite
  chunk-size warning;
- Windows desktop Design and Browser Review had already been exercised before the final
  documentation-only sync.

### Known gaps and next actions

1. Test the 132-reference and human-authored layout catalogs across varied real briefs. Score the
   visible results, retire weak or repetitive cues, and add anti-references before increasing the
   library. Do not treat library size as proof of taste.
2. Finish deterministic type, spacing, asset, and browser QA helpers. Palette, copy, gradient, and
   basic DOM/visual gates exist; production interaction, accessibility, contrast, reduced-motion,
   and overflow verification are not yet comprehensive.
3. Add a provider-neutral TasteCode image-generation/search execution layer. Asset prompts already
   prefer supplied/project assets, then generation, then licensed search, but execution currently
   depends on tools exposed by the selected provider. Direct API image attachments are also still
   missing.
4. Keep OriginKit optional until its official MCP identity, authentication, rate-limit behavior,
   import/provenance format, and licensing flow are agreed with the partner. Missing OriginKit must
   always fall back to existing dependencies and local implementation.
5. Add real cross-provider fixtures: one direct API flow, negotiated ACP image Review, and
   non-Codex adapter runs. Shared behavior must continue to use capabilities rather than model or
   provider IDs.
6. Close lifecycle risks: invalidate preview/capture continuation after panic stop, smoke-test the
   real macOS process tree, and route capture to the owning task/client instead of the first capable
   socket.
7. Product surfaces still missing from M4: a direction gallery, token editor, explicit supplied
   asset management, persistent Design-specific iteration history/hot reload, objective browser
   interaction/accessibility checks, and proven redesign behavior.
8. The M4 milestone is not complete until Design Mode builds TasteCode's own landing page to human
   ship quality and passes a Windows/macOS plus provider smoke matrix.

Before continuing, fetch `origin/main`, inspect current issues/PRs/worktrees, and coordinate around
the protected server orchestration, contracts, and shared shell files. Keep every new behavior in a
small provider-neutral PR and update `docs/DESIGN-AGENT.md`, the dashboard, and feature inventory
with the actual shipped state.
