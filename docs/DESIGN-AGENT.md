# Design agent

Personal Harness Design Mode is a provider-neutral workflow that turns a design request into
an implemented, reviewed interface. TasteSkill supplies judgment; Personal Harness owns the
workflow, durable artifacts, tool access, preview, and repair loop.

The workflow uses the same session and adapter path as every other turn. It must work with a
direct API provider, Codex, Claude Code, Cursor, or any future adapter that declares the needed
capabilities. Shared code never selects behavior by provider name.

## Workflow

1. **Qualify** — reject a non-design request even when Design Mode was selected accidentally.
2. **Brief** — infer the request, ask only material questions, and write `.taste/brief.json`.
3. **Brand** — turn brief evidence into explicit visual, type, image, motion, and voice
   decisions in `.taste/brand.json`.
4. **Blueprint** — plan page hierarchy, sections, copy intent, interactions, and responsive
   behavior in `.taste/page.json`.
5. **Source** — inventory existing assets, decide what is still needed, and track acquisition
   in `.taste/assets.json`. OriginKit is an optional component source at this phase.
6. **Build** — implement the approved artifacts in the user's existing project and dependency
   stack.
7. **Preview** — run the project through the existing process and preview infrastructure.
8. **Review** — capture the rendered result and evaluate it against the artifacts and the
   active TasteSkill rubric.
9. **Repair** — make bounded fixes, preview again, and stop when the review passes or the retry
   budget is exhausted.

Briefing is a hard gate: no website files are created before the brief is complete. After the
brief, phases advance automatically unless a real user decision or approval is required.

## Artifact ownership

The files are a chain of evidence and decisions, not copies of one large object.

| Artifact | Owns | May consume |
| --- | --- | --- |
| `brief.json` | User intent, business facts, constraints, explicit answers, assumptions | Prompt and briefing answers |
| `brand.json` | Derived visual and verbal system | Brief, existing brand files, brand skill |
| `page.json` | Page structure, content intent, component needs, responsive behavior | Brief and brand |
| `assets.json` | Existing and requested assets, provenance, status, destination | Brief, brand, page, project files, optional sources |
| Project files | The working implementation | All completed artifacts |

Later artifacts reference earlier decisions but do not mutate them. For example, a color the
user names is recorded as a brand input in the brief; the Brand phase decides its role and
writes the usable palette to `brand.json`. The Page phase consumes that palette but does not
copy it into `page.json`.

Every artifact is validated before it is written. Invalid model output is never treated as a
completed phase. Artifacts are deliberately compact: they record decisions that affect the
build, not design-process narration.

## Runtime state

The server remains the sole orchestrator and source of session state. A Design Mode run records:

- current phase and status;
- paths and versions of completed artifacts;
- the active user-input request, when blocked;
- build, preview, and review attempts;
- a concise failure reason and the safe phase to resume from.

Restart recovery resumes from the latest validated artifact. It does not ask the provider to
reconstruct state from chat text and does not repeat a completed phase. Editing an earlier
artifact invalidates only its downstream artifacts.

## Replaceable judgment

Workflow mechanics and design judgment stay separate. Each judgment-heavy phase has one narrow
input/output boundary:

- Brand: `brief.json` → `brand.json`
- Blueprint and copy: brief + brand → `page.json`
- Asset direction: brief + brand + page → `assets.json`
- Review: artifacts + screenshot → findings

The first implementation uses explicit phase prompts behind those boundaries. TasteSkill v2 can
replace each prompt without changing persistence, providers, UI, or preview orchestration. The
Harness must not invent a private TasteSkill API before its actual package contract exists.

## OriginKit

OriginKit is an optional MCP source during **Source** and **Build**. The agent may search its
catalog and fetch a fitting component when that improves the blueprint. It must record any
selected component and local changes in the asset or page artifact.

Rate limits, missing authentication, an unavailable MCP server, or no suitable result are normal
fallback cases. The workflow continues with the project's existing dependencies and local
implementation. OriginKit never becomes a requirement for shared Design Mode behavior.

## Activity and UI

The chat remains the primary progress surface. It derives live labels from normal domain items:
planning, searching, reading, creating or editing, running commands, previewing, and reviewing.
Adapters emit capabilities and items; the UI does not inspect provider names or model IDs.

Status motion is brief, interruptible, and limited to transform and opacity. The elapsed timer
does not remount when the label changes, and reduced-motion preferences disable transitions.
Questions and approvals use the existing shared request flow rather than a Design Mode-only modal
system.

## Failure behavior

- Non-design request: disable Design Mode for the turn and explain why.
- Invalid phase output: retry once with the validation error, then stop with a recoverable error.
- Missing optional tool: record the fallback and continue.
- Build or preview failure: surface the real command error and remain resumable.
- Review failure: make bounded repairs; never loop indefinitely.
- User cancellation: keep completed artifacts and stop the active run cleanly.

## Definition of done

A Design Mode run is complete only when the brief, brand, page, and asset artifacts validate;
the project builds; a local preview renders; the visual review passes or reports an explicit
remaining limitation; and the user can continue from the resulting normal Harness session.

Roadmap scope and release status remain in [ROADMAP.md](./ROADMAP.md#m4--design-agent).
