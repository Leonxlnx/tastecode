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
default. This is a public promise and it constrains future cloud or team product decisions.
Accept that now, or renegotiate it explicitly with users later.

## Loopback is not a trust boundary

Binding the server to `127.0.0.1` keeps other machines out. It does **not** keep other
_pages_ out: browsers deliberately exempt `WebSocket` from the same-origin policy, so any
site the user happens to be visiting can open `ws://127.0.0.1:4311` and speak our protocol.
Everything the UI can do — enumerate projects, start a thread with `full` approval, open a
terminal — it could do too.

The gate is the `Origin` header. Allowed: absent (non-browser clients — the CLI and tests),
`file://` (the packaged renderer), and loopback origins (the dev server and our own web UI).
Anything else is refused with 1008.

**`null` is not allowed, and must never be added back.** A page cannot forge an arbitrary
origin, but it can always mint the _opaque_ one — `<iframe sandbox="allow-scripts" srcdoc=…>`
or a `data:` document both serialize to `Origin: null`. Allowing it hands the gate back to
the attacker it exists to stop. If one of our own renderers ever reports an opaque origin,
the answer is an access token for that surface, not a hole here.

**Any new listener inherits this rule**, and so does any future HTTP surface — a fetch from a
hostile page carries an `Origin` too. Check it at the point of accept, before a single frame
is handled.

## Electron hardening

In the scaffold from day one, not "later": `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`, strict CSP, a narrow typed `contextBridge` surface, deny-by-default
`window.open` and external navigation.

**The renderer never spawns a process, touches the filesystem, or reads a credential.**

## Release checklist

Before any auth-related change ships, re-read the current terms for the affected provider.
