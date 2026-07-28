# Competitive landscape

**Last verified: 2026-07-28.** This field moves monthly; re-verify before quoting.

---

## The category

There are three layers, and it matters which one we are in.

1. **Engines** — the agents themselves. Claude Code, Codex CLI, Cursor CLI, OpenCode,
   Gemini CLI, Grok Build. These are commodities that improve every week and we do not
   want to compete with them.
2. **Clients / control planes** — GUIs that drive one or more engines. T3 Code, Conductor,
   Nimbalyst, Vibe Kanban, opcode/Claudia. **This is us.**
3. **Remote surfaces** — phone and web access to an engine running elsewhere. Omnara,
   Happy Coder, Anthropic's own Remote Control, Cursor Mobile.

We are a client that grows a remote surface. We are not an engine.

---

## The reference implementation: T3 Code

`pingdotgg/t3code` — MIT, TypeScript, ~15.4k stars, actively developed (pushed today).
Built by Theo (t3.gg) and Julius. This is the closest thing to what we are building and
the most useful thing to study.

### What their repo actually looks like

```
apps/
  desktop      Electron shell
  marketing    the landing page, in the same monorepo
  mobile       mobile client
  server       Node.js WebSocket + HTTP server — the real brain
  web          React + Vite front end
packages/
  client-runtime
  contracts               shared typed protocol between web and server
  effect-acp              Agent Client Protocol adapter
  effect-codex-app-server Codex app-server JSON-RPC adapter
  shared
  ssh                     remote environments
  tailscale               remote environments
```

Toolchain: pnpm 11, Node 24, Vite+ (`vp`), Effect-TS throughout, electron-builder
(`nsis` for Windows, `dmg` for macOS, `AppImage` for Linux).

### Their architecture, from their own docs

```
Browser (React + Vite)
   │  ws://localhost:3773   typed push envelopes: { channel, sequence, data }
apps/server (Node.js)
   │  ServerPushBus (ordered) · OrchestrationEngine · ProviderService · CheckpointReactor
   │  JSON-RPC over stdio
codex app-server
```

Key design moves worth stealing:

- **The browser is a thin renderer.** All orchestration state lives server-side; the client
  hydrates from an ordered push stream with a monotonic `sequence` per connection.
- **A `contracts` package** defines every request and push channel, schema-validated at the
  transport boundary, with structured decode diagnostics. This is what makes a
  web + desktop + mobile trio tractable for a small team.
- **Queue-backed workers** (`DrainableWorker`) for anything async, plus typed "runtime
  receipts" published on milestones so tests wait on signals instead of polling.
- **Automatic git checkpoints** captured on turn start and turn complete.
- **Adapters are packages, not branches in a switch statement** — `effect-acp` and
  `effect-codex-app-server` sit side by side.

### Where they are weak — our opening

- **Codex is the only implemented provider.** Their own architecture doc says it plainly:
  *"Codex is the only implemented provider. `claudeCode` is reserved in contracts/UI."*
  The marketing describes Codex, Claude, Cursor and OpenCode; the shipped depth is Codex.
- **No design story at all.** It is a session manager. Nothing about design output quality.
- **Web-app-in-Electron.** Reasonable, but it means the desktop app inherits web-app feel
  rather than app feel. There is room to be markedly more crafted.
- **Not Windows-led.** Windows targets exist in the build scripts, but the project's center
  of gravity is macOS.

**Read: they have validated the architecture. They have not validated taste, breadth of
provider support, or Windows.**

---

## The rest of the field

