# Security rules

⚠️ **The first rule here is not a preference. Getting it wrong gets our users banned.**

---

## Never reuse a vendor's subscription credential

In **March 2026 Anthropic restricted Claude Code's subscription OAuth to first-party
products**, with legal declarations _and_ server-side enforcement. Tokens from Free/Pro/Max
plans are for Claude Code and Claude.ai only — using them in any other product, including
the Agent SDK, is not permitted. Assume every vendor works the same way.

So the obvious design is dead: read `~/.claude/.credentials.json`, extract the token, call
the API ourselves. It's a terms violation, it's detectable server-side, and it would get our
users' accounts banned.

> **We spawn the vendor's own binary and let it authenticate itself. We never read, copy,
> forward, or re-use a subscription credential.**

The user runs `claude auth login` / `codex login` / `cursor-agent login` once. That CLI owns
its tokens under its own terms. We invoke the binary; our process never sees a token. To
check auth status we **ask the binary** — we don't inspect its credential files. Not even
"just to check if they're logged in."

**What it costs:** the vendor CLI becomes a hard dependency, so onboarding must detect
missing CLIs and guide installation beautifully. That first-run flow is now a real product
surface, not a chore.

**What it buys:** we're legally clean and can say so on the landing page. In this category
that's a selling point:

> _Your credentials never touch Personal Harness. We ask your tools to work; we don't ask
> for your passwords._

### BYOK is different and unambiguous

| Safe                                            | Prohibited                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| The user's **API key** → any client they choose | The user's **subscription OAuth token** → any client but the vendor's own |

Kimi and GLM publish Anthropic-compatible endpoints and issue their own API keys for them —
pointing the `claude` CLI at those with `ANTHROPIC_BASE_URL` is documented, intended usage.
Safe, and a headline feature.

---

## Credential handling

1. **BYOK keys live in the OS credential store** — Windows Credential Manager (DPAPI),
   macOS Keychain. Never in SQLite, a config file we write, `localStorage`, or a log.
2. **Keys reach child processes via environment, never argv.** Command lines are readable by
   other processes.
3. **Never commit a secret**, including in a test fixture or an example.
4. **Redaction is tested.** A test asserts secret-shaped strings never reach any log sink.
   Leakage via logs is the most common way good intentions fail.

## Nothing leaves the machine

No prompt, no file path, no key, no source code goes to any server we control. Ever.

If we ever add telemetry it is opt-in, aggregate-only, documented in the README, and off by
default. This is a public promise and it constrains future product decisions — including any
cloud, team, or mobile-relay feature. Accept that now, or renegotiate it explicitly with
users later.

## Electron hardening

In the scaffold from day one, not "later": `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`, strict CSP, a narrow typed `contextBridge` surface, deny-by-default
`window.open` and external navigation.

**The renderer never spawns a process, touches the filesystem, or reads a credential.**

## Release checklist

Before any auth-related change ships, re-read the current terms for the affected provider.
