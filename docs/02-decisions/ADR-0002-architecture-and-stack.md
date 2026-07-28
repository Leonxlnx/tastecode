# ADR-0002 — Core architecture and technology stack

- **Status:** Accepted
- **Date:** 2026-07-28
- **Supersedes:** nothing

## Context

We need one architecture that serves a desktop app now, a web client cheaply, and a mobile
remote-control client later — built and maintained by two people plus an agent.

## Decision

**A local server process owns all state and all agent orchestration. Every client is a thin
renderer connected over a typed WebSocket protocol.**

```
┌───────────────────────────────────────────────┐
│  Clients (thin, presentation only)            │
│  desktop renderer · web · mobile (later)      │
└────────────────────┬──────────────────────────┘
                     │  WebSocket, typed contracts
                     │  req/res { id, method, params }
                     │  push   { channel, sequence, data }
┌────────────────────▼──────────────────────────┐
│  Core server (Node.js, local, long-lived)     │
│   SessionOrchestrator · AdapterRegistry       │
│   EventLog (SQLite) · ReadModel · Checkpoints │
│   CredentialVault · WorktreeManager · PTY     │
└────────────────────┬──────────────────────────┘
                     │  per-adapter transports
     ┌───────────────┼───────────────┬───────────────┐
     ▼               ▼               ▼               ▼
 codex             ACP            CLI             direct API
 app-server       agents         adapters         (BYOK)
 (JSON-RPC)      (JSON-RPC)     (NDJSON)
```

### Why a server core rather than doing it in Electron's main process

1. **Agents survive the UI.** Close the window, the turn keeps running. Reopen and reattach.
   This is a genuine feature — OpenCode advertises exactly this property.
2. **Mobile becomes an addressable client instead of a rewrite.** The remote plan is "expose
   the same WebSocket securely," not "build a second backend."
3. **The web client is nearly free.**
4. **Testability.** The server is headless and scriptable, so the orchestration logic is
   testable without booting Electron.

This is the same shape T3 Code arrived at, and OpenCode independently. When three teams
converge on a design, that is evidence.

### The transport contract

Borrowed, with credit, from T3 Code's design because it is well-considered:

- **Request/response:** `{ id, method, params }` → `{ id, result }` | `{ id, error }`
- **Push:** `{ channel, sequence, data }` where `sequence` is monotonic per connection, so
  clients can detect gaps and resync rather than silently diverging.
- **Every payload is schema-validated at the transport boundary**, both directions, with
  structured decode diagnostics (code, reason, path). This is what keeps three client
  surfaces from drifting.
- Client transport is an explicit state machine: `connecting → open → reconnecting →
  closed → disposed`. Outbound requests queue while disconnected and flush on reconnect;
  inbound pushes are cached per channel with opt-in `replayLatest` on subscribe.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, strict | One language across server, all clients, and build scripts. |
| Runtime | Node 24 LTS | Native TS type-stripping, mature Windows support. Not Bun: native-module and Windows maturity still lag, and we depend on `node-pty` and `better-sqlite3`. |
| Monorepo | pnpm workspaces | Content-addressed store makes worktree-heavy workflows cheap — directly relevant since we create worktrees per session. |
| Build/task | Turborepo + Vite 6 | Boring, fast, well-documented. (T3 Code uses Vite+/`vp`; we avoid pre-1.0 tooling that only one team uses.) |
| Desktop | Electron + electron-builder | [ADR-0001](./ADR-0001-desktop-shell.md) |
| UI | React 19 | Ecosystem — TanStack Virtual and Streamdown, both load-bearing, are React. |
| Styling | Tailwind v4 + our own token layer | Tokens are generated from the design system, not hand-written. See [ADR-0007]. |
| Components | Radix / Base UI primitives, our own visual layer | We take accessibility and behavior from primitives and write every pixel ourselves. **We do not adopt a component kit wholesale** — shadcn-default styling is the single most recognizable AI-app look and it would undercut the entire premise. |
| Motion | Motion (ex-Framer Motion) | Spring physics; used sparingly per UX principles. |
| Chat list | TanStack Virtual, `anchorTo: 'end'` | [ui-performance.md](../01-research/ui-performance.md) |
| Markdown | Streamdown + Shiki in a worker | Handles unterminated markdown mid-stream. |
| State | Zustand + normalized event-derived store | Selector discipline matters more than the library. |
| Validation | Zod (or Valibot if bundle size bites) | Powers the transport contracts. |
| DB | SQLite via `better-sqlite3`, WAL, FTS5 | [ADR-0004](./ADR-0004-storage-and-search.md) |
| PTY | `node-pty` (ConPTY) | Only real option; Windows 10 1809+ required. |
| Tests | Vitest, Playwright for Electron | Contract tests per adapter run the real binaries. |
| Lint/format | oxlint + Prettier (or Biome) | Speed matters at monorepo scale. |

### On Effect-TS

T3 Code uses Effect throughout. It is genuinely good for exactly this problem — layered
dependency injection, typed errors, structured concurrency, resource safety around child
processes.

**Decision: we do not adopt Effect for v1.** The learning curve is real, it colors every
signature in the codebase, and with two developers the cost of everyone being fluent
outweighs the benefit before we have a shipped product. We adopt the *patterns* it
encourages — explicit layers, typed errors, drainable workers, deterministic test
synchronization via completion signals — using plain TypeScript.

Revisit after v1 if concurrency bugs in the orchestrator become a recurring source of pain.
That would be the honest signal that we needed it.

## Package layout

```
apps/
  desktop        Electron main + preload (thin)
  web            React client — the actual UI, shared by desktop and browser
  server         Core server: orchestration, adapters, storage
  marketing      Landing page (see docs/06-landing)
packages/
  contracts      Wire protocol + schemas. Single source of truth for all clients.
  domain         Thread / Turn / Item model, provider-agnostic
  adapters-*     One package per integration tier
  ui             Design system: tokens, primitives, motion
  design-agent   TasteSkill packaging and runtime
  shared         Utilities, logging, platform helpers
tools/
  scripts        Node-based repo scripts (never .sh — see working rules)
```

## Rejected alternatives

- **Everything in the Electron main process.** Simpler at first, but forecloses mobile, web,
  and agent-survives-UI. Rejected.
- **Rust core with a TS UI.** Better performance ceiling and smaller footprint; wrong
  ecosystem for the integration work, wrong skill fit for a 2-person JS team.
- **Bun runtime.** Attractive (OpenCode uses it), but our native-module dependencies and
  Windows-first stance make Node the lower-risk choice. Re-evaluate later.
- **tRPC over the wire.** Excellent DX, but ties us to a TS client. Mobile and any future
  non-TS client argue for a plain, documented, schema-validated JSON protocol.

## Consequences

- The renderer never spawns a process, touches the filesystem, or reads a credential.
- `packages/contracts` is the most carefully reviewed package in the repo. Changes there are
  breaking changes for three clients.
- The server must be independently runnable (`pnpm dev:server`) and scriptable, and must
  have a version-negotiation story with clients, since a desktop app and a phone may run
  different versions against the same server.
