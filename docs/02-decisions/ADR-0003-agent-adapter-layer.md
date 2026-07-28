# ADR-0003 — Agent adapter layer and the internal domain model

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

We must drive engines that expose wildly different interfaces: a rich bidirectional JSON-RPC
server (Codex), an open standard (ACP), several bespoke NDJSON CLIs (Claude Code, Cursor,
Grok Build), and an HTTP server with its own SDK (OpenCode). New engines appear every month.

The UI must not know or care which one it is talking to.

## Decision

### One internal domain model: Thread / Turn / Item

We adopt Codex's data model as our internal representation, because it is the best-designed
of the available models and it maps directly onto the UI we want:

- **Thread** — a conversation, bound to a project and a workspace (possibly a worktree).
- **Turn** — one user input and everything the agent does in response.
- **Item** — a unit inside a turn: `message`, `reasoning`, `command`, `file_change`,
  `tool_call`, `plan`, `error`. Items have lifecycle (`started` → deltas → `completed`).

Adapters translate *into* this model. The UI renders only this model. Nothing engine-specific
leaks past the adapter boundary.

### Three adapter tiers

| Tier | Mechanism | Engines | Fidelity |
| --- | --- | --- | --- |
| **1 — Native** | Vendor's own client protocol | Codex (`codex app-server` JSON-RPC), OpenCode (JS/TS SDK) | Full. Approvals, fork, steer, fs events, MCP calls. |
| **2 — ACP** | Agent Client Protocol over stdio | Gemini CLI + 25 others in the registry | Good. One adapter, long-tail coverage at zero marginal cost. |
| **3 — CLI** | Headless NDJSON | Claude Code, Cursor, Grok Build | Adequate. Version-pinned and fragile by nature. |

An engine may be reachable through more than one tier (Claude Code and Codex both speak
ACP). **Preference order is: highest fidelity available, with a user override.** If Claude
Code's ACP surface turns out richer or more stable than its CLI surface in practice, we
switch that engine's default tier without touching the UI. That flexibility is the entire
point of the layer.

### Adapter contract

Every adapter implements one interface:

```ts
interface AgentAdapter {
  readonly id: string
  detect(): Promise<DetectionResult>        // installed? version? authenticated?
  capabilities(): Capabilities              // what this engine can actually do
  startThread(opts): Promise<ThreadHandle>
  resumeThread(id): Promise<ThreadHandle>
  sendTurn(threadId, input): Promise<TurnHandle>
  interrupt(threadId): Promise<void>
  respondToApproval(requestId, decision): Promise<void>
  events: AsyncIterable<DomainEvent>        // normalized, never engine-native
  dispose(): Promise<void>
}
```

**`capabilities()` is what makes this honest.** Not every engine can fork a thread, steer
mid-turn, or emit reasoning items. The UI reads capabilities and hides what is unavailable
rather than showing a button that fails. Capability negotiation is a first-class concept,
not an afterthought — this is the difference between a wrapper that feels solid and one that
feels like it is lying to you.

### Handling Tier 3 fragility

Tier 3 adapters are coupled to someone else's CLI output shape. That will break. Required
for every Tier 3 adapter:

1. A declared supported version range, checked at `detect()` time.
2. A **contract test that runs the real binary** in CI against a trivial prompt and asserts
   the event shape. This is the only way we learn about a breaking change from an upgrade
   before our users do.
3. Graceful degradation: an unrecognized event becomes an `unknown` item that renders as raw
   text, never a crash and never silent data loss.
4. A visible "your Claude Code version is newer than we've tested" banner rather than
   mysterious misbehavior.

### Cross-cutting concerns live above the adapters

Checkpoints, worktree management, cost accounting, and full-text search are implemented
**once in the server**, not per engine. Git checkpoints on turn start and turn completion
(the approach T3 Code takes) work identically no matter which engine made the change, and
give us rollback even for engines with no checkpoint feature of their own.

## Rejected alternatives

- **ACP only.** Elegant and tempting. Rejected: we would give up Codex's approvals, fork,
  steer and fs-watch surface — the richest integration any vendor offers — to save one
  adapter.
- **Native adapters only.** Best fidelity, but caps us at the 3–4 engines we can afford to
  maintain and leaves the long tail unreachable.
- **Our own agent loop against raw APIs for everything.** Maximum control, but we would be
  competing with Anthropic's and OpenAI's harness teams on their own ground while also
  building a UI. It stays in the architecture for BYOK/local models and nothing more.
- **A `switch` on provider inside the orchestrator.** How this becomes unmaintainable is
  well known. Adapters are packages.

## Consequences

- `packages/domain` is provider-agnostic and stable; churn concentrates in `adapters-*`.
- New engine support is a new package plus a registry entry — a good first contribution for
  outside contributors once we open source, which is a deliberate design goal.
- We must track upstream releases for every Tier 3 engine. Automate it: a scheduled job that
  checks published versions and opens an issue on change.
