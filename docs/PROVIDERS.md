# Providers

Everything about connecting to agents and models: the rules we must not break, who we
support, and how we technically drive each one.

**Last verified: 2026-07-28.** Provider terms and CLI surfaces change monthly. Re-verify
before shipping any auth change, and add it to the release checklist.

- [1. The rule](#1-the-rule) ⚠️ compliance-critical
- [2. Who we support](#2-who-we-support)
- [3. How we drive each engine](#3-how-we-drive-each-engine)
- [4. Extension surfaces](#4-extension-surfaces)
- [5. Cost and quota](#5-cost-and-quota)

---

## 1. The rule

**In March 2026 Anthropic used both legal declarations and server-side enforcement to
restrict Claude Code's subscription OAuth to first-party products.** OAuth credentials from
Free/Pro/Max plans are for Claude Code and Claude.ai only. Using them in any other product,
tool or service — explicitly including the Agent SDK — is not permitted.

This kills the design every "bring your subscription" tool is tempted by: read
`~/.claude/.credentials.json`, extract the token, call the API ourselves. It is a terms
violation, it is server-side detectable, and it would get our users' accounts banned — a
far worse outcome for them than any feature is worth.

Other vendors have not all made equivalent declarations. Assume the same rule everywhere.

### The compliant design

> **We spawn the vendor's own binary and let it use its own credentials. We never read,
> copy, forward, or re-use a subscription credential.**

The user runs `claude auth login` / `codex login` / `cursor-agent login` once. Those CLIs
store their own tokens in their own locations under their own terms. We invoke the binary;
the binary authenticates itself; our process never sees a token. To check auth status we ask
the binary — we do not inspect its credential files.

This is what T3 Code does, and it is why their setup instructions are "install the CLI and
log in with it" rather than "paste your token here."

Consequences, all of them good:
- We are legally clean and can say so on the landing page. In this category that is a
  selling point, not fine print.
- We inherit each vendor's auth improvements for free.
- We never hold a credential we could leak.

### The hard rules

1. **Never read, copy, or forward a vendor subscription credential.** Not from
   `~/.claude/.credentials.json`, not from `~/.codex/auth.json`, not from a keyring, not
   "just to check if the user is logged in."
2. **Subscription access happens by spawning the vendor's binary.**
3. **BYOK keys live in the OS credential store** — Windows Credential Manager (DPAPI),
   macOS Keychain. Never in SQLite, never in a config file we write, never in
   `localStorage`, never in a log.
4. **Keys reach child processes via environment, never argv.** Command lines are readable by
   other processes (Task Manager, `ps`).
5. **Nothing leaves the machine.** No prompt, no file path, no key, no source code is
   transmitted to any server we control. Ever. If we add telemetry it is opt-in,
   aggregate-only, documented, and off by default. This is a public promise and it
   constrains future product decisions — accept that now.
6. **Redaction is tested.** A test asserts that secret-shaped strings never reach any log
   sink. Leakage via logs is the most common way good intentions fail.

### The one nuance: BYOK is unambiguous

An API key the user pastes is theirs to use with any client.

| Safe | Prohibited |
| --- | --- |
| User's **API key** → any client they choose | User's **subscription OAuth token** → a client other than the vendor's own |

Tools that proxy a *subscription* into a different client sit on the wrong side of that
line, whatever their README says. `raine/claude-code-proxy` is worth studying for the
general shape, with that caveat firmly in mind.

### What this costs us, and how we turn it around

**The vendor CLI becomes a hard dependency for subscription users.** Onboarding must detect
missing CLIs and guide installation beautifully — that first-run flow is now a load-bearing
part of the product, not a chore.

We cannot offer "log in inside our app" for subscriptions. Reframe it as the feature it
actually is:

> *Your credentials never touch Personal Harness. We ask your tools to work; we don't ask
> for your passwords.*

Any future cloud or team feature must preserve rule 5 or explicitly renegotiate it with
users.

---

## 2. Who we support

| Provider | Subscription | How we drive it | BYOK | Notes |
| --- | --- | --- | --- | --- |
| **Anthropic / Claude** | Pro, Max | Spawn `claude` CLI (headless stream-json, or ACP) | ✅ `ANTHROPIC_API_KEY` | Subscription OAuth is first-party only. CLI-spawn is the only compliant path. Native Windows + PowerShell tool since v2.1.84. |
| **OpenAI / Codex** | ChatGPT Plus / Pro / Business | Spawn `codex app-server` after `codex login` | ✅ `OPENAI_API_KEY` | Richest protocol of any vendor. Creds at `%USERPROFILE%\.codex\auth.json` or the OS keyring. |
| **Cursor** | Pro / Business | Spawn `cursor-agent` after `cursor-agent login` | Partial | `--trust` required for headless workspace trust. |
| **OpenCode** | n/a (BYO everything) | Connect to its server via the official JS/TS SDK | ✅ 75+ providers | Easiest integration in the set — already a client/server system. |
| **Moonshot / Kimi** | Kimi Code | **Anthropic-compatible endpoint** — `ANTHROPIC_BASE_URL` + the `claude` CLI | ✅ | K2 family, ~1M context. Moonshot ships the adapter for every Kimi Code plan. |
| **Z.ai / GLM** | GLM Coding Plan | **Anthropic-compatible endpoint**, same mechanism | ✅ | Far cheaper than first-party Anthropic. GLM-5.1 (April 2026) is a 744B MoE, MIT-licensed. |
| **xAI / Grok** | SuperGrok ($99/mo) | Grok Build CLI (ACP if available, else headless) | ✅ | Beta since 2026-05-14, local-first, up to 8 parallel agents, routes through OpenRouter for other models. |
| **OpenRouter** | pay-as-you-go | Direct API, OpenAI-compatible | ✅ | The universal fallback. One key, hundreds of models. |
| **Local models** | free | OpenAI-compatible base URL (Ollama, LM Studio, llama.cpp) | n/a | Nearly free once the OpenAI-compatible path exists. Strong privacy story. |

### The Anthropic-compatible trick is a big deal

Kimi and GLM both expose Anthropic-compatible endpoints. **One integration — "drive the
`claude` CLI with a custom `ANTHROPIC_BASE_URL`" — unlocks three providers at wildly
different price points.** A user with a cheap GLM plan gets the full Claude Code experience
through our harness.

Make this a *featured* flow, not a hidden advanced setting: a provider picker where
"Claude (Anthropic)", "Kimi Code" and "GLM Coding Plan" are three visible cards that happen
to share an implementation.

### Windows traps to catch for the user

These are exactly the papercuts our audience hits, and catching them earns loyalty:

- **openai/codex#2000** — on Windows, "Sign in with ChatGPT" has generated and required an
  API key for some Pro accounts, producing unexpected API charges; revoking the key breaks
  the CLI. Warn during setup and link the issue.
- Recommend `cli_auth_credentials_store = keyring` for Codex rather than the default
  plaintext `auth.json`. We can recommend it; we cannot read it either way.
- Run `codex logout` when switching auth modes, or stale tokens interfere.
- Claude Code's Bash tool historically assumed POSIX on Windows — `C:\` vs `/c/` path
  translation errors, encoding mismatches. Default new Windows users to the native
  PowerShell tool (v2.1.84+) and surface it in setup.

---

## 3. How we drive each engine

Four mechanisms, in descending order of richness. Which tier each engine lands in is in
[ARCHITECTURE.md §4](./ARCHITECTURE.md#4-agent-adapters).

### Codex app-server — JSON-RPC 2.0 (Tier 1)

The richest integration any vendor offers. A long-lived Rust process exposing bidirectional
JSON-RPC 2.0 — the same interface OpenAI uses for their own IDE extension and cloud
surfaces, so it is a supported client API, not a scraped CLI.

**Transports:** stdio (newline-delimited JSON, default), WebSocket (experimental), Unix
socket via `codex app-server proxy`.

**Handshake:** `initialize` → response with server info → client sends `initialized`.
Clients may opt out of notification classes via `optOutNotificationMethods`.

**Methods:**

| Area | Methods |
| --- | --- |
| Threads | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/goal/set`, `thread/goal/get` |
| Turns | `turn/start` (text/image/audio, per-turn config overrides), `turn/steer` (inject input mid-turn without restarting), `turn/interrupt` |
| Review | `review/start` |
| Execution | `command/exec` (sandboxed), `process/spawn` (unsandboxed, experimental) |
| Files | `fs/*` — read, write, watch, metadata |
| Extensions | `mcpServer/tool/call`, `skills/list`, `plugin/list` |

**Notifications:** `thread/started`, `thread/archived`, `thread/closed`, `turn/started`,
`turn/completed`, `item/started`, `item/agentMessage/delta` (token streaming),
`item/completed`, `fs/changed`, `configWarning`, `warning`.

**Approvals:** genuinely bidirectional — server sends `approval/requested`, client shows UI,
client replies `approval/respond`. `approvalsReviewer` is `"user"` or `"auto_review"`.

**Backpressure:** JSON-RPC error `-32001` "Server overloaded; retry later". Retryable —
requires exponential backoff with jitter in our client.

Two standouts: `thread/fork` gives us conversation branching almost free, and `turn/steer`
enables "type while it's working," which most clients do not expose and which is a genuinely
great affordance.

### Agent Client Protocol (ACP) — Tier 2

Open JSON-RPC 2.0 standard over stdio, created by Zed (August 2025), stable at 1.0, with a
registry since January 2026. LSP, but for agents.

**Coverage:** 25+ agents including Gemini CLI, Claude Code, Codex CLI and OpenCode. Zed and
JetBrains have native client support; Neovim, Emacs and VS Code have community plugins.

**Why it matters enormously:** one adapter buys the long tail. Every agent we have not heard
of yet arrives through the same code path. The difference between supporting 4 engines and
25.

**Tradeoff:** lowest-common-denominator. It will not expose Codex's `thread/fork` or Claude
Code's hooks. ACP is our *breadth* layer; native adapters are our *depth* layer.

### Headless CLI with streaming JSON — Tier 3

**Claude Code**

```
claude -p "<prompt>" --output-format stream-json --input-format stream-json --resume <session-id>
```

- `--output-format`: `text` | `json` | `stream-json`. The latter emits NDJSON, one event per
  line, flushed immediately.
- `--input-format stream-json` feeds messages in without respawning. **Under-documented**
  (anthropics/claude-code#24594) and has had bugs — duplicate entries in session `.jsonl`
  (#5034). Usable, but pin the CLI version and test on upgrade.
- Transcripts at `~/.claude/projects/<project>/<session-id>.jsonl`. We can read these to
  import history — "you already have 40 sessions, here they are" is a great first-run moment.
- `--resume <session-id>` continues a prior session.

**Cursor CLI**

```
cursor-agent -p "<prompt>" --output-format stream-json --trust --model <model>
```

- `stream-json` is the default. `json` emits one object on completion, no deltas.
- Event types: `system` (init, model), `assistant` (text + deltas, timestamped), `tool_call`
  (started/completed), `result` (metrics, duration).
- `--force` / `--yolo` skips file-change confirmation.
- Session resume and MCP support are not in the headless docs — verify empirically.

**Grok Build** — check for ACP first, else headless CLI.

### OpenCode — a different shape entirely (Tier 1)

Already a client/server system: launching spawns a TypeScript/Bun+Hono server plus a Go TUI
client. The server owns all LLM communication, file ops and shell execution; the TUI only
renders. There is a published JS/TS SDK.

**Easiest integration in the set** — we just become another client of their server. Sessions
also survive terminal disconnects by design.

### Direct API — our own agent loop

For BYOK users, providers with no CLI, and local models. Most work, most control.
**Not a v1 priority** — the engines are better than anything we would write in a quarter —
but the architecture must allow it, because it is the only way to serve "I have an
OpenRouter key and no subscription."

---

## 4. Extension surfaces

Cross-vendor now. Skipping these makes us look like a toy.

**MCP (Model Context Protocol)** — the tool/connector standard, supported by every engine.
We need add/remove/enable, tool inspection, and per-project scoping.

**Agent Skills (`SKILL.md`)** — Anthropic opened the spec on 2025-12-18; by March 2026
OpenAI, Microsoft, JetBrains, Cursor, Gemini CLI, Block's Goose and 25+ others had shipped
compatible implementations. A skill is a directory with a `SKILL.md` carrying YAML
frontmatter (`name` ≤64 chars, `description` ≤1024) plus optional scripts and assets.
Loading is three-stage progressive disclosure: discovery (name + description only) →
activation (full SKILL.md into context) → execution (bundled code and referenced files).

**This is the format TasteSkill ships in.** Building on the open standard means the design
agent works in Claude Code, Codex and Cursor — inside our harness and outside it. That is a
distribution advantage, not a compromise. See [DESIGN-AGENT.md](./DESIGN-AGENT.md).

**Hooks** — deterministic scripts at lifecycle points (`PreToolUse` is the security
checkpoint, plus session start/stop and subagent completion). Engine-specific today.

**Subagents** — isolated context windows for verbose work. Claude Code runs them in the
background by default as of v2.1.198, and they can commit, push and open a draft PR from a
worktree.

**Plugins** — versioned bundles of skills + subagents + commands + hooks + MCP definitions.

**Checkpoints** — we implement these ourselves with git rather than depending on each
engine's version. See [ARCHITECTURE.md §5](./ARCHITECTURE.md#5-storage-checkpoints-and-search).

---

## 5. Cost and quota

Users mixing five providers cannot track spend, and this is a real source of anxiety.
Surface, per session and per provider: tokens in/out and cached, cost for BYOK where we know
the rate card, and for subscriptions which pool is being consumed.

Note: **since 2026-06-15 Anthropic meters Agent-SDK and GitHub-Actions usage separately from
interactive Claude Code**, drawing on separate weekly token pools. If any of our paths use
the SDK, the user's quota behaves differently than they expect and the UI must say so.

A "you are about to run this on the expensive provider" nudge before a costly turn is the
kind of small thing that earns a lot of trust.

---

## Sources

- [A Claude Code Subscription Is Not a Developer Credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html) — the March 2026 enforcement change
- [Codex App Server](https://developers.openai.com/codex/app-server.md) · [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [Authentication | Codex](https://developers.openai.com/codex/auth)
- [openai/codex#2000](https://github.com/openai/codex/issues/2000) — Windows ChatGPT sign-in generates an API key
- [Zed — Agent Client Protocol](https://zed.dev/acp) · [The ACP Registry is Live](https://zed.dev/blog/acp-registry)
- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions) · [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [anthropics/claude-code#24594](https://github.com/anthropics/claude-code/issues/24594)
- [Using Headless CLI | Cursor Docs](https://cursor.com/docs/cli/headless) · [Output format](https://cursor.com/docs/cli/reference/output-format)
- [Agent Skills Overview](https://agentskills.io/home) · [Agent Skills Open Standard Explained](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
- [How to Connect Claude Code to Kimi K2.5 and GLM-4.7](https://docs.bswen.com/blog/2026-03-25-claude-code-kimi-glm-setup/) · [Alorse/cc-compatible-models](https://github.com/Alorse/cc-compatible-models)
- [Dissecting OpenCode](https://gist.github.com/shibuiwilliam/1d1466b24cb5c8f0d9367f2c75c9c064)
- [Claude Code on Windows: The New PowerShell Tool](https://claudcod.com/blog/claude-code-windows-powershell/)
- [Grok Build Complete Guide (2026)](https://www.aimadetools.com/blog/grok-build-complete-guide/) · [xAI on OpenRouter](https://openrouter.ai/x-ai)
