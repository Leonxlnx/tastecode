<img src="apps/desktop/assets/tastecode-icon.png" alt="TasteCode" width="96" />

# TasteCode

> A local desktop workspace for AI coding agents, with Design Mode built in.

**Status: public beta (`0.1.0-beta.6`).** TasteCode currently supports Windows x64 and
macOS Apple Silicon. Expect beta rough edges and report them through
[GitHub Issues](https://github.com/Leonxlnx/tastecode/issues).

## What TasteCode does

TasteCode puts multiple coding agents in one desktop app while keeping orchestration,
project state, terminal access, diffs, checkpoints, and history local to your machine.

The public beta ships with:

- Codex
- Claude Code
- Grok
- provider-aware models, permissions, and session controls
- project and session search, rename, and pinning
- terminal, browser preview, attachments, git context, and readable diffs
- Design Mode for inspecting and editing web interfaces

Provider capabilities differ. TasteCode hides or degrades unavailable controls instead of
pretending every provider supports the same features.

## Download

- [Download for Windows x64 (.exe)](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.6/TasteCode-0.1.0-beta.6-win-x64.exe)
- [Download for macOS Apple Silicon (.dmg)](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.6/TasteCode-0.1.0-beta.6-mac-arm64.dmg)
- [Release notes, checksums, and all versions](https://github.com/Leonxlnx/tastecode/releases)

The Windows beta is unsigned and may show a SmartScreen warning. The macOS beta is
Developer ID signed and notarized. Beta 5 and earlier need one manual installation of
beta 6 to switch to GitHub in-app updates. See [release details](docs/RELEASING.md).

## Requirements

- Windows 10/11 x64, macOS on Apple Silicon, or Linux x64 (glibc ≥ 2.31, Wayland session)
- at least one supported provider CLI installed and signed in
- Git for project checkpoints and worktree features

### Linux

Linux is qualified on Pop!_OS 24.04 (COSMIC) and Ubuntu 24.04 (GNOME); other Wayland desktops
are best-effort. Two artifacts ship per release:

- **deb** — the primary artifact. Installs to `/opt`, registers the desktop entry and AppArmor
  profile, and declares its dependencies to apt.
- **AppImage** — portable, with a statically linked runtime that needs no host FUSE library.
  It still needs unprivileged user namespaces for the Chromium sandbox; Ubuntu 23.10+ disables
  them by default (`kernel.apparmor_restrict_unprivileged_userns`), so prefer the deb there.
  If mounting fails for another reason, `./TasteCode-*.AppImage --appimage-extract` and run
  `squashfs-root/tastecode` instead.

Credential storage needs a Secret Service provider on the session bus — GNOME and KDE ship one;
minimal or headless desktops need gnome-keyring, KWallet, or KeePassXC installed.

### Linux troubleshooting

- **The AppImage refuses to start and mentions user namespaces.** The Chromium sandbox needs
  unprivileged user namespaces. The app shows a dialog with the fix; on Ubuntu 24.04 install
  the deb instead, or run
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
- **The AppArmor prompt asks about the profile.** The deb installs
  `/etc/apparmor.d/tastecode` at install time and removes it on uninstall.
- **No tray icon on GNOME.** Stock GNOME has no StatusNotifier host, so the window close
  button quits the app instead of hiding to a tray. Install the *AppIndicator and KStatusNotifierItem
  Support* extension to get the tray icon and close-to-tray behavior.
- **Credential errors mention gnome-keyring or KWallet.** Install and unlock a Secret Service
  provider; TasteCode stores nothing when none is available.
- **Collecting logs.** Settings → Local diagnostics writes a secret-scrubbed
  `errors.log` (512 KB, one rotated generation) under
  `~/.config/TasteCode/diagnostics/text/`. The button next to the toggle opens that directory.
  For console output, launch `tastecode` from a terminal.
- **Full uninstall.** `sudo apt remove tastecode`, then delete `~/.config/TasteCode` and
  `~/.tastecode`.

For local development, install Node 24 LTS and pnpm, then run:

```text
pnpm install
pnpm dev
```

## Local-first security model

The local server owns state and orchestration. Provider processes run on your machine,
credentials stay with the provider or operating-system credential store, and the renderer
does not receive raw credentials. See [SECURITY.md](./SECURITY.md) and
[rules/security.md](./rules/security.md).

## Documentation

| Document                                        | Purpose                                      |
| ----------------------------------------------- | -------------------------------------------- |
| [Architecture](./docs/ARCHITECTURE.md)          | System shape and decisions                   |
| [Providers](./docs/PROVIDERS.md)                | Integration model and provider matrix        |
| [Design Agent](./docs/DESIGN-AGENT.md)          | Design Mode behavior and acceptance criteria |
| [UI handoff](./docs/UI-HANDOFF.md)              | UI invariants and open work                  |
| [Roadmap](./docs/ROADMAP.md)                    | Product milestones                           |
| [Credits](./CREDITS.md)                         | Contributors and project references          |
| [Third-party notices](./THIRD_PARTY_NOTICES.md) | Dependency and attribution audit             |
| [Licensing](./docs/LICENSING.md)                | License status and release obligations       |

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Keep changes small,
cross-platform, and covered by the repository checks. Product discussion and bug reports
belong in [GitHub Issues](https://github.com/Leonxlnx/tastecode/issues).

Questions and beta feedback: [hello@tasteskill.dev](mailto:hello@tasteskill.dev).

## License

Licensed under the [Apache License 2.0](./LICENSE). Third-party components remain under
their respective licenses.
