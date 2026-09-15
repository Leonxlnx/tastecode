# Design agent

This document is the durable implementation guide for TasteCode Design Mode and the
internal `packages/design-agent` implementation. It explains the product goal, the current
runtime, the artifact contracts, what shipped in the first end-to-end implementation, and what
remains before M4 is complete.

It is not a live ownership tracker. Before changing code, read `AGENTS.md`, the linked rules,
`docs/ARCHITECTURE.md`, and the current GitHub issues and pull requests.

## Product goal

The v0.5 implementation and local catalog configuration are documented in
[Design references](./DESIGN-REFERENCES.md). This reference-first workflow supersedes the
bundled direction selection described below for new runs; older persisted runs remain compatible.

Design Mode should turn a useful but incomplete website request into a distinctive, implemented,
visually reviewed result without forcing the user to become a creative director or fill out a
long specification first.

The intended experience is:

1. The user selects Design in the normal composer and writes a request.
2. TasteCode extracts everything it can and asks only questions whose answers materially affect
   the result. It asks as many questions as necessary.
3. TasteCode records a validated brief before any website implementation begins.
4. The internal Design Agent makes explicit brand, copy, layout, asset, and motion decisions.
5. The normal selected agent implements those decisions in the user's existing project.
6. TasteCode starts the real local site, opens it in a dedicated Browser tab, captures representative
   viewports in a separate deterministic renderer, reviews the output, and performs bounded repairs.
7. The user receives normal project files, inspectable `.taste` artifacts, and a clear final
   result inside the existing TasteCode thread.

The milestone proof remains: Design Mode builds TasteCode's own landing page to a standard
the humans would actually ship.

## Scope and non-goals

The first reliable workflow targets a new website or page. Redesign support should be treated as
experimental until the new-build path is consistently strong.

Design Mode does not create a second agent framework, a second session model, or a second preview
system. It uses the same provider adapters, server-owned thread, event log, approvals, workspace,
checkpoints, tools, and renderer as every other TasteCode turn.

The server runtime is not the source of creative taste. It owns orchestration, persistence,
safety, preview, and recovery. The internal design-agent package owns the phase contracts,
creative rules, and deterministic checks that keep a capable model from converging on generic
output.

## Responsibility boundary

| TasteCode runtime owns                         | Internal design-agent package owns                    |
| ---------------------------------------------- | ----------------------------------------------------- |
| Design Mode entry and provider sessions        | Brief, Brand, Page, Asset, Build, and Review prompts  |
| Question transport and briefing UI             | Artifact contracts and trust-boundary parsers         |
| Durable `.taste` writes and flow recovery      | Creative direction and visual thesis rules            |
| Provider-neutral orchestration and permissions | Copy, layout, component, image, and motion judgment   |
| Safe project tools and command boundaries      | Deterministic palette and objective quality checks    |
| Preview lifecycle and screenshot capture       | Visual critique rubric and repair priorities          |
| Retry budgets and honest degradation           | Rules for when generated design output must be denied |

The boundary must preserve this split. Creative rules and deterministic design helpers belong in
`packages/design-agent`, not duplicated in server orchestration or provider adapters. The package
does not own sessions, recovery, tools, preview, or completion.

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
Internal brand judgment --> .taste/brand.json
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
        +--> dedicated sidebar Browser tab
        |
        v
Isolated desktop + mobile captures
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
After the brief, the current implementation advances automatically unless a normal TasteCode
approval or a real user decision blocks the selected provider.

## Current implementation status

