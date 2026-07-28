# ADR-0001 — Desktop shell: Electron, not Tauri

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** Windows dev, macOS dev

## Context

We need a cross-platform desktop shell for a two-person team where the product's entire
differentiator is that it looks and feels better than the alternatives. Windows ships first;
macOS must reach parity from the same codebase.

The realistic options are Electron and Tauri v2. Tauri is the fashionable answer and the
size numbers are dramatic — roughly 5–10 MB bundles versus 150 MB+, and ~30–40 MB idle
memory versus hundreds.

## Decision

**Electron.**

## Why

### 1. One rendering engine, or we pay for pixel divergence forever

Tauri uses the OS webview: WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS,
WebKitGTK on Linux. This is Tauri's biggest production tradeoff — CSS that works on Windows
breaks on Linux because WebKitGTK lags on prefixes and renders fonts differently.

For most apps that is an annoyance. For *this* app it is fatal to the premise. We are
selling craft. Two developers cannot maintain pixel-perfect, motion-perfect fidelity across
Chromium, WebKit and WebKitGTK. The Windows dev would ship a beautiful build the macOS dev
sees rendered subtly wrong, every single time. Electron's 150 MB is precisely the price of
never having that conversation.

### 2. The Node ecosystem is our integration layer

The whole product is process orchestration: spawning agent CLIs, speaking JSON-RPC over
stdio, PTY handling, git plumbing, SQLite. Every vendor SDK in this space ships JS/TS first
(OpenCode publishes a JS/TS SDK; ACP and app-server clients are trivial in Node). Doing this
from Rust means writing and maintaining our own bindings for all of it.

### 3. PTY on Windows

Terminal panes need `node-pty` (ConPTY on Windows 10 1809+). It is a native module with
known Electron packaging friction (ASAR extraction, node-gyp, Node version coupling), all of
which are *solved, documented* problems in Electron. In Tauri we would use `portable-pty`
from Rust and rebuild the bridge ourselves.

### 4. Shipping on Windows is mature in Electron

`electron-builder` gives us NSIS installers, differential auto-updates, staged rollouts, and
a working Azure Trusted Signing path. Getting Windows updates and SmartScreen right is
already several weeks of work; we are not also inventing it.

### 5. The reference implementation agrees

T3 Code — the closest comparable, by people who ship a lot of software — is Electron, with
`electron-builder` producing NSIS/DMG/AppImage. Conductor is native macOS, which is exactly
why it will never run on Windows.

## What we accept

- **~150 MB installs and higher idle memory.** Mitigation: aggressive main-process
  discipline, one renderer per window not per view, lazy-loading heavy modules, and a
  memory budget enforced in CI (see `ui-performance.md`). Our users install Docker and
  Node; 150 MB is not what stops them.
- **A weaker security default than Tauri.** Tauri gives the webview zero native access
  unless granted; Electron's hardening is opt-in. Mitigation is non-negotiable, in the
  scaffold from day one: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  a strict CSP, a narrow typed `contextBridge` surface, and a deny-by-default handler for
  `window.open` and external navigation.
- **We must keep the renderer thin.** All privileged work — process spawning, filesystem,
  credentials, database — lives in the server/main process behind the IPC contract. This is
  good architecture regardless, and it is what makes the web and mobile clients possible
  later.

## Rejected alternatives

**Tauri v2** — Rejected on webview divergence (above) plus ecosystem cost for a 2-person
team. Worth revisiting only if bundle size becomes a real adoption blocker, and even then the
right move is probably shipping a smaller Electron build, not a rewrite.

**Native per-platform (SwiftUI + WinUI)** — Best possible feel, and Conductor proves the
quality ceiling. Rejected: two codebases for two developers means the Windows version is
permanently the worse one. Directly contradicts Windows-first.

**Web app only** — Zero install friction and it falls out of our architecture for free (the
server-core design means a browser client works). Rejected as the *primary* surface: no PTY,
no filesystem, no local process spawning, no OS credential store. We will ship it as a
secondary surface because it costs almost nothing.

**Wails / Neutralino** — Same webview divergence as Tauri with a smaller ecosystem.

## Consequences

- The scaffold hardens Electron on day one; no "we'll secure it later."
- Renderer is presentation-only. Privileged operations cross a typed IPC boundary.
- CI builds and smoke-tests the desktop bundle on `windows-latest` and `macos-latest`.
- Windows code signing via **Azure Trusted Signing** (cheapest path, kills SmartScreen
  warnings; requires a US/Canada entity or individual with 3+ years business history —
  **this needs checking against our actual legal entity before v1 and may force a
  cloud-hosted EV certificate instead**). Tracked as an open question in the roadmap.

## Sources

- [Tauri vs Electron 2026: The Honest Comparison](https://www.buildmvpfast.com/blog/tauri-v2-vs-electron-desktop-apps-2026)
- [Desktop Apps from Web: Tauri vs Electron vs Deno 2026](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)
- [Code Signing for Windows | electron-builder](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [Code Signing With Azure Trusted Signing on GitHub Actions](https://hendrik-erz.de/post/code-signing-with-azure-trusted-signing-on-github-actions)
- [microsoft/node-pty](https://github.com/microsoft/node-pty)
