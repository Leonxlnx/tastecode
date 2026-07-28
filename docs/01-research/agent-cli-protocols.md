# How to drive each agent engine

**Last verified: 2026-07-28.**

This is the most important research file in the repo. Everything the harness does starts
with "how do we talk to this engine, and what does it give us back?"

There are four integration mechanisms available, in descending order of richness.

---

## Mechanism 1 — Codex app-server (JSON-RPC 2.0)

The richest integration available from any vendor. `codex app-server` is a long-lived Rust
process exposing bidirectional JSON-RPC 2.0. It is the same interface OpenAI uses to power
their own IDE extension and cloud surfaces, so it is a first-class, supported client API —
not a scraped CLI.

**Transports:** stdio (newline-delimited JSON, default), WebSocket (experimental), and a
Unix socket via `codex app-server proxy`.

**Handshake:** `initialize` → response with server info (user agent, home dir, platform)
→ client sends `initialized` notification. Clients may opt out of notification classes via
`optOutNotificationMethods`.

**Data model — three nested primitives:**
- **Thread** — a conversation
- **Turn** — one user input and everything the agent does in response
- **Item** — an individual unit inside a turn: message, command, reasoning, file change

This maps almost exactly onto the UI we want to build, which is a strong argument for
adopting it as our *internal* domain model too (see ADR-0003).

**Methods we care about:**

