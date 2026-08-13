# Design agent

This document is the durable implementation guide for Personal Harness Design Mode and its
TasteSkill integration. It explains the product goal, the current runtime, the artifact
contracts, what shipped in the first end-to-end implementation, and what remains before M4 is
complete.

It is not a live ownership tracker. Before changing code, read `AGENTS.md`, the linked rules,
`docs/ARCHITECTURE.md`, and the current GitHub issues and pull requests.

## Product goal

Design Mode should turn a useful but incomplete website request into a distinctive, implemented,
visually reviewed result without forcing the user to become a creative director or fill out a
long specification first.

The intended experience is:

1. The user selects Design in the normal composer and writes a request.
2. Harness extracts everything it can and asks only questions whose answers materially affect
   the result. It asks as many questions as necessary.
3. Harness records a validated brief before any website implementation begins.
4. TasteSkill makes explicit brand, copy, layout, asset, and motion decisions.
5. The normal selected agent implements those decisions in the user's existing project.
6. Harness starts the real local site, captures representative viewports, reviews the visible
   output, and performs bounded repairs.
7. The user receives normal project files, inspectable `.taste` artifacts, and a clear final
   result inside the existing Harness thread.

The milestone proof remains: Design Mode builds Personal Harness's own landing page to a standard
the humans would actually ship.

## Scope and non-goals

The first reliable workflow targets a new website or page. Redesign support should be treated as
experimental until the new-build path is consistently strong.

Design Mode does not create a second agent framework, a second session model, or a second preview
system. It uses the same provider adapters, server-owned thread, event log, approvals, workspace,
checkpoints, tools, and renderer as every other Harness turn.

Harness is not the source of creative taste. It owns orchestration, validated boundaries,
persistence, safety, preview, and recovery. TasteSkill owns the judgment that prevents a capable
model from converging on generic output.

## Responsibility boundary

| Personal Harness owns                              | TasteSkill owns                                        |
| -------------------------------------------------- | ------------------------------------------------------ |
| Design Mode entry and request qualification        | Creative direction and visual thesis                   |
| Question transport and briefing UI                 | Brand, typography, palette, image, and motion judgment |
| Durable `.taste` artifact writes                   | Anti-slop and anti-reference rules                     |
| Artifact parsing and rejection of malformed output | Copywriting and narrative quality                      |
| Phase order and server recovery                    | Layout and component judgment                          |
| Provider-neutral session orchestration             | Objective design checks supplied by skill tools        |
| Safe project tools and command boundaries          | Rules for when and how those tools should be used      |
| Local preview lifecycle and screenshot capture     | Visual critique rubric and repair priorities           |
| Bounded retry budgets and honest degradation       | Deterministic palette, type, gradient, and QA helpers  |

The integration contract must preserve this split. Copying TasteSkill prose into server prompts
would make Harness a second, stale fork of the skill. Moving orchestration into TasteSkill would
make Design Mode provider-specific and bypass Harness recovery and safety.

## Intended workflow

```text
Composer Design toggle
        |
        v
Qualify request
        |
        +-- not a design task --> explain and stop
        |
        v
Extract brief facts
        |
        +-- material gaps --> structured questions --> re-evaluate
        |
        v
Final optional note
        |
        v
.taste/brief.json
        |
        v
Brand / TasteSkill judgment --> .taste/brand.json
        |
        v
Page blueprint and final copy --> .taste/page.json
        |
        v
Asset inventory and sourcing --> .taste/assets.json
        |
        v
Build in the existing project
        |
        v
Validated local preview plan --> 127.0.0.1 server
        |
        v
Desktop + mobile captures
        |
        v
Visual review --> pass --------------------------+
        |                                         |
        +-- findings --> bounded repair --> review+
                                                  |
                                                  v
                                      .taste/review.json
                                                  |
                                                  v
                                         normal thread result
```

Briefing is a hard gate. No website implementation should begin before `brief.json` validates.
After the brief, the current implementation advances automatically unless a normal Harness
approval or a real user decision blocks the selected provider.

## Current implementation status

