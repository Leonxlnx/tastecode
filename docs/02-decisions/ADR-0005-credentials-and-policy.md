# ADR-0005 — Credentials, provider terms, and the trust boundary

- **Status:** Accepted
- **Date:** 2026-07-28
- **Severity:** This one is not a preference. Getting it wrong gets our users banned.

## Context

The product promise is "bring every subscription you already pay for." The obvious
implementation — read the vendor CLI's stored OAuth token and call the API ourselves — is
prohibited.

In **March 2026 Anthropic used both legal declarations and server-side enforcement** to
restrict Claude Code's subscription OAuth to first-party products. OAuth credentials from
Free/Pro/Max plans are for Claude Code and Claude.ai only; using them in any other product,
tool or service — explicitly including the Agent SDK — is not permitted.

Other vendors have not all made equivalent declarations, but the direction is unambiguous
and we should assume the same rule everywhere.

## Decision

### Rule 1 — We never read, copy, forward, or re-use a vendor subscription credential.

Not from `~/.claude/.credentials.json`. Not from `~/.codex/auth.json`. Not from a keyring.
Not "just to check if the user is logged in."

### Rule 2 — Subscription access happens by spawning the vendor's own binary.

The user runs `claude auth login` / `codex login` / `cursor-agent login` once. That CLI owns
its credentials under its own terms. We spawn the binary; the binary authenticates itself;
our process never holds a token.

To check authentication status we ask the binary (`detect()` runs the vendor's own status
command), we do not inspect its credential files.

### Rule 3 — BYOK keys live in the OS credential store.

Windows Credential Manager (DPAPI) / macOS Keychain. Never in SQLite, never in a config
file we write, never in `localStorage`, never in a log.

### Rule 4 — Keys reach child processes via environment, never argv.

Command lines are readable by other processes on the machine (Task Manager, `ps`).

### Rule 5 — Nothing leaves the machine.

No prompt, no file path, no key, no source code is transmitted to any server we control.
Ever. If we add telemetry it is opt-in, aggregate-only, documented in the README, and
disabled by default. This is a promise we make publicly and it constrains future product
decisions — accept that now.

### Rule 6 — Redaction is tested.

A test asserts that known-secret-shaped strings never appear in any log sink. Secret leakage
via logs is the most common way good intentions fail.

## The one nuance: Anthropic-compatible endpoints

Moonshot (Kimi Code) and Z.ai (GLM Coding Plan) deliberately publish Anthropic-compatible
endpoints and issue API keys for them. Pointing the `claude` CLI at those endpoints with
`ANTHROPIC_BASE_URL` and the vendor's own key is the documented, intended usage. That is
BYOK, it is safe, and it is a headline feature.

The distinction to hold onto:

| Safe | Prohibited |
| --- | --- |
| User's **API key** → any client they choose | User's **subscription OAuth token** → a client other than the vendor's own |

Tools that proxy a *subscription* into a different client sit on the wrong side of that
line, whatever their README says.

## Also worth surfacing to users

- Since **2026-06-15**, Anthropic meters Agent-SDK and GitHub-Actions usage separately from
  interactive Claude Code, drawing on separate weekly token pools. If any of our paths use
  the SDK, the user's quota behaves differently than they expect and the UI must say so.
- **openai/codex#2000:** on Windows, "Sign in with ChatGPT" has generated and required an API
  key for some Pro accounts, producing unexpected API charges; revoking the key breaks the
  CLI. Warn Windows users during setup and link the issue. This is exactly the kind of
  Windows-specific trap our audience falls into, and catching it for them is the sort of
  detail that earns loyalty.
- Recommend `cli_auth_credentials_store = keyring` for Codex during setup rather than the
  default plaintext `auth.json`. We can recommend it; we cannot read it either way.

## Consequences

- **The vendor CLI is a hard dependency for subscription users.** Our onboarding must detect
  missing CLIs and guide installation beautifully — that first-run flow is now a
  load-bearing part of the product, not a chore.
- We cannot offer "log in inside our app" for subscriptions. Reframe it as a feature:
  *"Your credentials never touch Personal Harness. We ask your tools to work, we don't ask
  for your passwords."* Put that on the landing page.
- Any future cloud/team feature must preserve Rule 5 or explicitly renegotiate it with users.
- Before any auth-related change ships, re-read the current terms for the affected provider.
  Add it to the release checklist.

## Sources

- [A Claude Code Subscription Is Not a Developer Credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html)
- [Claude Code Headless Mode: The Complete Self-Hosting Guide (2026)](https://amux.io/guides/claude-code-headless/)
- [Authentication | Codex](https://developers.openai.com/codex/auth)
- [openai/codex#2000](https://github.com/openai/codex/issues/2000)
