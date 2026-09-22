<img src="apps/desktop/assets/tastecode-icon.png" alt="TasteCode" width="96" />

# TasteCode

[Download Windows](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.1/TasteCode-0.1.1-win-x64.exe) · [Download macOS](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.1/TasteCode-0.1.1-mac-arm64.dmg) · [Download Linux preview (.deb)](https://github.com/Leonxlnx/tastecode/releases/download/linux-preview-e9ac0a03/TasteCode-0.1.1-linux-amd64.deb) · [Linux AppImage](https://github.com/Leonxlnx/tastecode/releases/download/linux-preview-e9ac0a03/TasteCode-0.1.1-linux-x86_64.AppImage)

> A local desktop workspace for AI coding agents, with Design Mode built in.

**Early beta (`0.1.1`).** Expect bugs, rough edges, and changes as we keep working
on TasteCode. Please [report any issues](https://github.com/Leonxlnx/tastecode/issues) you find.

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

- [Download for Windows x64 (.exe)](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.1/TasteCode-0.1.1-win-x64.exe)
- [Download for macOS Apple Silicon (.dmg)](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.1/TasteCode-0.1.1-mac-arm64.dmg)
- [Download Linux preview for Debian or Ubuntu x64 (.deb)](https://github.com/Leonxlnx/tastecode/releases/download/linux-preview-e9ac0a03/TasteCode-0.1.1-linux-amd64.deb)
- [Download Linux preview AppImage for x64](https://github.com/Leonxlnx/tastecode/releases/download/linux-preview-e9ac0a03/TasteCode-0.1.1-linux-x86_64.AppImage)
- [Release notes, checksums, and all versions](https://github.com/Leonxlnx/tastecode/releases)

The Windows beta is unsigned and may show a SmartScreen warning. The macOS beta is
Developer ID signed and notarized. Beta 7 and Beta 9 users can update through
**Settings > About > Check for updates**, then **Restart to update**. Beta 6 and earlier
users who missed the Beta 7 bridge need the current installer above.
See [release details](docs/RELEASING.md).

## Requirements

- Windows 10/11 x64, macOS on Apple Silicon, or Linux x64 (glibc ≥ 2.31, Wayland session)
- at least one supported provider CLI installed and signed in
- Git for project checkpoints and worktree features

### Linux

The [Linux preview release](https://github.com/Leonxlnx/tastecode/releases/tag/linux-preview-e9ac0a03)
is available for testing, but Linux is not yet approved for the production release line.
It has been tested on Pop!_OS 24.04 (COSMIC/Wayland). Ubuntu 24.04 (GNOME/Wayland) is the
next qualification target; its physical desktop pass is not yet verified. Other Wayland
desktops are best-effort.

To install on Debian or Ubuntu x64, download the deb above. Open a terminal in your Downloads
folder and run:

```bash
sudo apt install --reinstall ./TasteCode-0.1.1-linux-amd64.deb
```

Launch TasteCode from the app menu. For a portable run, download the AppImage above and run:

```bash
chmod +x TasteCode-0.1.1-linux-x86_64.AppImage
./TasteCode-0.1.1-linux-x86_64.AppImage
```

The preview has two package options:

- **deb** — the primary artifact. Installs to `/opt/Taste Code/`, registers the desktop entry
  and AppArmor profile, and declares its dependencies to apt.
- **AppImage** — portable, with a statically linked runtime that needs no host FUSE library.
  It still needs unprivileged user namespaces for the Chromium sandbox; Ubuntu 23.10+ disables
  them by default (`kernel.apparmor_restrict_unprivileged_userns`), so prefer the deb there.
  If mounting fails for another reason, `./TasteCode-*.AppImage --appimage-extract` and run
  `squashfs-root/tastecode` instead.

Credential storage needs a Secret Service provider on the session bus — GNOME and KDE ship one;
minimal or headless desktops need gnome-keyring, KWallet, or KeePassXC installed.
For tester checks and evidence collection, see the [Linux test playbook](docs/linux-test-playbook.md).

### Linux troubleshooting

- **The AppImage refuses to start and mentions user namespaces.** The Chromium sandbox needs
  unprivileged user namespaces. The app shows a dialog with the fix; on Ubuntu 24.04 install
  the deb instead, or run
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
- **The AppArmor prompt asks about the profile.** The deb installs
  `/etc/apparmor.d/tastecode` at install time and removes it on uninstall.
- **No tray icon on GNOME.** Stock GNOME has no StatusNotifier host, so the window close
  button quits the app instead of hiding to a tray. Install the _AppIndicator and KStatusNotifierItem
  Support_ extension to get the tray icon and close-to-tray behavior.
- **Credential errors mention gnome-keyring or KWallet.** Install and unlock a Secret Service
  provider; TasteCode stores nothing when none is available.
- **Collecting logs.** Settings → Local diagnostics writes a secret-scrubbed
  `errors.log` (512 KB, one rotated generation) under
  `~/.config/TasteCode/diagnostics/text/`. The button next to the toggle opens that directory.
  For console output, launch `tastecode` from a terminal.
- **Full uninstall.** `sudo apt remove tastecode`, then delete `~/.config/TasteCode`,
  `~/.local/share/TasteCode` (the local database), and `~/.tastecode`.

## Local development

Install Node 24 LTS and pnpm, then run:

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
