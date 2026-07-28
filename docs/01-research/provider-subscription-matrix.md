# Providers, subscriptions, and the rules for using them

**Last verified: 2026-07-28.** Provider terms change without notice. Re-verify before
shipping any auth change.

---

## ⚠️ Read this first: the single most important constraint in the project

**In March 2026 Anthropic used both legal declarations and server-side enforcement to
restrict Claude Code's subscription OAuth to first-party products only.** OAuth
authentication obtained through Free, Pro, and Max plans is for Claude Code and Claude.ai —
using those tokens in any other product, tool, or service, *including the Agent SDK*, is not
permitted.

This kills the naive design that every "bring your subscription" tool is tempted by:
reading `~/.claude/.credentials.json`, extracting the OAuth token, and calling the API
ourselves. **We will never do this.** It is a terms violation, it is server-side detectable,
and it would get our users' accounts banned — which is a far worse outcome for them than any
feature is worth.

### The compliant design

> **We spawn the vendor's own binary and let it use its own credentials. We never read,
> copy, forward, or re-use a subscription credential.**

The user runs `claude auth login` (or `codex login`, or `cursor-agent login`) once. Those
CLIs store their own tokens in their own locations under their own terms. We invoke the
binary; the binary authenticates itself. Our process never sees the token.

This is exactly what T3 Code does, and it is why their setup instructions are "install the
CLI and log in with it" rather than "paste your token here."

Practical consequences, all of them good:
- We are legally clean and we can say so on the landing page. In this category that is a
  selling point, not fine print.
- We inherit each vendor's auth improvements for free (device code flows, keyring storage).
- We never hold a credential we could leak.

Two things to also note on the Anthropic side:
- `claude setup-token` produces a `CLAUDE_CODE_OAUTH_TOKEN` for automated environments. It
  requires a subscription. This is a *sanctioned* path — but it is scoped to automation, and
  we should only use it where the docs sanction it, never as a general token-extraction
  mechanism.
- Since 2026-06-15 Agent-SDK and GitHub-Actions usage is metered separately from interactive
  Claude Code, drawing from separate weekly token pools on subscription plans. If we ever
  route through the SDK, the user's quota behaves differently than they expect and we must
  say so in the UI.

**BYOK is different and unambiguous.** An API key the user pastes is theirs to use with any
client. We store it in the OS credential store and send it directly to the provider. No
restriction, no ambiguity.

---

## The matrix