The first end-to-end implementation shipped in pull request
[#314](https://github.com/Leonxlnx/personalharness/pull/314). GitHub records 45 commits, 56 changed
files, 4,189 additions, and 99 deletions. The pull request was merged as `a41aa85` after its stacked
predecessor pull requests were superseded.

At the time of that merge, local validation recorded:

- `pnpm lint` passed;
- `pnpm typecheck` passed across all 12 built workspace projects;
- `pnpm test` passed 522 tests;
- `pnpm build` passed with the existing Vite chunk-size warnings;
- one real configured Codex desktop run completed Brief, Brand, Page, Assets, Build, Preview,
  Review, Repair, and a passing final Review;
- 1440 x 1000 and 390 x 844 captures were visually inspected;
- the resulting `review.json` reported `verdict: "pass"` with no findings.

Subsequent `main` work hardened desktop IPC, capture-window cleanup, preview command safety,
workspace path confinement, thread closure, queue and panic races, and preview shutdown. Always
verify the current head rather than treating the original PR snapshot as the latest code.

Implemented mechanics:

- Design entry through the existing composer;
- fast request qualification and brief extraction;
- adaptive structured questions and a final optional note;
- validated brief, brand, page, asset, preview, and review outputs;
- automatic phase turns in the same provider session;
- hidden machine-readable phase responses instead of raw JSON in chat;
- one correction attempt for malformed phase output;
- persisted in-progress flow state and restart recovery;
- phase-specific activity items and human labels;
- direct API workspace tools with path and credential boundaries;
- an allowlisted local preview runner;
- a capability-negotiated Electron screenshot bridge;
- visual review and at most two repair attempts;
- queue release after success and failure;
- cleanup of the preview process when the flow or thread ends.

The workflow skeleton is real. The final TasteSkill v2 judgment contract and several provider
truthfulness issues are not finished. The section `Known gaps and risks` is normative and must be
read before claiming universal support.

## Entry and qualification

The renderer adds the sentinel attachment
`personal-harness://design-brief-v1` when Design is active. The sentinel is protocol metadata, not
a filesystem path, and is removed before attachments reach the provider.

The server recognizes the sentinel in `Orchestrator.sendTurn`, creates a persisted `DesignFlow`,
and replaces the user's provider-visible text with `designBriefingPrompt`. The user still sees the
original request in the transcript; internal JSON instructions and assistant JSON responses are
suppressed from the normal chat presentation.

The briefing prompt is deliberately text-only and tool-free. It tells the provider not to inspect
the workspace, browse, invoke skills or MCP, edit files, or build anything. This keeps the first
response fast and prevents project contents from influencing whether the user's request is a
design task.

If the provider returns `not_design`, Harness clears the flow and shows:

```text
Design mode was turned off because this request is not a website design task.
```

## Briefing contract

The brief is not a complete brand system. It captures user intent, known evidence, constraints,
and decisions that later phases must respect.

### Current `brief.json` fields

| Field             | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `originalRequest` | The user's original Design Mode request.                                       |
| `subject`         | The organization, product, person, event, or idea the page represents.         |
| `pageType`        | Landing page, homepage, portfolio, product surface, or another concrete type.  |
| `scope`           | The bounded deliverable, such as one responsive homepage.                      |
| `primaryGoal`     | The business or communication outcome the page should achieve.                 |
| `audience`        | The primary visitor and relevant motivation or context.                        |
| `offer`           | The product, service, proposition, or value being presented.                   |
| `primaryAction`   | The most important visitor action.                                             |
| `requiredContent` | Content or sections that must appear.                                          |
| `constraints`     | Technical, legal, accessibility, content, timing, or design constraints.       |
| `brandInputs`     | User-supplied names, colors, fonts, references, assets, or visual preferences. |
| `creativeControl` | How much the user wants the agent to decide.                                   |
| `explicitAnswers` | Every question and resolved answer collected by Harness.                       |
| `assumptions`     | Reasonable decisions the agent made, including safe `Decide for me` choices.   |
| `unresolved`      | Non-blocking details intentionally left for later.                             |

All required string fields must be non-empty. All list fields must be string arrays. Unknown model
keys are stripped rather than persisted and later injected into Build instructions.

### Question behavior

The provider first infers everything reasonably supported by the request. If material information
is missing, it returns every currently useful question in one structured response. Harness shows
the questions one at a time and returns the collected answers together.

Each question contains:

- a stable snake-case ID;
- a short header retained in the shared protocol;
- one concise question;
- one or more selectable answers;
- a recommended default where appropriate;
- `Decide for me` when a safe assumption is possible;
- an optional custom text answer.

After the answers return, the provider re-evaluates all core fields. Vague or contradictory
answers produce the smallest useful set of follow-up questions. Resolved questions are not asked
again. Once the provider returns a complete candidate brief after any question round, Harness
always asks the final optional note:

```text
Before I finalize your brief, is there anything else you'd like me to know?
```

Choosing the recommended no-more-details answer writes the pending candidate brief. A custom final
note goes through one more briefing continuation so it can be incorporated and validated.

### Briefing UI

`UserInput` is a shared structured-input surface rendered through the normal thread store. For the
briefing it portals into `.composer__box` and appears eight pixels above the composer.

The current behavior includes:

- one visible question at a time;
- vertical single-line answer choices;
- a radio selection for every option;
- `Write your own answer` as a selectable row that becomes a text field;
- Back and Next or Submit actions;
- wheel-up to return and wheel-down to advance after a valid answer;
- preserved answers when navigating backward;
- disabled forward navigation until the visible question has an answer;
- a compact submitting state;
- reduced-motion handling;
- tactile hover, press, selected, and focus states using the existing token system.

The provider may return any necessary number of questions. The UI counter and local answer state
handle the returned list without a product-level maximum.

## Artifact chain

Artifacts are a chain of evidence and decisions, not copies of one growing object. A later phase
may consume earlier artifacts but never silently rewrite them.

| Artifact      | Owns                                                           | Consumes                                            |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `brief.json`  | User intent, facts, constraints, answers, assumptions          | Request and briefing answers                        |
| `brand.json`  | Derived visual and verbal system                               | Brief, project brand evidence, TasteSkill           |
| `page.json`   | Page story, copy, composition, responsive and interaction plan | Brief and brand                                     |
| `assets.json` | Asset needs, real sources, provenance, status, destinations    | Brief, brand, page, project files, optional sources |
| `review.json` | Latest visual verdict and actionable findings                  | Brief, brand, page, rendered screenshots            |
| Project files | The implementation                                             | All validated artifacts                             |

Every artifact is rebuilt field by field by a parser before it is written. A model cannot persist
arbitrary extra properties. Machine output may be plain JSON or one complete JSON fence; prose
around JSON is rejected.

### Current `brand.json`

The current version-one schema contains:

- `foundation.strategy`, verified `existingAssets`, evidence-based `assetActions`, locked
  decisions, and assumptions;
- `creativeDirection.summary`;
- bounded `creativeDirection.traits`;
- `creativeDirection.productiveTension`;
- one `creativeDirection.signatureDevice`, its evidence status, and stable invariants;
- one `creativeDirection.restraint`;
- `creativeDirection.avoid`;
- a `colorPalette` of name, value, and usage records;
- `typefaces` with family, source, roles, and numeric weights;
- `interfaceDirection`;
- `imageDirection` with summary, subjects, treatment, and avoid rules;
- `motionDirection` with summary, principles, and avoid rules;
- `voice` with summary and avoid rules.

User-supplied colors or fonts remain evidence in `brief.json`. The Brand phase assigns their usable
roles in `brand.json`. The Page phase consumes those roles rather than copying the palette.

Signature-device status is deliberately conservative. Existing or newly proposed devices are not
called validated unless the input includes real category-buyer attribution evidence. Visual
novelty, internal preference, and competitor distance can justify a candidate, but do not prove
brand recognition.

The current Brand prompt may inspect existing project brand files and may use any design or brand
skill exposed by the selected provider. It does not assume a specific skill name or private API.
Without a skill it asks the base model to produce the same schema. That fallback is functional but
is not the intended final quality path.

### Current `page.json`

The current version-one blueprint contains:

- page title, route, and description;
- navigation labels and targets;
- ordered sections with unique IDs;
- each section's purpose;
- final eyebrow, heading, body copy, and calls to action;
- layout direction;
- component needs;
- asset needs;
- page-level responsive rules;
- meaningful interactions;
- acceptance criteria.

The Page phase writes actual concise copy before implementation. It must use the approved brand
system and must not choose replacement colors, fonts, or sources.

### Current `assets.json`

Each asset has:

- a stable ID shared with `page.json`;
- kind: image, illustration, video, icon, font, or component;
- status: existing, needed, or ready;
- purpose and requirements;
- optional source kind: project, user, OriginKit, generated, or external;
- source reference and optional license;
- optional workspace-relative destination.

Ready assets require a real source and destination. Existing assets require a source. Absolute
destinations and parent-directory escapes are rejected. Duplicate IDs are rejected.

### Build result

Build does not write a second artifact for its summary. The provider returns a validated
`complete` or `failed` result with a summary, relative files, and reported checks. Build is
instructed to inspect and reuse the project's real framework, package manager, design system,
dependencies, entry points, scripts, and existing user changes. It must not scaffold a parallel
application.

The provider is currently responsible for running the project's relevant checks through its
available tools. Harness validates the final report shape but does not independently prove that
every reported command ran. This distinction matters for future verification work.

### Preview plan

The Preview phase returns an executable, argv array, workspace-relative working directory,
explicit `http://127.0.0.1:<port>` URL, optional readiness text, and one to four unique viewports.

The parser rejects:

- remote or `localhost` URLs;
- missing explicit ports;
- shell expressions and path-like executable names;
- absolute or parent-escaping working directories;
- duplicate viewport names;
- viewport dimensions outside bounded ranges.

### Current `review.json`

The latest visual review contains:

- `verdict`: `pass` or `repair`;
- a concise summary;
- zero or more findings;
- a stable finding ID;
- severity: blocking, major, or minor;
- visible area or viewport;
- concrete evidence;
- a bounded repair instruction.

A passing review cannot contain findings. A repair verdict must contain at least one finding in
practice, and Harness stops after at most two Repair attempts. The final artifact is the latest
review, not a history of every review iteration.

## Runtime state and recovery

The server is the sole Design Mode orchestrator. It persists `DesignFlow` in the normal Harness
database instead of writing `.taste/run.json`.

Persisted flow state includes:

- workspace path;
- original request;
- selected model, service tier, and effort options;
- current phase;
- whether material questions and the final note were asked;
- explicit briefing answers;
- whether a malformed response is already being corrected;
- pending candidate brief or next prompt;
- preview plan and URL;
- screenshot paths and dimensions;
- latest review;
- repair attempt;
- final completion text when waiting to finish.

On thread restoration, Harness:

1. parses and rejects corrupt stored flow state;
2. reconstructs unresolved structured questions from `user_input.requested` and
   `user_input.resolved` events;
3. reattaches an open provider turn when one exists;
4. finishes a persisted completion;
5. otherwise rebuilds the next phase prompt from validated workspace artifacts;
6. fails visibly and releases the queue if a required artifact was removed.

The current phase prompts are internal provider turns. Harness creates a synthetic `tool_call`
item such as `design:brand`, suppresses internal assistant JSON deltas, parses the completed
assistant message, and only then advances. The visible activity labels are:

- Preparing questions;
- Creating brand direction;
- Planning the page;
- Gathering assets;
- Building the website;
- Starting the preview;
- Reviewing the design;
- Refining the website.

Malformed output receives one correction prompt containing only the validation error and the
instruction to return corrected JSON. A second invalid response fails the flow rather than
looping. Success, failure, provider error, non-design qualification, and cancellation cleanup all
release per-thread flow guards; queued prompts should then drain normally.

## Provider and capability behavior

The architecture is provider-neutral: Design Mode uses `AgentSession.sendTurn`, persisted Harness
state, normal domain events, and declared capabilities. No shared phase branches on a provider
name.

The current product surface is not yet universally available, however.

| Provider path      | Briefing UI today        | Visual review today | Important detail                                                                       |
| ------------------ | ------------------------ | ------------------- | -------------------------------------------------------------------------------------- |
| Codex app-server   | Available                | Available           | Declares structured input and images; accepts screenshot attachments.                  |
| Claude Code CLI    | Blocked by renderer gate | Skipped             | Declares neither shared structured input nor images.                                   |
| Cursor CLI         | Blocked by renderer gate | Skipped             | Rejects attachments.                                                                   |
| Native OpenCode    | Blocked by renderer gate | Skipped             | Rejects attachments.                                                                   |
| Direct API runtime | Blocked by renderer gate | Skipped             | Workspace tools exist, but attachments are not implemented.                            |
| ACP                | Blocked by renderer gate | Potentially unsafe  | May declare image capability, but its current `sendTurn` path sends text-only prompts. |

The renderer currently allows Design Mode submission only when the selected provider advertises
`capabilities.userInput`. Design briefing questions are actually Harness-owned and are answered by
`Orchestrator.respondToUserInput`, so this gate unnecessarily couples Design Mode to an adapter
feature it does not need. In the current code, Codex is the practical working path.

This should be fixed by separating two concepts:

1. provider-originated structured input, which really is an adapter capability; and
2. Harness-originated Design Mode questions, which work above adapters and should be available to
   every provider that can complete ordinary text turns.

Image support also needs truthful end-to-end capability reporting. ACP currently derives its image
capability from initialization, but `AcpSession.sendTurn` ignores attachment arguments and creates
a text-only ACP prompt. Until ACP image prompt blocks are implemented and captured against a real
agent, ACP must report images as unsupported. Otherwise a screenshot path string can be reviewed as
if the model saw the image, producing a false pass.

Providers without real image input currently finish after Preview with an explicit message that
visual review was skipped. This is honest degradation, but it does not satisfy M4's full definition
of done.

## Direct API workspace tools

OpenAI, Anthropic, and compatible model endpoints do not provide a complete coding-agent runtime.
Harness supplies its own bounded workspace tools so Design phases can still use the shared session
model.

The current tool layer can list files, read text files with content hashes, perform guarded writes,
and run an allowlisted non-interactive project command. It:

- confines real and symlink-resolved paths to the workspace;
- rejects stale writes using the prior SHA-256;
- omits common credential files from listings and reads;
- rejects shell composition in argv;
- supplies a credential-free child environment;
- routes mutation through the normal approval mode.

Direct API image attachments remain unimplemented, so these providers can build but cannot yet
perform the screenshot Review phase.

## Preview and screenshot safety

Preview is intentionally split between the headless server and a connected desktop renderer.

The server:

- validates the model-authored plan;
- allows only bun, node, npm, pnpm, and yarn;
- deliberately excludes `npx`, because it can download and execute remote packages;
- rejects shell metacharacters in arguments;
- requires Node entry files to resolve inside the workspace;
- requires package-manager commands to name a script declared in the workspace's `package.json`;
- runs with a bounded credential-free environment;
- waits for the validated local URL;
- retains only the latest 100 KB of preview output;
- stops the process when the flow ends or the thread closes.

The renderer advertises `previewCapture` on every WebSocket connection. The server chooses one
connected capable client and sends a typed capture request. The Electron main process validates the
request and opens an invisible hardened BrowserWindow with context isolation, no Node integration,
sandboxing, denied permissions, denied new windows, and same-origin navigation enforcement.

Capture waits for animation settlement, fonts, and two animation frames, but races a 30-second hard
deadline. It captures each unique requested size, writes private temporary PNGs, destroys the
window, clears its session storage, removes failed captures, and sweeps capture directories older
than one day.

Current preview risks that still need explicit work:

- the non-Windows stop path signals only the wrapper process and does not wait for a descendant
  package-manager server to exit; validate and harden the real macOS process tree;
- the preview command executes a script already declared by the opened project without a separate
  Design Mode approval; confirm this trust model is intended or route it through the normal command
  approval surface;
- when several desktop clients are connected, the coordinator uses the first capable socket rather
  than selecting the client that owns the active thread;
- screenshot files are temporary evidence, not a durable iteration history.

## OriginKit

OriginKit is currently an optional instruction inside the Asset phase, not a required runtime
dependency and not a dedicated Harness integration.

When an OriginKit MCP server is already available to the selected provider and a specific component
need would materially benefit, the prompt allows one focused catalog search and one fitting fetch.
The result must be recorded with real provenance and a project destination. Missing authentication,
rate limits, unavailable MCP, or no suitable component are normal fallback cases; the need remains
available for local implementation.

Before stronger OriginKit support ships, decide:

- the official MCP server identity and authentication flow;
- rate-limit behavior and whether Harness should cache inventory;
- the exact component import and provenance format;
- how licensing metadata reaches `assets.json`;
- whether component retrieval remains provider tool use or becomes a Harness-owned project tool.

OriginKit must never become the foundation for shared Design Mode behavior. Existing dependencies
and local implementation remain the fallback.

## TasteSkill v2 source and intended structure

TasteSkill v2 is authored separately and should remain an installable skill. Its current plan uses:

```text
taste/
|-- SKILL.md
|-- agents/openai.yaml
|-- references/
|   |-- brief.md
|   |-- brand.md
|   |-- page.md
|   |-- assets.md
|   |-- build.md
|   `-- review.md
`-- scripts/
    |-- workflow.mjs
    |-- palette.mjs
    |-- type-system.mjs
    |-- gradient.mjs
    |-- asset-manifest.mjs
    `-- taste-check.mjs
```

The external source also contains research and rules for branding, copywriting, anti-slop,
animations, and components. Do not bulk-copy that repository into Personal Harness. Review the
installable skill contract and integrate through the existing Agent Skills path.

The planned tool order is:

1. workflow and artifact gating;
2. semantic palette and contrast output;
3. responsive typography and spacing scales;
4. controlled gradients;
5. asset manifest validation;
6. objective taste checks for assets, overflow, focus, contrast, reduced motion, and unsafe
   animation.

There is deliberate overlap between the external `workflow` and `asset-manifest` ideas and the
current Harness validators. Do not create two competing sources of workflow truth. Harness remains
the orchestration authority. TasteSkill scripts may validate or generate phase data, but their
output must match the Harness artifact contract and they must not own session phase, recovery, or
completion.

## Schema gaps against the TasteSkill plan

The current schemas were intentionally compact scaffolding. They need a deliberate v2 contract
review before the skill is integrated.

### Brand gaps

The external plan also expects brand name, product, audience, personality, visual thesis, spacing,
layout language, surface treatment, icon direction, accessibility requirements, references, and
supplied assets. Some evidence currently lives in `brief.json`; several decisions have no explicit
home in `brand.json`.

Do not add every possible design-system property. Add only information that a later Page, Build,
or Review phase actually consumes. Likely high-value additions are semantic color roles, type and
spacing scales, layout and surface principles, icon direction, and accessibility constraints.

### Page gaps

The current blueprint contains final copy, ordered sections, responsive behavior, interactions,
and acceptance criteria. It does not explicitly record visitor questions, per-section motion roles,
or the reasoning that connects content order to those questions. Decide whether those fields improve
Build and Review enough to justify persistence.

### Asset gaps

Asset requirements are currently free-form strings. The external plan expects known section,
purpose, aspect ratio, composition, dimensions, output path, source, and usage status before raster
generation. Add typed fields where they prevent bad generation or wrong cropping.

### Token and verification gaps

There is no separate token artifact. Tokens may belong inside `brand.json` if they are genuine
brand decisions, while generated CSS variables remain project output. There is also no independent
Harness verification that the production build, important interactions, overflow, contrast, and
reduced-motion checks succeeded; Review currently relies primarily on provider-reported checks and
screenshots.

## Known gaps and risks

### Critical correctness gaps

1. **Remove the provider `userInput` gate from Harness-owned briefing.** The current renderer blocks
   Design Mode for most providers even though the server owns the questions.
2. **Make image capabilities end-to-end truthful.** Implement ACP image prompt blocks or report
   images as unsupported. Add attachment support to other adapters only after real protocol capture.
3. **Do not force low effort for every phase.** The initial Design request currently stores
   `{ effort: "low" }` in the flow, so Brand, Page, Build, Review, and Repair inherit the fast
   briefing setting. Use low effort only for qualification and briefing, then restore the user's
   selected effort or define explicit phase policy.
4. **Invalidate async Preview and Capture work on panic stop.** A panic can happen after the
   provider turn has completed while preview startup or capture is awaiting. Those continuations
   must not launch Review after an emergency stop.
5. **Harden macOS preview-tree shutdown.** Stop the real descendant server and wait for exit.

### Missing TasteSkill work

1. Freeze the version-one artifact contract jointly with the TasteSkill source.
2. Decide how the standard installed skill is selected or required for Design Mode.
3. Replace fallback Brand, Page, Asset, Build, and Review judgment prompts with phase instructions
   that invoke the installable TasteSkill contract.
4. Build and test the deterministic palette, type, spacing, gradient, asset, and objective QA tools.
5. Integrate branding, copywriting, anti-slop, animation, and component rules without duplicating
   them in Harness.
6. Add fixture-based contract tests proving TasteSkill outputs parse in Harness.
7. Define artifact version migration before changing persisted schemas.

### Missing M4 product surfaces

- a visible live preview pane with hot reload;
- a direction gallery with real rendered choices before committing to one direction;
- a design-token editor;
- a reference and anti-reference board;
- explicit supplied-asset management;
- raster asset generation through the existing image-generation capability;
- objective browser interaction and accessibility checks;
- a durable comparison or iteration history;
- reliable redesign behavior after the new-build path is proven.

## Recommended continuation order

Keep each step in its own small PR. Do not combine schema changes, provider correctness, skill
content, and UI design.

### 1. Restore provider-neutral mechanics

- remove the renderer's `userInput` dependency for Design-owned questions;
- separate briefing effort from later phase effort;
- make ACP image capability truthful;
- add tests with a direct API session and a non-Codex adapter;
- verify that a future adapter works through capabilities without a provider-name branch.

### 2. Close lifecycle safety gaps

- add a flow generation or cancellation token around preview startup and capture;
- harden and test macOS descendant shutdown;
- decide the preview command approval boundary;
- ensure restart, failure, panic, close, and queued prompts all terminate cleanly.

### 3. Freeze artifacts with TasteSkill

- compare the current schemas with the external plan;
- agree on the smallest implementation-useful additions;
- version parsers and fixtures;
- keep `brief.json` factual, `brand.json` decisional, `page.json` compositional, and
  `assets.json` provenance-focused;
- do not create `.taste/run.json` while Harness already persists run state.

### 4. Integrate the real installable skill

- use the existing Agent Skills discovery and enablement path;
- avoid hardcoding Codex, Claude, model IDs, or a private tool API;
- define what happens when TasteSkill is missing: block high-quality mode, offer installation, or
  run an explicitly labeled fallback;
- make each judgment phase consume and produce the agreed artifacts;
- keep deterministic tools dependency-light and project-relative.

### 5. Raise visual quality with evidence

- build the palette, type, spacing, gradient, and taste-check tools;
- test them on several deliberately different briefs;
- add reference and anti-reference evidence;
- add the direction gallery before full implementation when multiple directions are plausible;
- measure reduction in repeated layouts, generic copy, ungrounded decoration, contrast failures,
  overflow, and unsafe motion.

### 6. Finish M4 surfaces

- visible preview and iteration controls;
- token editor;
- reference board;
- asset production and provenance UX;
- final cross-provider and Windows/macOS smoke matrix;
- Personal Harness landing-page proof run and human design approval.

## Human decisions still required

The implementation should not silently decide these product questions:

1. Is Design Mode a per-turn action or a persistent composer mode?
2. Must TasteSkill be installed, bundled, or offered as an optional quality layer?
3. Should the user choose among visual directions before Brand is locked?
4. Which Brand fields are editable and which remain agent-owned?
5. Should preview commands require a visible approval even in autonomous mode?
6. Which provider or model effort should each phase use?
7. Is a screenshot-only review acceptable, or must interaction and accessibility checks pass?
8. What is the official OriginKit MCP contract and licensing representation?
9. Does a final visual pass require human approval, or may the automated rubric complete the run?
10. When does redesign become supported rather than experimental?

## Implementation map

| Area                                                    | Files                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| Artifact types, parsers, writers, phase prompts         | `packages/design-agent/src/`                                      |
| Design flow state, phase routing, recovery, corrections | `apps/server/src/orchestrator.ts`                                 |
| Preview plan execution and command safety               | `apps/server/src/design-preview-runner.ts`                        |
| Desktop capture coordination                            | `apps/server/src/preview-capture.ts`, `apps/server/src/server.ts` |
| Typed capture and structured-input protocol             | `packages/contracts/src/`                                         |
| Desktop hidden capture window                           | `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`         |
| Design attachment and briefing UI                       | `apps/web/src/design-agent/`                                      |
| Design toggle and capability gate                       | `apps/web/src/App.tsx`, `apps/web/src/ui/Composer.tsx`            |
| Persisted renderer questions                            | `apps/web/src/thread-store.ts`, `apps/web/src/ui/Thread.tsx`      |
| Activity presentation                                   | `apps/web/src/ui/Thread.tsx`                                      |
| Client capture relay                                    | `apps/web/src/bridge.ts`, `apps/web/src/transport.ts`             |
| Direct API workspace tools                              | `apps/server/src/api-workspace-tools.ts`                          |
| Durable product scope                                   | `docs/ROADMAP.md`, `docs/FEATURES.md`, this document              |

Tests are colocated with each package or application. Important coverage includes artifact parser
tests, phase-prompt parsing, briefing continuation, question navigation, thread-store persistence,
orchestrator phase progression and restart recovery, preview plan validation, preview process
execution, capture coordination, Electron navigation restrictions, and adapter capability behavior.

## Rules for future implementation

- Preserve the existing Harness architecture. Do not build a second workflow engine beside the
  orchestrator.
- Keep shared behavior provider-neutral and capability-driven.
- Keep provider-specific checks inside adapters.
- Never infer capability from a provider name or model label.
- Never read vendor credential files.
- Never expose credentials to Design tools or preview processes.
- Never execute a model-authored shell string.
- Reuse the project's framework, dependencies, package manager, and design system.
- Preserve unrelated user changes.
- Validate every trust-boundary object before persisting or executing it.
- Keep creative rules in TasteSkill and deterministic runtime rules in Harness.
- Treat a skipped visual review as degraded completion, not proof of visual quality.
- Use human design review as the final quality authority.

## Definition of done

M4 is complete only when:

- Design Mode works through every supported provider path that can perform ordinary text turns;
- briefing asks only useful questions and produces a complete validated brief;
- the jointly authored TasteSkill contract drives Brand, Page, Assets, Build, and Review;
- the artifact schemas carry every decision consumed by implementation and review without becoming
  process narration;
- the real project builds through its existing stack;
- the preview runs safely and visibly;
- representative desktop and mobile captures are reviewed by a model that actually received them;
- objective browser, accessibility, and motion checks complement visual judgment;
- repairs are bounded and preserve approved decisions;
- restart, cancel, panic, failure, and queue behavior are proven;
- Windows and macOS smoke runs pass;
- the direction gallery, token editor, reference board, and asset workflow are usable;
- Personal Harness's own landing page passes the automated rubric and human design review.

Until then, the current system should be described as an implemented end-to-end Design Mode
skeleton with a working Codex proof run, not as a finished universal Taste Agent.