| Tool | What it is | Status / weakness |
| --- | --- | --- |
| **Conductor** (Melty Labs) | Native macOS app, parallel agents each in a worktree, real diff review. Free, BYO login. Supports Claude Code, Codex, Cursor, OpenCode. | **macOS + Apple Silicon only.** Windows and Linux are simply out. The most polished thing in the category and it cannot be installed by half the market. |
| **Crystal** (Stravu) | MIT Electron app, parallel Claude Code + Codex sessions. | **Deprecated February 2026**, redirects to a paid closed-source successor. |
| **Vibe Kanban** (Bloop) | Kanban board over agent tasks. | Company **wound down in early 2026**; hosted services shut off. Project continues community-maintained. |
| **Nimbalyst** | Currently the most complete free option: kanban session board, one-click worktree isolation, inline accept/reject diff review, seven visual editors (markdown, mockups, diagrams), iOS companion app, push notifications. Runs Claude Code and Codex side by side. | The genuine competitor for feature breadth. Free for individuals, open source. Where they are beatable: it is a *workspace with editors*, broad rather than deep, and design output quality is not their axis. |
| **opcode / Claudia** | Claude-Code-specific GUI. | Single-engine. |
| **Claude Squad** | Terminal session manager (tmux-based). | Leanest option, but still a terminal. |
| **Omnara / Happy Coder** | Phone control of agents running on your machine. Happy is open source with E2E encryption. | Remote surface only, no desktop client of substance. Validates our mobile plan. |

## What the table says

1. **Windows is genuinely underserved.** The best client (Conductor) is macOS-only. The
   good open-source Electron one (Crystal) is dead. The kanban one's company shut down.
   A Windows developer in 2026 has approximately one real option (Nimbalyst) and it is not
   Windows-led. **Shipping Windows first is not a constraint we are working around — it is
   the strategy.**
2. **Everyone competes on orchestration; nobody competes on design output.** Parallel
   agents, worktrees, kanban boards, diff review — that is the whole field. Not one of them
   claims their agent produces better-looking work. That is the TasteSkill wedge.
3. **Table stakes are now well defined.** To be taken seriously on day one we need:
   multi-agent, parallel sessions, worktree isolation, inline diff review with accept/reject,
   session persistence and resume, MCP support, and BYO subscription. Below that bar we are
   not in the conversation.
4. **Mobile is a real differentiator but a late one.** Nimbalyst has iOS; T3 Code has a
   mobile app in-repo. It arrives after desktop v1, and the architecture must not preclude
   it — which is the single strongest argument for a server-core design.

## Feature parity checklist

Derived from the union of Claude Code, Codex, Cursor, and the clients above. Detailed
scoping lives in [FEATURES.md](./FEATURES.md).

**Must have for v1**
- Multiple projects, multiple concurrent sessions, session resume after app restart
- Git worktree isolation per session, one click
- Streaming output with tool calls, reasoning, and plan surfaced as first-class UI
- Inline diff review, per-hunk accept/reject, checkpoint + rollback
- Approval prompts (command execution, file writes) with clear allow/deny and remembered scopes
- MCP server management (add, enable, inspect tools)
- Agent Skills support (`SKILL.md`) — the open standard, not a proprietary format
- Slash commands, custom instructions files, hooks
- Provider/model switching mid-session where the engine allows
- Terminal pane (real PTY) as the escape hatch
- Full-text search across all sessions
- Cost and token accounting per session and per provider

**Explicitly v2+**
- Kanban / task board over sessions
- Mobile remote control
- Multi-agent orchestration (agents that dispatch agents)
- Cloud/remote execution environments
- Team features

---

## Sources

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) — repo, docs/architecture, package manifests (inspected directly via GitHub API)
- [T3 Code: An Open-Source GUI for Managing AI Coding Agents](https://betterstack.com/community/guides/ai/t3-code/) — Better Stack
- [Best Claude Code GUI in 2026: 4 Tools Compared](https://nimbalyst.com/blog/best-claude-code-gui-tools-2026/) — Nimbalyst (vendor, read with that in mind)
- [The Best Tools to Run Multiple Claude Code Agents (2026)](https://munderdiffl.in/blog/best-claude-code-multi-agent-tools/)
- [Best Multi-Agent Coding Tools for Claude Code and Codex Users (2026)](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/)
- [Best Apps to Control Coding Agents from Mobile (2026 Update)](https://codeongrass.com/blog/best-app-to-control-coding-agents-from-mobile/)
- [Happy — Remote Control for Claude Code & Codex](https://happy.engineering/)
- [Omnara](https://remote.omnara.com/)