| Provider | Subscription product | How we drive it | BYOK | Notes |
| --- | --- | --- | --- | --- |
| **Anthropic / Claude** | Pro, Max | Spawn `claude` CLI (headless stream-json, or ACP) | ✅ `ANTHROPIC_API_KEY` | Subscription OAuth is first-party only. CLI-spawn is the only compliant subscription path. Native Windows + PowerShell tool since v2.1.84. |
| **OpenAI / Codex** | ChatGPT Plus / Pro / Business | Spawn `codex app-server` after `codex login` | ✅ `OPENAI_API_KEY` | Richest protocol of any vendor. Creds cached at `%USERPROFILE%\.codex\auth.json` or the OS keyring (`cli_auth_credentials_store = keyring`) — **we recommend keyring in setup**. Known Windows issue (openai/codex#2000): "Sign in with ChatGPT" has generated an API key on some Pro accounts causing unexpected API charges; warn Windows users and link the issue. Run `codex logout` when switching auth modes. |
| **Cursor** | Cursor Pro / Business | Spawn `cursor-agent` after `cursor-agent login` | Partial | Headless `-p --output-format stream-json`; `--trust` required for the cwd. |
| **OpenCode** | n/a (BYO everything) | Connect to its server via the official JS/TS SDK | ✅ 75+ providers | Easiest integration in the set — it is already a client/server system. |
| **Moonshot / Kimi** | Kimi Code | **Anthropic-compatible endpoint** — set `ANTHROPIC_BASE_URL` and drive the `claude` CLI against it | ✅ | K2 family, ~1M token context. Moonshot ships the Anthropic adapter for every Kimi Code plan. |
| **Z.ai / GLM** | GLM Coding Plan (console → Subscription) | **Anthropic-compatible endpoint**, same mechanism | ✅ | Dramatically cheaper than first-party Anthropic; GLM-5.1 (April 2026) is a 744B MoE, MIT-licensed. |
| **xAI / Grok** | SuperGrok ($99/mo) | Spawn Grok Build CLI (ACP if available, else headless) | ✅ | Grok Build beta since 2026-05-14, local-first, up to 8 parallel agents, routes through OpenRouter for other models. |
| **OpenRouter** | pay-as-you-go | Direct API (our own loop), OpenAI-compatible | ✅ | The universal fallback. One key, hundreds of models, including xAI's 27. |
| **Local models** | free | OpenAI-compatible base URL (Ollama, LM Studio, llama.cpp) | n/a | Costs us almost nothing once the OpenAI-compatible path exists. Great story for privacy-sensitive users. |

### The Anthropic-compatible trick is a big deal

Kimi and GLM both expose Anthropic-compatible endpoints. That means **one integration —
"drive the `claude` CLI with a custom `ANTHROPIC_BASE_URL`" — unlocks three providers at
once**, at wildly different price points. A user with a €10/mo GLM plan gets the full
Claude Code experience through our harness.

We should make this a *featured* flow, not a hidden advanced setting: a provider picker
where "Claude (Anthropic)", "Kimi Code", and "GLM Coding Plan" are three visible cards that
happen to share an implementation.

There is also an existing open-source reference for the general shape of this,
`raine/claude-code-proxy`, which translates Anthropic-protocol traffic to ChatGPT, Kimi,
Cursor or Grok subscriptions via a local proxy. **We should study it but be careful**: any
approach that proxies a *subscription* (as opposed to an API key) into a different client
runs into exactly the first-party restriction described above. The Kimi/GLM case is safe
because those vendors publish the compatible endpoint deliberately and issue API keys for it.

---

## Credential storage rules

1. **Vendor subscription credentials:** we never touch them. The vendor CLI owns them.
2. **BYOK API keys:** stored in the OS credential store —
   Windows Credential Manager (via DPAPI), macOS Keychain. **Never** a plaintext JSON file
   we write, never `localStorage`, never in the SQLite database.
3. **Never logged.** Redaction on every log path, plus a test that asserts it.
4. **Never leaves the machine.** No telemetry endpoint ever receives a key, a prompt, or a
   file path. If we add telemetry it is opt-in, aggregate, and documented.
5. **Environment injection:** when a child process needs a key, it goes in that process's
   environment, not on the command line — command lines are visible to other processes in
   Task Manager and `ps`.

---

## Cost and quota UX

Users mixing five providers cannot track spend, and this is a real source of anxiety. We
should surface, per session and per provider:

- tokens in / out, and cached tokens
- cost, for BYOK where we know the rate card
- for subscriptions: which pool is being consumed, and the fact that Anthropic meters
  interactive and headless usage separately since 2026-06-15

A "you are about to run this on the expensive provider" nudge before an expensive turn is
the kind of small thing that earns a lot of trust.

---

## Sources

- [A Claude Code Subscription Is Not a Developer Credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html) — the March 2026 enforcement change
- [Claude Code Headless Mode: The Complete Self-Hosting Guide (2026)](https://amux.io/guides/claude-code-headless/)
- [Authentication | Codex](https://developers.openai.com/codex/auth)
- [openai/codex#2000 — Windows: Sign in with ChatGPT still generates an API key](https://github.com/openai/codex/issues/2000)
- [Codex CLI Authentication: OAuth, Device Code, API Keys](https://codex.danielvaughan.com/2026/04/01/codex-cli-authentication-flows-credential-management/)
- [How to Connect Claude Code to Kimi K2.5 and GLM-4.7](https://docs.bswen.com/blog/2026-03-25-claude-code-kimi-glm-setup/)
- [Alorse/cc-compatible-models](https://github.com/Alorse/cc-compatible-models) — pricing and configs for alternative models
- [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy)
- [AI Coding Plan 2026 — Claude Code vs GLM vs Kimi vs Qwen](https://codingplan.run/)
- [Grok for Coding 2026: What xAI Actually Ships](https://www.verdent.ai/guides/grok-for-coding-2026)
- [xAI API and Models | OpenRouter](https://openrouter.ai/x-ai)
