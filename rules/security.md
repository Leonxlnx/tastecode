# Security rules

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