| Area | Methods |
| --- | --- |
| Threads | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/goal/set`, `thread/goal/get` |
| Turns | `turn/start` (text/image/audio input, per-turn config overrides), `turn/steer` (inject input mid-turn without restarting), `turn/interrupt` |
| Review | `review/start` |
| Execution | `command/exec` (sandboxed), `process/spawn` (unsandboxed, experimental) |
| Files | `fs/*` — read, write, watch, metadata |
| Extensions | `mcpServer/tool/call`, `skills/list`, `plugin/list` |

**Notifications (server → client):** `thread/started`, `thread/archived`, `thread/closed`,
`turn/started`, `turn/completed`, `item/started`, `item/agentMessage/delta` (token
streaming), `item/completed`, `fs/changed`, `configWarning`, `warning`.

**Approvals:** genuinely bidirectional — the server sends `approval/requested`, the client
shows UI, the client replies `approval/respond`. `approvalsReviewer` can be `"user"` or
`"auto_review"` (a subagent reviews instead of a human).

**Backpressure:** JSON-RPC error `-32001` "Server overloaded; retry later" — retryable,
requires exponential backoff with jitter in our client.

**Notable:** `thread/fork` gives us conversation branching almost for free, and
`turn/steer` enables "type while it's working," which is a genuinely great UX affordance
that most clients do not expose.

Docs: <https://developers.openai.com/codex/app-server> and `codex-rs/app-server/README.md`.

---

## Mechanism 2 — Agent Client Protocol (ACP)

Open JSON-RPC 2.0 standard over stdio, created by Zed (August 2025), stable at 1.0. Think
LSP but for agents. An ACP registry launched January 2026.

**Coverage as of 2026:** 25+ agents implement it, including Gemini CLI, Claude Code, Codex
CLI, and OpenCode. Zed and JetBrains have native client support; Neovim, Emacs and VS Code
have community plugins.

**Why this matters enormously for us:** one adapter buys us the long tail. Every agent we
have not heard of yet, and every agent a user wants that we have not prioritized, arrives
through the same code path. This is the difference between supporting 4 engines and
supporting 25.

**Tradeoff:** ACP is a lowest-common-denominator surface. It will not expose Codex's
`thread/fork` or Claude Code's hooks. So ACP is our *breadth* layer, and native adapters
are our *depth* layer, for the two or three engines that matter most.

Docs: <https://agentclientprotocol.com> · <https://zed.dev/acp>

---

## Mechanism 3 — Headless CLI with streaming JSON

The fallback when there is no protocol server. Every major agent supports some form of it.

### Claude Code

```
claude -p "<prompt>" --output-format stream-json --input-format stream-json --resume <session-id>
```

- `--output-format` accepts `text` | `json` | `stream-json`. `stream-json` emits NDJSON,
  one event per line, flushed immediately.
- `--input-format stream-json` lets us feed messages in without respawning the process.
  **Caveat: this is under-documented** (anthropics/claude-code#24594) and has had bugs —
  duplicate entries written to session `.jsonl` when using stream-json input (#5034).
  Treat it as usable but pin the CLI version and test on upgrade.
- Transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`. We can read these
  directly to import history and to recover state — very useful for "adopt an existing
  session started in the terminal."
- `--resume <session-id>` continues a prior session.

**Windows note:** Claude Code now runs natively on Windows; WSL is optional. As of v2.1.84
(2026-03-26) there is a native PowerShell tool that replaces the Git-Bash routing and drops
the Git for Windows dependency. Historically the Bash tool assumed POSIX and produced
`C:\` vs `/c/` path translation errors and encoding mismatches on Windows. **We should
default new Windows users to the PowerShell tool and surface it in setup** — this is
exactly the kind of Windows papercut our audience hits.

### Cursor CLI (`cursor-agent`)

```
cursor-agent -p "<prompt>" --output-format stream-json --trust --model <model>
```

- Formats: `text`, `json`, `stream-json` (**stream-json is the default**).
- `json` emits exactly one object on completion; no deltas, text consolidated.
- `stream-json` event types: `system` (init, model info), `assistant` (text + deltas,
  timestamped), `tool_call` (started/completed substates), `result` (metrics, duration).
- `--force` / `--yolo` skips file-change confirmation. `--trust` is required for headless
  workspace trust on the cwd.
- Session resume and MCP support are not covered in the headless docs — verify empirically.

### OpenCode

Different shape entirely: OpenCode *is* a client/server system already. Launching spawns a
TypeScript/Bun+Hono server plus a Go TUI client. The server owns all LLM communication,
file ops, and shell execution; the TUI only renders. There is a published JS/TS SDK, and
the same server can be driven by a desktop app, IDE extensions, or CI.

**For us this is the easiest integration of all** — we just become another client of their
server. Sessions also survive terminal disconnects and SSH drops by design.

### Grok Build

Local-first CLI agent, beta since 2026-05-14. Runs up to eight parallel agents per session,
all code executes locally. Requires SuperGrok ($99/mo) or an xAI API key. Supports custom
model routing through OpenRouter. Integration path: check for ACP support first, else
headless CLI.

---

## Mechanism 4 — Direct API (our own agent loop)

For BYOK users and for providers with no CLI, we run our own agent loop against the raw
API. This is also the path for local models.

This is the most work and the most control. It is **not** a v1 priority — the engines are
better than anything we would write in a quarter — but the architecture must allow it,
because it is the only way to serve "I have an OpenRouter key and no subscription."

---

## Extension surfaces we must support

These are cross-vendor now and skipping them makes us look toy.

- **MCP (Model Context Protocol)** — the tool/connector standard. Every engine supports it.
  We need add/remove/enable, tool inspection, and per-project scoping.
- **Agent Skills (`SKILL.md`)** — Anthropic opened the spec as a public standard on
  2025-12-18; by March 2026 OpenAI, Microsoft, JetBrains, Cursor, Gemini CLI, Block's Goose
  and 25+ others had shipped compatible implementations. A skill is a directory with a
  `SKILL.md` carrying YAML frontmatter (`name` ≤64 chars, `description` ≤1024 chars) plus
  optional scripts and assets. Loading is three-stage progressive disclosure:
  discovery (name + description only) → activation (full SKILL.md into context) →
  execution (bundled code and referenced files).
  **This is the format TasteSkill ships in.** Building on the open standard means the design
  agent works in Claude Code, Codex and Cursor — inside our harness and outside it. That is
  a distribution advantage, not a compromise.
  Spec: <https://agentskills.io>
- **Hooks** — deterministic scripts at lifecycle points (`PreToolUse` is the security
  checkpoint, plus session start/stop and subagent completion). Engine-specific today.
- **Subagents** — isolated context windows for verbose work. Claude Code runs them in the
  background by default as of v2.1.198 and they can commit, push and open a draft PR from a
  worktree when they finish.
- **Plugins** — versioned bundles of skills + subagents + commands + hooks + MCP defs.
- **Checkpoints** — automatic state snapshots before changes. T3 Code implements this
  independently with git; we should too, rather than depending on each engine's version.

---

## What this means for our adapter layer

Three tiers, and every engine lands in one of them:

```
Tier 1  Native adapter    Codex app-server, OpenCode server        full fidelity
Tier 2  ACP adapter       Gemini CLI, and 25+ others               good fidelity, zero marginal cost
Tier 3  CLI adapter       Claude Code, Cursor, Grok Build          NDJSON parsing, version-pinned
```

Every tier normalizes into one internal domain model (Thread / Turn / Item, borrowed from
Codex because it is the best-designed of the three). The UI never knows which tier it is
talking to. See [`ADR-0003`](../02-decisions/ADR-0003-agent-adapter-layer.md).

**Fragility warning:** Tier 3 is version-coupled to someone else's CLI. Every Tier 3
adapter needs a declared supported version range, a contract test that runs the real binary,
and a graceful degradation path when the output shape changes. Assume it will change.

---

## Sources

- [Codex App Server](https://developers.openai.com/codex/app-server.md) · [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [The Codex App Server: A Complete Guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/)
- [Zed — Agent Client Protocol](https://zed.dev/acp) · [The ACP Registry is Live](https://zed.dev/blog/acp-registry)
- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions) · [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [anthropics/claude-code#24594 — `--input-format stream-json` undocumented](https://github.com/anthropics/claude-code/issues/24594)
- [Using Headless CLI | Cursor Docs](https://cursor.com/docs/cli/headless) · [Output format](https://cursor.com/docs/cli/reference/output-format)
- [Agent Skills Overview](https://agentskills.io/home) · [Agent Skills Open Standard Explained](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
- [Dissecting OpenCode — 10 Design Elements](https://gist.github.com/shibuiwilliam/1d1466b24cb5c8f0d9367f2c75c9c064)
- [Claude Code on Windows: The New PowerShell Tool](https://claudcod.com/blog/claude-code-windows-powershell/)
- [Grok Build Complete Guide (2026)](https://www.aimadetools.com/blog/grok-build-complete-guide/)