The first end-to-end implementation shipped in pull request
[#314](https://github.com/Leonxlnx/tastecode/pull/314). GitHub records 45 commits, 56 changed
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
- one dedicated sidebar Browser tab that opens on capture and reloads for repair passes;
- a serialized, capability-negotiated Electron screenshot bridge that waits within fixed deadlines
  for animations, fonts, and images before capture;
- negotiated ACP image prompt blocks for screenshot-capable ACP agents;
- visual review and at most two repair attempts;
- queue release after success and failure;
- cleanup of the preview process when the flow or thread ends.

The workflow skeleton is real. Some internal judgment rules, deterministic tools, and provider
truthfulness issues are not finished. The section `Known gaps and risks` is normative and must be
read before claiming universal support.

## Entry and qualification

The renderer adds the sentinel attachment
`tastecode://design-brief-v1` when Design is active. The sentinel is protocol metadata, not a
filesystem path, and is removed before attachments reach the provider. Saved turns carrying the
legacy Personal Harness sentinel remain supported.

The server recognizes the sentinel in `Orchestrator.sendTurn`, creates a persisted `DesignFlow`,
and replaces the user's provider-visible text with `designBriefingPrompt`. The user still sees the
original request in the transcript; internal JSON instructions and assistant JSON responses are
suppressed from the normal chat presentation.

The briefing prompt is deliberately text-only and tool-free. It tells the provider not to inspect
the workspace, browse, invoke skills or MCP, edit files, or build anything. This keeps the first
response fast and prevents project contents from influencing whether the user's request is a
design task.

If the provider returns `not_design`, TasteCode clears the flow and shows:

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
| `explicitAnswers` | Every question and resolved answer collected by TasteCode.                     |
| `assumptions`     | Reasonable decisions the agent made, including safe `Decide for me` choices.   |
| `unresolved`      | Non-blocking details intentionally left for later.                             |

All required string fields must be non-empty. All list fields must be string arrays. Unknown model
keys are stripped rather than persisted and later injected into Build instructions.

### Question behavior

The provider first infers everything reasonably supported by the request. If material information
is missing, it returns every currently useful question in one structured response. TasteCode shows
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
again. Once the provider returns a complete candidate brief after any question round, TasteCode
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

| Artifact      | Owns                                                              | Consumes                                       |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| `brief.json`  | User intent, facts, constraints, answers, assumptions             | Request and briefing answers                   |
| `brand.json`  | Derived visual and verbal system                                  | Brief, project evidence, supplied references   |
| `page.json`   | Page story, copy, reference lock, responsive and interaction plan | Brief, brand, supplied and internal references |
| `assets.json` | Exact needs, roles, composition, provenance, status, destinations | Brief, brand, page, references, project files  |
| `review.json` | Latest visual verdict and actionable findings                     | Brief, brand, page, references, screenshots    |
| Project files | The implementation                                                | All validated artifacts                        |

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
- a `colorPalette` of semantic light or dark role records with exact value and usage;
- at most two `typefaces` with family, source, roles, and numeric weights; IBM Plex Mono and
  Archivo are rejected;
- `interfaceDirection`;
- `imageDirection` with summary, subjects, treatment, and avoid rules;
- `motionDirection` with summary, principles, and avoid rules;
- `voice` with summary and avoid rules.

User-supplied colors or fonts remain evidence in `brief.json`. The Brand phase assigns their usable
roles in `brand.json`. The Page phase consumes those roles rather than copying the palette.

The Brand model returns a compact palette recipe rather than improvising every shade. The runtime
turns its accent and neutral seeds into canvas, surface, text, control, focus, and accent roles;
preserves role locks exactly; maps generated colors into opaque sRGB; and rejects required text or
control pairs that miss WCAG 2.2 contrast. Light and dark directions are generated independently.
The persisted `colorPalette` remains version-one compatible, so later phases need no parallel color
framework. `60/30/10` is only loose composition guidance for dominant surfaces, supporting
structure, and sparse accent use, never a palette formula or pixel quota.

The deterministic gradient helper derives dependency-free CSS recipes for card, section, and page
purposes from the validated palette. It preserves an opaque content surface for readable copy and
controls. Build may use at most one matching purpose per view; gradients remain optional and may
not replace imagery, hierarchy, or content.

Signature-device status is deliberately conservative. Existing or newly proposed devices are not
called validated unless the input includes real category-buyer attribution evidence. Visual
novelty, internal preference, and competitor distance can justify a candidate, but do not prove
brand recognition.

The current Brand prompt may inspect existing project brand files. Provider-exposed design tools
may contribute optional evidence, but the required rules, schemas, and deterministic checks live
in `packages/design-agent` and require no particular skill, model, provider, or private API.

### Current `page.json`

The current version-one blueprint contains:

- page title, route, and description;
- a page contract, dominant page mode, novelty tolerance, base grid, signature composition rule,
  and rhythm;
- navigation labels and targets;
- the selected navigation layout case;
- ordered sections with unique IDs;
- each section's purpose;
- the user question, decision stage, prior-section dependencies, and real evidence for each section;
- final concise heading, body copy, and calls to action;
- one beta layout family, the exact selected case IDs, and a content-specific layout direction;
- one `referenceDirectionId` per section, identifying either a supplied user mockup or an internal
  direction image;
- one bounded motion decision per section with purpose, trigger, behavior, duration, easing, and a
  reduced-motion equivalent;
- component needs;
- asset needs;
- explicit compact, medium, and expanded transformations per section;
- page-level responsive rules;
- meaningful interactions;
- acceptance criteria.

Generated page copy passes an internal quality gate before the artifact is accepted. Em dashes,
unsupported objective claims, `click here`, all eyebrows, internal placeholders, overlong headings,
and multi-block Hero support copy fail validation. Formulaic copy, generic CTA labels, and
collision-prone generated names remain contextual review signals rather than an AI-authorship
score. Real process numbers may appear inside How It Works content, but not as a decorative
page-wide `01 / 02 / 03` label system.

The Page phase writes actual concise copy before implementation. It must use the approved brand
system and must not choose replacement colors, fonts, or sources.

New Page-phase outputs must map every section to Hero, About, Feature, How It Works, Social Proof,
Stats, FAQ, CTA, Pricing, Contact, or Footer and select a reviewed reference from the persisted
deck. New v0.5 runs record that reference ID in `layoutCases`; legacy runs retain the beta case
validation. A custom-named section such as Showcase may reuse the compatible Feature family.
Unknown, cross-family, and missing reference IDs fail the Page phase before Build.
The model must explicitly return every `referenceDirectionId`; TasteCode does not silently
fill an omitted choice, and a run with supplied user mockups must select at least one of them. Build
treats the reference as the primary composition contract; family and cases classify and support
it. Page, Build, and Review preserve its macro geometry, hierarchy, proportions, alignment,
overlap, density, negative space, media placement, and motion logic while adapting the project
identity, copy, colors, type, icons, image subjects, and small details. Older version-one artifacts
without these additive fields remain readable outside the strict new Page-phase boundary.

The package also carries 132 generated and visually inspected direction references across all 11
layout families. A deterministic brief-content seed selects one direction per family without
reshuffling it when only palette or typography changes. Image-capable provider turns receive the
selected WebP files, not only their text cues. Supplied user references are persisted with the
Design flow, receive stable `user-reference-#` IDs, outrank the internal deck, and are reattached to
Brand, Page, Assets, Build, Review, and Repair, including after restart. A provider that cannot
inspect images fails explicitly rather than silently ignoring supplied references. Repair also
receives the exact failed viewport screenshots and their dimensions, not only textual findings.

### Current `assets.json`

Each asset has:

- a stable ID shared with `page.json`;
- kind: image, illustration, video, icon, font, or component;
- status: existing, needed, or ready;
- purpose and requirements;
- semantic role and every consuming section ID;
- exact aspect ratio and composition for visual assets;
- optional source kind: project, user, OriginKit, generated, or external;
- source reference and optional license;
- optional workspace-relative destination.

New Asset-phase output must match the union of Page asset and component IDs exactly. Ready assets
require a non-empty real file at the destination. Ready external assets also require recorded
reuse terms. Existing raster visuals must resolve to a real project or supplied user file.
`source.kind: user` records the stable `user-reference-#` ID and must resolve to the corresponding
attached file. Absolute destinations, parent-directory escapes, arbitrary user paths, and project
or destination symlinks that resolve outside the workspace are rejected. Duplicate IDs, missing
or extra needs, wrong section ownership, and generated interface, icon, logo, or data-diagram
assets are rejected. Raster content must be a recognizable PNG, JPEG, WebP, or GIF, its real pixel
dimensions must match the declared aspect ratio, and generated or downloaded images must clear the
production resolution floor. Content sniffing still rejects SVG renamed as a raster extension.
Build cannot report `complete` while a photography, product-image, editorial-illustration, or
interface-capture record remains `needed`; unresolved meaningful imagery forces an honest failed
result instead of a generated substitute.

PNG data also passes chunk checksum and bounded decompression checks. JPEG, GIF, and WebP
validation establishes container and dimension evidence; the browser and visual Review must
still prove that images decode and look correct. A manifest or model report alone does not prove
image quality or license ownership. Supplied assets used in the page need a workspace copy so
the finished result does not depend on an upload path.

The Asset phase is an acquisition step rather than a wish list. It keeps every Page asset and
component ID and reuses suitable project or supplied files first. Licensed search comes next for
factual, editorial, or professional photography; image generation is reserved for precise,
brand-specific original needs. Generated output receives an exact creative brief, intended crop
inspection, and at most one defect-led regeneration. A generated or downloaded file must be saved
inside the project before it is marked ready. SVG is allowed only for a functional icon, logo, or
truthful data diagram. It cannot satisfy photography, product imagery, editorial art, interface
capture, or a generic open visual need.

### Build result

Build does not write a second artifact for its summary. The provider returns a validated
`complete` or `failed` result with a summary, relative files, and reported checks. Build is
instructed to inspect and reuse the project's real framework, package manager, design system,
dependencies, entry points, scripts, and existing user changes. It must not scaffold a parallel
application.

Build and visual Review share a pass-blocking quality floor: headings target one or two lines and
never exceed three, display sizes are bounded by viewport class, the Hero has one support block,
typography stays within the approved two families, and internal notes never appear on the page.
Cards group coherent features, people, plans, proof, actions, or media through one base language
and at most one emphasized variant; they may not become empty equal-column boxes or unrelated
experiments. The brand accent must reach meaningful actions and states rather than surviving only
in tiny labels. Hairline grids, repeated separator systems, full-height one-sided card-edge rails,
ornamental SVGs, unstyled controls, overflow, clipping, and footer overlap require repair. Before
Preview and after every Repair, TasteCode scans the workspace source rather than trusting the
provider's file report. A persisted baseline captured before the first Design turn preserves
unrelated existing user code while making newly introduced violations enforceable. The gate rejects card-edge borders,
pseudo-elements, inset shadows, narrow hard-stop gradients, child strips, equivalent utility
classes, and standalone or inline SVG substitutes not backed by an explicit functional asset in
`assets.json`, then permits one bounded source edit to remove the new output. Representative
interface or operational data may make a one-shot page feel complete, but Build returns it in a
`Verify before publishing:` summary that the final Harness message surfaces after Preview instead
of adding a disclaimer to the website.

The approved Brief, Brand, Page, and Asset artifacts are persisted on the Design flow before
Build. Build and Repair receive those snapshots, may not rewrite them, and are checked against all
four on-disk `.taste/*.json` artifacts before Preview or recapture. TasteCode restores any changed
artifact and rejects the phase result if a provider tries to remove an exact-file constraint,
change the approved direction, remove a reference lock, change an asset role, or otherwise weaken
an approved constraint.

All later phases, including resumed phases, check these trusted snapshots. Artifact replacement
is atomic and does not write through file symlinks. Reference and acquired media hashes must
still match; native component source remains editable during Build and Repair. Older interrupted
runs that lack the required snapshots must restart Design mode. Existing version-one artifacts
remain readable.

Exact deliverable checks compare with the workspace before any Design phase uses tools,
including Asset acquisition. They inspect normal nested directories, preserve pre-existing
files, reject symlink deliverables, and keep dependency trees opaque. Source checks compare with
the initial baseline and permit SVGs in the exact source file of a manifested functional icon,
logo, or data diagram. They check specific source patterns, not overall visual quality.

Filesystem work has explicit limits: 25,000 entries, 40 directory levels, 2 MB per source or JSON
artifact, 32 MB of scanned source, 32 MB per media file, and 128 MB per media snapshot. A scan that
exceeds a limit stops with an error instead of silently accepting unchecked files.

The provider is currently responsible for running the project's relevant checks through its
available tools. TasteCode validates the final report shape but does not independently prove that
every reported command ran. This distinction matters for future verification work.

### Preview plan

The Preview phase returns an executable, argv array, workspace-relative working directory,
explicit `http://127.0.0.1:<port>` URL, optional readiness text, and one to four unique viewports.

The parser rejects:

- remote or `localhost` URLs;
- missing explicit ports;
- shell expressions and path-like executable names;
- absolute or parent-escaping working directories;
- duplicate viewport names or dimensions;
- viewport dimensions outside bounded ranges.

### Current `review.json`

The latest visual review contains:

- `verdict`: `pass` or `repair`;
- a concise summary;
- zero or more findings;
- a stable finding ID;
- severity: blocking, major, or minor;
- visible area or viewport;
- evidence type: automated DOM evidence or visual inspection;
- confidence: high, medium, low, or unknown;
- concrete evidence;
- a bounded repair instruction.

A passing review cannot contain findings. A repair verdict must contain at least one finding in
practice, and TasteCode stops after at most two Repair attempts. The final artifact is the latest
review, not a history of every review iteration.

This phase deliberately makes only claims supported by screenshots and attached DOM audits. It
does not infer factual accuracy, working interactions, conversion, user comprehension, loading
performance, or provenance. Those require source, runtime, user, analytics, or performance
evidence outside the visual-review artifact.

## Runtime state and recovery

The server is the sole Design Mode orchestrator. It persists `DesignFlow` in the normal TasteCode
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

On thread restoration, TasteCode:

1. parses and rejects corrupt stored flow state;
2. reconstructs unresolved structured questions from `user_input.requested` and
   `user_input.resolved` events;
3. reattaches an open provider turn when one exists;
4. finishes a persisted completion;
5. otherwise rebuilds the next phase prompt from validated workspace artifacts;
6. fails visibly and releases the queue if a required artifact was removed.

The current phase prompts are internal provider turns. TasteCode creates a synthetic `tool_call`
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

The architecture is provider-neutral: Design Mode uses `AgentSession.sendTurn`, persisted TasteCode
state, normal domain events, and declared capabilities. No shared phase branches on a provider
name.

The current product surface is provider-neutral for briefing but capability-gated for visual review.

| Provider path      | Briefing UI today | Visual review today       | Important detail                                                               |
| ------------------ | ----------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Codex app-server   | Available         | Available                 | Accepts native screenshot attachments.                                         |
| Claude Code CLI    | Available         | Available                 | Accepts native image attachments.                                              |
| Grok CLI           | Available         | Available                 | Accepts native image attachments.                                              |
| Cursor CLI         | Available         | Skipped                   | Does not declare image input.                                                  |
| Native OpenCode    | Available         | Skipped                   | Does not declare image input.                                                  |
| Antigravity CLI    | Available         | Skipped                   | Does not declare image input.                                                  |
| Pi RPC             | Available         | Skipped                   | Does not declare image input.                                                  |
| Direct API runtime | Available         | Skipped                   | Workspace tools exist, but image attachments are not implemented.              |
| ACP                | Available         | Available when negotiated | Sends ACP image blocks only when the agent advertised image prompt capability. |

TasteCode-owned Design questions need only an ordinary text turn and do not depend on an adapter's
provider-originated structured-input capability. Provider-originated questions still use the
adapter's declared `userInput` support.

Image support remains truthful end to end. ACP derives its capability from initialization and
serializes screenshot files as ACP image content blocks only when
`promptCapabilities.image` was negotiated. Unsupported ACP agents reject image attachments, and
shared orchestration degrades the Review phase instead of pretending the model saw a path string.

Providers without real image input currently finish after Preview with an explicit message that
visual review was skipped. This is honest degradation, but it does not satisfy M4's full definition
of done.

## Direct API workspace tools

OpenAI, Anthropic, and compatible model endpoints do not provide a complete coding-agent runtime.
TasteCode supplies its own bounded workspace tools so Design phases can still use the shared session
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
connected capable client and serializes capture requests so one request owns the shared capture
session at a time.

The same typed capture request opens or focuses one dedicated sidebar Browser tab. A new request ID
reloads the requested URL after the Electron guest reports `dom-ready`, so repair passes refresh
even when the URL is unchanged. Manual Browser input normalizes HTTP `localhost` and IPv6 loopback
addresses to `127.0.0.1` for reliable Windows loading. This visible guest is for user inspection; a
separate hidden BrowserWindow remains the authority for exact review screenshots.

The Electron main process validates the request, denies permission checks and requests, denies new
windows, confines navigation and redirects to the preview origin, and verifies the final URL. It
scrolls through the document to activate lazy content, then waits, within a 30-second deadline, for
bounded animation settlement, fonts, image load and decode, and two final animation frames. It
audits interaction targets across the whole document and captures a whole-page image for each
requested viewport, bounded to 12,000 CSS pixels in height. It writes private temporary PNGs,
destroys the window, clears its session storage and HTTP cache, removes failed captures, and sweeps
capture directories older than one day. Cleanup finishes before the next serialized capture starts.

Current preview risks that still need explicit work:

- POSIX process-group shutdown is implemented but still needs a real macOS process-tree smoke run;
- the preview command executes a script already declared by the opened project without a separate
  Design Mode approval; confirm this trust model is intended or route it through the normal command
  approval surface;
- when several desktop clients are connected, the coordinator uses the first capable socket and the
  capture request has no thread owner, so a concurrent run can open in the wrong visible workspace;
- screenshot files are temporary evidence, not a durable iteration history.

## OriginKit

OriginKit is currently an optional instruction inside the Asset phase, not a required runtime
dependency and not a dedicated TasteCode integration.

When an OriginKit MCP server is already available to the selected provider and a specific component
need would materially benefit, the prompt allows one focused catalog search and one fitting fetch.
The result must be recorded with real provenance and a project destination. Missing authentication,
rate limits, unavailable MCP, or no suitable component are normal fallback cases; the need remains
available for local implementation.

Before stronger OriginKit support ships, decide:

- the official MCP server identity and authentication flow;
- rate-limit behavior and whether TasteCode should cache inventory;
- the exact component import and provenance format;
- how licensing metadata reaches `assets.json`;
- whether component retrieval remains provider tool use or becomes a TasteCode-owned project tool.

OriginKit must never become the foundation for shared Design Mode behavior. Existing dependencies
and local implementation remain the fallback.

## Internal design-agent judgment and tools

`packages/design-agent` is the v2 judgment boundary. It owns concise phase instructions, artifact
schemas and parsers, reusable creative rules, and deterministic checks. Provider-exposed design
skills, MCP servers, and tools may add evidence or assets, but none is required for the shared
workflow. The server remains the sole authority for sessions, phase order, recovery, permissions,
preview, and completion.

The dependency-light tool order is:

1. workflow and artifact gates;
2. semantic palette generation and contrast evidence;
3. responsive typography and spacing scales;
4. controlled gradient generation;
5. asset-manifest validation;
6. objective checks for assets, overflow, focus, contrast, reduced motion, and unsafe animation.

Only fragile or repeatable calculations become tools. Contextual choices such as art direction,
layout composition, imagery, and motion intent remain model judgment bounded by the artifacts and
review rules.

## Remaining artifact and verification gaps

The schemas are intentionally compact. Add a field only when a later phase consumes it or it
prevents a known failure; do not turn artifacts into reasoning transcripts.

### Brand gaps

Semantic palette roles now derive from a compact recipe and persist in the existing
`colorPalette`. Type and spacing scales, layout and surface principles, icon direction, and
accessibility constraints still need explicit homes only where Page, Build, or Review will consume
them.

### Page gaps

The blueprint records visitor questions, decision stages, information dependencies, final copy,
selected reference IDs, responsive behavior, interactions, acceptance criteria, and one
purposeful motion decision per section. New runs use the configured reviewed image library;
the 132 legacy direction variants remain available only for older saved runs. It still needs evidence from varied
real builds to show which cues improve results and which should be retired.

### Asset gaps

Asset acquisition currently depends on tools exposed by the selected provider. A provider-neutral
Harness search and generation tool does not exist yet. The manifest now types section ownership,
role, aspect ratio, and composition; pixel dimensions and usage variants remain future additions
only where they prevent bad generation, wrong cropping, or lost provenance.

### Token and verification gaps

There is no separate token artifact. Genuine brand decisions may live in `brand.json`, while
generated CSS variables remain project output. TasteCode still needs independent verification of the
production build, important interactions, overflow, contrast, and reduced motion; Review currently
relies primarily on provider-reported checks and screenshots.

## Known gaps and risks

### Critical correctness gaps

1. **Invalidate async Preview and Capture work on panic stop.** A panic can happen after the
   provider turn has completed while preview startup or capture is awaiting. Those continuations
   must not launch Review after an emergency stop.
2. **Prove preview-tree shutdown on macOS.** POSIX process-group termination and exit waiting are
   implemented, but the real package-manager descendant path still needs a macOS smoke run.
3. **Route capture to its owning task and desktop client.** The current typed request has no
   `threadId`; the first capable socket is correct only under the single-active-desktop assumption.

### Missing internal judgment and tool work

1. Finish compact Brand, Page, Asset, Build, and Review rules inside `packages/design-agent`.
2. Build and test deterministic type, spacing, asset, and objective QA tools; keep the existing
   palette and gradient helpers narrow and evidence-backed.
3. Test the beta layout and direction catalogs on varied real briefs, retire weak cues, then finish
   component, imagery, and motion judgment.
4. Add provider-independent fixtures proving every phase output parses into the same artifacts.
5. Define artifact migration before changing persisted schema versions.

### Missing M4 product surfaces

- persistent hot reload and Design-specific iteration history beyond capture-triggered Browser
  reloads;
- a direction gallery with real rendered choices before committing to one direction;
- a design-token editor;
- a reference and anti-reference board;
- explicit supplied-asset management;
- raster asset generation through the existing image-generation capability;
- objective browser interaction and accessibility checks;
- a durable comparison or iteration history;
- reliable redesign behavior after the new-build path is proven.

## Recommended continuation order

Keep each step in its own small PR. Do not combine schema changes, provider correctness, internal
judgment rules, and UI design.

### 1. Finish provider verification

- add real Design fixtures for a direct API session and non-Codex adapters;
- capture one negotiated ACP image-review run against a real ACP agent;
- add image attachments to another adapter only after its real protocol is captured;
- verify that a future adapter works through capabilities without a provider-name branch.

### 2. Close lifecycle safety gaps

- add a flow generation or cancellation token around preview startup and capture;
- harden and test macOS descendant shutdown;
- decide the preview command approval boundary;
- ensure restart, failure, panic, close, and queued prompts all terminate cleanly.

### 3. Finish artifact contracts

- agree on the smallest implementation-useful additions;
- version parsers and fixtures;
- keep `brief.json` factual, `brand.json` decisional, `page.json` compositional, and
  `assets.json` provenance-focused;
- do not create `.taste/run.json` while TasteCode already persists run state.

### 4. Strengthen the internal judgment layer

- keep required rules, schemas, and checks in `packages/design-agent`;
- make each judgment phase consume and produce the agreed artifacts;
- keep all behavior provider-neutral without model IDs or private tool APIs;
- use provider-exposed design tools only as optional evidence or asset sources;
- keep deterministic tools dependency-light and project-relative.

### 5. Raise visual quality with evidence

- build the type, spacing, asset, and taste-check tools around the existing palette and gradient
  helpers;
- test them on several deliberately different briefs;
- add reference and anti-reference evidence;
- add the direction gallery before full implementation when multiple directions are plausible;
- measure reduction in repeated layouts, generic copy, ungrounded decoration, contrast failures,
  overflow, and unsafe motion.

### 6. Finish M4 surfaces

- persistent hot reload and Design-specific preview iteration history;
- token editor;
- reference board;
- asset production and provenance UX;
- final cross-provider and Windows/macOS smoke matrix;
- TasteCode landing-page proof run and human design approval.

## Human decisions still required

The implementation should not silently decide these product questions:

1. Is Design Mode a per-turn action or a persistent composer mode?
2. Which decisions require deterministic enforcement instead of model judgment?
3. Should the user choose among visual directions before Brand is locked?
4. Which Brand fields are editable and which remain agent-owned?
5. Should preview commands require a visible approval even in autonomous mode?
6. Which provider or model effort should each phase use?
7. Is a screenshot-only review acceptable, or must interaction and accessibility checks pass?
8. What is the official OriginKit MCP contract and licensing representation?
9. Does a final visual pass require human approval, or may the automated rubric complete the run?
10. When does redesign become supported rather than experimental?

## Implementation map

| Area                                                    | Files                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Artifact types, parsers, writers, phase prompts         | `packages/design-agent/src/`                                                             |
| Design flow state, phase routing, recovery, corrections | `apps/server/src/orchestrator.ts`                                                        |
| Preview plan execution and command safety               | `apps/server/src/design-preview-runner.ts`                                               |
| Desktop capture coordination                            | `apps/server/src/preview-capture.ts`, `apps/server/src/server.ts`                        |
| Typed capture and structured-input protocol             | `packages/contracts/src/`                                                                |
| Desktop hidden capture window                           | `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`                                |
| Visible Design preview routing                          | `apps/web/src/ui/workspace/WorkspacePanel.tsx`, `WorkspaceBrowser.tsx`, `browser-url.ts` |
| Design attachment and briefing UI                       | `apps/web/src/design-agent/`                                                             |
| Design toggle and capability gate                       | `apps/web/src/App.tsx`, `apps/web/src/ui/Composer.tsx`                                   |
| Persisted renderer questions                            | `apps/web/src/thread-store.ts`, `apps/web/src/ui/Thread.tsx`                             |
| Activity presentation                                   | `apps/web/src/ui/Thread.tsx`                                                             |
| Client capture relay                                    | `apps/web/src/bridge.ts`, `apps/web/src/transport.ts`                                    |
| ACP screenshot prompt blocks                            | `packages/adapter-acp/src/`                                                              |
| Direct API workspace tools                              | `apps/server/src/api-workspace-tools.ts`                                                 |
| Durable product scope                                   | `docs/ROADMAP.md`, `docs/FEATURES.md`, this document                                     |

Tests are colocated with each package or application. Important coverage includes artifact parser
tests, phase-prompt parsing, briefing continuation, question navigation, thread-store persistence,
orchestrator phase progression and restart recovery, preview plan validation, preview process
execution, Browser auto-open and same-URL repair reload, serialized capture coordination, Electron
navigation and settle behavior, ACP image prompt blocks, and adapter capability behavior.

## Rules for future implementation

- Preserve the existing TasteCode architecture. Do not build a second workflow engine beside the
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
- Keep creative rules and deterministic design helpers in `packages/design-agent`; do not
  duplicate them in server orchestration or provider adapters.
- Treat a skipped visual review as degraded completion, not proof of visual quality.
- Use human design review as the final quality authority.

## Definition of done

M4 is complete only when:

- Design Mode works through every supported provider path that can perform ordinary text turns;
- briefing asks only useful questions and produces a complete validated brief;
- the internal design-agent contracts drive Brand, Page, Assets, Build, and Review across
  providers;
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
- TasteCode's own landing page passes the automated rubric and human design review.

Until then, the current system should be described as an implemented provider-neutral Design Mode
skeleton with capability-gated visual review, not as a finished cross-provider Design Mode.
